const crypto = require('crypto');
const QRCode = require('qrcode');
const messagingHelper = require('./messagingHelper');
const mediaHelper = require('./mediaHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');

/**
 * Merchant menu → Payment links: links (and their QR codes) a customer opens to pay the business,
 * as the merchant portal and tese-backend create them on a payment profile. One-time links work
 * once; the others until their end date, so turning a link off moves its end date to yesterday
 * (deleting goes through S3, which is broken on dev).
 */

const STEPS = {
    amount: 'mplink_amount',
    name: 'mplink_name',
    confirm: 'mplink_confirm',
};

const TYPES = {
    ONCE_OFF_FIXED: {title: 'One-time payment', description: 'A fixed amount, paid once (e.g. an invoice)', summary: 'Can be paid once'},
    OPEN_FIXED_AMOUNT: {title: 'Fixed amount', description: 'The same amount, paid by anyone, many times', summary: 'Can be paid many times'},
    OPEN_DYNAMIC_AMOUNT: {title: 'Customer enters amount', description: 'Customers type what they pay (e.g. donations)', summary: 'Customer enters the amount'},
};

const VALIDITY = [{days: 7, title: '1 week'}, {days: 30, title: '1 month'}, {days: 90, title: '3 months'}];
// One-time links ignore their end date; give them one anyway.
const ONCE_OFF_DAYS = 365;
const RENEW_DAYS = 30;
// Marks a one-time link that was turned off (see setOn).
const ONCE_TAG = '-ONCE';
const DAY_MS = 24 * 3600 * 1000;
// Smatpay keeps link dates as Harare midnight.
const HARARE_OFFSET_MS = 2 * 3600 * 1000;

const cancelButton = {id: 'MPLINK_CANCEL', title: 'Cancel'};
const menuButton = {id: 'MAIN_MENU', title: 'Menu'};
const linksButton = {id: 'MERCHANT_PAYMENT_LINKS', title: 'Payment links'};

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

