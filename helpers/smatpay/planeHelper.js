/**
 * Which Smatpay plane the bot talks to, as the app's src/lib/api/plane.ts: `production` (real
 * cards, real money) or `sandbox` (simulated payment outcomes, for testing). Set with
 * SMATPAY_PLANE. It applies to every call: cards saved in one plane don't exist in the other.
 */
module.exports = {
    isSandbox: function () {
        return process.env.SMATPAY_PLANE === 'sandbox';
    },

    /** Airtime, bundles, electricity and water. */
    vasBase: function () {
        return this.isSandbox() ? '/subscriber/api/customer/sandbox/vas' : '/subscriber/api/customer/vas';
    },

    /** Merchant reports and balances on transaction_service, or its sandbox twin. */
    merchantApiBase: function () {
        return this.isSandbox() ? '/sandbox/api' : '/api';
    },

    /** Paying merchants. */
    payBase: function () {
        return this.isSandbox() ? '/subscriber/api/customer/sandbox/pay' : '/subscriber/api/customer/pay';
    },

    /** The customer's saved cards. */
    customerCardsBase: function () {
        return this.isSandbox() ? '/subscriber/api/customer/sandbox/cards' : '/subscriber/api/customer/cards';
    },

    /** History sources; sandbox also shows production rows, labelled, as the app does. */
    transactionsSources: function () {
        return this.isSandbox()
            ? [
                {plane: 'sandbox', base: '/subscriber/api/customer/sandbox/transactions'},
                {plane: 'production', base: '/subscriber/api/customer/transactions'},
            ]
            : [{plane: 'production', base: '/subscriber/api/customer/transactions'}];
    },

    /** Card tokenisation and payment tracking on transaction_service or its sandbox twin. */
    cardsBase: function () {
        return this.isSandbox() ? '/sandbox/init' : '/init';
    },
};
