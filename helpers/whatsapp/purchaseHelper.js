const {Op} = require('sequelize');
const models = require('../../models');
const userModel = models.user;
const purchaseModel = models.purchase;
const messagingHelper = require('./messagingHelper');
const vasApi = require('../smatpay/vasApiHelper');
const payApi = require('../smatpay/payApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const lockHelper = require('../lockHelper');
const flowSessionHelper = require('../flows/flowSessionHelper');

/**
 * What happens after a VAS purchase is placed: tell the user what to do (approve a wallet prompt,
 * pay an InnBucks code, type an O'mari code), follow it on Smatpay, and send the receipt.
 */

const PENDING = ['PENDING_PAYMENT', 'PENDING_VEND'];
const POLL_EVERY_MS = 5000;
const FOLLOW_FOR_MS = 60 * 60 * 1000;
const enterOtp = 'purchase_enter_otp';

const RAILS = {ECOCASH: 'EcoCash', INNBUCKS: 'InnBucks', OMARI: 'O’mari', ZIMSWITCH: 'ZimSwitch', CARD: 'your card'};

function railName(type) {
    return RAILS[type] || type;
}

function money(amount, currency) {
    return `${currency} ${Number(amount).toFixed(2)}`;
}

/** "Econet airtime (USD)" → "Econet airtime". */
function productName(row) {
    return (row.biller_name || 'Purchase').replace(/\s*\((USD|ZWG)\)\s*$/, '');
}

/** Follows a purchase or a merchant payment on its own endpoint, in one shape. */
function fetchLatest(row, token) {
    return row.kind === 'pay'
        ? payApi.getPayment(token, row.purchase_id).then(p => payApi.asPurchase(p))
        : vasApi.getPurchase(token, row.purchase_id);
}

/** What the customer is getting, and where to buy more. */
function kindOf(row) {
    if (row.kind === 'pay') return {noun: 'payment', menuId: 'MENU_PAY', again: 'Pay again', meter: false, merchant: true};
    if (row.kind === 'data') return {noun: 'bundle', menuId: 'MENU_DATA', again: 'Buy more data', meter: false};
    if (/AIRTIME|BUNDLE/.test(row.biller || '')) return {noun: 'airtime', menuId: 'MENU_AIRTIME', again: 'Buy more airtime', meter: false};
    if (/WATER/.test(row.biller || '')) return {noun: 'water token', menuId: 'MENU_WATER', again: 'Buy more water', meter: true};
    return {noun: 'electricity token', menuId: 'MENU_ELECTRICITY', again: 'Buy more', meter: true};
}

/** 20-digit tokens are typed into the meter in groups of four. */
function groupToken(token) {
    const digits = String(token).replace(/\s/g, '');
    return /^\d{16,}$/.test(digits) ? digits.replace(/(\d{4})(?=\d)/g, '$1 ') : token;
}

const menuButton = [{id: 'MAIN_MENU', title: 'Main menu'}];

module.exports = {
    enterOtp,
    railName,
    money,

    /** Records a new purchase so it can be followed. */
    record: async function (phone, draft, purchase) {
        const merchant = draft.service === 'pay';
        const data = draft.service === 'data';
        return purchaseModel.create({
            phone,
            kind: merchant ? 'pay' : data ? 'data' : 'vas',
            purchase_id: purchase.purchaseId,
            biller: merchant ? 'MERCHANT' : draft.biller,
            // A bundle is named for what was bought: "NetOne WhatsApp Weekly 250MB".
            biller_name: data ? `${(draft.billerName || '').split(' ')[0]} ${draft.productName}` : draft.billerName,
            account: merchant ? (draft.link?.reference || draft.billerName) : draft.account,
            amount: purchase.amount,
            total: purchase.total,
            currency: purchase.currency,
            payment_method: draft.method?.type,
            // The wallet number, or the card ("Visa •••• 4242") for receipts.
            payment_msisdn: draft.method?.msisdn || (draft.method?.type === 'CARD' ? draft.method.label : null) || null,
            status: purchase.status,
        });
    },

    /** Tells the user where a purchase stands, once per status. */
    announce: async function (row, purchase) {
        const sender = row.phone.replace(/^\+/, '');
        const status = purchase.status;
        if (row.notified_status === status) return;
        const total = money(purchase.total, purchase.currency);
        const name = productName(row);
        const kind = kindOf(row);

        if (status === 'PENDING_PAYMENT') {
            const next = purchase.next || {};
            if (next.type === 'PROMPT') {
                await messagingHelper.sendMessage(sender, `Approve the ${railName(row.payment_method)} prompt on ${next.msisdn || row.payment_msisdn} to pay ${total}. I’ll message you as soon as it’s done.`);
            } else if (next.type === 'CODE') {
                await messagingHelper.sendMessage(sender, `Open InnBucks and pay with this code:\n\n*${next.code}*\n\nAmount: ${total}. I’ll message you once it’s paid.`);
            } else if (next.type === 'OTP') {
                await messagingHelper.sendMessage(sender, `O’mari has sent a code to ${next.msisdn || row.payment_msisdn}. Type it here to pay ${total}.`);
                await userModel.update({draft: {service: 'otp', purchaseId: row.purchase_id}}, {where: {phone: row.phone}});
                await messagingHelper.setStep(sender, enterOtp);
            } else if (next.type === 'REDIRECT' && next.url) {
                await messagingHelper.sendLinkButton(sender, {url: next.url, cta: 'Pay now', body: `Finish paying ${total} on the secure payment page. I’ll message you once it’s done.`});
            } else if (next.type === 'WIDGET' && next.scriptUrl) {
                // ZimSwitch: its card form, hosted on our page (/pay/zimswitch/<token>).
                const token = await flowSessionHelper.create(row.phone, 'zimswitch', null, {
                    purchaseId: row.purchase_id, scriptUrl: next.scriptUrl, brands: next.brands, total,
                });
                const baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
                await messagingHelper.sendLinkButton(sender, {
                    url: `${baseUrl}/pay/zimswitch/${token}`,
                    cta: 'Enter card details',
                    body: `Pay ${total} with any local bank card on ZimSwitch’s secure form. I’ll confirm here once it’s done.`,
                });
            } else {
                await messagingHelper.sendMessage(sender, `Waiting for your ${railName(row.payment_method)} payment of ${total}. I’ll message you once it’s done.`);
            }
        } else if (status === 'PENDING_VEND') {
            await messagingHelper.sendMessage(sender, kind.meter
                ? `Payment received. Getting your ${kind.noun} now…`
                : `Payment received. Sending your ${row.kind === 'data' ? 'bundle' : name.toLowerCase()} now…`);
        } else if (status === 'COMPLETED') {
            const r = purchase.result || {};
            const tokens = r.tokens?.length ? r.tokens : (r.token ? [r.token] : []);
            const lines = kind.merchant ? [
                `*Paid ${name}*`,
                money(purchase.amount, purchase.currency),
                row.account && row.account !== name ? `For: ${payApi.shortReference(row.account)}` : null,
            ] : kind.meter ? [
                `*Your ${name} ${tokens.length > 1 ? 'tokens' : 'token'}*`,
                ...tokens.map((t, i) => tokens.length > 1 ? `${i + 1}. *${groupToken(t)}*` : `*${groupToken(t)}*`),
                tokens.length > 1 ? 'Enter them into the meter in this order.' : null,
                `Meter ${r.meter || row.account}`,
                r.units ? `Units: ${r.units}${/^\d+(\.\d+)?$/.test(String(r.units)) ? ' kWh' : ''}` : null,
                r.energy ? `Energy: ${r.energy}` : null,
                r.debt && Number(String(r.debt).replace(/[^\d.]/g, '')) > 0 ? `Debt paid: ${r.debt}` : null,
                r.vat ? `VAT: ${r.vat}` : null,
            ] : [
                `*${name} sent*`,
                `${money(purchase.amount, purchase.currency)} to ${r.msisdn || row.account}`,
            ];
            lines.push(
                `Paid ${total} with ${railName(row.payment_method)}${row.payment_msisdn ? ` (${row.payment_msisdn})` : ''}`,
                // ZESA repeats the token as the receipt number; don't show it twice.
                r.receipt && !tokens.includes(r.receipt) ? `Receipt: ${r.receipt}` : null,
                `Reference: ${purchase.purchaseId}`,
            );
            await messagingHelper.sendButtons(sender, lines.filter(Boolean).join('\n'), [
                {id: kind.menuId, title: kind.again},
                ...menuButton,
            ]);
        } else if (status === 'NEEDS_ATTENTION') {
            await messagingHelper.sendButtons(sender,
                `${kind.merchant ? `Your payment to ${name} needs checking.` : `Your payment went through but the ${name.toLowerCase()} couldn’t be sent.`} Smatpay support will sort it out and refund you if needed. Reference: ${purchase.purchaseId}\n\nSupport: ${process.env.SUPPORT_PHONE}`,
                menuButton);
        } else if (status === 'REVERSED') {
            // Charged, the vend failed, and Smatpay credited the charge back.
            const paidWith = row.payment_method === 'CARD' && row.payment_msisdn ? row.payment_msisdn : railName(row.payment_method);
            await messagingHelper.sendButtons(sender,
                kind.merchant
                    ? `Your payment to ${name} was reversed, so ${total} has been refunded to ${paidWith}. Reference: ${purchase.purchaseId}`
                    : `We couldn’t ${kind.meter ? `get your ${kind.noun} for meter` : `send the ${row.kind === 'data' ? `${name} bundle` : name.toLowerCase()} to`} ${row.account}, so your payment of ${total} has been refunded to ${paidWith}. Reference: ${purchase.purchaseId}`,
                [{id: kind.menuId, title: 'Try again'}, ...menuButton]);
        } else {
            // FAILED: nothing was charged or bought.
            const reason = (purchase.message || 'The payment didn’t go through').replace(/[.\s]*$/, '.');
            await messagingHelper.sendButtons(sender, `${reason} Nothing was bought.`, menuButton);
        }

        row.status = status;
        row.notified_status = status;
        await row.save();
    },

    /** Handles a purchase response (from purchase, OTP or polling). */
    handleResponse: async function (row, purchase) {
        row.status = purchase.status;
        row.last_checked_at = new Date();
        await row.save();
        await this.announce(row, purchase);
    },

    /** The O'mari code typed in the chat. */
    submitOtp: async function (msg, user) {
        const purchaseId = user.draft?.purchaseId;
        const row = purchaseId && await purchaseModel.findOne({where: {purchase_id: purchaseId, phone: user.phone}});
        if (!row) {
            await user.update({draft: null});
            return false;
        }
        const code = (msg.content.text || '').replace(/\D/g, '');
        if (code.length < 4 || code.length > 8) {
            await messagingHelper.sendMessage(msg.sender, 'Type the code O’mari sent you.');
            return true;
        }
        try {
            const purchase = row.kind === 'pay'
                ? payApi.asPurchase(await sessionHelper.withSession(user.phone, token => payApi.submitOtp(token, purchaseId, code)))
                : await sessionHelper.withSession(user.phone, token => vasApi.submitOtp(token, purchaseId, code));
            await user.update({draft: null});
            await messagingHelper.setStep(msg.sender, 'main_menu');
            await this.handleResponse(row, purchase);
        } catch (e) {
            if (e instanceof sessionHelper.SessionEndedError) throw e;
            await messagingHelper.sendMessage(msg.sender, `${e.message} Type the code again.`);
        }
        return true;
    },

    /** Follows pending purchases; run every few seconds by jobs/purchasePollJob. */
    poll: async function () {
        const now = Date.now();
        const rows = await purchaseModel.findAll({
            where: {
                status: {[Op.in]: PENDING},
                // Merchant top-ups and payment requests have their own followers.
                kind: {[Op.notIn]: ['topup', 'request']},
                created_at: {[Op.gt]: new Date(now - FOLLOW_FOR_MS)},
                [Op.or]: [{last_checked_at: null}, {last_checked_at: {[Op.lt]: new Date(now - POLL_EVERY_MS)}}],
            },
            limit: 25,
        });
        for (const row of rows) {
            const sender = row.phone.replace(/^\+/, '');
            await lockHelper.withLock(`msg:${sender}`, async () => {
                try {
                    const purchase = await sessionHelper.withSession(row.phone, token => fetchLatest(row, token));
                    await this.handleResponse(row, purchase);
                } catch (e) {
                    row.last_checked_at = new Date();
                    await row.save();
                    if (!(e instanceof sessionHelper.SessionEndedError)) {
                        console.error(`Polling ${row.purchase_id} failed:`, e.message);
                    }
                }
            });
        }

        // Stop following after an hour; tell the user once.
        const stale = await purchaseModel.findAll({
            where: {status: {[Op.in]: PENDING}, kind: {[Op.notIn]: ['topup', 'request']}, created_at: {[Op.lte]: new Date(now - FOLLOW_FOR_MS)}},
            limit: 25,
        });
        for (const row of stale) {
            row.status = 'UNRESOLVED';
            await row.save();
            await messagingHelper.sendButtons(row.phone.replace(/^\+/, ''),
                `Your ${productName(row).toLowerCase()} for ${row.account} (reference ${row.purchase_id}) is still processing. Check Transactions later, or contact support on ${process.env.SUPPORT_PHONE}.`,
                menuButton).catch(e => console.error('Stale purchase notice failed:', e.message));
        }
    },

};
