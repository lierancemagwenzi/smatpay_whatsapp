const schedule = require('node-schedule');
const purchaseHelper = require('../helpers/whatsapp/purchaseHelper');
const cardHelper = require('../helpers/whatsapp/cardHelper');
const merchantTopUpHelper = require('../helpers/whatsapp/merchantTopUpHelper');
const merchantRequestHelper = require('../helpers/whatsapp/merchantRequestHelper');

/** Every 5 seconds: follow pending purchases and card saves, and message the user when they change. */
let running = false;

module.exports = {
    start: function () {
        return schedule.scheduleJob('*/5 * * * * *', async function () {
            if (running) return;
            running = true;
            try {
                await purchaseHelper.poll();
                await cardHelper.poll();
                await merchantTopUpHelper.poll();
                await merchantRequestHelper.poll();
            } catch (e) {
                console.error('Purchase polling failed:', e);
            } finally {
                running = false;
            }
        });
    },
};
