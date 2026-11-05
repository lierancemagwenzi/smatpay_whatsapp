const messagingHelper = require('./messagingHelper');
const onboardingHelper = require('./onboardingHelper');
const activationHelper = require('./activationHelper');
const menuHelper = require('./menuHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const loginFlowHelper = require('../flows/loginFlowHelper');
const vasHelper = require('./vasHelper');
const transactionsHelper = require('./transactionsHelper');
const merchantHelper = require('./merchantHelper');

const COMING_SOON = {
};

/** Button and list replies, routed by id. */
module.exports = {
    manageButtons: async function (msg, user) {
        const payload = msg.content.payload;
        const step = onboardingHelper.getNextStep(user);

        // Onboarding
        if (payload === 'USER_TYPE_CLIENT') return onboardingHelper.chooseClient(msg, user);
        if (payload === 'USER_TYPE_MERCHANT') return merchantHelper.start(msg, user);

        // Merchant mode has its own menu and buttons.
        if (merchantHelper.handlesPayload(payload)) return merchantHelper.manageButtons(msg, user);
        if (user.user_type === 'merchant') return merchantHelper.continue(msg, user);

        if (payload === 'AUTH_SIGNUP' && step === 'auth_choice') return onboardingHelper.startSignup(msg);
        if (payload === 'AUTH_LOGIN' && step === 'auth_choice') return onboardingHelper.startLogin(msg);
        if (payload === 'AUTH_GUEST' && step === 'auth_choice') return onboardingHelper.startGuest(msg, user);
        if (payload === 'RESEND_CODE' && step === 'activation') return activationHelper.resendCode(msg, user);

        // Everything below needs a finished account.
        if (step !== 'main_menu') return onboardingHelper.continue(msg, user);

        if (payload === 'MAIN_MENU') {
            if (user.draft) await user.update({draft: null});
            return menuHelper.sendMainMenu(msg.sender, user);
        }
        if (vasHelper.handlesPayload(payload)) return vasHelper.manageButtons(msg, user);
        // A guest keeps their guest session until the account form is done (signing in replaces it).
        if (payload === 'GUEST_SIGNUP') return onboardingHelper.startSignup(msg);
        if (payload === 'GUEST_LOGIN') return onboardingHelper.startLogin(msg);
        if (sessionHelper.isGuest(user) && (payload === 'MENU_TRANSACTIONS' || transactionsHelper.handlesPayload(payload) || payload === 'CHANGE_PIN')) {
            return messagingHelper.sendButtons(msg.sender, 'Guests don’t have a history or a PIN. Create an account to see your payments.', [
                {id: 'GUEST_SIGNUP', title: 'Create account'}, {id: 'MAIN_MENU', title: 'Main menu'},
            ]);
        }
        if (payload === 'MENU_TRANSACTIONS') return transactionsHelper.list(msg, user);
        if (transactionsHelper.handlesPayload(payload)) return transactionsHelper.show(msg, user, payload);
        if (COMING_SOON[payload]) return menuHelper.sendComingSoon(msg.sender, COMING_SOON[payload]);
        if (payload === 'MENU_ACCOUNT') return menuHelper.sendAccount(msg.sender, user);
        if (payload === 'MENU_HELP') return menuHelper.sendHelp(msg.sender);
        if (payload === 'CHANGE_PIN') return loginFlowHelper.send(msg.sender, 'reset_pin');
        if (payload === 'SIGN_OUT') {
            const guest = sessionHelper.isGuest(user);
            await sessionHelper.signOut(user.phone);
            await messagingHelper.sendMessage(msg.sender, guest ? 'You’ve left guest mode.' : 'You’re signed out of Smatpay on WhatsApp.');
            return onboardingHelper.sendAuthChoice(msg.sender);
        }

        return menuHelper.sendMainMenu(msg.sender, user);
    },
};
