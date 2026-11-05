const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const flowCryptoHelper = require('../helpers/flows/flowCryptoHelper');

/** Encrypts a request the way WhatsApp does. */
function whatsappRequest(publicKey, body) {
    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return {
        aesKey,
        iv,
        request: {
            encrypted_aes_key: crypto.publicEncrypt(
                {key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'},
                aesKey
            ).toString('base64'),
            encrypted_flow_data: data.toString('base64'),
            initial_vector: iv.toString('base64'),
        },
    };
}

test('decrypts a WhatsApp request and encrypts a reply WhatsApp can read', () => {
    const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const body = {version: '3.0', action: 'data_exchange', screen: 'LOGIN', data: {email: 'a@b.co'}, flow_token: 't'};
    const {request, aesKey, iv} = whatsappRequest(publicKey, body);

    const decrypted = flowCryptoHelper.decryptRequest(request, privateKey);
    assert.deepStrictEqual(decrypted.decryptedBody, body);

    const reply = {screen: 'LOGIN', data: {has_error: false}};
    const encrypted = Buffer.from(flowCryptoHelper.encryptResponse(reply, decrypted.aesKey, decrypted.iv), 'base64');
    const flipped = Buffer.from(iv.map(b => ~b & 0xff));
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, flipped);
    decipher.setAuthTag(encrypted.subarray(-16));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8');
    assert.deepStrictEqual(JSON.parse(plain), reply);
});

test('a request for another key is a FlowDecryptError (answered with 421)', () => {
    const ours = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const theirs = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const {request} = whatsappRequest(theirs.publicKey, {action: 'ping'});
    assert.throws(() => flowCryptoHelper.decryptRequest(request, ours.privateKey), flowCryptoHelper.FlowDecryptError);
});
