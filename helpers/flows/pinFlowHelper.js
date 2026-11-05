const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const cryptoHelper = require('../cryptoHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * PIN form (flows/pin_flow.json): one SET_PIN screen with masked fields. The PIN authorises
 * payments on WhatsApp; only its scrypt hash is stored.
 *
 * Purposes 'merchant_set' / 'merchant_change' set the business PIN instead (merchant_pin_hash),
 * which guards selling from the wallet and payout changes on the merchant side.
 */

function isMerchant(purpose) {
    return String(purpose || '').startsWith('merchant');
}

const FLOW = 'pin';

module.exports = {
    FLOW,

    send: async function (sender, purpose = 'set') {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW, purpose);
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_PIN_ID,
            flowToken,
            cta: 'Set PIN',
            header: isMerchant(purpose)
                ? (purpose === 'merchant_change' ? 'Choose a new business PIN' : 'Set your business PIN')
                : (purpose === 'change' ? 'Choose a new PIN' : 'Set your payment PIN'),
            body: isMerchant(purpose)
                ? 'Choose a 4-digit business PIN. You’ll enter it to sell from your wallet and to change payout details. It’s separate from any customer PIN, and typed in a secure form, not in this chat.'
                : 'Choose a 4-digit PIN. You’ll enter it to approve payments on WhatsApp. It’s typed in a secure form, not in this chat.',
        });
        await messagingHelper.setStep(sender, 'pin_flow_sent');
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || screen !== 'SET_PIN') {
            return flowSessionHelper.screen('SET_PIN');
        }

        const user = await userModel.findOne({where: {phone: session.phone}});
        const merchant = isMerchant(session.purpose);
        if (merchant ? !user?.merchant_keys_enc : !sessionHelper.isSignedIn(user)) {
            await flowSessionHelper.complete(session, 'not_signed_in');
            return flowSessionHelper.closeResponse(flowToken, {result: 'not_signed_in'});
        }

        const pin = String(data.pin || '');
        if (!utilityHelper.isValidPin(pin)) {
            return flowSessionHelper.screen('SET_PIN', {}, 'Your PIN must be exactly 4 digits.');
        }
        if (utilityHelper.isWeakPin(pin)) {
            return flowSessionHelper.screen('SET_PIN', {}, 'That PIN is too easy to guess. Avoid repeated or consecutive digits.');
        }
        if (pin !== String(data.confirm_pin || '')) {
            return flowSessionHelper.screen('SET_PIN', {}, 'The PINs don’t match.');
        }

        if (merchant) {
            await userModel.update({merchant_pin_hash: cryptoHelper.hashPin(pin), merchant_pin_failed_attempts: 0, merchant_pin_locked_until: null}, {where: {phone: session.phone}});
            await flowSessionHelper.complete(session, 'merchant_pin_set');
            return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_pin_set'});
        }
        await userModel.update({pin_hash: cryptoHelper.hashPin(pin)}, {where: {phone: session.phone}});
        await flowSessionHelper.complete(session, 'pin_set');
        return flowSessionHelper.closeResponse(flowToken, {result: 'pin_set'});
    },
};
