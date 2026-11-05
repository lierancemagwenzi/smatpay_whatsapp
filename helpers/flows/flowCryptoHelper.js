const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * WhatsApp Flows endpoint encryption. Each request carries an AES-128 key encrypted with our
 * RSA public key (OAEP, SHA-256); the body is AES-128-GCM. The reply is encrypted with the same
 * key and the bitwise-inverted IV, and sent back as a base64 string.
 */

const TAG_LENGTH = 16;
let cachedKey = null;

class FlowDecryptError extends Error {
}

function privateKey() {
    if (!cachedKey) {
        const keyPath = path.resolve(process.env.FLOW_PRIVATE_KEY_PATH || 'keys/flow_private.pem');
        cachedKey = crypto.createPrivateKey({
            key: fs.readFileSync(keyPath, 'utf8'),
            passphrase: process.env.FLOW_PRIVATE_KEY_PASSPHRASE || undefined,
        });
    }
    return cachedKey;
}

module.exports = {
    FlowDecryptError,

    decryptRequest: function (body, key = privateKey()) {
        const {encrypted_aes_key, encrypted_flow_data, initial_vector} = body || {};
        if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
            throw new FlowDecryptError('Missing encrypted fields');
        }
        let aesKey;
        try {
            aesKey = crypto.privateDecrypt(
                {key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'},
                Buffer.from(encrypted_aes_key, 'base64')
            );
        } catch (e) {
            // Usually a key mismatch: WhatsApp re-downloads the public key after a 421.
            throw new FlowDecryptError(`Could not decrypt the AES key: ${e.message}`);
        }
        const iv = Buffer.from(initial_vector, 'base64');
        const data = Buffer.from(encrypted_flow_data, 'base64');
        try {
            const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
            decipher.setAuthTag(data.subarray(-TAG_LENGTH));
            const plain = Buffer.concat([decipher.update(data.subarray(0, -TAG_LENGTH)), decipher.final()]);
            return {decryptedBody: JSON.parse(plain.toString('utf8')), aesKey, iv};
        } catch (e) {
            throw new FlowDecryptError(`Could not decrypt the flow data: ${e.message}`);
        }
    },

    encryptResponse: function (response, aesKey, iv) {
        const flippedIv = Buffer.from(iv.map(b => ~b & 0xff));
        const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
        return Buffer.concat([
            cipher.update(JSON.stringify(response), 'utf8'),
            cipher.final(),
            cipher.getAuthTag(),
        ]).toString('base64');
    },
};
