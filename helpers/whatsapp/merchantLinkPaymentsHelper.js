const {Op} = require('sequelize');
const models = require('../../models');
const userModel = models.user;
const purchaseModel = models.purchase;
const messagingHelper = require('./messagingHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const lockHelper = require('../lockHelper');
const {loadLinks} = require('./merchantPaymentLinksHelper');

/**
 * Tells merchants when a customer pays one of their payment links. Smatpay records a link payment
 * on the merchant's transactions with the link's token (payerGlobalToken), so the merchant report
 * is checked for paid rows carrying one of the business's link tokens. Each announced payment is
 * kept as a purchase of kind 'link' so it's only announced once.
 */

const RECENT = 20;
// Payments older than this aren't announced (e.g. after the bot was down for days).
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

function isPaid(row) {
    return /^(paid|success|successful|completed)$/i.test(row.paymentStatus || '') || row.transactionPaid === 1 || row.transactionPaid === true;
}

async function checkMerchant(user) {
    const sender = user.phone.replace(/^\+/, '');
    if (!user.merchant_link_notify_since) {
        // First check: start from now, rather than announcing old payments.
        return user.update({merchant_link_notify_since: new Date()});
    }
    const since = Math.max(new Date(user.merchant_link_notify_since).getTime(), Date.now() - MAX_AGE_MS);
    const rows = await merchantSession.withToken(user.phone, t => merchantApi.recentTransactions(t, user.merchant_id, RECENT));
    const candidates = rows.filter(r => r.id && r.payerGlobalToken && isPaid(r) && Date.parse(r.createdAt) >= since);
    if (!candidates.length) return;

    const seen = new Set((await purchaseModel.findAll({
        where: {purchase_id: {[Op.in]: candidates.map(r => `link:${r.id}`)}},
        attributes: ['purchase_id'],
    })).map(p => p.purchase_id));
    const fresh = candidates.filter(r => !seen.has(`link:${r.id}`));
    if (!fresh.length) return;

    const {links} = await loadLinks(user);
    const byToken = new Map(links.map(l => [l.paymentLinkToken, l]));
    for (const row of fresh.sort((a, b) => a.id - b.id)) {
        const link = byToken.get(row.payerGlobalToken);
        const record = {
            phone: user.phone, kind: 'link', purchase_id: `link:${row.id}`,
            biller: 'PAYMENT_LINK', biller_name: link?.paymentProfileName || null, account: link ? String(link.id) : null,
            amount: String(row.amount), total: String(row.amount), currency: row.paymentCurrency,
            payment_method: row.walletName, payment_msisdn: null,
        };
        // Not one of this business's links (e.g. another kind of token payment): remember it, say nothing.
        if (!link) {
            await purchaseModel.create({...record, status: 'IGNORED', notified_status: 'IGNORED'});
            continue;
        }
        // Recorded before sending, so a failed send is never repeated as a duplicate.
        const saved = await purchaseModel.create({...record, status: 'COMPLETED', notified_status: 'PENDING'});
        const payer = row.payerName && !/^customer$/i.test(row.payerName) ? ` from ${row.payerName}` : '';
        const lines = [
            `💰 *Payment received: ${money(row.amount, row.paymentCurrency)}*`,
            `For: ${link.paymentProfileName} (payment link)`,
            `By ${row.walletName || 'Smatpay'}${payer}`,
            `Reference: ${row.paymentReference || row.id}`,
        ];
        if (link.paymentLinkType === 'ONCE_OFF_FIXED') lines.push('This one-time link is now used up.');
        try {
            await lockHelper.withLock(`msg:${sender}`, () => messagingHelper.sendButtons(sender, lines.join('\n'), [
                {id: 'MERCHANT_EARNINGS', title: 'Earnings'},
                {id: 'MERCHANT_PAYMENT_LINKS', title: 'Payment links'},
                {id: 'MAIN_MENU', title: 'Menu'},
            ]));
            await saved.update({notified_status: 'COMPLETED'});
            console.log(`Link payment ${row.id} (link ${link.id}) announced to merchant ${user.merchant_id}`);
        } catch (e) {
            // Usually WhatsApp's 24-hour window: free-form messages need the merchant to have written recently.
            await saved.update({notified_status: 'UNSENT'});
            console.error(`Announcing link payment ${row.id} failed:`, e.response ? JSON.stringify(e.response.data) : e.message);
        }
    }
}

module.exports = {
    isPaid,

    /** Every signed-in business, including ones using their number as a customer at the moment. */
    poll: async function () {
        const merchants = await userModel.findAll({
            where: {merchant_keys_enc: {[Op.ne]: null}, merchant_id: {[Op.ne]: null}},
        });
        for (const user of merchants) {
            await checkMerchant(user).catch(e => console.error(`Payment link check for ${user.merchant_id} failed: ${e.reason || e.message}`));
        }
    },
};
