const messagingHelper = require('./messagingHelper');
const onboardingHelper = require('./onboardingHelper');
const activationHelper = require('./activationHelper');
const menuHelper = require('./menuHelper');
const flowSessionHelper = require('../flows/flowSessionHelper');
const loginFlowHelper = require('../flows/loginFlowHelper');
const pinFlowHelper = require('../flows/pinFlowHelper');
const confirmPinFlowHelper = require('../flows/confirmPinFlowHelper');
const vasHelper = require('./vasHelper');

/**
 * A form closed and WhatsApp posted its nfm_reply. The work was already done by the flow endpoint;
 * this carries on the chat. The result is read from our own record, not from the reply.
 */
module.exports = {
    handleFlowReply: async function (msg, user) {
        const session = await flowSessionHelper.findAny(msg.content.flow?.flow_token);
        if (!session || session.phone !== user.phone || session.status !== 'completed') {
            return onboardingHelper.continue(msg, user);
        }
        await user.reload();

        if (/^merchant_/.test(session.flow)) return require('./merchantHelper').afterForm(msg, user, session);

        const merchantAction = confirmPinFlowHelper.isMerchantService(session.data.draft?.service);
        if (session.data.result === 'merchant_pin_set') return require('./merchantHelper').afterPinSet(msg, user);
        if (session.flow === confirmPinFlowHelper.FLOW && merchantAction) {
            if (session.data.result === 'pin_confirmed') return require('./merchantHelper').afterPinConfirmed(msg, user, session.data.draft);
            if (session.data.result === 'pin_locked') return require('./merchantHelper').afterPinLocked(msg, user);
            return require('./merchantHelper').continue(msg, user);
        }

        switch (session.data.result) {
            case 'signed_up':
                return activationHelper.askForCode(msg.sender, user.email);

            case 'signed_up_login_failed':
                await messagingHelper.sendMessage(msg.sender, 'Your Smatpay account is created. Please sign in to carry on.');
                return loginFlowHelper.send(msg.sender);

            case 'logged_in':
                await messagingHelper.sendMessage(msg.sender, `Signed in as ${user.email}.`);
                return onboardingHelper.continue(msg, user);

            case 'pin_reset_verified':
                return pinFlowHelper.send(msg.sender, 'change');

            case 'pin_set':
                await messagingHelper.sendMessage(msg.sender, 'Your PIN is set. Keep it to yourself: Smatpay will never ask for it.');
                return menuHelper.sendMainMenu(msg.sender, user);

            case 'pin_confirmed':
                if (session.flow === confirmPinFlowHelper.FLOW && vasHelper.SERVICES[session.data.draft?.service]) {
                    return vasHelper.purchase(msg, user, session.data.draft);
                }
                return onboardingHelper.continue(msg, user);

            case 'pin_locked':
                await user.update({draft: null});
                return messagingHelper.sendButtons(msg.sender, `${confirmPinFlowHelper.lockedMessage(user.pin_locked_until)} Nothing was paid.`, [{id: 'MAIN_MENU', title: 'Main menu'}]);

            default:
                return onboardingHelper.continue(msg, user);
        }
    },
};
