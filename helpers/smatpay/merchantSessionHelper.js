const models = require('../../models');
const userModel = models.user;
const merchantApi = require('./merchantApiHelper');
const planeHelper = require('./planeHelper');
const sessionHelper = require('./sessionHelper');
const cryptoHelper = require('../cryptoHelper');
const lockHelper = require('../lockHelper');

/**
 * A merchant's session on the bot: their keys (encrypted) and a token from key sign-in, renewed
 * with the keys whenever it's close to its 5-hour expiry. No code and no password are needed.
 */

const TOKEN_MARGIN_MS = 5 * 60 * 1000;

class MerchantNotReadyError extends Error {
    constructor(message = 'Your merchant account isn’t set up on WhatsApp yet.') {
        super(message);
        this.name = 'MerchantNotReadyError';
    }
}

module.exports = {
    MerchantNotReadyError,

    keys: function (user) {
        const raw = cryptoHelper.decrypt(user?.merchant_keys_enc);
        return raw ? JSON.parse(raw) : null;
    },

    hasKeys: function (user) {
        const keys = this.keys(user);
        return Boolean(keys && (planeHelper.isSandbox() ? keys.sandbox?.key : keys.production?.key));
    },

    /** Stores a merchant account (from /api/merchant/profile) against this number. */
    saveAccount: async function (phone, userId, account) {
        const keys = {
            merchantId: account.accountMerchantId,
            sandbox: {key: account.accountMerchantKey || null, apiKey: account.accountAPIKey || null},
            production: {key: account.accountMerchantKeyProduction || null, apiKey: account.accountAPIKeyProduction || null},
        };
        await userModel.update({
            user_type: 'merchant',
            merchant_user_id: userId,
            merchant_account_id: account.id,
            merchant_id: account.accountMerchantId,
            merchant_name: account.tradingName || account.registeredLegalCompanyName || null,
            merchant_approved: account.accountApproved === true,
            merchant_keys_enc: cryptoHelper.encrypt(JSON.stringify(keys)),
            merchant_token_enc: null,
            merchant_token_expires_at: null,
        }, {where: {phone}});
    },

    /** A usable merchant token for the current plane, from key sign-in. */
    getToken: async function (phone) {
        return lockHelper.withLock(`merchant:${phone}`, async () => {
            const user = await userModel.findOne({where: {phone}});
            const expiresAt = user?.merchant_token_expires_at ? new Date(user.merchant_token_expires_at).getTime() : 0;
            if (user?.merchant_token_enc && expiresAt - Date.now() > TOKEN_MARGIN_MS) {
                return cryptoHelper.decrypt(user.merchant_token_enc);
            }
            const keys = this.keys(user);
            const pair = planeHelper.isSandbox() ? keys?.sandbox : keys?.production;
            if (!keys?.merchantId || !pair?.key || !pair?.apiKey) {
                throw new MerchantNotReadyError(planeHelper.isSandbox()
                    ? 'Your merchant account isn’t set up on WhatsApp yet.'
                    : 'Your business isn’t approved for live payments yet.');
            }
            const auth = await merchantApi.keyLogin(keys.merchantId, pair.key, pair.apiKey);
            await user.update({
                merchant_token_enc: cryptoHelper.encrypt(auth.token),
                merchant_token_expires_at: sessionHelper.jwtExpiry(auth.token),
            });
            return auth.token;
        });
    },

    /**
     * Runs a merchant call with the token. Smatpay keeps only the latest key sign-in per merchant,
     * so anything else signing in with the same keys (some Smatpay endpoints do it internally)
     * replaces the bot's token: on a 401, sign in again and retry once.
     */
    withToken: async function (phone, call) {
        const token = await this.getToken(phone);
        try {
            return await call(token);
        } catch (e) {
            if (e.status !== 401) throw e;
            await userModel.update({merchant_token_enc: null, merchant_token_expires_at: null}, {where: {phone}});
            return call(await this.getToken(phone));
        }
    },

    signOut: async function (phone) {
        await userModel.update({
            user_type: null,
            merchant_user_id: null, merchant_account_id: null, merchant_id: null, merchant_name: null,
            merchant_approved: false, merchant_keys_enc: null, merchant_token_enc: null, merchant_token_expires_at: null,
        }, {where: {phone}});
    },
};
