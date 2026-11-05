const test = require('node:test');
const assert = require('node:assert');
const {isPaid} = require('../helpers/whatsapp/merchantLinkPaymentsHelper');

test('only paid transactions count as link payments', () => {
    assert.equal(isPaid({paymentStatus: 'Paid', transactionPaid: 1}), true);
    assert.equal(isPaid({paymentStatus: 'Pending', transactionPaid: 1}), true);
    assert.equal(isPaid({paymentStatus: 'Pending', transactionPaid: 0}), false);
    assert.equal(isPaid({paymentStatus: 'Failed', transactionPaid: 0}), false);
});
