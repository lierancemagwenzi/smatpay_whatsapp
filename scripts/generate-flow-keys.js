/**
 * Makes the RSA key pair for the WhatsApp Flows endpoint.
 * keys/flow_private.pem stays on the server (gitignored); keys/flow_public.pem is uploaded to WhatsApp.
 * Set FLOW_PRIVATE_KEY_PASSPHRASE in .env first to encrypt the private key.
 */
require('dotenv').config({quiet: true});
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.resolve('keys');
const privatePath = path.join(dir, 'flow_private.pem');
const publicPath = path.join(dir, 'flow_public.pem');

if (fs.existsSync(privatePath) && !process.argv.includes('--force')) {
    console.error(`${privatePath} already exists. Pass --force to replace it (then upload the new public key).`);
    process.exit(1);
}

const passphrase = process.env.FLOW_PRIVATE_KEY_PASSPHRASE || undefined;
const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {type: 'spki', format: 'pem'},
    privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        ...(passphrase ? {cipher: 'aes-256-cbc', passphrase} : {}),
    },
});

fs.mkdirSync(dir, {recursive: true});
fs.writeFileSync(privatePath, privateKey, {mode: 0o600});
fs.writeFileSync(publicPath, publicKey);
console.log(`Private key: ${privatePath}${passphrase ? ' (encrypted with FLOW_PRIVATE_KEY_PASSPHRASE)' : ''}`);
console.log(`Public key:  ${publicPath}`);
console.log('Next: npm run flow:upload-key');
