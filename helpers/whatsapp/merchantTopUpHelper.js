const crypto = require('crypto');
const {Op} = require('sequelize');
const models = require('../../models');
const purchaseModel = models.purchase;
const messagingHelper = require('./messagingHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const lockHelper = require('../lockHelper');

/**
 * Merchant Wallet → Top up wallet, as the POS top-up: currency → amount → how to pay (and the
 * number for EcoCash/O'mari) → confirm → the provider step → tracked until Paid. Only a tracker
 * "Paid" counts as added; the wallet balance itself is never taken as proof.
 */

const STEPS = {
    amount: 'mtopup_amount',
    number: 'mtopup_number',
    confirm: 'mtopup_confirm',
};

const METHODS = {
    ECOCASH: {walletName: 'Ecocash', label: 'EcoCash', number: /^07[78]\d{7}$/, hint: 'the Econet number registered for EcoCash'},
    OMARI: {walletName: 'Omari', label: 'O’mari', number: /^071\d{7}$/, hint: 'the NetOne number registered for O’mari'},
    INNBUCKS: {walletName: 'Innbucks', label: 'InnBucks', usdOnly: true},
    ZIMSWITCH: {walletName: 'ZimSwitch', label: 'ZimSwitch', description: 'Any local bank card, on a secure page'},
    VISA: {walletName: 'Visa', label: 'Visa', description: 'Card, on your bank’s secure page'},
    MASTERCARD: {walletName: 'Mastercard', label: 'Mastercard', description: 'Card, on your bank’s secure page'},
};

const FOLLOW_FOR_MS = 30 * 60 * 1000;
const cancelButton = {id: 'MTOPUP_CANCEL', title: 'Cancel'};
const menuButton = {id: 'MAIN_MENU', title: 'Menu'};

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

/** 0771234567 / +263 77 123 4567 / 263771234567 → 0771234567. */
function localNumber(text) {
    const digits = String(text || '').replace(/[^\d+]/g, '');
    if (digits.startsWith('+263')) return `0${digits.slice(4)}`;
    if (digits.startsWith('263')) return `0${digits.slice(3)}`;
    return digits;
}

module.exports = {
    STEPS,

    ownsStep: function (step) {
        return Object.values(STEPS).includes(step);
    },

    handlesPayload: function (payload) {
        return /^MTOPUP_/.test(payload || '');
    },

    saveDraft: async function (user, patch, step) {
        await user.update({draft: {...(user.draft || {}), ...patch}});
        if (step) await messagingHelper.setStep(user.phone.replace(/^\+/, ''), step);
    },

    start: async function (msg, user) {
        await user.update({draft: {service: 'merchant_topup'}});
        await messagingHelper.sendButtons(msg.sender, 'Top up your wallet in which currency?', [
            {id: 'MTOPUP_CURRENCY:USD', title: 'USD'},
            {id: 'MTOPUP_CURRENCY:ZWG', title: 'ZWG'},
            cancelButton,
        ], 'Top up wallet');
    },

    chooseCurrency: async function (msg, user, currency) {
        if (!['USD', 'ZWG'].includes(currency)) return this.start(msg, user);
        await this.saveDraft(user, {service: 'merchant_topup', currency}, STEPS.amount);
        return messagingHelper.sendButtons(msg.sender, `How much, in ${currency}? Type the amount, e.g. 20.00.`, [cancelButton]);
    },

    saveAmount: async function (msg, user, raw) {
        const text = String(raw || '').replace(/[^\d.]/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
            return messagingHelper.sendMessage(msg.sender, 'Type the amount as a number, e.g. 20.00.');
        }
        await this.saveDraft(user, {amount: Number(text).toFixed(2)});
        return this.askMethod(msg, user);
    },

    askMethod: async function (msg, user) {
        const usd = user.draft.currency === 'USD';
        const rows = Object.entries(METHODS)
            .filter(([, m]) => usd || !m.usdOnly)
            .map(([key, m]) => ({id: `MTOPUP_METHOD:${key}`, title: m.label, description: m.description || (m.number ? 'Approve a prompt on your phone' : 'Pay a code in the InnBucks app')}));
        return messagingHelper.sendList(msg.sender, `Top up ${money(user.draft.amount, user.draft.currency)}. How would you like to pay?`, 'Choose how to pay', [{title: 'Pay with', rows}]);
    },

    chooseMethod: async function (msg, user, key) {
        const method = METHODS[key];
        if (!method || !user.draft?.amount) return this.start(msg, user);
        if (method.usdOnly && user.draft.currency !== 'USD') return this.askMethod(msg, user);
        if (method.number) {
            await this.saveDraft(user, {method: key, msisdn: null}, STEPS.number);
            const own = user.phone.startsWith('+263') ? localNumber(user.phone) : null;
            const suggestion = own && method.number.test(own) ? [{id: `MTOPUP_NUMBER:${own}`, title: own}] : [];
            return messagingHelper.sendButtons(msg.sender, `Type ${method.hint}${suggestion.length ? ', or choose it below' : ''}.`, [...suggestion, cancelButton]);
        }
        await this.saveDraft(user, {method: key, msisdn: null});
        return this.confirm(msg, user);
    },

    saveNumber: async function (msg, user, raw) {
        const method = METHODS[user.draft?.method];
        const msisdn = localNumber(raw);
        if (!method?.number || !method.number.test(msisdn)) {
            return messagingHelper.sendMessage(msg.sender, `Type ${method?.hint || 'the wallet number'}, e.g. ${user.draft?.method === 'OMARI' ? '0712345678' : '0771234567'}.`);
        }
        await this.saveDraft(user, {msisdn});
        return this.confirm(msg, user);
    },

    confirm: async function (msg, user) {
        const d = user.draft;
        const method = METHODS[d.method];
        // A reference per attempt, made before submitting: a retry must never charge twice.
        await this.saveDraft(user, {reference: `WA-TOPUP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}, STEPS.confirm);
        return messagingHelper.sendButtons(msg.sender,
            `*Top up your wallet*\n${money(d.amount, d.currency)} with ${method.label}${d.msisdn ? ` ${d.msisdn}` : ''}.`,
            [{id: 'MTOPUP_CONFIRM', title: 'Top up'}, cancelButton]);
    },

    submit: async function (msg, user) {
        const d = user.draft;
        const method = METHODS[d?.method];
        if (!d?.reference || !method) return this.start(msg, user);
        const keys = merchantSession.keys(user);
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');

        let init;
        try {
            init = await merchantApi.walletTopUp({
                merchantId: keys?.merchantId,
                merchantKey: keys?.sandbox?.key,
                merchantApiKey: keys?.sandbox?.apiKey,
                accountId: user.merchant_account_id,
                walletName: method.walletName,
                amount: d.amount,
                currency: d.currency,
                payerName: user.merchant_name || 'Merchant',
                payerReference: d.reference,
                payerMobile: d.msisdn ? `+263${d.msisdn.slice(1)}` : null,
            });
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, `${String(e.message).replace(/[.\s]*$/, '.')} Nothing was charged.`, [
                {id: 'MERCHANT_TOPUP', title: 'Try again'}, menuButton,
            ]);
        }
        if (!init) {
            return messagingHelper.sendButtons(msg.sender, 'Wallet top-ups for merchants aren’t available on WhatsApp in production yet.', [menuButton]);
        }

        // Track by the returned payment reference, as the POS does.
        const reference = init.paymentReference || init.reference || d.reference;
        await purchaseModel.create({
            phone: user.phone, kind: 'topup', purchase_id: reference,
            biller: 'WALLET_TOPUP', biller_name: 'Wallet top-up', account: user.merchant_id,
            amount: d.amount, total: d.amount, currency: d.currency,
            payment_method: method.label, payment_msisdn: d.msisdn,
            status: 'PENDING_PAYMENT', notified_status: 'PENDING_PAYMENT',
        });

        const total = money(d.amount, d.currency);
        const url = init.paymentRedirectUrl
            || (d.method === 'VISA' ? init.paymentVisaSkinnedUrl : null)
            || (d.method === 'MASTERCARD' ? init.paymentMasterCardSkinnedUrl : null);
        if (d.method === 'INNBUCKS' && init.paymentCode) {
            return messagingHelper.sendMessage(msg.sender, `Open InnBucks and pay with this code:\n\n*${init.paymentCode}*\n\nAmount: ${total}. I’ll tell you once it’s in your wallet.`);
        }
        if (url && /^https:\/\//i.test(url)) {
            return messagingHelper.sendLinkButton(msg.sender, {url, cta: 'Pay now', body: `Pay ${total} on the secure ${method.label} page. I’ll tell you once it’s in your wallet.`});
        }
        return messagingHelper.sendMessage(msg.sender, `Approve the ${method.label} request on ${d.msisdn} to pay ${total}. I’ll tell you once it’s in your wallet.`);
    },

    cancel: async function (msg, user) {
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');
        return messagingHelper.sendButtons(msg.sender, 'Top-up cancelled. Nothing was charged.', [menuButton]);
    },

    manageInput: async function (msg, user) {
        if (user.last_bot_message === STEPS.amount) return this.saveAmount(msg, user, msg.content.text);
        if (user.last_bot_message === STEPS.number) return this.saveNumber(msg, user, msg.content.text);
        if (user.last_bot_message === STEPS.confirm) {
            return messagingHelper.sendButtons(msg.sender, 'Tap Top up to continue, or Cancel.', [{id: 'MTOPUP_CONFIRM', title: 'Top up'}, cancelButton]);
        }
        return this.start(msg, user);
    },

    manageButtons: async function (msg, user) {
        const [action, value] = msg.content.payload.split(':');
        switch (action) {
            case 'MTOPUP_CURRENCY': return this.chooseCurrency(msg, user, value);
            case 'MTOPUP_METHOD': return this.chooseMethod(msg, user, value);
            case 'MTOPUP_NUMBER': return this.saveNumber(msg, user, value);
            case 'MTOPUP_CONFIRM': return this.submit(msg, user);
            case 'MTOPUP_CANCEL': return this.cancel(msg, user);
            default: return this.start(msg, user);
        }
    },

    /** Follows pending top-ups; run with the purchase poller. Only "Paid" means it's in the wallet. */
    poll: async function () {
        const rows = await purchaseModel.findAll({
            where: {kind: 'topup', status: 'PENDING_PAYMENT', created_at: {[Op.gt]: new Date(Date.now() - FOLLOW_FOR_MS)}},
            limit: 25,
        });
        for (const row of rows) {
            const sender = row.phone.replace(/^\+/, '');
            await lockHelper.withLock(`msg:${sender}`, async () => {
                let info;
                try {
                    info = await merchantApi.trackPayment(row.purchase_id);
                } catch (e) {
                    return console.error(`Tracking top-up ${row.purchase_id} failed:`, e.message);
                }
                const status = String(info?.status || 'Pending').toLowerCase();
                const total = money(row.amount, row.currency);
                if (status === 'paid' || status === 'success') {
                    await row.update({status: 'COMPLETED', notified_status: 'COMPLETED'});
                    return messagingHelper.sendButtons(sender,
                        `*Wallet topped up*\n${total} with ${row.payment_method}${row.payment_msisdn ? ` (${row.payment_msisdn})` : ''}\nReference: ${row.purchase_id}`,
                        [{id: 'MERCHANT_WALLET', title: 'View wallet'}, menuButton]);
                }
                if (status === 'refunded') {
                    await row.update({status: 'REVERSED', notified_status: 'REVERSED'});
                    return messagingHelper.sendButtons(sender, `Your ${total} top-up was refunded. Reference: ${row.purchase_id}`, [menuButton]);
                }
                if (['failed', 'cancelled', 'canceled', 'expired', 'timedout'].includes(status)) {
                    await row.update({status: 'FAILED', notified_status: 'FAILED'});
                    return messagingHelper.sendButtons(sender,
                        `Your ${total} top-up didn’t go through${info?.description ? ` (${info.description})` : ''}. Nothing was added.`,
                        [{id: 'MERCHANT_TOPUP', title: 'Try again'}, menuButton]);
                }
            }).catch(e => console.error('Top-up follow-up failed:', e.message));
        }

        // Give up after half an hour, once.
        const stale = await purchaseModel.findAll({
            where: {kind: 'topup', status: 'PENDING_PAYMENT', created_at: {[Op.lte]: new Date(Date.now() - FOLLOW_FOR_MS)}},
            limit: 25,
        });
        for (const row of stale) {
            await row.update({status: 'UNRESOLVED'});
            await messagingHelper.sendButtons(row.phone.replace(/^\+/, ''),
                `Your ${money(row.amount, row.currency)} top-up (reference ${row.purchase_id}) hasn’t been confirmed. Check your wallet later, or contact support on ${process.env.SUPPORT_PHONE}.`,
                [menuButton]).catch(() => {});
        }
    },
};
