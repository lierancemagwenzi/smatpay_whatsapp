/**
 * Uploads keys/flow_public.pem as the WhatsApp Business encryption key of the 360dialog number,
 * then reads it back. 360dialog proxies the Cloud API's whatsapp_business_encryption endpoint;
 * check their Flows docs if the path has changed.
 */
require('dotenv').config({quiet: true});
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const apiHelper = require('../helpers/whatsapp/apiHelper');

async function main() {
    const publicKey = fs.readFileSync(path.resolve('keys/flow_public.pem'), 'utf8');
    const url = `${apiHelper.baseUrl()}/whatsapp_business_encryption`;
    const headers = {'D360-API-KEY': apiHelper.apiKey()};

    const upload = await axios.post(url, new URLSearchParams({business_public_key: publicKey}), {
        headers: {...headers, 'Content-Type': 'application/x-www-form-urlencoded'},
    });
    console.log('Upload:', JSON.stringify(upload.data));

    const check = await axios.get(url, {headers});
    console.log('Current key:', JSON.stringify(check.data, null, 2));
}

main().catch((e) => {
    console.error('Failed:', JSON.stringify(e.response?.data || e.message));
    process.exit(1);
});
