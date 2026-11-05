const messagingHelper = require('./messagingHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const planeHelper = require('../smatpay/planeHelper');

/**
 * Merchant menu → Earnings: what customers have paid the merchant that's available to pay out
 * (money in less payouts), and the latest customer payments.
 */

const RECENT = 5;

function money(amount, currency) {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

function when(value) {
    return value ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare',
    }) : '';
}

function statusOf(row) {
    if (row.paymentStatus) return row.paymentStatus;
    return row.transactionPaid === 1 ? 'Paid' : 'Pending';
}

module.exports = {
    show: async function (msg, user) {
        const menu = [{id: 'MAIN_MENU', title: 'Menu'}];
        try {
            await merchantSession.getToken(user.phone);
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, e.message, menu);
        }
        const [payout, recent] = await Promise.allSettled([
            merchantSession.withToken(user.phone, token => merchantApi.payoutBalance(token, user.merchant_id)),
            merchantSession.withToken(user.phone, token => merchantApi.recentTransactions(token, user.merchant_id, RECENT)),
        ]);

        const lines = [`*Earnings: ${user.merchant_name || 'your business'}*${planeHelper.isSandbox() ? ' (sandbox)' : ''}`, ''];
        lines.push('*Available to pay out*');
        if (payout.status === 'rejected') lines.push('Couldn’t load right now.');
        else if (!payout.value.length) lines.push('Nothing yet');
        else lines.push(...payout.value.map(r => money(r.amount, r.currency || 'USD')));

        lines.push('', '*Latest customer payments*');
        if (recent.status === 'rejected') {
            lines.push('Couldn’t load right now.');
        } else if (!recent.value.length) {
            lines.push('No payments yet.');
        } else {
            for (const row of recent.value) {
                lines.push(`• ${[when(row.createdAt), money(row.amount, row.paymentCurrency || 'USD'), row.walletName, statusOf(row), row.payerName]
                    .filter(Boolean).join(' · ')}`);
            }
        }

        await messagingHelper.sendButtons(msg.sender, lines.join('\n'), [
            {id: 'MERCHANT_EARNINGS', title: 'Refresh'},
            ...menu,
        ]);
    },
};
