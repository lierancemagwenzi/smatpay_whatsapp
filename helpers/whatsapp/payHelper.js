const messagingHelper = require('./messagingHelper');
const mediaHelper = require('./mediaHelper');
const payApi = require('../smatpay/payApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');

/**
 * Pay a merchant: the customer sends the merchant's Smatpay payment link, the code under their QR,
 * or a photo of the QR (the app scans it). The link is resolved to show who's being paid, the
 * amount is taken from the link or typed, and the rest (how to pay, quote, PIN, following the
 * payment) is the shared purchase flow in vasHelper.
 */

const STEPS = {
    enterCode: 'pay_enter_code',
    enterAmount: 'pay_enter_amount',
};

const cancelButton = {id: 'VAS_CANCEL', title: 'Cancel'};

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

/** Why a resolved link can't be paid here, as the app's linkProblem. */
function linkProblem(link) {
    if (link.isActive === false) return 'This payment link has been switched off by the merchant.';
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) return 'This payment link has expired.';
    if (link.spent) return 'This payment link has already been paid.';
    if (link.type === 'SUBSCRIPTION_AMOUNT') return 'Subscriptions can’t be set up on WhatsApp yet. Open the link in your browser.';
    return null;
}

/** "*Pay Tariro’s Store*" plus address and what it's for. */
function merchantLines(link) {
    return [
        `*Pay ${link.merchant?.name || 'merchant'}*`,
        link.merchant?.address || null,
        link.reference ? `For: ${payApi.shortReference(link.reference)}` : null,
    ].filter(Boolean);
}

module.exports = {
    STEPS,

    ownsStep: function (step) {
        return Object.values(STEPS).includes(step);
    },

    /** A pasted link or till QR text, recognised anywhere in the chat (bare codes only when asked for). */
    looksLikePaymentCode: function (text) {
        const code = payApi.parseCode(text);
        return Boolean(code && !code.short) || /smatpay\.africa\/auth\//i.test(text || '');
    },

    start: async function (msg, user) {
        await user.update({draft: {service: 'pay'}});
        await messagingHelper.sendButtons(msg.sender,
            'Send the merchant’s Smatpay payment link, the code printed under their QR, or a photo of the QR code.',
            [cancelButton], 'Pay a merchant');
        await messagingHelper.setStep(msg.sender, STEPS.enterCode);
    },

    /** A link or code; returns false when the text isn't one (and nothing was sent). */
    handleCode: async function (msg, user, raw) {
        const code = payApi.parseCode(raw);
        if (!code) {
            await messagingHelper.sendButtons(msg.sender,
                'That doesn’t look like a Smatpay payment link or code. Paste the link, type the code under the QR, or send a photo of the QR.',
                [cancelButton]);
            await messagingHelper.setStep(msg.sender, STEPS.enterCode);
            return;
        }

        let link;
        try {
            link = await sessionHelper.withSession(user.phone, token => payApi.resolve(token, code));
        } catch (e) {
            if (e instanceof sessionHelper.SessionEndedError) throw e;
            await messagingHelper.sendButtons(msg.sender, `${String(e.message).replace(/[.\s]*$/, '.')} Check the link or code and send it again.`, [cancelButton]);
            await messagingHelper.setStep(msg.sender, STEPS.enterCode);
            return;
        }
        const problem = linkProblem(link);
        if (problem) {
            await user.update({draft: null});
            await messagingHelper.setStep(msg.sender, 'main_menu');
            return messagingHelper.sendButtons(msg.sender, problem, [{id: 'MAIN_MENU', title: 'Main menu'}]);
        }

        const vasHelper = require('./vasHelper');
        const draft = {
            service: 'pay',
            link: {
                token: link.token,
                type: link.type,
                reference: link.reference || null,
                merchant: {id: link.merchant?.id, name: link.merchant?.name, address: link.merchant?.address || null},
            },
            billerName: link.merchant?.name || 'Merchant',
            currency: link.currency,
            currencies: [link.currency],
        };

        if (link.type !== 'OPEN_DYNAMIC_AMOUNT' && link.amount) {
            await vasHelper.saveDraft(user, {...draft, amount: Number(link.amount).toFixed(2)}, vasHelper.STEPS.chooseMethod);
            return vasHelper.askMethod(msg, user, [...merchantLines(link), `Amount: ${money(link.amount, link.currency)}`, '', 'How would you like to pay?'].join('\n'));
        }
        await vasHelper.saveDraft(user, draft, STEPS.enterAmount);
        return messagingHelper.sendButtons(msg.sender,
            [...merchantLines(link), '', `How much are you paying, in ${link.currency}? Type the amount on the till, e.g. 5.00.`].join('\n'),
            [cancelButton]);
    },

    /** A photo: read the QR in it and carry on as if the code had been typed. */
    handleImage: async function (msg, user) {
        let text = null;
        try {
            const {buffer, mimeType} = await mediaHelper.download(msg.content.mediaId);
            text = mediaHelper.readQr(buffer, mimeType || msg.content.mimeType);
        } catch (e) {
            console.error('Reading a QR photo failed:', e.response ? `${e.message} ${JSON.stringify(e.response.data)}` : e.message);
        }
        if (!text) {
            await user.update({draft: {service: 'pay'}});
            await messagingHelper.setStep(msg.sender, STEPS.enterCode);
            return messagingHelper.sendButtons(msg.sender,
                'I couldn’t read a QR code in that photo. Send a closer, sharper photo of just the QR, or paste the payment link.',
                [cancelButton]);
        }
        return this.handleCode(msg, user, text);
    },

    saveAmount: async function (msg, user, raw) {
        const text = String(raw || '').replace(/[^\d.]/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
            return messagingHelper.sendMessage(msg.sender, 'Type the amount as a number, e.g. 5.00.');
        }
        // Set when Smatpay refused a smaller amount for this merchant.
        if (user.draft.minAmount && Number(text) < Number(user.draft.minAmount)) {
            return messagingHelper.sendMessage(msg.sender, `The minimum is ${money(user.draft.minAmount, user.draft.currency)}. Type a higher amount.`);
        }
        const vasHelper = require('./vasHelper');
        const draft = await vasHelper.saveDraft(user, {amount: Number(text).toFixed(2)}, vasHelper.STEPS.chooseMethod);
        return vasHelper.askMethod(msg, user, `Paying ${money(draft.amount, draft.currency)} to ${draft.billerName}.\n\nHow would you like to pay?`);
    },

    manageInput: async function (msg, user) {
        if (user.last_bot_message === STEPS.enterAmount && user.draft?.link) return this.saveAmount(msg, user, msg.content.text);
        return this.handleCode(msg, user, msg.content.text);
    },
};
