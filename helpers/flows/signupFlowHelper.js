const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const smatpayApi = require('../smatpay/smatpayApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Client signup form (flows/signup_flow.json): DETAILS → PASSWORD. Submitting PASSWORD creates the
 * Smatpay account and signs in; the activation code is then asked for in the chat.
 */

const FLOW = 'signup';
const MIN_PASSWORD_LENGTH = 8;

function detailsScreen(details, error = null) {
    return flowSessionHelper.screen('DETAILS', {
        first_name: details.first_name || '',
        last_name: details.last_name || '',
        email: details.email || '',
        phone: details.phone || '',
    }, error);
}

function validateDetails(d) {
    if ((d.first_name || '').trim().length < 2) return 'Enter your first name.';
    if ((d.last_name || '').trim().length < 2) return 'Enter your last name.';
    if (!utilityHelper.isValidEmail(d.email)) return 'That doesn’t look like a valid email.';
    if (!utilityHelper.isValidMobile(d.phone)) return 'Enter a valid mobile number, e.g. 0771234567 or +27821234567.';
    return null;
}

module.exports = {
    FLOW,

    send: async function (sender) {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW);
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_SIGNUP_ID,
            flowToken,
            cta: 'Create account',
            header: 'Create your Smatpay account',
            body: 'Fill in your details in the secure form. Your password is never shown in this chat.',
        });
        await messagingHelper.setStep(sender, 'signup_flow_sent', {current_flow: 'onboarding'});
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK') {
            const saved = session.data.details || {};
            return detailsScreen({phone: utilityHelper.localPhone(session.phone), ...saved});
        }

        if (screen === 'DETAILS') {
            const details = {
                first_name: (data.first_name || '').trim(),
                last_name: (data.last_name || '').trim(),
                email: (data.email || '').trim().toLowerCase(),
                phone: (data.phone || '').trim(),
            };
            const error = validateDetails(details);
            if (error) return detailsScreen(details, error);
            await flowSessionHelper.saveData(session, {details});
            return flowSessionHelper.screen('PASSWORD', {email: details.email});
        }

        if (screen === 'PASSWORD') {
            const details = session.data.details;
            if (!details) return detailsScreen({phone: utilityHelper.localPhone(session.phone)}, 'Please fill in your details first.');
            const password = data.password || '';
            if (password.length < MIN_PASSWORD_LENGTH) {
                return flowSessionHelper.screen('PASSWORD', {email: details.email}, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
            }
            if (password !== data.confirm_password) {
                return flowSessionHelper.screen('PASSWORD', {email: details.email}, 'Passwords don’t match.');
            }

            try {
                await smatpayApi.signup({
                    firstName: details.first_name,
                    lastName: details.last_name,
                    email: details.email,
                    phoneNumber: utilityHelper.normalizePhone(details.phone),
                    password,
                });
            } catch (e) {
                if (/exist/i.test(e.message)) {
                    return detailsScreen(details, 'That email already has a Smatpay account. Use another email, or close this form and choose “I have an account”.');
                }
                return flowSessionHelper.screen('PASSWORD', {email: details.email}, e.message);
            }

            await userModel.update({user_type: 'client'}, {where: {phone: session.phone}});
            let result = 'signed_up';
            try {
                // Unactivated accounts can sign in; Smatpay emails the activation code again.
                const auth = await smatpayApi.login(details.email, password);
                await sessionHelper.saveSession(session.phone, auth);
            } catch (e) {
                console.error('Sign in after signup failed:', e.message);
                result = 'signed_up_login_failed';
            }
            await flowSessionHelper.complete(session, result);
            return flowSessionHelper.closeResponse(flowToken, {result});
        }

        return detailsScreen({phone: utilityHelper.localPhone(session.phone)});
    },
};
