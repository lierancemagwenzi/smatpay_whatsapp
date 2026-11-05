const messagingHelper = require('./messagingHelper');
const transactionsApi = require('../smatpay/transactionsApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');

/** Main menu → Transactions: the latest history as a list; tapping one shows its details. */

const LIST_SIZE = 10;
const STATUS = {
    SUCCESS: 'Successful',
    PENDING: 'Pending',
    NEEDS_ATTENTION: 'Being checked',
    FAILED: 'Failed',
    REVERSED: 'Refunded',
};
const WHAT = {AIRTIME: 'airtime', BUNDLES: 'data', ELECTRICITY: 'electricity', WATER: 'water', PAYMENT: 'payment'};

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

/** 263782801353 → 0782801353, for numbers; anything else unchanged. */
function account(value) {
    const digits = String(value || '');
    return /^2637\d{8}$/.test(digits) ? `0${digits.slice(3)}` : digits;
}

function when(iso, withYear = false) {
    return new Date(iso).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', ...(withYear ? {year: 'numeric'} : {}),
        hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare',
    });
}

function title(t) {
    return t.type === 'PAYMENT' ? `${t.provider}` : `${t.provider} ${WHAT[t.type]}`;
}

const buttons = [
    {id: 'MENU_TRANSACTIONS', title: 'Transactions'},
    {id: 'MAIN_MENU', title: 'Main menu'},
];

module.exports = {
    handlesPayload: function (payload) {
        return /^TXN:/.test(payload || '');
    },

    list: async function (msg, user) {
        const {merged, transactions} = await sessionHelper.withSession(user.phone, token => transactionsApi.list(token, LIST_SIZE));
        if (!transactions.length) {
            return messagingHelper.sendButtons(msg.sender, 'You have no transactions yet.', [
                {id: 'MENU_AIRTIME', title: 'Buy airtime'},
                {id: 'MAIN_MENU', title: 'Main menu'},
            ]);
        }
        const rows = transactions.slice(0, LIST_SIZE).map(t => ({
            id: `TXN:${t.plane}:${t.id}`,
            title: `${money(t.amount, t.currency)} ${t.provider}`,
            description: [STATUS[t.status] || t.status, when(t.createdAt), merged ? t.plane : null].filter(Boolean).join(' · '),
        }));
        await messagingHelper.sendList(msg.sender, 'Your recent transactions. Tap one for the details.', 'View', [
            {title: 'Recent', rows},
        ], 'Transactions');
        await messagingHelper.setStep(msg.sender, 'transactions');
    },

    show: async function (msg, user, payload) {
        const [, plane, id] = payload.split(':');
        const {transactions} = await sessionHelper.withSession(user.phone, token => transactionsApi.list(token, 50));
        const t = transactions.find(x => x.plane === plane && String(x.id) === id);
        if (!t) {
            return messagingHelper.sendButtons(msg.sender, 'That transaction isn’t in your recent history any more.', buttons);
        }
        const total = (Number(t.amount) + Number(t.fee || 0)).toFixed(2);
        const lines = [
            `*${title(t)}*`,
            t.type === 'PAYMENT' ? money(t.amount, t.currency) : `${money(t.amount, t.currency)} to ${account(t.target)}`,
            Number(t.fee) > 0 ? `Fee ${money(t.fee, t.currency)} · Total ${money(total, t.currency)}` : null,
            t.method ? `Paid with ${t.method}` : null,
            `Status: ${STATUS[t.status] || t.status}${t.status === 'REVERSED' ? ' (the payment was credited back)' : ''}`,
            t.token ? `Token: *${t.token}*${t.units ? ` (${t.units} units)` : ''}` : null,
            when(t.createdAt, true),
            `Reference: ${t.reference}`,
            t.plane === 'sandbox' ? '_Sandbox: no real money_' : null,
        ].filter(Boolean);
        await messagingHelper.sendButtons(msg.sender, lines.join('\n'), buttons);
    },
};
