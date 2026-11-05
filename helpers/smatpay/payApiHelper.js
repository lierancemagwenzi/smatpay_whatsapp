const {request} = require('./smatpayApiHelper');
const planeHelper = require('./planeHelper');

/**
 * Paying a merchant, as Smatpay-Customer-Mobile-App does it (src/lib/api/payments.ts). Served by
 * transaction_service CustomerPayController through subscriber_customer_service.
 */

const PAY_TIMEOUT_MS = 60000;

/** Payment-link tokens look like `<base64url>-<id>`; short links `/auth/<code>` or `/auth/s/<code>`. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}-\d+$/;
const SHORT_PATH_RE = /^\/auth\/(?:s\/)?([A-Za-z0-9]{1,12})\/?$/;
const SHORT_CODE_RE = /^[A-Za-z0-9]{4,12}$/;

module.exports = {
    /**
     * What a pasted link, a typed code or a scanned QR refers to, as the resolve body:
     * { token } | { short } | { transactionReference }, or null when it isn't a Smatpay code.
     */
    parseCode: function (raw) {
        const text = String(raw || '').trim();
        if (!text) return null;

        // A merchant till QR: {"transactionReference": "POS-…", "merchantId", "amount", "currency"}.
        if (text.startsWith('{')) {
            try {
                const data = JSON.parse(text);
                return typeof data?.transactionReference === 'string' && data.transactionReference.trim()
                    ? {transactionReference: data.transactionReference.trim()}
                    : null;
            } catch {
                return null;
            }
        }
        if (/^POS-[A-Za-z0-9-]+$/i.test(text)) return {transactionReference: text};
        if (TOKEN_RE.test(text)) return {token: text};

        let url = null;
        try {
            url = new URL(text.includes('://') ? text : `https://${text}`);
        } catch {
            url = null;
        }
        if (url && /(^|\.)smatpay\.africa$/i.test(url.hostname)) {
            const token = url.searchParams.get('token');
            if (token && TOKEN_RE.test(token)) return {token};
            const short = SHORT_PATH_RE.exec(url.pathname);
            if (short) return {short: short[1]};
            return null;
        }
        // The code printed under a merchant's QR.
        if (SHORT_CODE_RE.test(text) && /\d/.test(text)) return {short: text};
        return null;
    },

    /** { token, type, reference, merchant: {id, name, address…}, amount?, currency, isActive, spent, expiresAt } */
    resolve: async function (token, code) {
        return request('post', `${planeHelper.payBase()}/resolve`, {token, body: code});
    },

    /** { amount, fee, total, currency, expiresAt, quoteToken? } */
    quote: async function (token, body) {
        return request('post', `${planeHelper.payBase()}/quote`, {token, body});
    },

    /** A payment; FAILED comes back as a 422 SmatpayError carrying the reason. */
    pay: async function (token, body, idempotencyKey) {
        return request('post', `${planeHelper.payBase()}/pay`, {token, body: {idempotencyKey, ...body}, timeoutMs: PAY_TIMEOUT_MS});
    },

    getPayment: async function (token, paymentId) {
        return request('get', `${planeHelper.payBase()}/${encodeURIComponent(paymentId)}`, {token});
    },

    submitOtp: async function (token, paymentId, otp) {
        return request('post', `${planeHelper.payBase()}/${encodeURIComponent(paymentId)}/otp`, {token, body: {otp}, timeoutMs: PAY_TIMEOUT_MS});
    },

    /** "POS-e8ca84c9-c49e-4a3d-…" → "POS-e8ca84c9" for display; other references are left as they are. */
    shortReference: function (reference) {
        const match = /^(POS-[0-9a-f]{8})-[0-9a-f-]+$/i.exec(String(reference || ''));
        return match ? match[1] : reference;
    },

    /** A payment in the shape the purchase follow-up understands (PENDING → PENDING_PAYMENT). */
    asPurchase: function (payment) {
        return {
            ...payment,
            purchaseId: payment.paymentId,
            status: payment.status === 'PENDING' ? 'PENDING_PAYMENT' : payment.status,
            result: null,
        };
    },
};
