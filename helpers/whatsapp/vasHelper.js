const crypto = require('crypto');
const messagingHelper = require('./messagingHelper');
const purchaseHelper = require('./purchaseHelper');
const cardHelper = require('./cardHelper');
const vasApi = require('../smatpay/vasApiHelper');
const payApi = require('../smatpay/payApiHelper');
const cardsApi = require('../smatpay/cardsApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const confirmPinFlowHelper = require('../flows/confirmPinFlowHelper');

/**
 * Buying airtime, electricity and water, the same steps as the app's buy flow:
 * provider (skipped when there's one) → number or meter (meters are looked up and confirmed) →
 * amount → how to pay → quote → PIN → purchase. The draft lives on user.draft; the step on
 * user.last_bot_message.
 *
 * Pays with a saved card, EcoCash, InnBucks, O'mari or ZimSwitch; a card can be added on the way.
 * Paying a merchant (service 'pay') starts in payHelper and joins here at "how to pay".
 */

const SERVICES = {
    airtime: {
        menuId: 'MENU_AIRTIME',
        header: 'Buy airtime',
        noun: 'airtime',
        choose: 'Which network is the airtime for?',
        chooseButton: 'Choose network',
        billers: b => /AIRTIME/.test(b.code) && !/BUNDLE/.test(b.code),
    },
    data: {
        menuId: 'MENU_DATA',
        header: 'Buy data',
        noun: 'data',
        choose: 'Which network is the data for?',
        chooseButton: 'Choose network',
        // NetOne sells its bundles as products of its USD airtime biller.
        billers: b => /BUNDLE/.test(b.code) || bundleProducts(b).length > 0,
    },
    electricity: {
        menuId: 'MENU_ELECTRICITY',
        header: 'Buy electricity',
        noun: 'electricity',
        choose: 'Which electricity provider?',
        chooseButton: 'Choose provider',
        billers: b => !/AIRTIME|BUNDLE|WATER/.test(b.code),
    },
    pay: {
        menuId: 'MENU_PAY',
        header: 'Pay a merchant',
        noun: 'payment',
    },
    water: {
        menuId: 'MENU_WATER',
        header: 'Pay for water',
        noun: 'water',
        choose: 'Which council?',
        chooseButton: 'Choose council',
        billers: b => /WATER/.test(b.code),
    },
};
const SERVICE_BY_MENU = Object.fromEntries(Object.entries(SERVICES).map(([key, s]) => [s.menuId, key]));

const STEPS = {
    chooseBiller: 'vas_choose_biller',
    enterAccount: 'vas_enter_account',
    confirmAccount: 'vas_confirm_account',
    chooseCurrency: 'vas_choose_currency',
    enterAmount: 'vas_enter_amount',
    chooseBundle: 'vas_choose_bundle',
    chooseMethod: 'vas_choose_method',
    enterWalletNumber: 'vas_enter_wallet_number',
    confirm: 'vas_confirm',
    pinSent: 'vas_pin_sent',
};

// Which numbers each wallet takes (O'mari runs on NetOne; EcoCash on Econet).
const WALLET_PATTERNS = {
    ECOCASH: /^07[78]\d{7}$/,
    OMARI: /^071\d{7}$/,
    INNBUCKS: /^07\d{8}$/,
};
const WALLET_NUMBER_HINT = {
    ECOCASH: 'the Econet number registered for EcoCash',
    OMARI: 'the NetOne number registered for O’mari',
    INNBUCKS: 'the mobile number registered for InnBucks',
};

const cancelButton = {id: 'VAS_CANCEL', title: 'Cancel'};
const menuButton = {id: 'MAIN_MENU', title: 'Main menu'};

/** 0771234567 / +263 77 123 4567 / 263771234567 → 0771234567. */
function localNumber(text) {
    const digits = String(text || '').replace(/[^\d+]/g, '');
    if (digits.startsWith('+263')) return `0${digits.slice(4)}`;
    if (digits.startsWith('263')) return `0${digits.slice(3)}`;
    return digits;
}

/** The customer's own WhatsApp number, when it's Zimbabwean. */
function ownNumber(user) {
    return user.phone.startsWith('+263') ? localNumber(user.phone) : null;
}

/** Electricity and water are bought for a meter; airtime for a phone number. */
function isMeter(draft) {
    return draft.service === 'electricity' || draft.service === 'water';
}

function isPayment(draft) {
    return draft.service === 'pay';
}

/**
 * A quote refused because the amount is under the minimum: { min } (null when the message
 * doesn't say it), or false for any other refusal.
 */
function belowMinimum(message) {
    const text = String(message || '');
    if (!/minimum|\bmin\b|too (small|low)|amount[^.]*at least|at least[^.]*amount/i.test(text)) return false;
    // "Amount 0.50 is below the minimum of 1.00": the figure after "minimum"/"at least", else the largest.
    const after = text.match(/(?:minimum|\bmin\b|at least)\D{0,20}?(\d+(?:\.\d{1,2})?)/i);
    const figures = (text.match(/\d+(?:\.\d{1,2})?/g) || []).map(Number);
    const min = after ? Number(after[1]) : figures.length ? Math.max(...figures) : null;
    return {min};
}

/** "NetOne airtime (USD)" → "NetOne"; and an example number on that network. */
function network(draft) {
    return (draft.billerName || '').split(' ')[0];
}

/** The pattern reads "^(\\+263|0)71\\d{7}$" for NetOne. */
function exampleNumber(draft) {
    return /71\\d/.test(draft.accountPattern || '') ? '0712345678' : '0771234567';
}

function plainName(draft) {
    return (draft.billerName || '').replace(/\s*\((USD|ZWG)\)$/, '');
}

/** NetOne USD is sold in fixed amounts; only the airtime ones, not bundles. */
function products(biller) {
    return (biller.products || []).filter(p => /airtime/i.test(p.name));
}

/** Data bundles: everything in the catalogue that isn't airtime. */
function bundleProducts(biller) {
    return (biller.products || []).filter(p => !/airtime/i.test(p.name));
}

/** Catalogue names arrive as "Facebook_Daily_USD_Bundle_180_MB"; the price says the currency (the app's productLabel). */
function bundleLabel(name) {
    return String(name || '').replace(/_/g, ' ').replace(/\b(USD|ZWG)\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

// The app's bundle groups, in order; a bundle goes in the first that matches.
const BUNDLE_GROUPS = [
    {title: 'Social', test: /whatsapp|facebook|instagram|tiktok/i},
    {title: 'A day or less', test: /hour|night|daily|1[_ ]?day|a[_ ]?day|2day/i},
    {title: 'A week', test: /weekly|7[_ ]?day/i},
    {title: 'A month', test: /monthly|30[_ ]?day/i},
    {title: 'Data', test: /bundle|mb|gb/i},
    {title: 'More', test: /./},
];
// A WhatsApp list shows 10 rows; one is kept for "More bundles".
const BUNDLES_PER_PAGE = 9;

function bundleGroup(name) {
    return BUNDLE_GROUPS.findIndex(g => g.test.test(name));
}

/** "MOCK CUSTOMER\n123 Mock Street" → first line, for one-line summaries. */
function holderName(draft) {
    return (draft.holder?.customerName || '').split('\n')[0].trim();
}

function summary(draft, quote) {
    const method = draft.method.label || `${purchaseHelper.railName(draft.method.type)}${draft.method.msisdn ? ` ${draft.method.msisdn}` : ''}`;
    const what = isPayment(draft)
        ? `to ${draft.billerName}${draft.link?.reference ? ` for ${payApi.shortReference(draft.link.reference)}` : ''}.`
        : draft.service === 'data'
            ? `${network(draft)} data: ${draft.productName} for ${draft.account}.`
            : isMeter(draft)
            ? `${plainName(draft)} for meter ${draft.account}${holderName(draft) ? ` (${holderName(draft)})` : ''}.`
            : `${plainName(draft)} for ${draft.account}.`;
    return [
        `${purchaseHelper.money(quote.amount, quote.currency)} ${what}`,
        `Fee ${purchaseHelper.money(quote.fee, quote.currency)}, total ${purchaseHelper.money(quote.total, quote.currency)}, paid with ${method}.`,
    ].join(' ');
}

module.exports = {
    STEPS,
    SERVICES,

    ownsStep: function (step) {
        return Object.values(STEPS).includes(step);
    },

    handlesPayload: function (payload) {
        return Boolean(SERVICE_BY_MENU[payload])
            || /^(VAS_|AIRTIME_|PAY_METHOD:|PAY_WALLET_NUMBER:|PAY_CARD:|PAY_ADD_CARD$|CARD_BRAND:)/.test(payload || '');
    },

    service: function (user) {
        return SERVICES[user.draft?.service] || SERVICES.airtime;
    },

    saveDraft: async function (user, patch, step) {
        const draft = {...(user.draft || {}), ...patch};
        await user.update({draft});
        if (step) await messagingHelper.setStep(user.phone.replace(/^\+/, ''), step);
        return draft;
    },

    cancel: async function (msg, user) {
        await user.update({draft: null});
        await messagingHelper.sendButtons(msg.sender, 'Cancelled. Nothing was paid.', [menuButton]);
        await messagingHelper.setStep(msg.sender, 'main_menu');
    },

    // ------------------------------------------------------------ provider

    start: async function (msg, user, serviceKey) {
        const key = SERVICES[serviceKey] ? serviceKey : (user.draft?.service || 'airtime');
        if (key === 'pay') return require('./payHelper').start(msg, user);
        const service = SERVICES[key];
        const billers = (await sessionHelper.withSession(user.phone, token => vasApi.billers(token))).filter(service.billers);
        if (!billers.length) {
            return messagingHelper.sendButtons(msg.sender, `${service.header} isn’t available right now. Please try again later.`, [menuButton]);
        }
        await user.update({draft: {service: key}});
        if (billers.length === 1) return this.chooseBiller(msg, user, billers[0].code);
        await messagingHelper.sendList(msg.sender, service.choose, service.chooseButton, [{
            title: service.header.replace(/^Buy |^Pay for /, '').replace(/^./, c => c.toUpperCase()),
            rows: billers.map(b => ({
                id: `VAS_BILLER:${b.code}`,
                title: b.name,
                description: b.products?.length ? 'Fixed amounts' : (b.minAmount ? `From ${b.currencies[0]} ${b.minAmount}` : undefined),
            })),
        }], service.header);
        await messagingHelper.setStep(msg.sender, STEPS.chooseBiller);
    },

    chooseBiller: async function (msg, user, code) {
        const billers = await sessionHelper.withSession(user.phone, token => vasApi.billers(token));
        const biller = billers.find(b => b.code === code);
        if (!biller) return this.start(msg, user);
        await this.saveDraft(user, {
            service: user.draft?.service || 'airtime',
            biller: biller.code,
            billerName: biller.name,
            accountLabel: biller.accountLabel,
            accountPattern: biller.accountPattern,
            lookup: biller.lookup === true,
            currencies: biller.currencies,
            minAmount: biller.minAmount || null,
            products: (user.draft?.service === 'data'
                ? bundleProducts(biller).map(p => ({code: p.code, amount: p.amount, name: bundleLabel(p.name), group: bundleGroup(p.name)}))
                : products(biller).map(p => ({code: p.code, amount: p.amount}))),
        }, STEPS.enterAccount);
        return this.askAccount(msg, user);
    },

    // ------------------------------------------------------------ number or meter

    askAccount: async function (msg, user) {
        const d = user.draft;
        if (isMeter(d)) {
            const digits = /\{(\d+)\}/.exec(d.accountPattern || '')?.[1];
            return messagingHelper.sendButtons(msg.sender,
                `Type the ${plainName(d)} ${String(d.accountLabel || 'meter number').toLowerCase()}${digits ? ` (${digits} digits)` : ''}.`,
                [cancelButton]);
        }
        const own = ownNumber(user);
        const pattern = d.accountPattern && new RegExp(d.accountPattern);
        const body = d.service === 'data'
            ? `Type the ${network(d)} number the bundle is for, e.g. ${exampleNumber(d)}.`
            : `Type the ${network(d)} number to top up, e.g. ${exampleNumber(d)}.`;
        if (own && (!pattern || pattern.test(own))) {
            return messagingHelper.sendButtons(msg.sender, body, [{id: 'VAS_OWN_NUMBER', title: 'My number'}, cancelButton]);
        }
        return messagingHelper.sendButtons(msg.sender, body, [cancelButton]);
    },

    saveAccount: async function (msg, user, raw) {
        const d = user.draft;
        const account = isMeter(d) ? String(raw || '').replace(/[\s-]/g, '') : localNumber(raw);
        const pattern = d.accountPattern && new RegExp(d.accountPattern);
        if (pattern && !pattern.test(account)) {
            return messagingHelper.sendMessage(msg.sender, isMeter(d)
                ? `That isn’t a valid ${String(d.accountLabel || 'meter number').toLowerCase()}. Check it and type it again.`
                : `That number isn’t on ${network(d)}. Type one like ${exampleNumber(d)}.`);
        }
        await this.saveDraft(user, {account, holder: null});
        if (d.lookup) return this.lookup(msg, user);
        return this.afterAccount(msg, user);
    },

    /** Meters: show whose meter it is before any money moves. */
    lookup: async function (msg, user) {
        const d = user.draft;
        let holder;
        try {
            holder = await sessionHelper.withSession(user.phone, token => vasApi.lookup(token, d.biller, d.account));
        } catch (e) {
            if (e instanceof sessionHelper.SessionEndedError) throw e;
            await messagingHelper.setStep(msg.sender, STEPS.enterAccount);
            return messagingHelper.sendButtons(msg.sender, `${e.message} Type the meter number again, or cancel.`, [cancelButton]);
        }
        await this.saveDraft(user, {holder}, STEPS.confirmAccount);
        const lines = [
            'Is this the right meter?',
            '',
            // Some billers put the address on the name's second line.
            `*${(holder.customerName || 'Unknown').trim().split('\n')[0].trim()}*`,
            ...(holder.customerName || '').trim().split('\n').slice(1).map(l => l.trim()).filter(Boolean),
            holder.address ? holder.address : null,
            `Meter ${d.account}`,
            holder.arrears && Number(holder.arrears) > 0 ? `Arrears: ${d.currencies[0]} ${holder.arrears}` : null,
        ].filter(l => l !== null);
        return messagingHelper.sendButtons(msg.sender, lines.join('\n'), [
            {id: 'VAS_ACCOUNT_OK', title: 'Yes, continue'},
            {id: 'VAS_ACCOUNT_CHANGE', title: 'Different meter'},
            cancelButton,
        ]);
    },

    afterAccount: async function (msg, user) {
        const d = user.draft;
        if (d.currencies.length > 1 && !d.currency) {
            await messagingHelper.setStep(msg.sender, STEPS.chooseCurrency);
            return messagingHelper.sendButtons(msg.sender, 'Which currency?',
                d.currencies.slice(0, 2).map(c => ({id: `VAS_CURRENCY:${c}`, title: c})).concat(cancelButton));
        }
        if (d.service === 'data') {
            await this.saveDraft(user, {currency: d.currency || d.currencies[0]}, STEPS.chooseBundle);
            return this.askBundleGroup(msg, user);
        }
        await this.saveDraft(user, {currency: d.currency || d.currencies[0]}, STEPS.enterAmount);
        return this.askAmount(msg, user);
    },

    chooseCurrency: async function (msg, user, currency) {
        if (!user.draft?.currencies?.includes(currency)) return this.start(msg, user);
        await this.saveDraft(user, {currency}, STEPS.enterAmount);
        return this.askAmount(msg, user);
    },

    // ------------------------------------------------------------ bundles

    askBundleGroup: async function (msg, user) {
        const bundles = user.draft.products || [];
        const rows = BUNDLE_GROUPS.map((g, i) => ({g, i, items: bundles.filter(b => b.group === i)}))
            .filter(x => x.items.length)
            .map(({g, i, items}) => {
                const cheapest = Math.min(...items.map(b => Number(b.amount)));
                return {id: `VAS_BUNDLE_GROUP:${i}:0`, title: g.title, description: `${items.length} bundles, from ${user.draft.currency} ${cheapest.toFixed(2)}`};
            });
        return messagingHelper.sendList(msg.sender, `What kind of ${network(user.draft)} bundle?`, 'Choose bundles', [{title: 'Bundles', rows}], 'Buy data');
    },

    askBundle: async function (msg, user, groupIndex, offset) {
        const group = BUNDLE_GROUPS[groupIndex];
        const items = (user.draft?.products || []).filter(b => b.group === groupIndex)
            .sort((a, b) => Number(a.amount) - Number(b.amount));
        if (!group || !items.length) return this.askBundleGroup(msg, user);
        const page = items.slice(offset, offset + BUNDLES_PER_PAGE);
        const rows = page.map(b => {
            // List titles stop at 24 characters: drop "Bundle", and keep the full name below when still too long.
            const title = b.name.replace(/\s*\bBundles?\b\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
            const price = `${user.draft.currency} ${Number(b.amount).toFixed(2)}`;
            return {id: `VAS_BUNDLE:${b.code}`, title, description: title.length > 24 ? `${price} · ${b.name}` : price};
        });
        if (offset + BUNDLES_PER_PAGE < items.length) {
            rows.push({id: `VAS_BUNDLE_GROUP:${groupIndex}:${offset + BUNDLES_PER_PAGE}`, title: 'More bundles', description: `${items.length - offset - BUNDLES_PER_PAGE} more`});
        }
        return messagingHelper.sendList(msg.sender, `${group.title}: tap a bundle.`, 'Choose bundle', [{title: group.title, rows}], 'Buy data');
    },

    chooseBundle: async function (msg, user, code) {
        const bundle = (user.draft?.products || []).find(b => b.code === code);
        if (!bundle) return this.askBundleGroup(msg, user);
        await this.saveDraft(user, {amount: Number(bundle.amount).toFixed(2), productCode: bundle.code, productName: bundle.name}, STEPS.chooseMethod);
        return this.askMethod(msg, user, `${bundle.name} for ${user.draft.account}: ${user.draft.currency} ${Number(bundle.amount).toFixed(2)}.\n\nHow would you like to pay?`);
    },

    // ------------------------------------------------------------ amount

    askAmount: async function (msg, user) {
        const d = user.draft;
        const noun = this.service(user).noun;
        if (d.products?.length) {
            const amounts = d.products.map(p => Number(p.amount)).filter(a => a >= 0.5);
            const shown = (amounts.length ? amounts : d.products.map(p => Number(p.amount))).slice(0, 12);
            return messagingHelper.sendButtons(msg.sender,
                `How much ${noun}? ${d.billerName} comes in fixed amounts:\n${shown.map(a => `${d.currency} ${a.toFixed(2)}`).join(', ')}\n\nType one of them, e.g. ${shown[0].toFixed(2)}.`,
                [cancelButton]);
        }
        return messagingHelper.sendButtons(msg.sender,
            `How much ${noun}, in ${d.currency}?${d.minAmount ? ` The minimum is ${d.currency} ${d.minAmount}.` : ''} Type the amount, e.g. ${isMeter(d) ? '10.00' : '1.00'}.`,
            [cancelButton]);
    },

    saveAmount: async function (msg, user, raw) {
        const d = user.draft;
        const text = String(raw || '').replace(/[^\d.]/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
            return messagingHelper.sendMessage(msg.sender, 'Type the amount as a number, e.g. 10.00.');
        }
        const amount = Number(text);
        let productCode = null;
        if (d.products?.length) {
            const product = d.products.find(p => Number(p.amount) === amount);
            if (!product) return messagingHelper.sendMessage(msg.sender, `${d.billerName} isn’t sold in that amount. Type one of the amounts listed above.`);
            productCode = product.code;
        } else if (d.minAmount && amount < Number(d.minAmount)) {
            return messagingHelper.sendMessage(msg.sender, `The minimum is ${d.currency} ${d.minAmount}.`);
        }
        await this.saveDraft(user, {amount: amount.toFixed(2), productCode}, STEPS.chooseMethod);
        return this.askMethod(msg, user);
    },

    // ------------------------------------------------------------ payment

    askMethod: async function (msg, user, intro = 'How would you like to pay?') {
        const usd = user.draft.currency === 'USD';
        const cards = (await cardHelper.usableCards(user)).slice(0, 4);
        const sections = [];
        if (cards.length) {
            sections.push({
                title: 'Your cards',
                rows: cards.map(c => ({id: `PAY_CARD:${c.id}`, title: cardsApi.label(c), description: c.isDefault ? 'Default card' : undefined})),
            });
        }
        sections.push({
            title: 'Other ways',
            rows: [
                {id: 'PAY_METHOD:ECOCASH', title: 'EcoCash', description: 'Approve a prompt on your phone'},
                ...(usd ? [{id: 'PAY_METHOD:INNBUCKS', title: 'InnBucks', description: 'Pay a code in the InnBucks app'}] : []),
                {id: 'PAY_METHOD:OMARI', title: 'O’mari', description: 'Enter the code O’mari texts you'},
                {id: 'PAY_METHOD:ZIMSWITCH', title: 'ZimSwitch', description: 'Any local bank card, on a secure page'},
                {id: 'PAY_ADD_CARD', title: 'Add a card', description: 'Visa or Mastercard, saved for next time'},
            ],
        });
        await messagingHelper.setStep(msg.sender, STEPS.chooseMethod);
        return messagingHelper.sendList(msg.sender, intro, 'Choose how to pay', sections);
    },

    /** A saved card from the list. */
    chooseCard: async function (msg, user, id) {
        const card = (await cardHelper.usableCards(user)).find(c => String(c.id) === String(id));
        if (!card) return this.askMethod(msg, user);
        await this.saveDraft(user, {method: {type: 'CARD', cardTokenId: card.id, label: cardsApi.label(card)}, awaitingCard: false});
        return this.quote(msg, user);
    },

    /** "Add a card": the bank's page; the purchase carries on once the card is saved. */
    addCard: async function (msg, user) {
        await this.saveDraft(user, {awaitingCard: true});
        return cardHelper.askBrand(msg);
    },

    /** Called by cardHelper when the card this draft was waiting for is saved. */
    useCard: async function (user, card) {
        const sender = user.phone.replace(/^\+/, '');
        if (!user.draft?.biller || !user.draft?.amount) {
            await user.update({draft: null});
            return messagingHelper.sendButtons(sender, 'You can now pay with it.', [menuButton]);
        }
        await this.saveDraft(user, {method: {type: 'CARD', cardTokenId: card.id, label: cardsApi.label(card)}, awaitingCard: false});
        return this.quote({sender}, user);
    },

    chooseMethod: async function (msg, user, type) {
        if (type === 'ZIMSWITCH') {
            await this.saveDraft(user, {method: {type, label: 'ZimSwitch (bank card)'}, awaitingCard: false});
            return this.quote(msg, user);
        }
        if (!WALLET_PATTERNS[type]) return this.askMethod(msg, user);
        const draft = await this.saveDraft(user, {method: {type}, awaitingCard: false}, STEPS.enterWalletNumber);
        const suggestions = [['airtime', 'data'].includes(draft.service) ? draft.account : null, ownNumber(user)]
            .filter((n, i, all) => n && WALLET_PATTERNS[type].test(n) && all.indexOf(n) === i);
        const body = `Type ${WALLET_NUMBER_HINT[type]}${suggestions.length ? ', or choose it below' : ''}.`;
        return messagingHelper.sendButtons(msg.sender, body,
            suggestions.slice(0, 2).map(n => ({id: `PAY_WALLET_NUMBER:${n}`, title: n})).concat(cancelButton));
    },

    saveWalletNumber: async function (msg, user, raw) {
        const type = user.draft?.method?.type;
        const msisdn = localNumber(raw);
        if (!type || !WALLET_PATTERNS[type]?.test(msisdn)) {
            return messagingHelper.sendMessage(msg.sender, `Type ${WALLET_NUMBER_HINT[type] || 'the wallet number'}, e.g. ${type === 'OMARI' ? '0712345678' : '0771234567'}.`);
        }
        await this.saveDraft(user, {method: {type, msisdn}});
        return this.quote(msg, user);
    },

    // ------------------------------------------------------------ quote and confirm

    requestBody: function (draft) {
        const paymentMethod = {type: draft.method.type, cardTokenId: draft.method.cardTokenId, msisdn: draft.method.msisdn};
        if (isPayment(draft)) {
            return {token: draft.link.token, amount: draft.amount, currency: draft.currency, paymentMethod};
        }
        return {
            biller: draft.biller,
            account: draft.account,
            productCode: draft.productCode || null,
            amount: draft.amount,
            currency: draft.currency,
            paymentMethod,
        };
    },

    quote: async function (msg, user) {
        const d = user.draft;
        let quote;
        try {
            const api = isPayment(d) ? payApi : vasApi;
            quote = await sessionHelper.withSession(user.phone, token => api.quote(token, this.requestBody(d)));
        } catch (e) {
            if (e instanceof sessionHelper.SessionEndedError) throw e;
            // Another way to pay would be quoted the same amount and refused again: ask for a new amount.
            const minimum = !d.products?.length && belowMinimum(e.message);
            if (minimum) {
                const minAmount = minimum.min ? minimum.min.toFixed(2) : d.minAmount || null;
                const step = isPayment(d) ? require('./payHelper').STEPS.enterAmount : STEPS.enterAmount;
                await this.saveDraft(user, {amount: null, quote: null, minAmount}, step);
                return messagingHelper.sendButtons(msg.sender,
                    `${String(e.message).replace(/[.\s]*$/, '.')} Type a new amount${minAmount ? ` of at least ${d.currency} ${minAmount}` : ''}.`,
                    [cancelButton]);
            }
            return messagingHelper.sendButtons(msg.sender, e.message, [{id: 'VAS_OTHER_METHOD', title: 'Pay another way'}, cancelButton]);
        }
        const draft = await this.saveDraft(user, {quote, idempotencyKey: crypto.randomUUID()}, STEPS.confirm);
        return messagingHelper.sendButtons(msg.sender, `*Check your ${isPayment(draft) ? 'payment' : 'purchase'}*\n${summary(draft, quote)}`, [
            {id: 'VAS_PAY', title: 'Pay'},
            cancelButton,
        ]);
    },

    /** "Pay": the PIN form, carrying this exact draft. */
    requestPin: async function (msg, user) {
        const d = user.draft;
        if (!d?.quote || !d.idempotencyKey) return this.start(msg, user);
        // A guest has no PIN: the payment itself is approved in the wallet or on the card.
        if (sessionHelper.isGuest(user)) return this.purchase(msg, user, d);
        if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
            return messagingHelper.sendMessage(msg.sender, confirmPinFlowHelper.lockedMessage(user.pin_locked_until));
        }
        await confirmPinFlowHelper.send(msg.sender, d, summary(d, d.quote));
        await messagingHelper.setStep(msg.sender, STEPS.pinSent);
    },

    /** After the PIN is confirmed: place the purchase the PIN approved. */
    purchase: async function (msg, user, approved) {
        const current = user.draft;
        if (!approved || !current || current.idempotencyKey !== approved.idempotencyKey) {
            return messagingHelper.sendButtons(msg.sender, 'That payment was changed or cancelled, so nothing was paid.', [menuButton]);
        }
        const service = SERVICES[approved.service] || SERVICES.airtime;
        let purchase;
        try {
            const body = {...this.requestBody(approved), quoteToken: approved.quote?.quoteToken};
            purchase = isPayment(approved)
                ? payApi.asPurchase(await sessionHelper.withSession(user.phone, token => payApi.pay(token, body, approved.idempotencyKey)))
                : await sessionHelper.withSession(user.phone, token => vasApi.purchase(token, body, approved.idempotencyKey));
        } catch (e) {
            if (e instanceof sessionHelper.SessionEndedError) throw e;
            await user.update({draft: null});
            await messagingHelper.setStep(msg.sender, 'main_menu');
            return messagingHelper.sendButtons(msg.sender, `${String(e.message).replace(/[.\s]*$/, '.')} ${isPayment(approved) ? 'Nothing was paid.' : 'Nothing was bought.'}`, [
                {id: service.menuId, title: 'Try again'},
                menuButton,
            ]);
        }
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'main_menu');
        const row = await purchaseHelper.record(user.phone, approved, purchase);
        await purchaseHelper.handleResponse(row, purchase);
    },

    // ------------------------------------------------------------ routing

    /** Typed text while buying. */
    manageInput: async function (msg, user) {
        const text = msg.content.text;
        switch (user.last_bot_message) {
            case STEPS.enterAccount:
                return this.saveAccount(msg, user, text);
            case STEPS.confirmAccount:
                // A new meter number typed instead of tapping a button.
                return this.saveAccount(msg, user, text);
            case STEPS.enterAmount:
                return this.saveAmount(msg, user, text);
            case STEPS.chooseBundle:
                return this.askBundleGroup(msg, user);
            case STEPS.enterWalletNumber:
                return this.saveWalletNumber(msg, user, text);
            case STEPS.confirm:
                return messagingHelper.sendButtons(msg.sender, 'Tap Pay to continue, or Cancel.', [{id: 'VAS_PAY', title: 'Pay'}, cancelButton]);
            case STEPS.pinSent:
                return messagingHelper.sendMessage(msg.sender, 'Enter your PIN in the secure form above to pay, or type “menu” to cancel.');
            default:
                return this.start(msg, user);
        }
    },

    /** Button and list replies while buying. AIRTIME_* are older ids for the same actions. */
    manageButtons: async function (msg, user) {
        const payload = msg.content.payload;
        if (SERVICE_BY_MENU[payload]) return this.start(msg, user, SERVICE_BY_MENU[payload]);
        const [rawAction, value] = payload.split(':');
        const action = rawAction.replace(/^AIRTIME_/, 'VAS_');
        switch (action) {
            case 'VAS_BILLER':
                return this.chooseBiller(msg, user, value);
            case 'VAS_OWN_NUMBER':
                return this.saveAccount(msg, user, ownNumber(user));
            case 'VAS_ACCOUNT_OK':
                if (!user.draft?.account) return this.start(msg, user);
                return this.afterAccount(msg, user);
            case 'VAS_ACCOUNT_CHANGE':
                if (!user.draft?.biller) return this.start(msg, user);
                await messagingHelper.setStep(msg.sender, STEPS.enterAccount);
                return this.askAccount(msg, user);
            case 'VAS_BUNDLE_GROUP': {
                const [, groupIndex, offset] = payload.split(':');
                return this.askBundle(msg, user, Number(groupIndex), Number(offset) || 0);
            }
            case 'VAS_BUNDLE':
                return this.chooseBundle(msg, user, value);
            case 'VAS_CURRENCY':
                return this.chooseCurrency(msg, user, value);
            case 'PAY_METHOD':
                return this.chooseMethod(msg, user, value);
            case 'PAY_WALLET_NUMBER':
                return this.saveWalletNumber(msg, user, value);
            case 'PAY_CARD':
                return this.chooseCard(msg, user, value);
            case 'PAY_ADD_CARD':
                return this.addCard(msg, user);
            case 'CARD_BRAND':
                return cardHelper.start(msg, user, value);
            case 'VAS_PAY':
                return this.requestPin(msg, user);
            case 'VAS_OTHER_METHOD':
                if (!user.draft?.amount) return this.start(msg, user);
                await this.saveDraft(user, {awaitingCard: false});
                return this.askMethod(msg, user);
            case 'VAS_CANCEL':
                return this.cancel(msg, user);
            default:
                return this.start(msg, user);
        }
    },
};
