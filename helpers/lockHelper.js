/**
 * Runs work for one key at a time. WhatsApp can deliver a user's messages in parallel, and a
 * Smatpay refresh token works once, so a user's messages and refreshes must not overlap.
 *
 * In-process only: run a single instance of this service, or replace this with a shared lock.
 */
const tails = new Map();

module.exports = {
    withLock: async function (key, work) {
        const previous = tails.get(key) || Promise.resolve();
        let release;
        const current = new Promise(resolve => (release = resolve));
        const tail = previous.then(() => current);
        tails.set(key, tail);
        await previous;
        try {
            return await work();
        } finally {
            release();
            if (tails.get(key) === tail) tails.delete(key);
        }
    },
};
