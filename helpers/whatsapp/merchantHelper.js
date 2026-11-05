const messagingHelper = require('./messagingHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const planeHelper = require('../smatpay/planeHelper');
const merchantSignupFlowHelper = require('../flows/merchantSignupFlowHelper');
const merchantLoginFlowHelper = require('../flows/merchantLoginFlowHelper');
const merchantBusinessFlowHelper = require('../flows/merchantBusinessFlowHelper');
const merchantWalletHelper = require('./merchantWalletHelper');
const merchantEarningsHelper = require('./merchantEarningsHelper');
const merchantTopUpHelper = require('./merchantTopUpHelper');
const merchantSellHelper = require('./merchantSellHelper');
const merchantGoLiveHelper = require('./merchantGoLiveHelper');
const merchantRequestHelper = require('./merchantRequestHelper');
const merchantPaymentLinksHelper = require('./merchantPaymentLinksHelper');
const utilityHelper = require('./utilityHelper');
const crypto = require('crypto');
const pinFlowHelper = require('../flows/pinFlowHelper');
const confirmPinFlowHelper = require('../flows/confirmPinFlowHelper');

/**
 * The merchant side of the bot. A number in merchant mode (user_type 'merchant') registers or
 * signs in once; the bot then holds the merchant's keys and renews its own session with them.
 * The same number can switch back to the customer side at any time.
 */

const COMING_SOON = {
};

const menuButton = {id: 'MAIN_MENU', title: 'Menu'};

module.exports = {
    handlesPayload: function (payload) {
        return /^(MERCHANT_|MTOPUP_|MSELL_|MGOLIVE_|MREQ_|MPLINK_)/.test(payload || '');
    },

    isReady: function (user) {
        return user.user_type === 'merchant' && merchantSession.hasKeys(user);
    },

    /** Where a merchant-mode number stands. */
    continue: async function (msg, user) {
        if (this.isReady(user) && !user.merchant_pin_hash) return this.askToSetPin(msg.sender);
        if (this.isReady(user)) return this.sendMenu(msg.sender, user);
        // Signed in, business not created yet: the token from sign-in is still good for the form.
        if (user.merchant_user_id && user.merchant_token_enc && new Date(user.merchant_token_expires_at) > new Date()) {
            return merchantBusinessFlowHelper.send(msg.sender);
        }
        return this.sendAuthChoice(msg.sender);
    },

    start: async function (msg, user) {
        await user.update({user_type: 'merchant'});
        return this.continue(msg, user);
    },

    // ------------------------------------------------------------ business PIN

    askToSetPin: async function (sender) {
        await messagingHelper.sendMessage(sender, 'One last step: choose a business PIN. You’ll need it to sell from your wallet and to change where your money is paid out.');
        return pinFlowHelper.send(sender, 'merchant_set');
    },

    /**
     * Asks for the business PIN before a critical action. draft.service names the action
     * ('merchant_sell', 'merchant_bank', 'merchant_profile_live', 'merchant_pin_change'); the
     * action runs in afterPinConfirmed, only if this exact draft is still the current one.
     */
    requirePin: async function (msg, user, draft, summary) {
        if (!user.merchant_pin_hash) return this.askToSetPin(msg.sender);
        const approved = {...draft, reference: draft.reference || `WA-PIN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`};
        // The business turned its PIN off: go straight on (turning it off itself always asks).
        if (user.merchant_pin_required === false && draft.service !== 'merchant_pin_off') {
            await user.update({draft: approved});
            return this.afterPinConfirmed(msg, user, approved);
        }
        if (user.merchant_pin_locked_until && new Date(user.merchant_pin_locked_until) > new Date()) {
            return messagingHelper.sendButtons(msg.sender, confirmPinFlowHelper.lockedMessage(user.merchant_pin_locked_until, true), [menuButton]);
        }
        await user.update({draft: approved});
        return confirmPinFlowHelper.send(msg.sender, approved, summary);
    },

    afterPinConfirmed: async function (msg, user, approved) {
        await user.reload();
        if (!approved?.reference || user.draft?.reference !== approved.reference) {
            return messagingHelper.sendButtons(msg.sender, 'That was changed or cancelled, so nothing was done.', [menuButton]);
        }
        switch (approved.service) {
            case 'merchant_sell':
                return merchantSellHelper.submit(msg, user);
            case 'merchant_bank':
                await user.update({draft: null});
                return require('../flows/merchantGoLiveFlowHelper').bank.send(msg.sender);
            case 'merchant_profile_live':
                await user.update({draft: null});
                return require('../flows/merchantGoLiveFlowHelper').profile.send(msg.sender, 'production');
            case 'merchant_pin_off':
                return this.setPinRequired(msg.sender, user, false);
            case 'merchant_pin_change':
                await user.update({draft: null});
                return pinFlowHelper.send(msg.sender, 'merchant_change');
            default:
                await user.update({draft: null});
                return this.sendMenu(msg.sender, user);
        }
    },

    afterPinLocked: async function (msg, user) {
        await user.update({draft: null});
        await user.reload();
        return messagingHelper.sendButtons(msg.sender, `${confirmPinFlowHelper.lockedMessage(user.merchant_pin_locked_until, true)} Nothing was done.`, [menuButton]);
    },

    afterPinSet: async function (msg, user) {
        await user.reload();
        await messagingHelper.sendMessage(msg.sender, 'Your business PIN is set. Keep it to yourself: Smatpay will never ask for it.');
        return this.sendMenu(msg.sender, user);
    },

    sendAuthChoice: async function (sender) {
        await messagingHelper.sendButtons(sender,
            'Smatpay for business: take payments from customers and manage your Smatpay merchant account on WhatsApp.\n\nAre you new to Smatpay, or do you already have a merchant account?',
            [
                {id: 'MERCHANT_REGISTER', title: 'Register business'},
                {id: 'MERCHANT_SIGNIN', title: 'Sign in'},
                {id: 'MERCHANT_TO_CUSTOMER', title: 'Use as customer'},
            ], 'Smatpay for business');
        await messagingHelper.setStep(sender, 'merchant_auth_choice', {current_flow: 'merchant'});
    },

    sendMenu: async function (sender, user) {
        const sandbox = planeHelper.isSandbox();
        await messagingHelper.sendList(sender,
            `${user.merchant_name || 'Your business'}: what would you like to do?`,
            'Menu',
            [
                {
                    title: 'Payments',
                    rows: [
                        {id: 'MERCHANT_SELL', title: 'Sell ZESA, water, airtime', description: 'For a customer, paid from your wallet'},
                        {id: 'MERCHANT_REQUEST_PAYMENT', title: 'Request payment', description: 'EcoCash, O’mari, InnBucks or a QR code'},
                        {id: 'MERCHANT_PAYMENT_LINKS', title: 'Payment links', description: 'Links and QR codes customers pay you with'},
                        {id: 'MERCHANT_WALLET', title: 'Wallet', description: 'Prepaid balance for selling airtime and ZESA'},
                        {id: 'MERCHANT_EARNINGS', title: 'Earnings', description: 'Customer payments and what you can pay out'},
                    ],
                },
                {
                    title: 'Business',
                    rows: [
                        {id: 'MERCHANT_DETAILS', title: 'Business details', description: 'Merchant ID and status'},
                        {id: 'MERCHANT_PIN_SETTINGS', title: 'PIN settings', description: 'Turn the PIN on or off, change or reset it'},
                        user.merchant_approved
                            ? {id: 'MERCHANT_GO_LIVE', title: 'Documents & bank', description: 'Your business documents and bank accounts'}
                            : {id: 'MERCHANT_GO_LIVE', title: 'Go live', description: 'Documents, bank account and approval'},
                        {id: 'MERCHANT_TO_CUSTOMER', title: 'Switch to customer', description: 'Pay and buy as a customer'},
                        {id: 'MERCHANT_SIGN_OUT', title: 'Sign out', description: 'Remove this business from WhatsApp'},
                    ],
                },
            ],
            sandbox ? 'Smatpay business (sandbox)' : 'Smatpay business');
        await messagingHelper.setStep(sender, 'merchant_menu', {current_flow: 'merchant'});
    },

    sendDetails: async function (sender, user) {
        const keys = merchantSession.keys(user);
        const live = Boolean(keys?.production?.key);
        const status = user.merchant_approved && live
            ? 'Approved for live payments'
            : 'Test (sandbox) payments only. Go live to take real payments.';
        // Checks the stored keys still work on Smatpay.
        let check = 'Connected';
        try {
            await merchantSession.getToken(user.phone);
        } catch (e) {
            check = e.message;
        }
        await messagingHelper.sendButtons(sender, [
            `*${user.merchant_name || 'Your business'}*`,
            `Merchant ID: ${user.merchant_id}`,
            `Status: ${status}`,
            `Smatpay: ${check}`,
        ].join('\n'), [
            {id: 'MERCHANT_PIN_SETTINGS', title: 'PIN settings'},
            menuButton,
        ]);
    },

    /** Business PIN: whether anything asks for it, change it, reset it by signing in again. */
    sendPinSettings: async function (sender, user) {
        const required = user.merchant_pin_required !== false;
        await messagingHelper.sendList(sender, [
            '*Business PIN*',
            required
                ? 'Your PIN is *on*: sales, adding a bank account, live payment profiles and PIN changes ask for it.'
                : 'Your PIN is *off*: nothing asks for it.',
        ].join('\n'), 'PIN settings', [{
            title: 'PIN settings',
            rows: [
                required
                    ? {id: 'MERCHANT_PIN_OFF', title: 'Turn off PIN', description: 'Nothing asks for it. Anyone with this phone can use the business.'}
                    : {id: 'MERCHANT_PIN_ON', title: 'Turn on PIN', description: 'Ask for the PIN before sales and account changes'},
                {id: 'MERCHANT_PIN_CHANGE', title: 'Change PIN', description: required ? 'You need your current PIN' : 'Choose a new PIN'},
                {id: 'MERCHANT_PIN_FORGOT', title: 'Reset PIN', description: 'Forgot it? Sign in again with email and password'},
                {id: 'MAIN_MENU', title: 'Menu'},
            ],
        }], 'Business PIN');
    },

    setPinRequired: async function (sender, user, on) {
        await user.update({merchant_pin_required: on, draft: null});
        return messagingHelper.sendButtons(sender, on
            ? '🔒 Your business PIN is on. Sales and account changes ask for it again.'
            : 'Your business PIN is off: nothing asks for it. Anyone who can use WhatsApp on this phone can sell from your wallet and change your bank details, so keep the phone locked. You can turn it back on in PIN settings.',
        [{id: 'MERCHANT_PIN_SETTINGS', title: 'PIN settings'}, menuButton]);
    },

    /** Results of the merchant forms (from the Flow reply or the web page). */
    afterForm: async function (msg, user, session) {
        switch (session.data.result) {
            case 'merchant_signed_up':
                await messagingHelper.sendButtons(msg.sender,
                    `Your Smatpay merchant account is created. We’ve emailed an activation link to ${session.data.details?.email}. Open it, then sign in here.`,
                    [{id: 'MERCHANT_SIGNIN', title: 'Sign in'}]);
                return messagingHelper.setStep(msg.sender, 'merchant_activate');

            case 'merchant_needs_business':
                await messagingHelper.sendMessage(msg.sender, 'You’re signed in. Now let’s add your business.');
                return merchantBusinessFlowHelper.send(msg.sender, session.data.email);

            case 'merchant_bank_saved':
                await messagingHelper.sendMessage(msg.sender, '✅ Bank account saved.');
                return merchantGoLiveHelper.show(msg, user);

            case 'merchant_profile_saved':
                await messagingHelper.sendMessage(msg.sender, '✅ Payment profile created.');
                return merchantGoLiveHelper.showProfiles(msg, user);

            case 'merchant_contact_saved':
                await messagingHelper.sendMessage(msg.sender, '✅ Contact person saved.');
                return merchantGoLiveHelper.show(msg, user);

            case 'merchant_relogin':
                await messagingHelper.sendMessage(msg.sender, 'Your sign-in expired before the business was saved. Please sign in again; your details aren’t lost.');
                return merchantLoginFlowHelper.send(msg.sender, session.data.email);

            case 'merchant_ready': {
                await user.reload();
                try {
                    await merchantSession.getToken(user.phone);
                } catch (e) {
                    return messagingHelper.sendButtons(msg.sender, `Signed in, but Smatpay didn’t accept your merchant keys: ${e.message}`, [menuButton]);
                }
                // Forgot PIN: signing in again proves it's them; now choose a new business PIN.
                if (session.purpose === 'reset_pin') {
                    await user.update({merchant_pin_hash: null, merchant_pin_failed_attempts: 0, merchant_pin_locked_until: null});
                    await messagingHelper.sendMessage(msg.sender, 'That’s you. Now choose a new business PIN.');
                    return pinFlowHelper.send(msg.sender, 'merchant_change');
                }
                if (!user.merchant_pin_hash) {
                    await messagingHelper.sendMessage(msg.sender, `*${user.merchant_name || 'Your business'}* is set up on WhatsApp. You won’t need to sign in again here.`);
                    return this.askToSetPin(msg.sender);
                }
                await messagingHelper.sendMessage(msg.sender, `*${user.merchant_name || 'Your business'}* is set up on WhatsApp. You won’t need to sign in again here.`);
                return this.sendMenu(msg.sender, user);
            }

            default:
                return this.continue(msg, user);
        }
    },

    /** A photo or PDF in merchant mode: a go-live document. */
    manageMedia: async function (msg, user) {
        if (!this.isReady(user)) return this.continue(msg, user);
        return merchantGoLiveHelper.receiveDocument(msg, user);
    },

    /** Typed text in merchant mode: the step being waited on, or the menu. */
    manageInput: async function (msg, user) {
        if (utilityHelper.isGreeting(msg.content.text)) {
            if (user.draft) await user.update({draft: null});
            return this.continue(msg, user);
        }
        if (this.isReady(user) && merchantTopUpHelper.ownsStep(user.last_bot_message)) return merchantTopUpHelper.manageInput(msg, user);
        if (this.isReady(user) && merchantSellHelper.ownsStep(user.last_bot_message)) return merchantSellHelper.manageInput(msg, user);
        if (this.isReady(user) && merchantRequestHelper.ownsStep(user.last_bot_message)) return merchantRequestHelper.manageInput(msg, user);
        if (this.isReady(user) && merchantPaymentLinksHelper.ownsStep(user.last_bot_message)) return merchantPaymentLinksHelper.manageInput(msg, user);
        return this.continue(msg, user);
    },

    manageButtons: async function (msg, user) {
        const payload = msg.content.payload;
        if (payload === 'MERCHANT_REGISTER') return merchantSignupFlowHelper.send(msg.sender);
        if (payload === 'MERCHANT_SIGNIN') return merchantLoginFlowHelper.send(msg.sender);
        if (payload === 'MERCHANT_TO_CUSTOMER') {
            await user.update({user_type: 'client'});
            return require('./onboardingHelper').continue(msg, user);
        }
        if (!this.isReady(user)) return this.continue(msg, user);

        if (COMING_SOON[payload]) {
            return messagingHelper.sendButtons(msg.sender, `${COMING_SOON[payload]} on WhatsApp is coming next.`, [menuButton]);
        }
        if (payload === 'MERCHANT_DETAILS') return this.sendDetails(msg.sender, user);
        if (payload === 'MERCHANT_PIN_SETTINGS') return this.sendPinSettings(msg.sender, user);
        // Turning the PIN off needs the PIN; turning it on doesn't.
        if (payload === 'MERCHANT_PIN_OFF') return this.requirePin(msg, user, {service: 'merchant_pin_off'}, 'Turn off your business PIN.');
        if (payload === 'MERCHANT_PIN_ON') return this.setPinRequired(msg.sender, user, true);
        if (payload === 'MERCHANT_PIN_CHANGE') return this.requirePin(msg, user, {service: 'merchant_pin_change'}, 'Change your business PIN.');
        if (payload === 'MERCHANT_PIN_FORGOT') {
            await messagingHelper.sendMessage(msg.sender, 'To reset your business PIN, sign in again with your Smatpay merchant email and password.');
            return merchantLoginFlowHelper.send(msg.sender, null, 'reset_pin');
        }
        if (payload === 'MERCHANT_WALLET') return merchantWalletHelper.show(msg, user);
        if (payload === 'MERCHANT_EARNINGS') return merchantEarningsHelper.show(msg, user);
        if (payload === 'MERCHANT_TOPUP') return merchantTopUpHelper.start(msg, user);
        if (payload === 'MERCHANT_SELL') return merchantSellHelper.start(msg, user);
        if (payload === 'MERCHANT_GO_LIVE') return merchantGoLiveHelper.show(msg, user);
        if (payload === 'MERCHANT_REQUEST_PAYMENT') return merchantRequestHelper.start(msg, user);
        if (merchantRequestHelper.handlesPayload(payload)) return merchantRequestHelper.manageButtons(msg, user);
        if (payload === 'MERCHANT_PAYMENT_LINKS') return merchantPaymentLinksHelper.show(msg, user);
        if (merchantPaymentLinksHelper.handlesPayload(payload)) return merchantPaymentLinksHelper.manageButtons(msg, user);
        if (merchantGoLiveHelper.handlesPayload(payload)) return merchantGoLiveHelper.manageButtons(msg, user);
        if (merchantSellHelper.handlesPayload(payload)) return merchantSellHelper.manageButtons(msg, user);
        if (merchantTopUpHelper.handlesPayload(payload)) return merchantTopUpHelper.manageButtons(msg, user);
        if (payload === 'MERCHANT_SIGN_OUT') {
            await merchantSession.signOut(user.phone);
            await messagingHelper.sendMessage(msg.sender, 'Your business is signed out of WhatsApp. Your Smatpay merchant account isn’t affected.');
            await user.reload();
            return require('./onboardingHelper').continue(msg, user);
        }
        return this.sendMenu(msg.sender, user);
    },
};
