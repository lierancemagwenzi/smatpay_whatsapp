const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const smatpayApi = require('../smatpay/smatpayApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Sign-in form (flows/login_flow.json): one LOGIN screen. The password goes from the form to our
 * endpoint and on to Smatpay; it is never stored and never appears in the chat.
 *
 * Purposes: 'login' (first time, or after the session ended) and 'reset_pin' (proves it's them
 * before a new PIN is set).
 */

const FLOW = 'login';

const COPY = {
    login: {
        header: 'Sign in to Smatpay',
        body: 'Sign in with your Smatpay email and password in the secure form. Your password is never shown in this chat.',
    },
    expired: {
        header: 'Please sign in again',
        body: 'Your Smatpay session has ended. Sign in again in the secure form to carry on.',
    },
    reset_pin: {
        header: 'Change your PIN',
        body: 'To change your PIN, first confirm it’s you by signing in with your Smatpay password.',
    },
};

module.exports = {
    FLOW,

    /** copyKey: 'login' | 'expired' | 'reset_pin'. */
    send: async function (sender, purpose = 'login', copyKey = purpose) {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW, purpose);
        const copy = COPY[copyKey] || COPY.login;
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_LOGIN_ID,
            flowToken,
            cta: 'Sign in',
            header: copy.header,
            body: copy.body,
        });
        await messagingHelper.setStep(sender, 'login_flow_sent');
    },

    handle: async function (session, action, screen, data, flowToken) {
        const user = await userModel.findOne({where: {phone: session.phone}});

        if (action === 'INIT' || action === 'BACK' || screen !== 'LOGIN') {
            return flowSessionHelper.screen('LOGIN', {email: user?.email || ''});
        }

        const email = (data.email || '').trim().toLowerCase();
        if (!utilityHelper.isValidEmail(email)) {
            return flowSessionHelper.screen('LOGIN', {email}, 'That doesn’t look like a valid email.');
        }
        if (!data.password) {
            return flowSessionHelper.screen('LOGIN', {email}, 'Enter your password.');
        }
        // Changing the PIN must be the account already linked to this number.
        if (session.purpose === 'reset_pin' && user?.email && user.email !== email) {
            return flowSessionHelper.screen('LOGIN', {email: user.email}, `Sign in as ${user.email}, the account linked to this number.`);
        }

        let auth;
        try {
            auth = await smatpayApi.login(email, data.password);
        } catch (e) {
            const message = e.code === 'unauthorized' ? 'Incorrect email or password.' : e.message;
            return flowSessionHelper.screen('LOGIN', {email}, message);
        }

        // Another Smatpay account on this number replaces the old one, and its PIN with it.
        const switched = user?.smatpay_user_id && user.smatpay_user_id !== auth.user?.id;
        await userModel.update(
            {user_type: 'client', ...(switched ? {pin_hash: null} : {})},
            {where: {phone: session.phone}}
        );
        await sessionHelper.saveSession(session.phone, auth);
        const result = session.purpose === 'reset_pin' ? 'pin_reset_verified' : 'logged_in';
        await flowSessionHelper.complete(session, result);
        return flowSessionHelper.closeResponse(flowToken, {result});
    },
};
