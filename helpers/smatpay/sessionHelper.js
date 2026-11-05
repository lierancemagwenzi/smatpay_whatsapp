const crypto = require('crypto');
const {Op} = require('sequelize');
const models = require('../../models');
const userModel = models.user;
const smatpayApi = require('./smatpayApiHelper');
const cryptoHelper = require('../cryptoHelper');
const lockHelper = require('../lockHelper');

/**
 * The Smatpay session behind a WhatsApp number.
 *
 * Access tokens last 5 hours. Refresh tokens last 30 days, are rotated on every use, and reusing
 * a rotated one more than 30 seconds later ends the whole session on Smatpay
 * (subscriber_customer_service CustomerRefreshTokenService). So: one refresh per user at a time,
 * and the new tokens are saved before anything else happens.
 *
 * A guest (no account) has a short-lived token and no refresh token: it is renewed by asking
 * Smatpay for a new guest session with the number's stored device key.
 */

// Refresh this long before the access token expires.
const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;
// The daily job renews refresh tokens that expire within this window.
const KEEPALIVE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/** `exp` from a JWT, without verifying it; Smatpay does that. */
function jwtExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload.exp ? new Date(payload.exp * 1000) : null;
    } catch {
        return null;
    }
}

function refreshLockKey(phone) {
    return `refresh:${phone}`;
}

/** The Smatpay session is gone; the user has to sign in again. */
class SessionEndedError extends Error {
    constructor() {
        super('Your Smatpay session has ended. Please sign in again.');
        this.name = 'SessionEndedError';
    }
}

module.exports = {
    jwtExpiry,
    SessionEndedError,

    /**
     * Runs an authenticated Smatpay call with this number's session. A 401 gets one refresh and
     * one retry; SessionEndedError means the user must sign in again.
     */
    withSession: async function (phone, call) {
        const token = await this.getAccessToken(phone);
        if (!token) throw new SessionEndedError();
        try {
            return await call(token);
        } catch (e) {
            if (e.code !== 'unauthorized') throw e;
            const fresh = await this.refresh(phone);
            if (!fresh) throw new SessionEndedError();
            return call(fresh);
        }
    },

    isSignedIn: function (user) {
        return Boolean(user && (user.refresh_token_enc || user.guest_key_enc));
    },

    /** Buying without an account. */
    isGuest: function (user) {
        return Boolean(user && user.guest_key_enc && !user.refresh_token_enc);
    },

    /** Starts (or renews) this number's guest session; one device key per number, kept encrypted. */
    startGuest: async function (phone) {
        return lockHelper.withLock(refreshLockKey(phone), async () => {
            const fresh = await userModel.findOne({where: {phone}});
            let key = cryptoHelper.decrypt(fresh?.guest_key_enc);
            if (!key) key = crypto.randomBytes(32).toString('hex');
            const auth = await smatpayApi.guest(key);
            await userModel.update({
                guest_key_enc: cryptoHelper.encrypt(key),
                customer_number: auth.user?.customerNumber || null,
                first_name: null,
                last_name: null,
                email: null,
                activation_activated: true,
                access_token_enc: cryptoHelper.encrypt(auth.token),
                access_token_expires_at: jwtExpiry(auth.token),
                refresh_token_enc: null,
                refresh_token_expires_at: null,
            }, {where: {phone}});
            return auth.token;
        });
    },

    /** Stores a login or refresh response. */
    saveSession: async function (phone, auth) {
        const u = auth.user || {};
        await userModel.update(
            {
                smatpay_user_id: u.id,
                email: u.email,
                first_name: u.firstName,
                last_name: u.lastName,
                customer_number: u.customerNumber || null,
                activation_activated: u.activationActivated === true,
                access_token_enc: cryptoHelper.encrypt(auth.token),
                access_token_expires_at: jwtExpiry(auth.token),
                refresh_token_enc: cryptoHelper.encrypt(auth.refreshToken),
                refresh_token_expires_at: auth.refreshTokenExpiresAt ? new Date(auth.refreshTokenExpiresAt) : null,
                // Signing in or up ends guest mode.
                guest_key_enc: null,
            },
            {where: {phone}}
        );
    },

    clearSession: async function (phone) {
        await userModel.update(
            {
                guest_key_enc: null,
                access_token_enc: null,
                access_token_expires_at: null,
                refresh_token_enc: null,
                refresh_token_expires_at: null,
            },
            {where: {phone}}
        );
    },

    /**
     * Swaps the refresh token for new tokens. Returns the new access token, or null when Smatpay
     * ended the session (the stored session is then cleared). Network errors are thrown and the
     * stored session is kept for the next try.
     */
    refresh: async function (phone) {
        const current = await userModel.findOne({where: {phone}});
        if (this.isGuest(current)) return this.startGuest(phone);
        return lockHelper.withLock(refreshLockKey(phone), async () => {
            const fresh = await userModel.findOne({where: {phone}});
            const refreshToken = cryptoHelper.decrypt(fresh?.refresh_token_enc);
            if (!refreshToken) return null;
            const auth = await smatpayApi.refresh(refreshToken);
            if (!auth) {
                await this.clearSession(phone);
                return null;
            }
            await this.saveSession(phone, auth);
            return auth.token;
        });
    },

    /** A usable access token, refreshed when close to expiry; null means "sign in again". */
    getAccessToken: async function (phone) {
        const fresh = await userModel.findOne({where: {phone}});
        if (!this.isSignedIn(fresh)) return null;
        const expiresAt = fresh.access_token_expires_at ? new Date(fresh.access_token_expires_at).getTime() : 0;
        if (expiresAt - Date.now() > ACCESS_TOKEN_MARGIN_MS) {
            return cryptoHelper.decrypt(fresh.access_token_enc);
        }
        return this.refresh(phone);
    },

    signOut: async function (phone) {
        const fresh = await userModel.findOne({where: {phone}});
        const refreshToken = cryptoHelper.decrypt(fresh?.refresh_token_enc);
        await this.clearSession(phone);
        if (refreshToken) await smatpayApi.logout(refreshToken);
    },

    /**
     * Keeps active users signed in: renews refresh tokens that are about to expire for users who
     * messaged within SESSION_KEEPALIVE_DAYS. Everyone else is left to expire.
     */
    renewExpiringSessions: async function () {
        const keepaliveDays = Number(process.env.SESSION_KEEPALIVE_DAYS || 90);
        const now = Date.now();
        const due = await userModel.findAll({
            attributes: ['phone'],
            where: {
                refresh_token_enc: {[Op.ne]: null},
                refresh_token_expires_at: {[Op.lt]: new Date(now + KEEPALIVE_WINDOW_MS)},
                last_user_timestamp: {[Op.gt]: new Date(now - keepaliveDays * 24 * 60 * 60 * 1000)},
            },
        });
        let renewed = 0;
        let ended = 0;
        for (const {phone} of due) {
            try {
                const token = await this.refresh(phone);
                token ? renewed++ : ended++;
            } catch (e) {
                // Still valid for a few more days; the next run tries again.
                console.error(`Session renewal failed for ${phone}:`, e.message);
            }
        }
        return {due: due.length, renewed, ended};
    },
};
