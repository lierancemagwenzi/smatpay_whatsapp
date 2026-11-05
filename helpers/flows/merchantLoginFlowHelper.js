const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const cryptoHelper = require('../cryptoHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Merchant sign-in (flows/merchant_login_flow.json): email and password, then the emailed code,
 * once. The bot then reads the merchant's keys from their profile and works with those; the
 * password and the code are never stored.
 */

const FLOW = 'merchant_login';

module.exports = {
    FLOW,

    /** purpose 'reset_pin': signing in again to replace a forgotten business PIN. */
    send: async function (sender, email = null, purpose = null) {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW, purpose, {email});
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_MERCHANT_LOGIN_ID,
            flowToken,
            cta: 'Sign in',
            header: 'Merchant sign in',
            body: 'Sign in with your Smatpay merchant email and password in the secure form. You’ll only need the emailed code this once.',
        });
        await messagingHelper.setStep(sender, 'merchant_login_sent');
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || !screen) {
            return flowSessionHelper.screen('LOGIN', {email: session.data.email || ''});
        }

        if (screen === 'LOGIN') {
            const email = (data.email || '').trim().toLowerCase();
            if (!utilityHelper.isValidEmail(email)) return flowSessionHelper.screen('LOGIN', {email}, 'That doesn’t look like a valid email.');
            if (!data.password) return flowSessionHelper.screen('LOGIN', {email}, 'Enter your password.');

            let auth;
            try {
                auth = await merchantApi.login(email, data.password);
            } catch (e) {
                return flowSessionHelper.screen('LOGIN', {email}, e.code === 'unauthorized' ? 'Incorrect email or password.' : e.message);
            }
            // The code is only emailed to activated accounts.
            if (auth.user?.activationActivated !== true) {
                return flowSessionHelper.screen('LOGIN', {email},
                    `Your account isn’t activated yet. Open the activation link we emailed to ${email}, then sign in again.`);
            }
            await flowSessionHelper.saveData(session, {
                email,
                token: cryptoHelper.encrypt(auth.token),
                // A team member works on the owner's merchant account.
                userId: auth.user.isTeamMember ? auth.user.teamMerchantUserId : auth.user.id,
            });
            return flowSessionHelper.screen('CODE', {email});
        }

        if (screen === 'CODE') {
            const {email, userId} = session.data;
            const token = cryptoHelper.decrypt(session.data.token);
            if (!token) return flowSessionHelper.screen('LOGIN', {email: email || ''}, 'Please sign in first.');
            const code = String(data.code || '').replace(/\s/g, '');
            if (!/^\d{4,8}$/.test(code)) return flowSessionHelper.screen('CODE', {email}, 'Enter the code from the email.');
            try {
                await merchantApi.verifyOtp(email, code, token);
            } catch (e) {
                return flowSessionHelper.screen('CODE', {email}, e.message);
            }

            const account = await merchantApi.profile(token, userId);
            if (account) {
                await merchantSession.saveAccount(session.phone, userId, account);
                await flowSessionHelper.complete(session, 'merchant_ready');
                return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_ready'});
            }

            // Signed in but no business yet: keep this (verified) token for the business form only.
            await userModel.update({
                user_type: 'merchant',
                merchant_user_id: userId,
                merchant_token_enc: cryptoHelper.encrypt(token),
                merchant_token_expires_at: sessionHelper.jwtExpiry(token),
            }, {where: {phone: session.phone}});
            await flowSessionHelper.complete(session, 'merchant_needs_business');
            return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_needs_business'});
        }

        return flowSessionHelper.screen('LOGIN', {email: session.data.email || ''});
    },
};
