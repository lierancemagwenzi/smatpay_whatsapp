const test = require('node:test');
const assert = require('node:assert');
const utilityHelper = require('../helpers/whatsapp/utilityHelper');

function webhook(message, name = 'Tariro Moyo') {
    return {entry: [{changes: [{value: {contacts: [{profile: {name}}], messages: [message]}}]}]};
}

test('parses text, button replies, list replies and finished flows', () => {
    const text = utilityHelper.parseIncomingMessage(webhook({id: 'm1', from: '263771234567', type: 'text', text: {body: 'hi'}}));
    assert.deepStrictEqual([text.sender, text.type, text.content.text, text.name], ['263771234567', 'text', 'hi', 'Tariro Moyo']);

    const button = utilityHelper.parseIncomingMessage(webhook({
        id: 'm2', from: '263771234567', type: 'interactive',
        interactive: {type: 'button_reply', button_reply: {id: 'AUTH_LOGIN', title: 'I have an account'}},
    }));
    assert.strictEqual(button.content.payload, 'AUTH_LOGIN');

    const list = utilityHelper.parseIncomingMessage(webhook({
        id: 'm3', from: '263771234567', type: 'interactive',
        interactive: {type: 'list_reply', list_reply: {id: 'MENU_HELP', title: 'Help'}},
    }));
    assert.strictEqual(list.content.payload, 'MENU_HELP');

    const flow = utilityHelper.parseIncomingMessage(webhook({
        id: 'm4', from: '263771234567', type: 'interactive',
        interactive: {type: 'nfm_reply', nfm_reply: {name: 'flow', response_json: '{"flow_token":"abc","result":"logged_in"}'}},
    }));
    assert.strictEqual(flow.content.flow.flow_token, 'abc');
});

test('delivery statuses and empty bodies are recognised', () => {
    const status = utilityHelper.parseIncomingMessage({entry: [{changes: [{value: {statuses: [{id: 's', recipient_id: '263', status: 'read'}]}}]}]});
    assert.strictEqual(status.type, 'status');
    assert.strictEqual(utilityHelper.parseIncomingMessage({}), null);
});

test('phone numbers normalise to the format Smatpay expects', () => {
    assert.strictEqual(utilityHelper.normalizePhone('077 123 4567'), '+263771234567');
    assert.strictEqual(utilityHelper.normalizePhone('263771234567'), '+263771234567');
    assert.strictEqual(utilityHelper.localPhone('+263771234567'), '0771234567');
    assert.ok(utilityHelper.isValidZimMobile('0771234567'));
    assert.ok(!utilityHelper.isValidZimMobile('0271234567'));
});

test('customers abroad can sign up with their international number', () => {
    assert.strictEqual(utilityHelper.localPhone('+27824208001'), '+27824208001');
    assert.ok(utilityHelper.isValidMobile('+27824208001'));
    assert.ok(utilityHelper.isValidMobile('0771234567'));
    assert.ok(!utilityHelper.isValidMobile('0824208001'));
    assert.strictEqual(utilityHelper.normalizePhone('+27 82 420 8001'), '+27824208001');
});

test('weak PINs are rejected', () => {
    for (const pin of ['0000', '1111', '1234', '4321', '6789']) assert.ok(utilityHelper.isWeakPin(pin), pin);
    for (const pin of ['4829', '1357', '2023']) assert.ok(!utilityHelper.isWeakPin(pin), pin);
});

test('greetings', () => {
    assert.ok(utilityHelper.isGreeting('Hi'));
    assert.ok(utilityHelper.isGreeting('hello there'));
    assert.ok(!utilityHelper.isGreeting('history'));
});

test('only allowed numbers are served while ALLOWED_NUMBERS is set', () => {
    const saved = process.env.ALLOWED_NUMBERS;
    process.env.ALLOWED_NUMBERS = '+27824208001';
    assert.ok(utilityHelper.isAllowedNumber('27824208001'));
    assert.ok(utilityHelper.isAllowedNumber('+27824208001'));
    assert.ok(!utilityHelper.isAllowedNumber('263771234567'));
    process.env.ALLOWED_NUMBERS = '';
    assert.ok(utilityHelper.isAllowedNumber('263771234567'));
    process.env.ALLOWED_NUMBERS = saved;
});
