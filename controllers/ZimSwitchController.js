const models = require('../models');
const purchaseModel = models.purchase;
const flowSessionHelper = require('../helpers/flows/flowSessionHelper');
const webFormHelper = require('../helpers/flows/webFormHelper');
const utilityHelper = require('../helpers/whatsapp/utilityHelper');

/**
 * ZimSwitch's card form (OPPWA's payment widget) for a purchase that asked for it, the same markup
 * the app renders. The card is typed into OPPWA's form, never into WhatsApp or this server; when
 * it's done OPPWA sends the browser to /done and the purchase poller picks up the outcome.
 */

const {escapeHtml, page} = webFormHelper;

function headers(res) {
    // The token is in the URL: don't cache it, leak its path in a Referer, or let it be framed.
    res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'strict-origin',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "frame-ancestors 'none'",
    });
}

function expired(res) {
    return res.status(410).send(webFormHelper.renderMessage(
        'This link has expired',
        'Go back to WhatsApp and type “menu” to start again.'
    ));
}

exports.Show = async (req, res) => {
    headers(res);
    const token = req.params.token;
    const session = await flowSessionHelper.findOpen(token);
    if (!session || session.flow !== 'zimswitch' || !utilityHelper.isAllowedNumber(session.phone)) return expired(res);

    const {scriptUrl, brands, total} = session.data;
    const baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const done = `${baseUrl}/pay/zimswitch/${encodeURIComponent(token)}/done`;
    res.send(page('Pay with ZimSwitch', `
      <h1>Pay ${escapeHtml(total)}</h1>
      <p class="caption">Any local bank card, on ZimSwitch’s secure form.</p>
      <script>var wpwlOptions = { style: "card", locale: "en" };</script>
      <script src="${escapeHtml(scriptUrl)}"></script>
      <form action="${escapeHtml(done)}" class="paymentWidgets" data-brands="${escapeHtml(brands || 'PRIVATE_LABEL')}"></form>`));
};

exports.Done = async (req, res) => {
    headers(res);
    const session = await flowSessionHelper.findAny(req.params.token);
    if (!session || session.flow !== 'zimswitch') return expired(res);
    if (session.status === 'open') await flowSessionHelper.complete(session, 'card_entered');
    // Check the purchase on the next poll rather than waiting out the interval.
    await purchaseModel.update({last_checked_at: null}, {where: {purchase_id: session.data.purchaseId}});
    res.send(webFormHelper.renderMessage('Payment submitted', 'Go back to WhatsApp: I’ll confirm your purchase there in a moment.'));
};
