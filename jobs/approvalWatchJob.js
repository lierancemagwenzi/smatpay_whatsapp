const schedule = require('node-schedule');
const merchantGoLiveHelper = require('../helpers/whatsapp/merchantGoLiveHelper');

/** Every 5 minutes: tell merchants who asked for approval once Smatpay approves them. */
let running = false;

module.exports = {
    start: function () {
        return schedule.scheduleJob('*/5 * * * *', async function () {
            if (running) return;
            running = true;
            try {
                await merchantGoLiveHelper.watchApprovals();
            } catch (e) {
                console.error('Approval watch failed:', e);
            } finally {
                running = false;
            }
        });
    },
};
