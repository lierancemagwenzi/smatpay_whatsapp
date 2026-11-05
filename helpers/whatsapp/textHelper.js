const onboardingHelper = require('./onboardingHelper');
const activationHelper = require('./activationHelper');
const vasHelper = require('./vasHelper');
const payHelper = require('./payHelper');
const purchaseHelper = require('./purchaseHelper');
const utilityHelper = require('./utilityHelper');

/** Typed messages, routed by the step the bot is waiting on (user.last_bot_message). */
module.exports = {
    manageInput: async function (msg, user) {
        const step = onboardingHelper.getNextStep(user);
        if (step === 'merchant') return require('./merchantHelper').manageInput(msg, user);

        if (step === 'activation' && user.last_bot_message === activationHelper.enterActivationCode) {
            const activated = await activationHelper.verifyCode(msg, user);
            if (activated) {
                await user.reload();
                return onboardingHelper.continue(msg, user);
            }
            return;
        }

        if (step === 'main_menu') {
            // "hi" / "menu" abandons whatever was being bought.
            if (utilityHelper.isGreeting(msg.content.text)) {
                if (user.draft) await user.update({draft: null});
                return onboardingHelper.continue(msg, user);
            }
            if (user.last_bot_message === purchaseHelper.enterOtp && await purchaseHelper.submitOtp(msg, user)) return;
            if (payHelper.ownsStep(user.last_bot_message)) return payHelper.manageInput(msg, user);
            if (vasHelper.ownsStep(user.last_bot_message)) return vasHelper.manageInput(msg, user);
            // A merchant's payment link pasted at any other time starts a payment.
            if (payHelper.looksLikePaymentCode(msg.content.text)) return payHelper.handleCode(msg, user, msg.content.text);
        }

        // Greetings, and anything we're not waiting on, get the next step (or the main menu).
        return onboardingHelper.continue(msg, user);
    },

    /** A photo: once signed in, read it as a merchant's QR code. */
    manageImage: async function (msg, user) {
        if (user.user_type === 'merchant') return require('./merchantHelper').manageMedia(msg, user);
        if (msg.type === 'document') return onboardingHelper.continue(msg, user);
        if (onboardingHelper.getNextStep(user) !== 'main_menu') return onboardingHelper.continue(msg, user);
        return payHelper.handleImage(msg, user);
    },
};
