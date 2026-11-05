const {request} = require('./smatpayApiHelper');
const planeHelper = require('./planeHelper');

/**
 * Airtime, bundles, electricity and water, as Smatpay-Customer-Mobile-App calls them
 * (src/lib/api/vas.ts). Served by transaction_service CustomerVasController through
 * subscriber_customer_service.
 */

// Charge plus vend; the app allows a minute too.
const PURCHASE_TIMEOUT_MS = 60000;

module.exports = {
    /** [{code, name, accountLabel, accountPattern, currencies, minAmount, lookup, products}] */
    billers: async function (token) {
        const data = await request('get', `${planeHelper.vasBase()}/billers`, {token});
        return data.billers || [];
    },

    /** Whose meter it is: { account, customerName, address?, arrears? }. The biller can be slow. */
    lookup: async function (token, biller, account) {
        return request('post', `${planeHelper.vasBase()}/lookup`, {token, body: {biller, account}, timeoutMs: 15000});
    },

    /** { amount, fee, total, currency, expiresAt, quoteToken? } */
    quote: async function (token, body) {
        return request('post', `${planeHelper.vasBase()}/quote`, {token, body});
    },

    /** A purchase; FAILED comes back as a 422 SmatpayError carrying the reason. */
    purchase: async function (token, body, idempotencyKey) {
        return request('post', `${planeHelper.vasBase()}/purchase`, {
            token,
            body: {idempotencyKey, ...body},
            timeoutMs: PURCHASE_TIMEOUT_MS,
        });
    },

    getPurchase: async function (token, purchaseId) {
        return request('get', `${planeHelper.vasBase()}/purchase/${encodeURIComponent(purchaseId)}`, {token});
    },

    /** O'mari: the one-time code texted to the customer; paying it starts the vend. */
    submitOtp: async function (token, purchaseId, otp) {
        return request('post', `${planeHelper.vasBase()}/purchase/${encodeURIComponent(purchaseId)}/otp`, {
            token,
            body: {otp},
            timeoutMs: PURCHASE_TIMEOUT_MS,
        });
    },
};
