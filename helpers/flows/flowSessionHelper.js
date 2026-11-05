const {Op} = require('sequelize');
const models = require('../../models');
const flowSessionModel = models.flow_session;
const cryptoHelper = require('../cryptoHelper');

const TTL_MS = 60 * 60 * 1000;

module.exports = {
    /**
     * Starts a Flow for a phone and returns the raw flow_token to send. Older open ones are closed,
     * unless keepOpen: a card save on an earlier bank page can still finish after a new one starts.
     */
    create: async function (phone, flow, purpose = null, data = {}, {keepOpen = false} = {}) {
        if (!keepOpen) {
            await flowSessionModel.update(
                {status: 'superseded'},
                {where: {phone, flow, status: 'open'}}
            );
        }
        const token = cryptoHelper.randomToken();
        await flowSessionModel.create({
            token_hash: cryptoHelper.sha256(token),
            phone,
            flow,
            purpose,
            data,
            expires_at: new Date(Date.now() + TTL_MS),
        });
        return token;
    },

    /** The open, unexpired session for a flow_token, or null. */
    findOpen: async function (token) {
        if (!token) return null;
        return flowSessionModel.findOne({
            where: {
                token_hash: cryptoHelper.sha256(token),
                status: 'open',
                expires_at: {[Op.gt]: new Date()},
            },
        });
    },

    /** Any session for a flow_token; used when the finished form comes back through the webhook. */
    findAny: async function (token) {
        if (!token) return null;
        return flowSessionModel.findOne({where: {token_hash: cryptoHelper.sha256(token)}});
    },

    saveData: async function (session, patch) {
        session.data = {...session.data, ...patch};
        await session.save();
    },

    complete: async function (session, result) {
        session.status = 'completed';
        session.completed_at = new Date();
        session.data = {...session.data, result};
        await session.save();
    },

    /** Tells WhatsApp to close the form; `params` come back to us in the webhook's nfm_reply. */
    closeResponse: function (flowToken, params = {}) {
        return {
            screen: 'SUCCESS',
            data: {extension_message_response: {params: {flow_token: flowToken, ...params}}},
        };
    },

    /** Screen data with an error line; every form screen declares has_error and error_message. */
    screen: function (name, data = {}, error = null) {
        return {screen: name, data: {...data, has_error: Boolean(error), error_message: error || ''}};
    },
};
