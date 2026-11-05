const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const cryptoHelper = require('../cryptoHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Approves a payment with the user's PIN (flows/confirm_pin_flow.json). The form only checks the
 * PIN; the payment itself runs in the chat afterwards (flowReplyHelper), so a WhatsApp Flow never
 * waits on it. The draft being paid is stored with the form, so the approval can't be reused for
 * anything else.
 */

const FLOW = 'confirm_pin';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 30 * 60 * 1000;

function lockedMessage(until, merchant = false) {
    const time = new Date(until).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare'});
    return merchant
        ? `Too many wrong business PINs. Try again after ${time}, or reset it under PIN settings in the menu.`
        : `Too many wrong PINs. Try again after ${time}, or change your PIN from My account.`;
}

/** Merchant actions (draft.service 'merchant_…') are approved with the business PIN. */
function pinFields(merchant) {
    return merchant
        ? {hash: 'merchant_pin_hash', attempts: 'merchant_pin_failed_attempts', locked: 'merchant_pin_locked_until'}
        : {hash: 'pin_hash', attempts: 'pin_failed_attempts', locked: 'pin_locked_until'};
}

function isMerchantService(service) {
    return String(service || '').startsWith('merchant_');
}

module.exports = {
    FLOW,
    lockedMessage,
    isMerchantService,

    /** draft: the payment being approved; summary: one line saying what it is. */
    send: async function (sender, draft, summary) {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW, draft.service, {draft, summary});
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_CONFIRM_PIN_ID,
            flowToken,
            cta: isMerchantService(draft.service) ? 'Enter business PIN' : 'Enter PIN',
            body: isMerchantService(draft.service)
                ? 'Enter your business PIN in the secure form to continue.'
                : 'Enter your PIN in the secure form to pay.',
        });
    },

    handle: async function (session, action, screen, data, flowToken) {
        const summary = session.data.summary || '';
        if (action === 'INIT' || action === 'BACK' || screen !== 'CONFIRM') {
            return flowSessionHelper.screen('CONFIRM', {summary});
        }

        const user = await userModel.findOne({where: {phone: session.phone}});
        const merchant = isMerchantService(session.data.draft?.service);
        const f = pinFields(merchant);
        if (!user?.[f.hash]) {
            await flowSessionHelper.complete(session, 'no_pin');
            return flowSessionHelper.closeResponse(flowToken, {result: 'no_pin'});
        }
        if (user[f.locked] && new Date(user[f.locked]) > new Date()) {
            return flowSessionHelper.screen('CONFIRM', {summary}, lockedMessage(user[f.locked], merchant));
        }

        if (!cryptoHelper.verifyPin(String(data.pin || ''), user[f.hash])) {
            const attempts = (user[f.attempts] || 0) + 1;
            if (attempts >= MAX_ATTEMPTS) {
                const until = new Date(Date.now() + LOCK_MS);
                await user.update({[f.attempts]: 0, [f.locked]: until});
                await flowSessionHelper.complete(session, 'pin_locked');
                return flowSessionHelper.closeResponse(flowToken, {result: 'pin_locked'});
            }
            await user.update({[f.attempts]: attempts});
            const left = MAX_ATTEMPTS - attempts;
            return flowSessionHelper.screen('CONFIRM', {summary}, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
        }

        await user.update({[f.attempts]: 0, [f.locked]: null});
        await flowSessionHelper.complete(session, 'pin_confirmed');
        return flowSessionHelper.closeResponse(flowToken, {result: 'pin_confirmed'});
    },
};
