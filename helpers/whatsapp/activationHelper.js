const messagingHelper = require('./messagingHelper');
const utilityHelper = require('./utilityHelper');
const smatpayApi = require('../smatpay/smatpayApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');

const enterActivationCode = 'enter_activation_code';

/** New accounts are activated with the 6-digit code Smatpay emails; it's typed in the chat. */
module.exports = {
    enterActivationCode,

    askForCode: async function (sender, email) {
        await messagingHelper.sendButtons(
            sender,
            `We’ve emailed a 6-digit code to ${email}. Type it here to activate your account.`,
            [{id: 'RESEND_CODE', title: 'Resend code'}]
        );
        await messagingHelper.setStep(sender, enterActivationCode, {current_flow: 'activation'});
    },

    resendCode: async function (msg, user) {
        try {
            await smatpayApi.resendActivation(user.email);
            await messagingHelper.sendMessage(msg.sender, `A new code is on its way to ${user.email}. Type it here when it arrives.`);
        } catch (e) {
            await messagingHelper.sendMessage(msg.sender, e.message);
        }
        await messagingHelper.setStep(msg.sender, enterActivationCode);
    },

    /** Returns true once the account is active. */
    verifyCode: async function (msg, user) {
        const code = (msg.content.text || '').replace(/\s/g, '');
        if (!utilityHelper.isValidOtp(code)) {
            await messagingHelper.sendMessage(msg.sender, 'Enter the 6-digit code from the email.');
            return false;
        }
        try {
            await smatpayApi.verifyAccount(user.smatpay_user_id, code);
        } catch (e) {
            await messagingHelper.sendMessage(msg.sender, e.message);
            return false;
        }
        await user.update({activation_activated: true});
        try {
            // Picks up the profile as Smatpay now sees it.
            await sessionHelper.refresh(user.phone);
        } catch (e) {
            console.error('Refresh after activation failed:', e.message);
        }
        await messagingHelper.sendMessage(msg.sender, 'Your Smatpay account is active.');
        return true;
    },
};
