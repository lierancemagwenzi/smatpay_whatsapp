const schedule = require('node-schedule');
const merchantLinkPaymentsHelper = require('../helpers/whatsapp/merchantLinkPaymentsHelper');

/** Every 30 seconds: tell merchants about payments received through their payment links. */
let running = false;

module.exports = {
    start: function () {
        return schedule.scheduleJob('*/30 * * * * *', async function () {
            if (running) return;
            running = true;
            try {
                await merchantLinkPaymentsHelper.poll();
            } catch (e) {
                console.error('Payment link watch failed:', e);
            } finally {
                running = false;
            }
        });
    },
};
