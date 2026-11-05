const models = require('../models');
const userModel = models.user;
const flowSessionHelper = require('../helpers/flows/flowSessionHelper');
const webFormHelper = require('../helpers/flows/webFormHelper');
const utilityHelper = require('../helpers/whatsapp/utilityHelper');
const signupFlowHelper = require('../helpers/flows/signupFlowHelper');
const loginFlowHelper = require('../helpers/flows/loginFlowHelper');
const pinFlowHelper = require('../helpers/flows/pinFlowHelper');
const confirmPinFlowHelper = require('../helpers/flows/confirmPinFlowHelper');
const merchantSignupFlowHelper = require('../helpers/flows/merchantSignupFlowHelper');
const merchantLoginFlowHelper = require('../helpers/flows/merchantLoginFlowHelper');
const merchantBusinessFlowHelper = require('../helpers/flows/merchantBusinessFlowHelper');
const merchantGoLiveForms = require('../helpers/flows/merchantGoLiveFlowHelper');
const flowReplyHelper = require('../helpers/whatsapp/flowReplyHelper');
const lockHelper = require('../helpers/lockHelper');
const sessionHelper = require('../helpers/smatpay/sessionHelper');

/**
 * The WhatsApp forms as web pages (/forms/<flow_token>), for when Flows can't be sent. Each page is
 * a Flow screen; submissions go through the same handlers as the Flow endpoint, and a finished form
 * continues the chat just as a Flow's nfm_reply would.
 */

const HANDLERS = {
    [signupFlowHelper.FLOW]: signupFlowHelper,
    [loginFlowHelper.FLOW]: loginFlowHelper,
    [pinFlowHelper.FLOW]: pinFlowHelper,
    [confirmPinFlowHelper.FLOW]: confirmPinFlowHelper,
    [merchantSignupFlowHelper.FLOW]: merchantSignupFlowHelper,
    [merchantLoginFlowHelper.FLOW]: merchantLoginFlowHelper,
    [merchantBusinessFlowHelper.FLOW]: merchantBusinessFlowHelper,
    [merchantGoLiveForms.bank.FLOW]: merchantGoLiveForms.bank,
    [merchantGoLiveForms.contact.FLOW]: merchantGoLiveForms.contact,
    [merchantGoLiveForms.profile.FLOW]: merchantGoLiveForms.profile,
};

const DONE = {
    signed_up: ['Account created', 'Check your email for a 6-digit code, then type it in the WhatsApp chat.'],
    signed_up_login_failed: ['Account created', 'Go back to WhatsApp to sign in.'],
    logged_in: ['You’re signed in', 'Go back to WhatsApp to carry on.'],
    pin_reset_verified: ['That’s you', 'Go back to WhatsApp to choose your new PIN.'],
    pin_set: ['PIN saved', 'Go back to WhatsApp to carry on.'],
    pin_confirmed: ['PIN confirmed', 'Go back to WhatsApp to carry on.'],
    merchant_pin_set: ['Business PIN saved', 'Go back to WhatsApp to carry on.'],
    pin_locked: ['Too many wrong PINs', 'Nothing was paid. Go back to WhatsApp for what to do next.'],
    merchant_signed_up: ['Account created', 'Open the activation link we emailed you, then go back to WhatsApp to sign in.'],
    merchant_needs_business: ['You’re signed in', 'Go back to WhatsApp to add your business.'],
    merchant_relogin: ['Please sign in again', 'Your sign-in expired. Go back to WhatsApp to sign in again.'],
    merchant_ready: ['All set', 'Go back to WhatsApp: your business is ready.'],
    merchant_bank_saved: ['Bank account saved', 'Go back to WhatsApp to carry on.'],
    merchant_contact_saved: ['Contact person saved', 'Go back to WhatsApp to carry on.'],
    merchant_profile_saved: ['Payment profile created', 'Go back to WhatsApp to carry on.'],
};

function secure(res) {
    // The token is in the URL: don't cache it, leak it in a Referer, or let it be framed.
    res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
}

function expired(res) {
    return res.status(410).send(webFormHelper.renderMessage(
        'This link has expired',
        'Links work once and for one hour. Send “hi” in the WhatsApp chat to get a new one.'
    ));
}

/** Continues the WhatsApp chat once a form is finished, as the Flow's nfm_reply would. */
function continueChat(session, flowToken) {
    const sender = session.phone.replace(/^\+/, '');
    lockHelper.withLock(`msg:${sender}`, async () => {
        const user = await userModel.findOne({where: {phone: session.phone}});
        if (!user) return;
        const msg = {id: null, sender, name: null, type: 'interactive', content: {flow: {flow_token: flowToken}}};
        try {
            await flowReplyHelper.handleFlowReply(msg, user);
        } catch (e) {
            if (!(e instanceof sessionHelper.SessionEndedError)) throw e;
            const wasGuest = sessionHelper.isGuest(user);
            await sessionHelper.clearSession(session.phone);
            if (wasGuest) return require('../helpers/whatsapp/onboardingHelper').sendAuthChoice(sender);
            await loginFlowHelper.send(sender, 'login', 'expired');
        }
    }).catch(e => console.error('Continuing chat after form failed:', e.message));
}

exports.Show = async (req, res) => {
    secure(res);
    const flowToken = req.params.token;
    const session = await flowSessionHelper.findOpen(flowToken);
    if (!session || !webFormHelper.isKnownFlow(session.flow) || !utilityHelper.isAllowedNumber(session.phone)) return expired(res);

    const result = await HANDLERS[session.flow].handle(session, 'INIT', null, {}, flowToken);
    res.send(webFormHelper.renderScreen(session.flow, result.screen, result.data, req.originalUrl.split('?')[0]));
};

exports.Submit = async (req, res) => {
    secure(res);
    const flowToken = req.params.token;
    const formUrl = req.originalUrl.split('?')[0];

    // One submission per form at a time: a double tap must not sign up twice.
    await lockHelper.withLock(`form:${flowToken}`, async () => {
        const session = await flowSessionHelper.findOpen(flowToken);
        if (!session || !webFormHelper.isKnownFlow(session.flow) || !utilityHelper.isAllowedNumber(session.phone)) return expired(res);

        const screen = String(req.body._screen || '');
        const data = {};
        for (const [key, field] of webFormHelper.payloadFields(session.flow, screen)) {
            data[key] = typeof req.body[field] === 'string' ? req.body[field] : '';
        }

        let result;
        try {
            result = await HANDLERS[session.flow].handle(session, 'data_exchange', screen, data, flowToken);
        } catch (e) {
            console.error('Form handling failed:', e);
            return res.status(500).send(webFormHelper.renderMessage('Something went wrong', 'Please go back and try again in a moment.'));
        }

        if (result.screen === 'SUCCESS') {
            const outcome = result.data.extension_message_response.params.result;
            const [title, message] = DONE[outcome] || ['All done', 'Go back to WhatsApp to carry on.'];
            res.send(webFormHelper.renderMessage(title, message));
            return continueChat(session, flowToken);
        }
        res.send(webFormHelper.renderScreen(session.flow, result.screen, result.data, formUrl));
    });
};
