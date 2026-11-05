const utilityHelper = require('../helpers/whatsapp/utilityHelper');
const messagingHelper = require('../helpers/whatsapp/messagingHelper');
const buttonsHelper = require('../helpers/whatsapp/buttonsHelper');
const textHelper = require('../helpers/whatsapp/textHelper');
const flowReplyHelper = require('../helpers/whatsapp/flowReplyHelper');
const lockHelper = require('../helpers/lockHelper');
const sessionHelper = require('../helpers/smatpay/sessionHelper');
const loginFlowHelper = require('../helpers/flows/loginFlowHelper');
const userModel = require('../models').user;

// WhatsApp retries webhooks it thinks failed; don't handle the same message twice.
const SEEN_LIMIT = 5000;
const seen = new Set();

function alreadySeen(id) {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
    return false;
}

const NOTIFY_EVERY_MS = 60 * 60 * 1000;
const lastNotified = new Map();

function shouldNotify(sender) {
    const last = lastNotified.get(sender) || 0;
    if (Date.now() - last < NOTIFY_EVERY_MS) return false;
    lastNotified.set(sender, Date.now());
    return true;
}

async function handleMessage(msg) {
    const user = await utilityHelper.findOrCreateUser(msg);
    await user.update({
        last_user_timestamp: new Date(),
        ...(msg.name && msg.name !== user.wa_name ? {wa_name: msg.name} : {}),
    });

    if (msg.type === 'interactive' && msg.content.flow) {
        return flowReplyHelper.handleFlowReply(msg, user);
    }
    if (msg.content.payload) {
        return buttonsHelper.manageButtons(msg, user);
    }
    if (msg.type === 'image' || msg.type === 'document') {
        return textHelper.manageImage(msg, user);
    }
    return textHelper.manageInput(msg, user);
}

exports.WebHook = async (req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    if (secret && req.get('X-Webhook-Secret') !== secret) {
        return res.status(401).json({error: 'unauthorized'});
    }
    res.status(200).json({data: 'received'});

    const msg = utilityHelper.parseIncomingMessage(req.body);
    if (!msg || msg.type === 'status' || alreadySeen(msg.id)) return;
    if (!utilityHelper.isAllowedNumber(msg.sender)) {
        // While in development only listed numbers are served; tell anyone else, at most once an hour.
        if (shouldNotify(msg.sender)) {
            await messagingHelper.sendMessage(msg.sender, 'Sorry, you’re not authorised to use this service yet. It’s still being tested.').catch(() => {});
        }
        return;
    }
    if (!utilityHelper.permittedMessages.includes(msg.type)) {
        await messagingHelper.sendMessage(msg.sender, 'Sorry, I can only read text, button replies and photos of QR codes.').catch(() => {});
        return;
    }

    // One message at a time per number, so steps and token refreshes never overlap.
    await lockHelper.withLock(`msg:${msg.sender}`, async () => {
        try {
            await handleMessage(msg);
        } catch (e) {
            if (e instanceof sessionHelper.SessionEndedError) {
                // Smatpay ended the session (expired, signed out elsewhere, password changed).
                const wasGuest = sessionHelper.isGuest(await userModel.findOne({where: {phone: '+' + msg.sender}}));
                await sessionHelper.clearSession('+' + msg.sender);
                if (wasGuest) {
                    await require('../helpers/whatsapp/onboardingHelper').sendAuthChoice(msg.sender).catch(() => {});
                    return;
                }
                await loginFlowHelper.send(msg.sender, 'login', 'expired').catch(() => {});
                return;
            }
            console.error('Webhook handling failed:', e.response ? `${e.message} ${JSON.stringify(e.response.data)}` : e);
            await messagingHelper.sendMessage(msg.sender, 'Something went wrong on our side. Please try again in a moment.').catch(() => {});
        }
    });
};
