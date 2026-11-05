const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const cryptoHelper = require('../helpers/cryptoHelper');
const lockHelper = require('../helpers/lockHelper');

test('tokens round-trip through encryption and are not stored in the clear', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
    const stored = cryptoHelper.encrypt(token);
    assert.ok(!stored.includes(token));
    assert.strictEqual(cryptoHelper.decrypt(stored), token);
});

test('PIN hashes verify only the right PIN', () => {
    const stored = cryptoHelper.hashPin('4829');
    assert.ok(cryptoHelper.verifyPin('4829', stored));
    assert.ok(!cryptoHelper.verifyPin('4828', stored));
});

test('work for one key never overlaps', async () => {
    const order = [];
    const slow = (label, ms) => lockHelper.withLock('refresh:+263771234567', async () => {
        order.push(`${label} start`);
        await new Promise(r => setTimeout(r, ms));
        order.push(`${label} end`);
    });
    await Promise.all([slow('a', 30), slow('b', 1), slow('c', 1)]);
    assert.deepStrictEqual(order, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

test('a failure releases the lock', async () => {
    await assert.rejects(lockHelper.withLock('k', async () => {
        throw new Error('boom');
    }));
    assert.strictEqual(await lockHelper.withLock('k', async () => 'ok'), 'ok');
});
