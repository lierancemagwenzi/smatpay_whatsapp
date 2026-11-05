const crypto = require('crypto');

const PIN_KEY_LENGTH = 32;

function tokenKey() {
    const raw = process.env.TOKEN_ENCRYPTION_KEY || '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    }
    return key;
}

module.exports = {
    /** AES-256-GCM; "iv.tag.ciphertext", each base64. */
    encrypt: function (plain) {
        if (plain == null) return null;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
        const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64')).join('.');
    },

    decrypt: function (stored) {
        if (!stored) return null;
        const [iv, tag, body] = stored.split('.').map(p => Buffer.from(p, 'base64'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },

    sha256: function (value) {
        return crypto.createHash('sha256').update(value).digest('hex');
    },

    randomToken: function (bytes = 32) {
        return crypto.randomBytes(bytes).toString('base64url');
    },

    /** "scrypt$salt$hash". */
    hashPin: function (pin) {
        const salt = crypto.randomBytes(16);
        const hash = crypto.scryptSync(pin, salt, PIN_KEY_LENGTH);
        return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
    },

    verifyPin: function (pin, stored) {
        if (!stored) return false;
        const [scheme, salt, hash] = stored.split('$');
        if (scheme !== 'scrypt') return false;
        const expected = Buffer.from(hash, 'base64');
        const actual = crypto.scryptSync(pin, Buffer.from(salt, 'base64'), expected.length);
        return crypto.timingSafeEqual(expected, actual);
    },
};
