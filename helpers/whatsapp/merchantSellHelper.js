const crypto = require('crypto');
const messagingHelper = require('./messagingHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');

/**
 * Merchant menu → Sell: ZESA, water or airtime for a customer, paid from the merchant's prepaid
 * wallet — what the POS does at the counter. Smatpay checks the balance and calls the biller in
 * one request, so the result (and token) comes straight back. A sale whose answer is lost is never
 * retried automatically: the biller may already have sold it.
 */

const STEPS = {
    account: 'msell_account',
    amount: 'msell_amount',
    confirm: 'msell_confirm',
};

const PRODUCTS = {
    electricity: {label: 'ZESA electricity', account: 'meter number', pattern: /^\d{11}$/, hint: 'the 11-digit ZESA meter number', min: 1},
    water: {label: 'Water', account: 'meter number', pattern: /^\d{6,14}$/, hint: 'the council water meter number', min: 1},
    airtime: {label: 'Airtime', account: 'mobile number', min: 0.5},
};
const NETWORKS = {
    ECONET: {label: 'Econet', pattern: /^07[78]\d{7}$/, example: '0771234567'},
    NETONE: {label: 'NetOne', pattern: /^071\d{7}$/, example: '0712345678'},
};

const cancelButton = {id: 'MSELL_CANCEL', title: 'Cancel'};
const menuButton = {id: 'MAIN_MENU', title: 'Menu'};

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

function localNumber(text) {
    const digits = String(text || '').replace(/[^\d+]/g, '');
    if (digits.startsWith('+263')) return `0${digits.slice(4)}`;
    if (digits.startsWith('263')) return `0${digits.slice(3)}`;
    return digits;
}

/** Biller results nest differently per product; collect every token-looking string. */
function findTokens(value, found = []) {
    if (!value || typeof value !== 'object') return found;
    for (const [key, v] of Object.entries(value)) {
        if (typeof v === 'string' && /^(token\d*|tokens?)$/i.test(key) && /\d{4}/.test(v)) found.push(v.trim());
        else if (Array.isArray(v) && /^tokens$/i.test(key)) v.filter(t => typeof t === 'string').forEach(t => found.push(t.trim()));
        else if (v && typeof v === 'object') findTokens(v, found);
    }
    return [...new Set(found)];
}

