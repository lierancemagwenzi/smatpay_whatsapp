const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Merchant registration, part 1 (flows/merchant_signup_flow.json): the person who manages the
 * business, then a password. Smatpay emails an activation link; signing in follows.
 */

const FLOW = 'merchant_signup';
const MIN_PASSWORD_LENGTH = 8;
const TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof'].map(t => ({id: t, title: t}));

function detailsScreen(details, error = null) {
    return flowSessionHelper.screen('DETAILS', {
        titles: TITLES,
        title: details.title || '',
        first_name: details.first_name || '',
        last_name: details.last_name || '',
        email: details.email || '',
    }, error);
}

module.exports = {
    FLOW,

    send: async function (sender) {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW);
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_MERCHANT_SIGNUP_ID,
            flowToken,
            cta: 'Register',
            header: 'Register your business',
            body: 'Create your Smatpay merchant account in the secure form. Your password is never shown in this chat.',
        });
        await messagingHelper.setStep(sender, 'merchant_signup_sent');
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || !screen) return detailsScreen(session.data.details || {});

        if (screen === 'DETAILS') {
            const details = {
                title: (data.title || '').trim(),
                first_name: (data.first_name || '').trim(),
                last_name: (data.last_name || '').trim(),
                email: (data.email || '').trim().toLowerCase(),
            };
            if (!TITLES.some(t => t.id === details.title)) return detailsScreen(details, 'Choose a title.');
            if (details.first_name.length < 2) return detailsScreen(details, 'Enter your first name.');
            if (details.last_name.length < 2) return detailsScreen(details, 'Enter your last name.');
            if (!utilityHelper.isValidEmail(details.email)) return detailsScreen(details, 'That doesn’t look like a valid email.');
            await flowSessionHelper.saveData(session, {details});
            return flowSessionHelper.screen('PASSWORD', {email: details.email});
        }

        if (screen === 'PASSWORD') {
            const details = session.data.details;
            if (!details) return detailsScreen({}, 'Please fill in your details first.');
            const password = data.password || '';
            if (password.length < MIN_PASSWORD_LENGTH) {
                return flowSessionHelper.screen('PASSWORD', {email: details.email}, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
            }
            if (password !== data.confirm_password) {
                return flowSessionHelper.screen('PASSWORD', {email: details.email}, 'Passwords don’t match.');
            }
            try {
                await merchantApi.signup({
                    title: details.title, firstName: details.first_name, lastName: details.last_name, email: details.email, password,
                });
            } catch (e) {
                if (/exist/i.test(e.message)) {
                    return detailsScreen(details, 'That email already has a Smatpay account. Close this form and choose Sign in.');
                }
                return flowSessionHelper.screen('PASSWORD', {email: details.email}, e.message);
            }
            await flowSessionHelper.complete(session, 'merchant_signed_up');
            return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_signed_up'});
        }

        return detailsScreen({});
    },
};
