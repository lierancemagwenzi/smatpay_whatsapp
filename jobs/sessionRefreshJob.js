const schedule = require('node-schedule');
const sessionHelper = require('../helpers/smatpay/sessionHelper');

/** Daily at 03:00: renew Smatpay sessions that are about to expire for active users. */
module.exports = {
    start: function () {
        return schedule.scheduleJob('0 3 * * *', async function () {
            try {
                const result = await sessionHelper.renewExpiringSessions();
                console.log('Session renewal:', JSON.stringify(result));
            } catch (e) {
                console.error('Session renewal job failed:', e);
            }
        });
    },
};
