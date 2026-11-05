const axios = require('axios');
const models = require('../../models');
const userModel = models.user;
const apiHelper = require('./apiHelper');

/**
 * Outgoing messages through 360dialog. Menus use interactive buttons and lists rather than
 * templates: replies inside the 24-hour customer service window need no template approval.
 */

// 360dialog answers 429 "Too many requests for one number" when messages to one person come too
// fast (e.g. a form finishing right after the message that opened it); wait and retry.
const RETRY_DELAYS_MS = [2000, 5000, 10000];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function send(to, payload) {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await axios.post(
                apiHelper.messagingEndpoint(),
                {messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload},
                {headers: apiHelper.headers(), timeout: 15000}
            );
            return {
                to: response.data.contacts?.[0]?.wa_id || to,
                messageId: response.data.messages?.[0]?.id || null,
            };
        } catch (error) {
            if (error.response?.status === 429 && attempt < RETRY_DELAYS_MS.length) {
                const retryAfter = Number(error.response.headers?.['retry-after']) * 1000;
                await sleep(retryAfter > 0 ? retryAfter : RETRY_DELAYS_MS[attempt]);
                continue;
            }
            console.error('Error sending message:', JSON.stringify(error.response?.data || error.message));
            throw error;
        }
    }
}

/** WhatsApp's limits: button titles 20 chars, list row titles 24, descriptions 72. */
function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

module.exports = {
    /** Records the step the bot is now waiting on. */
    setStep: async function (to, step, extra = {}) {
        await userModel.update(
            {last_bot_message: step, last_bot_timestamp: new Date(), ...extra},
            {where: {phone: '+' + to}}
        );
    },

    sendMessage: async function (to, body) {
        return send(to, {type: 'text', text: {body, preview_url: false}});
    },

    /** Up to 3 reply buttons: [{id, title}]. */
    sendButtons: async function (to, body, buttons, header = null) {
        const interactive = {
            type: 'button',
            body: {text: body},
            action: {
                buttons: buttons.slice(0, 3).map(b => ({type: 'reply', reply: {id: b.id, title: clip(b.title, 20)}})),
            },
        };
        if (header) interactive.header = {type: 'text', text: header};
        return send(to, {type: 'interactive', interactive});
    },

    /** Up to 10 rows in total: sections = [{title, rows: [{id, title, description}]}]. */
    sendList: async function (to, body, buttonText, sections, header = null) {
        const interactive = {
            type: 'list',
            body: {text: body},
            action: {
                button: clip(buttonText, 20),
                sections: sections.map(s => ({
                    title: clip(s.title, 24),
                    rows: s.rows.map(r => ({
                        id: r.id,
                        title: clip(r.title, 24),
                        ...(r.description ? {description: clip(r.description, 72)} : {}),
                    })),
                })),
            },
        };
        if (header) interactive.header = {type: 'text', text: header};
        return send(to, {type: 'interactive', interactive});
    },

    /** An image already uploaded to WhatsApp (mediaHelper.upload), with an optional caption. */
    sendImage: async function (to, mediaId, caption = null) {
        return send(to, {type: 'image', image: {id: mediaId, ...(caption ? {caption} : {})}});
    },

    /** A button that opens a URL. */
    sendLinkButton: async function (to, {url, cta, body, header = null}) {
        const interactive = {
            type: 'cta_url',
            body: {text: body},
            action: {name: 'cta_url', parameters: {display_text: clip(cta, 20), url}},
        };
        if (header) interactive.header = {type: 'text', text: header};
        return send(to, {type: 'interactive', interactive});
    },

    /**
     * Sends a form: a WhatsApp Flow when FORMS_MODE=flows, otherwise a button to the same form as a
     * web page on this server (/forms/<flow_token>).
     */
    sendForm: async function (to, {flowId, flowToken, cta, body, header = null}) {
        if (process.env.FORMS_MODE === 'flows') {
            return this.sendFlow(to, {flowId, flowToken, cta, body, header});
        }
        const baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
        return this.sendLinkButton(to, {url: `${baseUrl}/forms/${flowToken}`, cta, body, header});
    },

    /**
     * Opens a WhatsApp Flow. `data_exchange` makes WhatsApp ask our flow endpoint (INIT) for the
     * first screen, so forms can be prefilled.
     */
    sendFlow: async function (to, {flowId, flowToken, cta, body, header = null}) {
        const parameters = {
            flow_message_version: '3',
            flow_token: flowToken,
            flow_id: flowId,
            flow_cta: clip(cta, 20),
            flow_action: 'data_exchange',
        };
        if (process.env.FLOW_MODE === 'draft') parameters.mode = 'draft';
        const interactive = {
            type: 'flow',
            body: {text: body},
            action: {name: 'flow', parameters},
        };
        if (header) interactive.header = {type: 'text', text: header};
        return send(to, {type: 'interactive', interactive});
    },
};
