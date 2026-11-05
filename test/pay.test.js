const test = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const jpeg = require('jpeg-js');
const {PNG} = require('pngjs');
const payApi = require('../helpers/smatpay/payApiHelper');
const mediaHelper = require('../helpers/whatsapp/mediaHelper');

const TOKEN = 'Q2hlY2tvdXRUb2tlbkZvckFUZXN0-42';

test('recognises every way a merchant code arrives', () => {
    assert.deepStrictEqual(payApi.parseCode(TOKEN), {token: TOKEN});
    assert.deepStrictEqual(payApi.parseCode(`https://payments.smatpay.africa/pay?token=${TOKEN}`), {token: TOKEN});
    assert.deepStrictEqual(payApi.parseCode('https://smatpay.africa/auth/s/aB3dE9'), {short: 'aB3dE9'});
    assert.deepStrictEqual(payApi.parseCode('dev-payments.smatpay.africa/auth/Xy12'), {short: 'Xy12'});
    assert.deepStrictEqual(payApi.parseCode('aB3dE9'), {short: 'aB3dE9'});
    assert.deepStrictEqual(payApi.parseCode('POS-20260930-0001'), {transactionReference: 'POS-20260930-0001'});
    assert.deepStrictEqual(
        payApi.parseCode('{"transactionReference":"POS-77","merchantId":"311","amount":5,"currency":"USD"}'),
        {transactionReference: 'POS-77'});
});

test('ignores things that are not merchant codes', () => {
    for (const text of ['hello', 'https://example.com/auth/s/aB3dE9', '{"foo":1}', 'menu', '']) {
        assert.strictEqual(payApi.parseCode(text), null, text);
    }
    // Pasted anywhere, only unmistakable links start a payment; a bare number doesn't.
    const payHelper = require('../helpers/whatsapp/payHelper');
    assert.ok(payHelper.looksLikePaymentCode(`https://payments.smatpay.africa/pay?token=${TOKEN}`));
    assert.ok(!payHelper.looksLikePaymentCode('0771234567'));
});

test('reads the QR in a PNG or a JPEG photo', async () => {
    const text = `https://payments.smatpay.africa/pay?token=${TOKEN}`;
    const pngBuffer = await QRCode.toBuffer(text, {type: 'png', margin: 4, scale: 8});
    assert.strictEqual(mediaHelper.readQr(pngBuffer, 'image/png'), text);

    const png = PNG.sync.read(pngBuffer);
    const jpegBuffer = jpeg.encode({data: png.data, width: png.width, height: png.height}, 85).data;
    assert.strictEqual(mediaHelper.readQr(jpegBuffer, 'image/jpeg'), text);
});

test('a photo without a QR reads as nothing', () => {
    const blank = new PNG({width: 64, height: 64});
    blank.data.fill(255);
    assert.strictEqual(mediaHelper.readQr(PNG.sync.write(blank), 'image/png'), null);
});

test('till references are shortened for display only', () => {
    assert.strictEqual(payApi.shortReference('POS-e8ca84c9-c49e-4a3d-8edf-b1546d9a219d'), 'POS-e8ca84c9');
    assert.strictEqual(payApi.shortReference('Invoice 1042'), 'Invoice 1042');
    assert.strictEqual(payApi.shortReference(null), null);
});
