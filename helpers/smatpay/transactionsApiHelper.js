const {request} = require('./smatpayApiHelper');
const planeHelper = require('./planeHelper');

/**
 * The customer's history, as the app reads it (src/lib/api/transactions.ts):
 * GET /subscriber/api/customer/transactions, one page per plane, merged newest first.
 * The customer is identified by the JWT.
 */

/** Vendor codes the backend may send when a biller isn't in its catalogue. */
const VENDOR_BILLERS = {NET1: 'NETONE_AIRTIME', ECONET: 'ECONET_AIRTIME', ZETDC_PREPAID: 'ZESA', COH_PREPAID: 'WATER'};
const PROVIDERS = {ECONET: 'Econet', NETONE: 'NetOne', ZESA: 'ZESA', WATER: 'Council'};

function kind(row, biller) {
    if (row.type === 'PAYMENT') return 'PAYMENT';
    if (biller.includes('BUNDLE')) return 'BUNDLES';
    if (biller.includes('AIRTIME')) return 'AIRTIME';
    if (biller.includes('WATER')) return 'WATER';
    return 'ELECTRICITY';
}

function provider(biller) {
    const head = biller.split('_')[0];
    return PROVIDERS[head] || (head ? head.charAt(0) + head.slice(1).toLowerCase() : 'Smatpay');
}

/** A history row in the shape the chat needs. */
function toTransaction(row, plane) {
    const raw = row.vas?.biller || '';
    const biller = VENDOR_BILLERS[raw.toUpperCase()] || raw;
    const type = kind(row, biller);
    return {
        id: row.id,
        plane,
        type,
        provider: type === 'PAYMENT' ? row.merchant?.name || 'Merchant' : provider(biller),
        description: row.description,
        target: type === 'PAYMENT' ? row.description : row.vas?.account || row.description,
        amount: row.amount,
        fee: row.fee,
        currency: row.currency,
        status: row.status,
        method: row.paymentMethod?.label || row.paymentMethod?.type || null,
        token: row.vas?.token || null,
        units: row.vas?.units || null,
        reference: row.reference,
        createdAt: row.createdAt,
    };
}

module.exports = {
    /** The most recent history across this plane's sources; one source down still shows the other. */
    list: async function (token, pageSize = 10) {
        const sources = planeHelper.transactionsSources();
        const params = new URLSearchParams({pageNo: '1', pageSize: String(pageSize)});
        const results = await Promise.allSettled(sources.map(async ({plane, base}) => {
            const page = await request('get', `${base}?${params}`, {token});
            return (page.content || [])
                .filter(row => row.type === 'VAS' || row.type === 'PAYMENT')
                .map(row => toTransaction(row, plane));
        }));
        const loaded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        if (!loaded.length) throw results[0].reason;
        return {
            merged: sources.length > 1,
            transactions: loaded.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        };
    },
};
