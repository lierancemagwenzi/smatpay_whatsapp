const messagingHelper = require('./messagingHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const planeHelper = require('../smatpay/planeHelper');

/**
 * Merchant menu → Wallet, as the POS wallet card shows it (Smatpay-POS WalletDashboardContract):
 * the prepaid wallet the merchant tops up to sell airtime, ZESA and water — its balance by
 * currency, totals by payment method, this year's monthly activity and the five latest wallet
 * top-ups and purchases.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function money(amount, currency) {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

function when(value) {
    return value ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare',
    }) : '';
}

/** Like the POS: an "All" row is the total; otherwise the method rows add up. */
function totalFor(rows) {
    const all = rows.filter(r => String(r.paymentMethod || '').toLowerCase() === 'all');
    if (all.length === 1) return Number(all[0].amount || 0);
    if (all.length > 1) return null;
    return rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
}

function monthName(month) {
    const n = Number(month);
    return n >= 1 && n <= 12 ? MONTHS[n - 1] : String(month);
}

module.exports = {
    show: async function (msg, user) {
        const menu = [{id: 'MAIN_MENU', title: 'Menu'}];
        const year = new Date().getFullYear();
        let dashboard;
        try {
            dashboard = await merchantSession.withToken(user.phone, token => merchantApi.walletDashboard(token, user.merchant_id, year));
        } catch (e) {
            if (e instanceof merchantSession.MerchantNotReadyError) return messagingHelper.sendButtons(msg.sender, e.message, menu);
            return messagingHelper.sendButtons(msg.sender, `Wallet data could not be loaded: ${e.message}`, [
                {id: 'MERCHANT_WALLET', title: 'Try again'}, ...menu,
            ]);
        }
        if (!dashboard) {
            return messagingHelper.sendButtons(msg.sender,
                'The live wallet isn’t available for merchants on WhatsApp yet: Smatpay only offers it to POS devices in production.', menu);
        }

        const balances = dashboard.walletBalance || [];
        const values = dashboard.transactionValue || [];
        const monthly = dashboard.transactionValueMonth || [];
        const recent = dashboard.mostRecentTransactions || [];
        const currencies = [...new Set([
            ...balances.map(b => b.currency), ...values.map(v => v.currency), ...monthly.map(m => m.currency),
        ].filter(Boolean))].sort();

        const lines = [`*Wallet: ${user.merchant_name || 'your business'}*`, `${planeHelper.isSandbox() ? 'Sandbox' : 'Live'} · ${year}`, ''];

        lines.push('*Wallet balance*');
        if (!balances.length) lines.push('No wallet balances are available yet.');
        else lines.push(...balances.map(b => money(b.amount, b.currency)));

        if (values.length) {
            lines.push('', '*Top-ups and purchases*');
            for (const currency of currencies) {
                const rows = values.filter(v => v.currency === currency);
                if (!rows.length) continue;
                const total = totalFor(rows);
                const parts = rows.filter(r => String(r.paymentMethod || '').toLowerCase() !== 'all')
                    .map(r => `${r.paymentMethod || 'Other'} ${money(r.amount, currency)}`);
                lines.push(`${currency}: ${total === null ? '' : `${money(total, currency)} in total`}${parts.length ? ` (${parts.join(', ')})` : ''}`);
            }
        }

        if (monthly.length) {
            lines.push('', `*Activity in ${year}*`);
            const byMonth = new Map();
            for (const m of monthly) {
                if (String(m.paymentMethod || '').toLowerCase() === 'all') continue;
                const key = monthName(m.month);
                byMonth.set(key, (byMonth.get(key) || 0) + Number(m.transactionCount || 0));
            }
            lines.push([...byMonth.entries()].map(([month, count]) => `${month}: ${count}`).join(' · ') || 'None yet');
        }

        lines.push('', '*Latest*');
        if (!recent.length) {
            lines.push('No wallet top-ups or purchases yet.');
        } else {
            for (const r of recent.slice(0, 5)) {
                lines.push(`• ${[
                    when(r.createdAt),
                    r.amount != null ? money(r.amount, (r.paymentCurrency || '').toUpperCase() || 'USD') : null,
                    r.paymentDescription || r.walletName,
                    r.paymentStatus,
                ].filter(Boolean).join(' · ')}`);
            }
        }

        await messagingHelper.sendButtons(msg.sender, lines.join('\n'), [
            {id: 'MERCHANT_TOPUP', title: 'Top up wallet'},
            {id: 'MERCHANT_WALLET', title: 'Refresh'},
            ...menu,
        ]);
    },
};
