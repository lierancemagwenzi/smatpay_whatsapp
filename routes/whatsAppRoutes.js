'use strict';
module.exports = function (app) {
    const whatsapp = require('../controllers/WhatsappController');
    const flows = require('../controllers/FlowController');

    app.route('/api/whatsapp/webhook')
        .post(whatsapp.WebHook);

    // WhatsApp Flows data endpoint (set as the endpoint URI of every flow in flows/).
    app.route('/api/whatsapp/flows')
        .post(flows.Endpoint);

    // The same forms as web pages, used while FORMS_MODE=web.
    const forms = require('../controllers/FormController');
    app.route('/forms/:token')
        .get(forms.Show)
        .post(forms.Submit);

    // ZimSwitch's card form for a purchase that asked for it.
    const zimswitch = require('../controllers/ZimSwitchController');
    app.route('/pay/zimswitch/:token').get(zimswitch.Show);
    app.route('/pay/zimswitch/:token/done').get(zimswitch.Done).post(zimswitch.Done);

    app.route('/health')
        .get((req, res) => res.json({status: 'ok'}));
};
