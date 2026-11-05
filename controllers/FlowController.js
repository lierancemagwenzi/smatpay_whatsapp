const flowCryptoHelper = require('../helpers/flows/flowCryptoHelper');
const flowSessionHelper = require('../helpers/flows/flowSessionHelper');
const signupFlowHelper = require('../helpers/flows/signupFlowHelper');
const loginFlowHelper = require('../helpers/flows/loginFlowHelper');
const pinFlowHelper = require('../helpers/flows/pinFlowHelper');
const confirmPinFlowHelper = require('../helpers/flows/confirmPinFlowHelper');
const merchantSignupFlowHelper = require('../helpers/flows/merchantSignupFlowHelper');
const merchantLoginFlowHelper = require('../helpers/flows/merchantLoginFlowHelper');
const merchantBusinessFlowHelper = require('../helpers/flows/merchantBusinessFlowHelper');
const merchantGoLiveForms = require('../helpers/flows/merchantGoLiveFlowHelper');

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

// WhatsApp Flows status codes: 421 = re-fetch our public key, 427 = flow_token no longer valid.
const KEY_MISMATCH = 421;
const TOKEN_INVALID = 427;

async function respond(decryptedBody) {
    const {action, screen, data = {}, flow_token: flowToken} = decryptedBody;

    if (action === 'ping') return {status: 200, body: {data: {status: 'active'}}};
    // WhatsApp reporting an error it hit on a screen we returned.
    if (data && data.error) {
        console.error('Flow client error:', JSON.stringify(data));
        return {status: 200, body: {data: {acknowledged: true}}};
    }

    const session = await flowSessionHelper.findOpen(flowToken);
    const handler = session && HANDLERS[session.flow];
    if (!handler) return {status: TOKEN_INVALID, body: null};

    return {status: 200, body: await handler.handle(session, action, screen, data, flowToken)};
}

exports.Endpoint = async (req, res) => {
    let decrypted;
    try {
        decrypted = flowCryptoHelper.decryptRequest(req.body);
    } catch (e) {
        console.error('Flow request rejected:', e.message);
        return res.sendStatus(e instanceof flowCryptoHelper.FlowDecryptError ? KEY_MISMATCH : 500);
    }

    const {decryptedBody, aesKey, iv} = decrypted;
    let result;
    try {
        result = await respond(decryptedBody);
    } catch (e) {
        console.error('Flow handling failed:', e);
        return res.sendStatus(500);
    }
    if (result.status !== 200) return res.sendStatus(result.status);
    res.type('text/plain').send(flowCryptoHelper.encryptResponse(result.body, aesKey, iv));
};