/** yyyy-MM-dd in Harare, `days` from today. */
function harareDate(days = 0) {
    return new Date(Date.now() + HARARE_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

function showDate(value) {
    return new Date(Date.parse(value) + HARARE_OFFSET_MS).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

function isOn(link) {
    if (link.paymentLinkType === 'ONCE_OFF_FIXED') return true;
    return Boolean(link.paymentLinkEndDate) && Date.parse(link.paymentLinkEndDate) > Date.now();
}

function amountText(link) {
    return link.paymentLinkType === 'OPEN_DYNAMIC_AMOUNT' || link.paymentLinkAmount == null
        ? `${link.paymentLinkCurrency}, any amount`
        : money(link.paymentLinkAmount, link.paymentLinkCurrency);
}

function linkUrl(link) {
    return link.paymentLinkShortUrl || link.paymentLinkUrl;
}

/** The business's payment profiles on this plane, each with its links. */
async function loadLinks(user) {
    const profiles = await merchantSession.withToken(user.phone, t => merchantApi.paymentProfiles(t, user.merchant_account_id));
    const links = [];
    for (const profile of profiles) {
        const {links: page} = await merchantSession.withToken(user.phone, t => merchantApi.paymentLinks(t, profile.id, {pageSize: 50}));
        for (const link of page) links.push({...link, profileNumber: profile.paymentProfileNumber, profileName: profile.paymentProfileName});
    }
    return {profiles, links: links.sort((a, b) => b.id - a.id)};
}

/** Only links on this business's own profiles (the backend doesn't check whose link it changes). */
async function findLink(user, id) {
    const {links} = await loadLinks(user);
    return links.find(l => String(l.id) === String(id)) || null;
}

module.exports = {
    STEPS,
    loadLinks,

    ownsStep: function (step) {
        return Object.values(STEPS).includes(step);
    },

    handlesPayload: function (payload) {
        return /^MPLINK_/.test(payload || '');
    },

    saveDraft: async function (user, patch, step) {
        await user.update({draft: {...(user.draft || {}), ...patch}});
        if (step) await messagingHelper.setStep(user.phone.replace(/^\+/, ''), step);
    },

    /** The business's links, newest first, with New link on top. */
    show: async function (msg, user) {
        let links;
        try {
            ({links} = await loadLinks(user));
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, `Your payment links couldn’t be loaded: ${e.message}`, [linksButton, menuButton]);
        }
        await messagingHelper.setStep(msg.sender, 'merchant_menu');
        if (!links.length) {
            return messagingHelper.sendButtons(msg.sender,
                'A payment link is a web page (and QR code) your customers open to pay you by card, EcoCash, InnBucks or ZimSwitch. You don’t have any yet.',
                [{id: 'MPLINK_NEW', title: 'New link'}, menuButton], 'Payment links');
        }
        const rows = links.slice(0, 9).map(l => ({
            id: `MPLINK_VIEW:${l.id}`,
            title: l.paymentProfileName || `Link ${l.id}`,
            description: `${amountText(l)} · ${isOn(l) ? (l.paymentLinkType === 'ONCE_OFF_FIXED' ? 'one-time' : `until ${showDate(l.paymentLinkEndDate)}`) : 'off'}`,
        }));
        const more = links.length > 9 ? ` Showing the latest 9 of ${links.length}.` : '';
        return messagingHelper.sendList(msg.sender, `Your payment links.${more} Choose one to share it or turn it off.`, 'Payment links', [
            {title: 'Create', rows: [{id: 'MPLINK_NEW', title: 'New link', description: 'Make a link and QR code to get paid'}]},
            {title: 'Your links', rows},
        ], 'Payment links');
    },

    start: async function (msg, user) {
        await user.update({draft: {service: 'merchant_link'}});
        const rows = Object.entries(TYPES).map(([id, t]) => ({id: `MPLINK_TYPE:${id}`, title: t.title, description: t.description}));
        return messagingHelper.sendList(msg.sender, 'What kind of payment link?', 'Choose', [{title: 'Link type', rows}], 'New payment link');
    },

    chooseType: async function (msg, user, type) {
        if (!TYPES[type]) return this.start(msg, user);
        await this.saveDraft(user, {service: 'merchant_link', type});
        return messagingHelper.sendButtons(msg.sender, 'Customers pay in which currency?', [
            {id: 'MPLINK_CURRENCY:USD', title: 'USD'},
            {id: 'MPLINK_CURRENCY:ZWG', title: 'ZWG'},
            cancelButton,
        ]);
    },

    chooseCurrency: async function (msg, user, currency) {
        if (!['USD', 'ZWG'].includes(currency) || !TYPES[user.draft?.type]) return this.start(msg, user);
        if (user.draft.type === 'OPEN_DYNAMIC_AMOUNT') {
            await this.saveDraft(user, {currency, amount: null}, STEPS.name);
            return this.askName(msg);
        }
        await this.saveDraft(user, {currency}, STEPS.amount);
        return messagingHelper.sendButtons(msg.sender, `How much, in ${currency}? Type the amount, e.g. 10.00.`, [cancelButton]);
    },

    saveAmount: async function (msg, user, raw) {
        const text = String(raw || '').replace(/[^\d.]/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
            return messagingHelper.sendMessage(msg.sender, 'Type the amount as a number, e.g. 10.00.');
        }
        await this.saveDraft(user, {amount: Number(text).toFixed(2)}, STEPS.name);
        return this.askName(msg);
    },

    askName: async function (msg) {
        return messagingHelper.sendButtons(msg.sender, 'What is the payment for? Customers see this, e.g. _Haircut_ or _Invoice 1024_.', [cancelButton]);
    },

    saveName: async function (msg, user, raw) {
        const name = String(raw || '').replace(/\s+/g, ' ').trim();
        if (name.length < 2 || name.length > 60) {
            return messagingHelper.sendMessage(msg.sender, 'Type a short description, 2 to 60 characters, e.g. Haircut.');
        }
        await this.saveDraft(user, {name});
        if (user.draft.type === 'ONCE_OFF_FIXED') {
            await this.saveDraft(user, {days: ONCE_OFF_DAYS});
            return this.chooseProfile(msg, user);
        }
        return messagingHelper.sendButtons(msg.sender, 'How long should the link work?',
            VALIDITY.map(v => ({id: `MPLINK_DAYS:${v.days}`, title: v.title})));
    },

    chooseDays: async function (msg, user, days) {
        if (!VALIDITY.some(v => v.days === Number(days)) || !user.draft?.name) return this.start(msg, user);
        await this.saveDraft(user, {days: Number(days)});
        return this.chooseProfile(msg, user);
    },

    /** Asks which payment profile only when the business has more than one here. */
    chooseProfile: async function (msg, user) {
        let profiles;
        try {
            profiles = (await merchantSession.withToken(user.phone, t => merchantApi.paymentProfiles(t, user.merchant_account_id)))
                .filter(p => p.paymentProfileNumber);
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, `Your payment profiles couldn’t be loaded: ${e.message}`, [linksButton, menuButton]);
        }
        if (!profiles.length) {
            await user.update({draft: null});
            return messagingHelper.sendButtons(msg.sender, 'Your business needs a payment profile before it can make payment links. Add one under Documents & bank.',
                [{id: 'MERCHANT_GO_LIVE', title: 'Documents & bank'}, menuButton]);
        }
        if (profiles.length === 1) return this.useProfile(msg, user, profiles[0].paymentProfileNumber, profiles);
        const rows = profiles.slice(0, 10).map(p => ({
            id: `MPLINK_PROFILE:${p.paymentProfileNumber}`,
            title: p.paymentProfileName || `Profile ${p.paymentProfileNumber}`,
            description: `#${p.paymentProfileNumber}${p.paymentProfileApproved === false ? ' · awaiting approval' : ''}`,
        }));
        return messagingHelper.sendList(msg.sender, 'Which payment profile should the money go to?', 'Choose profile', [{title: 'Payment profiles', rows}]);
    },

    useProfile: async function (msg, user, number, profiles = null) {
        if (!user.draft?.name) return this.start(msg, user);
        profiles = profiles || await merchantSession.withToken(user.phone, t => merchantApi.paymentProfiles(t, user.merchant_account_id));
        const profile = profiles.find(p => String(p.paymentProfileNumber) === String(number));
        if (!profile) return this.chooseProfile(msg, user);
        await this.saveDraft(user, {profileNumber: profile.paymentProfileNumber, profileName: profile.paymentProfileName}, STEPS.confirm);
        return this.confirm(msg, user, profiles.length > 1);
    },

    confirm: async function (msg, user, showProfile = false) {
        const d = user.draft;
        const lines = [
            '*New payment link*',
            `For: ${d.name}`,
            `Amount: ${d.type === 'OPEN_DYNAMIC_AMOUNT' ? `customer enters it (${d.currency})` : money(d.amount, d.currency)}`,
            TYPES[d.type].summary,
        ];
        if (d.type !== 'ONCE_OFF_FIXED') lines.push(`Works until: ${showDate(`${harareDate(d.days)}T00:00:00Z`)}`);
        if (showProfile) lines.push(`Profile: ${d.profileName || d.profileNumber}`);
        return messagingHelper.sendButtons(msg.sender, lines.join('\n'), [{id: 'MPLINK_CREATE', title: 'Create link'}, cancelButton]);
    },

    create: async function (msg, user) {
        const d = user.draft;
        if (!d?.profileNumber || !TYPES[d.type]) return this.start(msg, user);
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');

        let link;
        try {
            const currency = (await merchantApi.currencies()).find(c => c.currencyCode === d.currency);
            if (!currency) throw new Error(`${d.currency} isn’t available.`);
            link = await merchantSession.withToken(user.phone, token => merchantApi.createPaymentLink(token, {
                profileNumber: d.profileNumber,
                type: d.type,
                name: d.name,
                description: d.name,
                reference: `WA-LINK-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
                amount: d.amount,
                currency: d.currency,
                currencyId: currency.id,
                startDate: harareDate(0),
                endDate: harareDate(d.days),
            }));
        } catch (e) {
            console.log(`Payment link for ${user.merchant_id} failed: [${e.code}/${e.status}] ${e.reason || e.message}`);
            return messagingHelper.sendButtons(msg.sender, `The link couldn’t be created: ${String(e.message).replace(/[.!\s]*$/, '.')}`, [
                {id: 'MPLINK_NEW', title: 'Try again'}, menuButton,
            ]);
        }
        console.log(`Payment link ${link.id} created for ${user.merchant_id} (${d.type})`);
        return this.share(msg, user, link, 'Your payment link is ready. Forward the next message to customers, or let them scan the QR code.');
    },

    /** A forwardable message with the link, the QR, then what to do next. */
    share: async function (msg, user, link, intro = null) {
        const url = linkUrl(link);
        if (intro) await messagingHelper.sendMessage(msg.sender, intro);
        const what = link.paymentProfileName ? ` for ${link.paymentProfileName}` : '';
        const amount = link.paymentLinkType === 'OPEN_DYNAMIC_AMOUNT' || link.paymentLinkAmount == null
            ? '' : ` ${money(link.paymentLinkAmount, link.paymentLinkCurrency)}`;
        await messagingHelper.sendMessage(msg.sender, `Pay ${user.merchant_name || 'us'}${amount}${what} securely with Smatpay:\n${url}`);
        try {
            const png = await QRCode.toBuffer(url, {type: 'png', margin: 2, scale: 8});
            const mediaId = await mediaHelper.upload(png, 'image/png', `link-${link.id}.png`);
            await messagingHelper.sendImage(msg.sender, mediaId, `Scan to pay ${user.merchant_name || 'us'}${amount}${what}.`);
        } catch (e) {
            console.error('Sending the payment link QR failed:', e.response ? JSON.stringify(e.response.data) : e.message);
        }
        return messagingHelper.sendButtons(msg.sender, 'I’ll message you here whenever someone pays through this link. Payments also show under Earnings.', [
            linksButton, {id: 'MERCHANT_EARNINGS', title: 'Earnings'}, menuButton,
        ]);
    },

    view: async function (msg, user, id) {
        const link = await findLink(user, id).catch(() => null);
        if (!link) return messagingHelper.sendButtons(msg.sender, 'That payment link wasn’t found.', [linksButton, menuButton]);
        const on = isOn(link);
        const lines = [
            `*${link.paymentProfileName || `Link ${link.id}`}*`,
            `Amount: ${amountText(link)}`,
            on ? TYPES[link.paymentLinkType]?.summary || link.paymentLinkType : 'Off: customers can’t pay with it',
        ];
        if (on && link.paymentLinkType !== 'ONCE_OFF_FIXED' && link.paymentLinkEndDate) lines.push(`Works until: ${showDate(link.paymentLinkEndDate)}`);
        lines.push(`Profile: ${link.profileName || link.profileNumber}`, linkUrl(link));
        return messagingHelper.sendButtons(msg.sender, lines.join('\n'), [
            {id: `MPLINK_SHARE:${link.id}`, title: 'Share'},
            on ? {id: `MPLINK_OFF:${link.id}`, title: 'Turn off'}
                : {id: `MPLINK_ON:${link.id}`, title: (link.paymentLinkReference || '').endsWith(ONCE_TAG) ? 'Turn on' : `Turn on (${RENEW_DAYS} days)`},
            linksButton,
        ]);
    },

    shareById: async function (msg, user, id) {
        const link = await findLink(user, id).catch(() => null);
        if (!link) return messagingHelper.sendButtons(msg.sender, 'That payment link wasn’t found.', [linksButton, menuButton]);
        return this.share(msg, user, link);
    },

    askTurnOff: async function (msg, user, id) {
        return messagingHelper.sendButtons(msg.sender, 'Turn this link off? Customers who open it won’t be able to pay. You can turn it on again later.', [
            {id: `MPLINK_OFF_OK:${id}`, title: 'Turn off'}, {id: `MPLINK_VIEW:${id}`, title: 'Keep it'},
        ]);
    },

    /**
     * Off: end date yesterday. One-time links ignore end dates, so they become fixed-amount links that
     * have ended, tagged in their reference so turning them on makes them one-time again.
     */
    setOn: async function (msg, user, id, on) {
        const link = await findLink(user, id).catch(() => null);
        if (!link) return messagingHelper.sendButtons(msg.sender, 'That payment link wasn’t found.', [linksButton, menuButton]);
        const reference = link.paymentLinkReference || '';
        let type = link.paymentLinkType;
        let newReference = reference;
        if (!on && type === 'ONCE_OFF_FIXED') {
            type = 'OPEN_FIXED_AMOUNT';
            newReference = `${reference}${ONCE_TAG}`;
        } else if (on && reference.endsWith(ONCE_TAG)) {
            type = 'ONCE_OFF_FIXED';
            newReference = reference.slice(0, -ONCE_TAG.length);
        }
        try {
            await merchantSession.withToken(user.phone, t => merchantApi.updatePaymentLink(t, link, {type, reference: newReference, endDate: harareDate(on ? RENEW_DAYS : -1)}));
        } catch (e) {
            console.log(`Turning payment link ${link.id} ${on ? 'on' : 'off'} failed: [${e.code}/${e.status}] ${e.reason || e.message}`);
            return messagingHelper.sendButtons(msg.sender, `The link couldn’t be changed: ${String(e.message).replace(/[.!\s]*$/, '.')}`, [linksButton, menuButton]);
        }
        const until = type === 'ONCE_OFF_FIXED' ? 'until it’s paid' : `until ${showDate(`${harareDate(RENEW_DAYS)}T00:00:00Z`)}`;
        const text = on
            ? `*${link.paymentProfileName}* is on again, ${until}. The link and QR code are the same as before.`
            : `*${link.paymentProfileName}* is off. Customers can’t pay with it any more.`;
        return messagingHelper.sendButtons(msg.sender, text, [linksButton, menuButton]);
    },

    cancel: async function (msg, user) {
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');
        return messagingHelper.sendButtons(msg.sender, 'Cancelled. No link was created.', [linksButton, menuButton]);
    },

    manageInput: async function (msg, user) {
        if (user.last_bot_message === STEPS.amount) return this.saveAmount(msg, user, msg.content.text);
        if (user.last_bot_message === STEPS.name) return this.saveName(msg, user, msg.content.text);
        if (user.last_bot_message === STEPS.confirm) {
            return messagingHelper.sendButtons(msg.sender, 'Tap Create link, or Cancel.', [{id: 'MPLINK_CREATE', title: 'Create link'}, cancelButton]);
        }
        return this.show(msg, user);
    },

    manageButtons: async function (msg, user) {
        const [action, value] = msg.content.payload.split(':');
        switch (action) {
            case 'MPLINK_NEW': return this.start(msg, user);
            case 'MPLINK_TYPE': return this.chooseType(msg, user, value);
            case 'MPLINK_CURRENCY': return this.chooseCurrency(msg, user, value);
            case 'MPLINK_DAYS': return this.chooseDays(msg, user, value);
            case 'MPLINK_PROFILE': return this.useProfile(msg, user, value);
            case 'MPLINK_CREATE': return this.create(msg, user);
            case 'MPLINK_CANCEL': return this.cancel(msg, user);
            case 'MPLINK_VIEW': return this.view(msg, user, value);
            case 'MPLINK_SHARE': return this.shareById(msg, user, value);
            case 'MPLINK_OFF': return this.askTurnOff(msg, user, value);
            case 'MPLINK_OFF_OK': return this.setOn(msg, user, value, false);
            case 'MPLINK_ON': return this.setOn(msg, user, value, true);
            default: return this.show(msg, user);
        }
    },
};
