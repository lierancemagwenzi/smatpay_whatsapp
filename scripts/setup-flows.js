/**
 * Creates or updates the WhatsApp Flows in flows/ through 360dialog (no WhatsApp Manager needed):
 * finds each flow by name, creates it if missing, points it at our endpoint, uploads the JSON,
 * reports validation errors and writes the IDs into .env. Flows stay DRAFT; pass --publish to
 * publish them (irreversible: a published flow can't be edited, only replaced).
 *
 *   node scripts/setup-flows.js https://<public-host>
 */
require('dotenv').config({quiet: true});
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const apiHelper = require('../helpers/whatsapp/apiHelper');

const FLOWS = [
    {name: 'smatpay_signup', file: 'flows/signup_flow.json', category: 'SIGN_UP', envKey: 'FLOW_SIGNUP_ID'},
    {name: 'smatpay_login', file: 'flows/login_flow.json', category: 'SIGN_IN', envKey: 'FLOW_LOGIN_ID'},
    {name: 'smatpay_pin', file: 'flows/pin_flow.json', category: 'OTHER', envKey: 'FLOW_PIN_ID'},
    {name: 'smatpay_confirm_pin', file: 'flows/confirm_pin_flow.json', category: 'OTHER', envKey: 'FLOW_CONFIRM_PIN_ID'},
    {name: 'smatpay_merchant_signup', file: 'flows/merchant_signup_flow.json', category: 'SIGN_UP', envKey: 'FLOW_MERCHANT_SIGNUP_ID'},
    {name: 'smatpay_merchant_login', file: 'flows/merchant_login_flow.json', category: 'SIGN_IN', envKey: 'FLOW_MERCHANT_LOGIN_ID'},
    {name: 'smatpay_merchant_business', file: 'flows/merchant_business_flow.json', category: 'OTHER', envKey: 'FLOW_MERCHANT_BUSINESS_ID'},
    {name: 'smatpay_merchant_bank', file: 'flows/merchant_bank_flow.json', category: 'OTHER', envKey: 'FLOW_MERCHANT_BANK_ID'},
    {name: 'smatpay_merchant_contact', file: 'flows/merchant_contact_flow.json', category: 'OTHER', envKey: 'FLOW_MERCHANT_CONTACT_ID'},
    {name: 'smatpay_merchant_profile', file: 'flows/merchant_profile_flow.json', category: 'OTHER', envKey: 'FLOW_MERCHANT_PROFILE_ID'},
];

const publicHost = (process.argv.find(a => a.startsWith('https://')) || '').replace(/\/+$/, '');
const publish = process.argv.includes('--publish');
const options = {headers: {'D360-API-KEY': apiHelper.apiKey()}, timeout: 30000, validateStatus: () => true};

async function call(method, urlPath, data, extraHeaders = {}) {
    const res = await axios({
        method,
        url: `${apiHelper.baseUrl()}${urlPath}`,
        data,
        ...options,
        headers: {...options.headers, ...extraHeaders},
    });
    if (res.status >= 300) throw new Error(`${method.toUpperCase()} ${urlPath} → ${res.status} ${JSON.stringify(res.data)}`);
    return res.data;
}

function setEnv(key, value) {
    const envPath = path.resolve('.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const line = `${key}=${value}`;
    fs.writeFileSync(envPath, new RegExp(`^${key}=.*$`, 'm').test(env)
        ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
        : `${env.trimEnd()}\n${line}\n`);
}

async function main() {
    if (!publicHost) throw new Error('Pass the public HTTPS host, e.g. https://example.ngrok-free.dev');
    const endpointUri = `${publicHost}/api/whatsapp/flows`;
    const existing = (await call('get', '/flows')).data || [];

    for (const flow of FLOWS) {
        let found = existing.find(f => f.name === flow.name);
        let id = found?.id;
        if (!id) {
            id = (await call('post', '/flows', {name: flow.name, categories: [flow.category], endpoint_uri: endpointUri},
                {'Content-Type': 'application/json'})).id;
            console.log(`${flow.name}: created ${id}`);
        } else {
            console.log(`${flow.name}: found ${id} (${found.status})`);
        }

        const details = await call('get', `/flows/${id}?fields=status,endpoint_uri`);
        if (details.status !== 'DRAFT') {
            console.log(`  ${details.status}: can't be changed; skipping upload`);
            setEnv(flow.envKey, id);
            continue;
        }
        if (details.endpoint_uri !== endpointUri) {
            await call('post', `/flows/${id}`, {endpoint_uri: endpointUri}, {'Content-Type': 'application/json'});
            console.log(`  endpoint → ${endpointUri}`);
        }

        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(path.resolve(flow.file))], {type: 'application/json'}), 'flow.json');
        form.append('name', 'flow.json');
        form.append('asset_type', 'FLOW_JSON');
        const upload = await call('post', `/flows/${id}/assets`, form);
        const errors = upload.validation_errors || [];
        console.log(errors.length ? `  JSON has ${errors.length} error(s):\n${JSON.stringify(errors, null, 2)}` : '  JSON uploaded, no validation errors');

        setEnv(flow.envKey, id);
        if (publish && !errors.length) {
            await call('post', `/flows/${id}/publish`);
            console.log('  published');
        }
    }
    console.log('\nIDs written to .env. Restart the app to pick them up.');
}

main().catch(e => {
    console.error('Failed:', e.message);
    process.exit(1);
});
