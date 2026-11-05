const axios = require('axios');

/**
 * Calls to subscriber_customer_service, the same ones Smatpay-Customer-Mobile-App makes
 * (src/lib/api/auth.ts). Every failure is a SmatpayError whose message can go to the user.
 */

// Flow endpoints must answer WhatsApp within 10 seconds.
const DEFAULT_TIMEOUT_MS = 8000;

class SmatpayError extends Error {
    constructor(message, code = 'unknown', status = 0) {
        super(message);
        this.name = 'SmatpayError';
        this.code = code;
        this.status = status;
    }
}

/** Unwraps `Gson().toJson(list.toString())` validation errors, as the app does. */
function cleanMessage(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let text = raw.trim();
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
    const joined = text.split(/,\s*(?=[A-Z])/).map(p => p.trim()).filter(Boolean).join('. ');
    return /[.!?]$/.test(joined) ? joined : `${joined}.`;
}

function messageFromBody(body, fallback) {
    if (body && typeof body === 'object') {
        return cleanMessage(body.errorResponse?.errorMessage) ?? cleanMessage(body.message) ?? fallback;
    }
    return fallback;
}

async function request(method, path, {body, token, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
    const baseUrl = (process.env.SMATPAY_API_URL || '').replace(/\/+$/, '');
    const headers = {Accept: 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
        response = await axios({
            method,
            url: `${baseUrl}${path}`,
            data: body,
            headers,
            timeout: timeoutMs,
            validateStatus: () => true,
        });
    } catch (e) {
        if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
            throw new SmatpayError('Smatpay took too long to answer. Please try again.', 'timeout');
        }
        throw new SmatpayError('We could not reach Smatpay. Please try again shortly.', 'network');
    }

    const {status, data} = response;
    if (status >= 200 && status < 300) return data;
    if (status === 401) {
        throw new SmatpayError(messageFromBody(data, 'Please sign in again.'), 'unauthorized', 401);
    }
    if (status >= 500) {
        // Keep the reason for the logs (and for callers that want to show it); users get a plain message.
        const reason = messageFromBody(data, typeof data === 'string' ? data.slice(0, 300) : '');
        console.error(`Smatpay ${method.toUpperCase()} ${path.split('?')[0]} → ${status}: ${reason || '(no message)'}`);
        const error = new SmatpayError('Smatpay is having trouble right now. Please try again shortly.', 'server', status);
        error.reason = reason;
        throw error;
    }
    throw new SmatpayError(messageFromBody(data, 'That request could not be completed.'), 'validation', status);
}

/** Backend: "Success"/"Verified" ok, "Failed"/"false" not. */
function expectSuccess(response, fallback) {
    if (!response || response.status === 'Failed' || response.status === 'false') {
        throw new SmatpayError(cleanMessage(response?.message) || fallback, 'validation', 400);
    }
    return response;
}

module.exports = {
    SmatpayError,
    request,

    /** Returns { token, refreshToken, refreshTokenExpiresAt, user }. */
    login: async function (email, password) {
        const res = await request('post', '/subscriber/customer/login', {
            body: {email: email.trim().toLowerCase(), password},
        });
        if (!res?.token) {
            throw new SmatpayError(res?.errorResponse?.errorMessage || 'Incorrect email or password.', 'unauthorized', 401);
        }
        return res;
    },

    /** "Email already exists!" comes back as a 400, i.e. a 'validation' SmatpayError. */
    signup: async function ({firstName, lastName, email, phoneNumber, password}) {
        const res = await request('post', '/subscriber/customer/signup', {
            body: {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.trim().toLowerCase(),
                phoneNumber,
                password,
            },
        });
        return expectSuccess(res, 'Sign up failed. Please try again.');
    },

    verifyAccount: async function (userId, otpCode) {
        try {
            const res = await request('post', `/subscriber/customer/verify/account/${userId}/${encodeURIComponent(otpCode)}`);
            return expectSuccess(res, 'That code is not right. Check the email and try again.');
        } catch (e) {
            // A wrong code is a 404 "User not found or token invalid".
            if (e instanceof SmatpayError && e.status === 404) {
                throw new SmatpayError('That code is not right. Check the email and try again.', 'validation', 404);
            }
            throw e;
        }
    },

    resendActivation: async function (email) {
        const res = await request('post', '/subscriber/customer/resendActivation', {
            body: {email: email.trim().toLowerCase()},
        });
        return expectSuccess(res, 'We could not send a new code. Please try again.');
    },

    /** A new access and refresh token; null when Smatpay has ended the session. */
    refresh: async function (refreshToken) {
        try {
            const res = await request('post', '/subscriber/customer/token/refresh', {body: {refreshToken}});
            return res?.token ? res : null;
        } catch (e) {
            if (e instanceof SmatpayError && e.code === 'unauthorized') return null;
            throw e;
        }
    },

    /**
     * A guest session, as the app's "Continue as guest": buy and pay only, no history or saved
     * cards. Short-lived and never refreshed; asking again with the same key renews it.
     */
    guest: async function (deviceKey) {
        const res = await request('post', '/subscriber/customer/guest', {body: {deviceKey}});
        if (!res?.token) {
            throw new SmatpayError(res?.errorResponse?.errorMessage || 'Guest checkout is unavailable right now.', 'validation', 400);
        }
        return res;
    },

    /** Ends the session on Smatpay; never throws. */
    logout: async function (refreshToken) {
        try {
            await request('post', '/subscriber/customer/logout', {body: {refreshToken}});
        } catch (e) {
            console.error('Smatpay logout failed:', e.message);
        }
    },
};
