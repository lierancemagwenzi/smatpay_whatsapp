const {Op} = require('sequelize');
const models = require('../../models');
const userModel = models.user;
const flowSessionModel = models.flow_session;
const messagingHelper = require('./messagingHelper');
const cardsApi = require('../smatpay/cardsApiHelper');
const sessionHelper = require('../smatpay/sessionHelper');
const flowSessionHelper = require('../flows/flowSessionHelper');
const lockHelper = require('../lockHelper');

/**
 * Adding a card: the bot opens the bank's hosted page with a link, then follows the save on
 * Smatpay (like the app's cards/secure screen) and picks up the purchase that was waiting on it.
 */

const FLOW = 'add_card';
// The bank page closes its session well before this.
const FOLLOW_FOR_MS = 15 * 60 * 1000;
// A verified card is saved in the same callback, but the list can lag a little.
const LIST_RETRIES = 3;

module.exports = {
    FLOW,

    askBrand: async function (msg) {
        await messagingHelper.sendButtons(msg.sender,
            'Which kind of card? You’ll type the card details on your bank’s secure page, never in this chat. It’s checked with a zero-value payment.',
            [
                {id: 'CARD_BRAND:VISA', title: 'Visa'},
                {id: 'CARD_BRAND:MASTERCARD', title: 'Mastercard'},
                {id: 'VAS_CANCEL', title: 'Cancel'},
            ]);
    },

    start: async function (msg, user, brand) {
        if (!['VISA', 'MASTERCARD'].includes(brand)) return this.askBrand(msg);
        const known = (await sessionHelper.withSession(user.phone, token => cardsApi.list(token))).map(c => c.id);
        let tokenization;
        try {
            tokenization = await cardsApi.startTokenization({
                customerNumber: user.customer_number,
                firstName: user.first_name,
                lastName: user.last_name,
                email: user.email || '',
            }, brand);
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, e.message, [{id: 'MAIN_MENU', title: 'Main menu'}]);
        }
        // Earlier bank pages stay followed: the customer may finish one they opened before.
        await flowSessionHelper.create(user.phone, FLOW, brand, {reference: tokenization.reference, known, tries: 0}, {keepOpen: true});
        await messagingHelper.sendLinkButton(msg.sender, {
            url: tokenization.url,
            cta: 'Add card',
            body: `Add your ${brand === 'VISA' ? 'Visa' : 'Mastercard'} on your bank’s secure page. I’ll carry on here as soon as it’s saved.`,
        });
    },

    /** Follows open card saves; run with the purchase poller. */
    poll: async function () {
        const sessions = await flowSessionModel.findAll({where: {flow: FLOW, status: 'open'}, limit: 25});
        for (const session of sessions) {
            const sender = session.phone.replace(/^\+/, '');
            await lockHelper.withLock(`msg:${sender}`, async () => {
                try {
                    await this.check(session, sender);
                } catch (e) {
                    if (!(e instanceof sessionHelper.SessionEndedError)) console.error(`Card save ${session.id} check failed:`, e.message);
                }
            });
        }
    },

    check: async function (session, sender) {
        const age = Date.now() - new Date(session.created_at).getTime();
        const {status, reason} = await cardsApi.tokenizationStatus(session.data.reference);

        if (status === 'FAILED' || (status === 'PENDING' && age > FOLLOW_FOR_MS)) {
            await flowSessionHelper.complete(session, 'card_failed');
            const why = status === 'FAILED'
                ? (reason ? `The bank said: “${reason}”.` : 'The bank declined it.')
                : 'The bank page wasn’t finished in time.';
            return messagingHelper.sendButtons(sender,
                `Your card wasn’t saved. ${why} You can try again or pay another way.`,
                [{id: 'PAY_ADD_CARD', title: 'Try again'}, {id: 'VAS_OTHER_METHOD', title: 'Pay another way'}, {id: 'MAIN_MENU', title: 'Main menu'}]);
        }
        if (status === 'PENDING') return;

        const cards = await sessionHelper.withSession(session.phone, token => cardsApi.list(token));
        const added = cards.find(c => !session.data.known.includes(c.id));
        if (!added) {
            const tries = (session.data.tries || 0) + 1;
            if (tries < LIST_RETRIES) return flowSessionHelper.saveData(session, {tries});
            await flowSessionHelper.complete(session, 'card_missing');
            return messagingHelper.sendButtons(sender,
                'Your card was verified but hasn’t appeared yet. Try paying again in a minute.',
                [{id: 'MAIN_MENU', title: 'Main menu'}]);
        }

        // One card, one message: stop following this customer's other bank pages.
        await flowSessionModel.update({status: 'superseded'}, {where: {phone: session.phone, flow: FLOW, status: 'open', id: {[Op.ne]: session.id}}});

        if (session.data.known.length === 0) {
            await sessionHelper.withSession(session.phone, token => cardsApi.setDefault(token, added.id)).catch(() => {});
        }
        await flowSessionHelper.complete(session, 'card_added');
        const user = await userModel.findOne({where: {phone: session.phone}});
        await messagingHelper.sendMessage(sender, sessionHelper.isGuest(user)
            ? `${cardsApi.label(added)} is ready. As a guest it works for this payment only (30 minutes).`
            : `${cardsApi.label(added)} is saved to your Smatpay account.`);

        // Carry on with the purchase that was waiting for a card.
        if (user?.draft?.awaitingCard) {
            const vasHelper = require('./vasHelper');
            return vasHelper.useCard(user, added);
        }
        return messagingHelper.sendButtons(sender, 'You can now pay with it.', [{id: 'MAIN_MENU', title: 'Main menu'}]);
    },

    /** Cards that can pay, default first. */
    usableCards: async function (user) {
        const cards = await sessionHelper.withSession(user.phone, token => cardsApi.list(token));
        return cards.filter(c => c.isActive !== false).sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
    },

};
