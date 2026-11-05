const crypto = require('crypto');
const QRCode = require('qrcode');
const {Op} = require('sequelize');
const models = require('../../models');
const purchaseModel = models.purchase;
const messagingHelper = require('./messagingHelper');
const mediaHelper = require('./mediaHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const lockHelper = require('../lockHelper');

/**
 * Merchant menu → Request payment: charge a customer, as tese and the NetOne bot do through
 * /init/authenticate/merchant/wallet. EcoCash/O'mari prompt the customer's phone; InnBucks gives a
 * code to pass on; ZimSwitch/Visa/Mastercard give a payment link (sent as a forwardable message and a
 * QR to scan off the merchant's screen). Followed until Smatpay's tracker says Paid.
 */

const STEPS = {
    amount: 'mreq_amount',
    number: 'mreq_number',
    confirm: 'mreq_confirm',
};

const METHODS = {
    ECOCASH: {walletName: 'Ecocash', label: 'EcoCash', number: /^07[78]\d{7}$/, hint: 'the customer’s EcoCash (Econet) number', description: 'Customer approves a prompt'},
    OMARI: {walletName: 'Omari', label: 'O’mari', number: /^071\d{7}$/, hint: 'the customer’s O’mari (NetOne) number', description: 'Customer approves on their phone'},
    INNBUCKS: {walletName: 'Innbucks', label: 'InnBucks', usdOnly: true, description: 'Customer pays a code in InnBucks'},
    ZIMSWITCH: {walletName: 'ZimSwitch', label: 'ZimSwitch', link: true, description: 'Customer pays by bank card, via a link'},
    VISA: {walletName: 'Visa', label: 'Visa', link: true, description: 'Customer pays by card, via a link'},
    MASTERCARD: {walletName: 'Mastercard', label: 'Mastercard', link: true, description: 'Customer pays by card, via a link'},
};

const FOLLOW_FOR_MS = 20 * 60 * 1000;
const cancelButton = {id: 'MREQ_CANCEL', title: 'Cancel'};
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

module.exports = {
    STEPS,

    ownsStep: function (step) {
        return Object.values(STEPS).includes(step);
    },

    handlesPayload: function (payload) {
        return /^MREQ_/.test(payload || '');
    },

    saveDraft: async function (user, patch, step) {
        await user.update({draft: {...(user.draft || {}), ...patch}});
        if (step) await messagingHelper.setStep(user.phone.replace(/^\+/, ''), step);
    },

    start: async function (msg, user) {
        await user.update({draft: {service: 'merchant_request'}});
        await messagingHelper.sendButtons(msg.sender, 'Request a payment in which currency?', [
            {id: 'MREQ_CURRENCY:USD', title: 'USD'},
            {id: 'MREQ_CURRENCY:ZWG', title: 'ZWG'},
            cancelButton,
        ], 'Request payment');
    },

    chooseCurrency: async function (msg, user, currency) {
        if (!['USD', 'ZWG'].includes(currency)) return this.start(msg, user);
        await this.saveDraft(user, {service: 'merchant_request', currency}, STEPS.amount);
        return messagingHelper.sendButtons(msg.sender, `How much is the customer paying, in ${currency}? Type the amount, e.g. 5.00.`, [cancelButton]);
    },

    saveAmount: async function (msg, user, raw) {
        const text = String(raw || '').replace(/[^\d.]/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
            return messagingHelper.sendMessage(msg.sender, 'Type the amount as a number, e.g. 5.00.');
        }
        await this.saveDraft(user, {amount: Number(text).toFixed(2)});
        const usd = user.draft.currency === 'USD';
        const rows = Object.entries(METHODS).filter(([, m]) => usd || !m.usdOnly)
            .map(([key, m]) => ({id: `MREQ_METHOD:${key}`, title: m.label, description: m.description}));
        return messagingHelper.sendList(msg.sender, `Request ${money(text, user.draft.currency)}. How will the customer pay?`, 'Choose how', [{title: 'Customer pays with', rows}]);
    },

    chooseMethod: async function (msg, user, key) {
        const method = METHODS[key];
        if (!method || !user.draft?.amount) return this.start(msg, user);
        if (method.number) {
            await this.saveDraft(user, {method: key, msisdn: null}, STEPS.number);
            return messagingHelper.sendButtons(msg.sender, `Type ${method.hint}, e.g. ${key === 'OMARI' ? '0712345678' : '0771234567'}.`, [cancelButton]);
        }
        await this.saveDraft(user, {method: key, msisdn: null});
        return this.confirm(msg, user);
    },

    saveNumber: async function (msg, user, raw) {
        const method = METHODS[user.draft?.method];
        const msisdn = localNumber(raw);
        if (!method?.number || !method.number.test(msisdn)) {
            return messagingHelper.sendMessage(msg.sender, `Type ${method?.hint || 'the customer’s number'}, e.g. ${user.draft?.method === 'OMARI' ? '0712345678' : '0771234567'}.`);
        }
        await this.saveDraft(user, {msisdn});
        return this.confirm(msg, user);
    },

    confirm: async function (msg, user) {
        const d = user.draft;
        const method = METHODS[d.method];
        await this.saveDraft(user, {reference: `WA-REQ-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}, STEPS.confirm);
        const who = d.msisdn ? `from ${d.msisdn} ` : '';
        return messagingHelper.sendButtons(msg.sender, `*Request payment*\n${money(d.amount, d.currency)} ${who}by ${method.label}.`, [
            {id: 'MREQ_CONFIRM', title: 'Send request'}, cancelButton,
        ]);
    },

    submit: async function (msg, user) {
        const d = user.draft;
        const method = METHODS[d?.method];
        if (!d?.reference || !method) return this.start(msg, user);
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');

        let init;
        try {
            const profiles = await merchantSession.withToken(user.phone, token => merchantApi.paymentProfiles(token, user.merchant_account_id));
            const profile = profiles.find(p => p.paymentProfileApproved !== false && p.paymentProfileNumber) || profiles[0];
            if (!profile?.paymentProfileNumber) {
                return messagingHelper.sendButtons(msg.sender, 'Your business has no payment profile here yet, so it can’t take payments. Please contact Smatpay support.', [menuButton]);
            }
            init = await merchantApi.requestPayment({
                keys: merchantSession.keys(user),
                accountId: user.merchant_account_id,
                profileNumber: profile.paymentProfileNumber,
                walletName: method.walletName,
                amount: d.amount,
                currency: d.currency,
                payerName: d.msisdn || 'Customer',
                reference: d.reference,
                payerMobile: d.msisdn ? `+263${d.msisdn.slice(1)}` : null,
                description: `Payment to ${user.merchant_name || 'merchant'}`,
            });
        } catch (e) {
            console.log(`Payment request ${d.reference} failed: [${e.code}/${e.status}] ${e.reason || e.message}`);
            return messagingHelper.sendButtons(msg.sender, `The request didn’t go through: ${String(e.message).replace(/[.!\s]*$/, '.')}`, [
                {id: 'MERCHANT_REQUEST_PAYMENT', title: 'Try again'}, menuButton,
            ]);
        }

        const reference = init.paymentReference || init.reference || d.reference;
        await purchaseModel.create({
            phone: user.phone, kind: 'request', purchase_id: reference,
            biller: 'MERCHANT_REQUEST', biller_name: 'Payment request', account: d.msisdn || null,
            amount: d.amount, total: d.amount, currency: d.currency,
            payment_method: method.label, payment_msisdn: d.msisdn,
            status: 'PENDING_PAYMENT', notified_status: 'PENDING_PAYMENT',
        });

        const total = money(d.amount, d.currency);
        if (d.method === 'INNBUCKS' && init.paymentCode) {
            await messagingHelper.sendMessage(msg.sender, `To pay ${user.merchant_name || 'us'} ${total}, open InnBucks and pay with this code:\n\n*${init.paymentCode}*`);
            return messagingHelper.sendMessage(msg.sender, 'Give the customer the code above (you can forward that message). I’ll tell you when it’s paid.');
        }
        const url = init.paymentRedirectUrl
            || (d.method === 'VISA' ? init.paymentVisaSkinnedUrl : null)
            || (d.method === 'MASTERCARD' ? init.paymentMasterCardSkinnedUrl : null);
        if (method.link && url && /^https:\/\//i.test(url)) {
            // A message the merchant can forward, and a QR the customer can scan off the merchant's screen.
            await messagingHelper.sendMessage(msg.sender, `Pay ${user.merchant_name || 'us'} ${total} securely by ${method.label}:\n${url}`);
            try {
                const png = await QRCode.toBuffer(url, {type: 'png', margin: 2, scale: 8});
                const mediaId = await mediaHelper.upload(png, 'image/png', `pay-${reference}.png`);
                await messagingHelper.sendImage(msg.sender, mediaId, `Or let the customer scan this to pay ${total}.`);
            } catch (e) {
                console.error('Sending the payment QR failed:', e.response ? JSON.stringify(e.response.data) : e.message);
            }
            return messagingHelper.sendMessage(msg.sender, 'Forward the link to the customer or show them the QR. I’ll tell you when it’s paid.');
        }
        return messagingHelper.sendMessage(msg.sender, `Payment request sent to ${d.msisdn}. Ask the customer to approve ${total} on their phone. I’ll tell you when it’s paid.`);
    },

    cancel: async function (msg, user) {
        await user.update({draft: null});
        await messagingHelper.setStep(msg.sender, 'merchant_menu');
        return messagingHelper.sendButtons(msg.sender, 'Cancelled. No request was sent.', [menuButton]);
    },

    manageInput: async function (msg, user) {
        if (user.last_bot_message === STEPS.amount) return this.saveAmount(msg, user, msg.content.text);
        if (user.last_bot_message === STEPS.number) return this.saveNumber(msg, user, msg.content.text);
        if (user.last_bot_message === STEPS.confirm) {
            return messagingHelper.sendButtons(msg.sender, 'Tap Send request, or Cancel.', [{id: 'MREQ_CONFIRM', title: 'Send request'}, cancelButton]);
        }
        return this.start(msg, user);
    },

    manageButtons: async function (msg, user) {
        const [action, value] = msg.content.payload.split(':');
        switch (action) {
            case 'MREQ_CURRENCY': return this.chooseCurrency(msg, user, value);
            case 'MREQ_METHOD': return this.chooseMethod(msg, user, value);
            case 'MREQ_CONFIRM': return this.submit(msg, user);
            case 'MREQ_CANCEL': return this.cancel(msg, user);
            default: return this.start(msg, user);
        }
    },

    /** Follows open requests; run with the purchase poller. Only "Paid" counts as received. */
    poll: async function () {
        const rows = await purchaseModel.findAll({
            where: {kind: 'request', status: 'PENDING_PAYMENT', created_at: {[Op.gt]: new Date(Date.now() - FOLLOW_FOR_MS)}},
            limit: 25,
        });
        for (const row of rows) {
            const sender = row.phone.replace(/^\+/, '');
            await lockHelper.withLock(`msg:${sender}`, async () => {
                let info;
                try {
                    info = await merchantApi.trackPayment(row.purchase_id);
                } catch (e) {
                    return console.error(`Tracking request ${row.purchase_id} failed:`, e.message);
                }
                const status = String(info?.status || 'Pending').toLowerCase();
                const total = money(row.amount, row.currency);
                if (status === 'paid' || status === 'success') {
                    await row.update({status: 'COMPLETED', notified_status: 'COMPLETED'});
                    return messagingHelper.sendButtons(sender,
                        `✅ *Received ${total}*\nBy ${row.payment_method}${row.payment_msisdn ? ` from ${row.payment_msisdn}` : ''}\nReference: ${row.purchase_id}`,
                        [{id: 'MERCHANT_EARNINGS', title: 'Earnings'}, {id: 'MERCHANT_REQUEST_PAYMENT', title: 'New request'}, menuButton]);
                }
                if (status === 'refunded') {
                    await row.update({status: 'REVERSED', notified_status: 'REVERSED'});
                    return messagingHelper.sendButtons(sender, `The ${total} payment (reference ${row.purchase_id}) was refunded to the customer.`, [menuButton]);
                }
                if (['failed', 'cancelled', 'canceled', 'expired', 'timedout'].includes(status)) {
                    await row.update({status: 'FAILED', notified_status: 'FAILED'});
                    return messagingHelper.sendButtons(sender,
                        `The customer’s ${total} ${row.payment_method} payment didn’t go through${info?.description ? ` (${info.description})` : ''}. Nothing was received.`,
                        [{id: 'MERCHANT_REQUEST_PAYMENT', title: 'Try again'}, menuButton]);
                }
            }).catch(e => console.error('Payment request follow-up failed:', e.message));
        }

        const stale = await purchaseModel.findAll({
            where: {kind: 'request', status: 'PENDING_PAYMENT', created_at: {[Op.lte]: new Date(Date.now() - FOLLOW_FOR_MS)}},
            limit: 25,
        });
        for (const row of stale) {
            await row.update({status: 'UNRESOLVED'});
            await messagingHelper.sendButtons(row.phone.replace(/^\+/, ''),
                `The ${money(row.amount, row.currency)} request (reference ${row.purchase_id}) hasn’t been paid after 20 minutes. Check Earnings later to see if it came in.`,
                [menuButton]).catch(() => {});
        }
    },
};