function findField(value, names) {
    if (!value || typeof value !== 'object') return null;
    for (const [key, v] of Object.entries(value)) {
        if (names.includes(key.toLowerCase()) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
        if (v && typeof v === 'object') {
            const inner = findField(v, names);
            if (inner) return inner;
        }
    }
    return null;
}

/** 20-digit tokens are typed into the meter in groups of four. */
function groupToken(token) {
    const digits = token.replace(/\s/g, '');
    return /^\d{16,}$/.test(digits) ? digits.replace(/(\d{4})(?=\d)/g, '$1 ') : token;
}

async function walletBalance(user, currency) {
    try {
        const dashboard = await merchantSession.withToken(user.phone, token => merchantApi.walletDashboard(token, user.merchant_id, new Date().getFullYear()));
        const row = (dashboard?.walletBalance || []).find(b => b.currency === currency);
        return row ? Number(row.amount) : null;
    } catch {
        return null;
    }
}

module.exports = {
    STEPS,

    ownsStep: function (step) {
        return Object.values(STEPS).includes(step);
    },

    handlesPayload: function (payload) {
        return /^MSELL_/.test(payload || '');
    },

    saveDraft: async function (user, patch, step) {
        await user.update({draft: {...(user.draft || {}), ...patch}});
        if (step) await messagingHelper.setStep(user.phone.replace(/^\+/, ''), step);
    },

    start: async function (msg, user) {
        // Smatpay's biller only sells for approved businesses, sandbox included.
        let approved = null;
        try {
            approved = (await merchantApi.keyProfile(merchantSession.keys(user)))?.accountApproved === true;
            if (approved !== user.merchant_approved) await user.update({merchant_approved: approved});
        } catch (e) {
            console.error('Approval check failed:', e.message);
        }
        if (approved === false) {
            return messagingHelper.sendButtons(msg.sender,
                'Selling ZESA, water and airtime needs your business to be approved by Smatpay first, even for testing. Your wallet and top-ups work in the meantime.',
                [{id: 'MERCHANT_GO_LIVE', title: 'Get approved'}, {id: 'MAIN_MENU', title: 'Menu'}]);
        }
        await user.update({draft: {service: 'merchant_sell'}});
        await messagingHelper.sendButtons(msg.sender, 'What are you selling? It’s paid from your wallet.', [
            {id: 'MSELL_KIND:electricity', title: 'ZESA electricity'},
            {id: 'MSELL_KIND:water', title: 'Water'},
            {id: 'MSELL_KIND:airtime', title: 'Airtime'},
        ], 'Sell from your wallet');
    },

    chooseKind: async function (msg, user, kind) {
        if (!PRODUCTS[kind]) return this.start(msg, user);
        if (kind === 'airtime') {
            await this.saveDraft(user, {service: 'merchant_sell', kind, currency: 'USD'});
            return messagingHelper.sendButtons(msg.sender, 'Which network?', [
                {id: 'MSELL_NETWORK:ECONET', title: 'Econet'},
                {id: 'MSELL_NETWORK:NETONE', title: 'NetOne'},
                cancelButton,
            ]);
        }
        await this.saveDraft(user, {service: 'merchant_sell', kind, currency: 'USD'}, STEPS.account);
        return messagingHelper.sendButtons(msg.sender, `Type ${PRODUCTS[kind].hint}.`, [cancelButton]);
    },

    chooseNetwork: async function (msg, user, network) {
        if (!NETWORKS[network] || user.draft?.kind !== 'airtime') return this.start(msg, user);
        await this.saveDraft(user, {network}, STEPS.account);
        return messagingHelper.sendButtons(msg.sender, `Type the customer’s ${NETWORKS[network].label} number, e.g. ${NETWORKS[network].example}.`, [cancelButton]);
    },

    saveAccount: async function (msg, user, raw) {
        const d = user.draft;
        const product = PRODUCTS[d?.kind];
        if (!product) return this.start(msg, user);
        let account;
        if (d.kind === 'airtime') {
            account = localNumber(raw);
            const network = NETWORKS[d.network];
            if (!network.pattern.test(account)) return messagingHelper.sendMessage(msg.sender, `That number isn’t on ${network.label}. Type one like ${network.example}.`);
        } else {
            account = String(raw || '').replace(/[\s-]/g, '');
            if (!product.pattern.test(account)) return messagingHelper.sendMessage(msg.sender, `That isn’t a valid ${product.account}. Type ${product.hint}.`);
        }
        await this.saveDraft(user, {account}, STEPS.amount);
        return messagingHelper.sendButtons(msg.sender, `How much, in ${d.currency}? The minimum is ${money(product.min, d.currency)}.`, [cancelButton]);
    },

    saveAmount: async function (msg, user, raw) {
        const d = user.draft;
        const product = PRODUCTS[d?.kind];
        const text = String(raw || '').replace(/[^\d.]/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(text)) return messagingHelper.sendMessage(msg.sender, 'Type the amount as a number, e.g. 5.00.');
        if (Number(text) < product.min) return messagingHelper.sendMessage(msg.sender, `The minimum is ${money(product.min, d.currency)}.`);
        // One reference per attempt, made before submitting.
        await this.saveDraft(user, {amount: Number(text).toFixed(2), reference: `WA-SALE-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}, STEPS.confirm);
        const balance = await walletBalance(user, d.currency);
        const what = d.kind === 'airtime' ? `${NETWORKS[d.network].label} airtime for ${d.account}` : `${product.label} for meter ${d.account}`;
        const lines = [`*Sell ${what}*`, `Amount: ${money(text, d.currency)}, paid from your wallet.`];
        if (balance !== null) lines.push(`Wallet balance: ${money(balance, d.currency)}`);
        if (d.kind !== 'airtime') lines.push('Check the meter number with the customer: the token can’t be undone.');
        if (balance !== null && balance < Number(text)) {
            await user.update({draft: null});
            return messagingHelper.sendButtons(msg.sender, `${lines.join('\n')}\n\nYour wallet doesn’t have enough for this. Top it up first.`, [
                {id: 'MERCHANT_TOPUP', title: 'Top up wallet'}, menuButton,
            ]);
        }
        return messagingHelper.sendButtons(msg.sender, lines.join('\n'), [{id: 'MSELL_CONFIRM', title: 'Sell'}, cancelButton]);
    },

    submit: async function (msg, user) {
        const d = user.draft;
        if (!d?.reference || !d.amount) return this.start(msg, user);
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');

        let result;
        try {
            // A 401 is refused before anything is sold, so withToken's one retry is safe; a lost
            // answer (timeout/network) is never retried — see below.
            result = await merchantSession.withToken(user.phone, token => merchantApi.sell(token, merchantSession.keys(user), d.kind, {
                account: d.account, amount: d.amount, currency: d.currency, reference: d.reference, network: d.network,
            }));
        } catch (e) {
            console.log(`Wallet sale ${d.reference} (${d.kind} ${d.currency} ${d.amount}) failed: [${e.code}/${e.status}] ${e.message}`);
            if (e.code === 'timeout' || e.code === 'network' || e.code === 'server') {
                // Unknown outcome: the biller may have sold it. Don't retry; check first.
                return messagingHelper.sendButtons(msg.sender,
                    `We didn’t get an answer from Smatpay, so we don’t know if this went through. Don’t sell it again yet: check your wallet’s latest sales for reference ${d.reference}.`,
                    [{id: 'MERCHANT_WALLET', title: 'Check wallet'}, menuButton]);
            }
            return messagingHelper.sendButtons(msg.sender, `The sale didn’t go through: ${String(e.message).replace(/[.!\s]*$/, '.')}`, [
                {id: 'MERCHANT_SELL', title: 'Try again'}, menuButton,
            ]);
        }
        if (!result) {
            return messagingHelper.sendButtons(msg.sender, 'Selling from your wallet isn’t available on WhatsApp in production yet.', [menuButton]);
        }

        // Outcome only: tokens are never logged.
        console.log(`Wallet sale ${d.reference} (${d.kind} ${d.currency} ${d.amount}) succeeded: ${result.message || result.status}; ${findTokens(result.data).length} token(s); data keys: ${Object.keys(result.data || {}).join(',')}`);
        const total = money(d.amount, d.currency);
        let lines;
        if (d.kind === 'airtime') {
            lines = [`*${NETWORKS[d.network].label} airtime sold*`, `${total} to ${d.account}`];
        } else {
            const tokens = findTokens(result.data);
            const units = findField(result.data, ['units', 'unit']);
            lines = [
                `*${PRODUCTS[d.kind].label} token${tokens.length > 1 ? 's' : ''}*`,
                ...(tokens.length
                    ? tokens.map((t, i) => tokens.length > 1 ? `${i + 1}. *${groupToken(t)}*` : `*${groupToken(t)}*`)
                    : ['Smatpay confirmed the sale but didn’t return a token. Check your wallet’s latest sales.']),
                tokens.length > 1 ? 'Enter them into the meter in this order.' : null,
                `Meter ${d.account}`,
                units ? `Units: ${units}${/^\d+(\.\d+)?$/.test(units) ? ' kWh' : ''}` : null,
                `Amount: ${total}`,
            ];
        }
        lines.push(`Reference: ${d.reference}`);
        await messagingHelper.sendMessage(msg.sender, lines.filter(Boolean).join('\n'));
        return messagingHelper.sendButtons(msg.sender, 'Paid from your wallet. You can forward the message above to your customer.', [
            {id: 'MERCHANT_SELL', title: 'Sell again'}, menuButton,
        ]);
    },

    cancel: async function (msg, user) {
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');
        return messagingHelper.sendButtons(msg.sender, 'Cancelled. Nothing was sold.', [menuButton]);
    },

    manageInput: async function (msg, user) {
        const text = msg.content.text;
        if (user.last_bot_message === STEPS.account) return this.saveAccount(msg, user, text);
        if (user.last_bot_message === STEPS.amount) return this.saveAmount(msg, user, text);
        if (user.last_bot_message === STEPS.confirm) {
            return messagingHelper.sendButtons(msg.sender, 'Tap Sell to continue, or Cancel.', [{id: 'MSELL_CONFIRM', title: 'Sell'}, cancelButton]);
        }
        return this.start(msg, user);
    },

    manageButtons: async function (msg, user) {
        const [action, value] = msg.content.payload.split(':');
        switch (action) {
            case 'MSELL_KIND': return this.chooseKind(msg, user, value);
            case 'MSELL_NETWORK': return this.chooseNetwork(msg, user, value);
            case 'MSELL_CONFIRM': {
                // Spending wallet money needs the business PIN (unless the business turned it off).
                const d = user.draft;
                if (!d?.reference) return this.start(msg, user);
                const what = d.kind === 'airtime' ? `${NETWORKS[d.network].label} airtime for ${d.account}` : `${PRODUCTS[d.kind].label} for meter ${d.account}`;
                return require('./merchantHelper').requirePin(msg, user, d, `Sell ${what}: ${money(d.amount, d.currency)} from your wallet.`);
            }
            case 'MSELL_CANCEL': return this.cancel(msg, user);
            default: return this.start(msg, user);
        }
    },
};
