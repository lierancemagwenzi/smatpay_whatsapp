const messagingHelper = require('./messagingHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const signupFlowHelper = require('../flows/signupFlowHelper');
const loginFlowHelper = require('../flows/loginFlowHelper');
const pinFlowHelper = require('../flows/pinFlowHelper');
const activationHelper = require('./activationHelper');
const menuHelper = require('./menuHelper');

/**
 * Where a number stands: choose a user type → sign up or sign in → activate → set a PIN → menu.
 * Choosing merchant hands over to merchantHelper. A guest skips the account steps and goes
 * straight to the menu (buy and pay only).
 */
module.exports = {
    getNextStep: function (user) {
        if (user.user_type === 'merchant') return 'merchant';
        if (!sessionHelper.isSignedIn(user)) {
            return user.user_type === 'client' ? 'auth_choice' : 'choose_type';
        }
        // Payments are approved in EcoCash, InnBucks or on the card itself, so a guest needs no PIN.
        if (sessionHelper.isGuest(user)) return 'main_menu';
        if (!user.activation_activated) return 'activation';
        if (!user.pin_hash) return 'pin';
        return 'main_menu';
    },

    /** Sends whatever the user needs next. */
    continue: async function (msg, user) {
        switch (this.getNextStep(user)) {
            case 'merchant':
                return require('./merchantHelper').continue(msg, user);
            case 'choose_type':
                return this.sendUserTypeChoice(msg.sender, msg.name);
            case 'auth_choice':
                return this.sendAuthChoice(msg.sender);
            case 'activation':
                return activationHelper.askForCode(msg.sender, user.email);
            case 'pin':
                return pinFlowHelper.send(msg.sender);
            default:
                return menuHelper.sendMainMenu(msg.sender, user);
        }
    },

    sendUserTypeChoice: async function (sender, name) {
        const greeting = name ? `Hi ${name.split(' ')[0]}, welcome to Smatpay.` : 'Welcome to Smatpay.';
        await messagingHelper.sendButtons(
            sender,
            `${greeting}\n\nPay merchants, buy airtime and electricity, and track your payments, all from WhatsApp.\n\nHow will you use Smatpay?`,
            [
                {id: 'USER_TYPE_CLIENT', title: 'As a customer'},
                {id: 'USER_TYPE_MERCHANT', title: 'As a merchant'},
            ]
        );
        await messagingHelper.setStep(sender, 'choose_user_type', {current_flow: 'onboarding'});
    },

    sendAuthChoice: async function (sender) {
        await messagingHelper.sendButtons(
            sender,
            'Do you already have a Smatpay account? You can use the same one as the Smatpay app.\n\nOr buy and pay as a guest, without an account.',
            [
                {id: 'AUTH_SIGNUP', title: 'Create account'},
                {id: 'AUTH_LOGIN', title: 'I have an account'},
                {id: 'AUTH_GUEST', title: 'Continue as guest'},
            ]
        );
        await messagingHelper.setStep(sender, 'auth_choice', {current_flow: 'onboarding'});
    },

    chooseClient: async function (msg, user) {
        await user.update({user_type: 'client'});
        return this.continue(msg, user);
    },

    startSignup: async function (msg) {
        return signupFlowHelper.send(msg.sender);
    },

    startLogin: async function (msg) {
        return loginFlowHelper.send(msg.sender);
    },

    startGuest: async function (msg, user) {
        try {
            await sessionHelper.startGuest(user.phone);
        } catch (e) {
            console.error(`Guest session for ${msg.sender} failed: [${e.code}/${e.status}] ${e.reason || e.message}`);
            return messagingHelper.sendButtons(msg.sender, `Guest checkout isn’t available right now: ${String(e.message).replace(/[.!\s]*$/, '.')}`, [
                {id: 'AUTH_GUEST', title: 'Try again'},
                {id: 'AUTH_SIGNUP', title: 'Create account'},
                {id: 'AUTH_LOGIN', title: 'I have an account'},
            ]);
        }
        await user.reload();
        await messagingHelper.sendMessage(msg.sender,
            'You’re using Smatpay as a guest. You can buy airtime, data, electricity and water, and pay merchants. You pay with EcoCash, O’mari, InnBucks or a card each time; nothing is saved. Create an account any time to keep your cards and see your history.');
        return menuHelper.sendMainMenu(msg.sender, user);
    },
};
