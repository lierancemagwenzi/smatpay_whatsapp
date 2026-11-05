const crypto = require('crypto');
const {request, SmatpayError} = require('./smatpayApiHelper');
const planeHelper = require('./planeHelper');

/**
 * Saved cards, as Smatpay-Customer-Mobile-App calls them (src/lib/api/cards.ts). A card is added
 * on the bank's own hosted page (a zero-value tokenisation); it's never typed into WhatsApp.
 */


module.exports = {
    /** [{id, brand, last4, expiryMonth, expiryYear, holderName, isActive, isDefault}] */
    list: async function (token) {
        const res = await request('get', planeHelper.customerCardsBase(), {token});
        return res.cards || [];
    },

    setDefault: async function (token, id) {
        const res = await request('put', `${planeHelper.customerCardsBase()}/${id}/default`, {token});
        return res.cards || [];
    },

    /**
     * Starts a card save on the bank's page. The backend still takes the owner from this body
     * (not the JWT), exactly as the app sends it. Returns { reference, url }.
     */
    startTokenization: async function (owner, brand) {
        // A guest's (GST…) card is charged once and expires on the server after 30 minutes.
        if (!/^(CUS|GST)/i.test(owner.customerNumber || '')) {
            throw new SmatpayError('Activate your account before adding a card.', 'validation', 400);
        }
        const reference = `CARD-TOKEN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const res = await request('post', `${planeHelper.cardsBase()}/authenticate/merchant/wallet/tokenize-card`, {
            body: {
                walletName: brand,
                amount: '0.00',
                paymentCurrency: 'USD',
                paymentDescription: 'Save card for future payments',
                payerName: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || 'Guest',
                payerReference: reference,
                customerNumber: owner.customerNumber,
                customerEmail: owner.email,
                setDirectSubscription: true,
            },
            timeoutMs: 20000,
        });
        const init = res?.paymentInitiationResponse;
        const url = (brand === 'MASTERCARD' ? init?.paymentMasterCardSkinnedUrl : init?.paymentVisaSkinnedUrl) || init?.paymentRedirectUrl;
        if (init?.status !== 'Success' || !url) {
            throw new SmatpayError(res?.errorResponse?.errorMessage || 'We couldn’t start adding your card. Please try again.', 'server', 502);
        }
        return {reference, url};
    },

    /**
     * { status, reason }: PENDING until the customer finishes on the bank's page; VERIFIED means the
     * card passed; FAILED carries the bank's reason, e.g. "Authentication could not be completed".
     */
    tokenizationStatus: async function (reference) {
        const rows = await request('post', `${planeHelper.cardsBase()}/trackPaymentTransaction`, {body: {transactionReference: reference}});
        const row = Array.isArray(rows) ? rows[0] : undefined;
        const status = row?.status?.toLowerCase();
        if (status === 'paid' || status === 'success') return {status: 'VERIFIED'};
        if (status === 'failed' || status === 'expired' || status === 'cancelled') return {status: 'FAILED', reason: row.description || null};
        return {status: 'PENDING'};
    },

    /** "Visa •••• 4242". */
    label: function (card) {
        const brand = card.brand === 'MASTERCARD' ? 'Mastercard' : card.brand === 'VISA' ? 'Visa' : 'Card';
        return `${brand} •••• ${card.last4}`;
    },
};
