const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Going-live forms: the payout bank account (flows/merchant_bank_flow.json) and, for companies,
 * the contact person Smatpay's CRM needs before approval (flows/merchant_contact_flow.json).
 */

async function bankScreen(values, error = null) {
    const [banks, currencies] = await Promise.all([merchantApi.banks(), merchantApi.currencies()]);
    return flowSessionHelper.screen('BANK', {
        banks: banks.map(b => ({id: String(b.id), title: b.bankLongName || b.bankName})),
        currencies: currencies.filter(c => ['USD', 'ZWG'].includes(c.currencyCode)).map(c => ({id: c.currencyCode, title: c.currencyCode})),
        bank: values.bank || '',
        branch: values.branch || '',
        account_number: values.account_number || '',
        account_name: values.account_name || '',
        currency: values.currency || 'USD',
    }, error);
}

async function contactScreen(values, error = null) {
    const titles = await merchantApi.titles();
    return flowSessionHelper.screen('CONTACT', {
        titles: titles.map(t => ({id: String(t.id), title: t.titleName})),
        title: values.title || '',
        first_name: values.first_name || '',
        last_name: values.last_name || '',
        id_number: values.id_number || '',
        email: values.email || '',
        mobile: values.mobile || '',
    }, error);
}

const bank = {
    FLOW: 'merchant_bank',

    send: async function (sender) {
        const flowToken = await flowSessionHelper.create('+' + sender, this.FLOW);
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_MERCHANT_BANK_ID,
            flowToken,
            cta: 'Add bank account',
            body: 'Add the bank account Smatpay pays your money into, in the secure form.',
        });
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || screen !== 'BANK') {
            const user = await userModel.findOne({where: {phone: session.phone}});
            return bankScreen({account_name: user?.merchant_name || ''});
        }
        const values = {
            bank: String(data.bank || ''),
            branch: (data.branch || '').trim(),
            account_number: String(data.account_number || '').replace(/\s/g, ''),
            account_name: (data.account_name || '').trim(),
            currency: String(data.currency || ''),
        };
        const chosen = (await merchantApi.banks()).find(b => String(b.id) === values.bank);
        if (!chosen) return bankScreen(values, 'Choose your bank.');
        if (values.branch.length < 2) return bankScreen(values, 'Enter the branch.');
        if (!/^[0-9A-Za-z-]{5,30}$/.test(values.account_number)) return bankScreen(values, 'Enter a valid account number.');
        if (values.account_name.length < 2) return bankScreen(values, 'Enter the name on the account.');
        const currency = (await merchantApi.currencies()).find(c => c.currencyCode === values.currency);
        if (!currency) return bankScreen(values, 'Choose the account currency.');

        const user = await userModel.findOne({where: {phone: session.phone}});
        try {
            await merchantSession.withToken(session.phone, token => merchantApi.createBankAccount(token, {
                accountId: Number(user.merchant_account_id),
                bankName: chosen.bankName,
                bankBranch: values.branch,
                bankAccount: values.account_number,
                bankAccountNames: values.account_name,
                bankBICCode: chosen.bankCode,
                bankSwiftCode: chosen.bankCode,
                bankCurrency: currency.currencyCode,
                bankCurrencyId: currency.id,
            }));
        } catch (e) {
            return bankScreen(values, e.message);
        }
        await flowSessionHelper.complete(session, 'merchant_bank_saved');
        return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_bank_saved'});
    },
};

const contact = {
    FLOW: 'merchant_contact',

    send: async function (sender) {
        const flowToken = await flowSessionHelper.create('+' + sender, this.FLOW);
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_MERCHANT_CONTACT_ID,
            flowToken,
            cta: 'Add contact',
            body: 'Add the company’s contact person in the secure form.',
        });
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || screen !== 'CONTACT') {
            return contactScreen({mobile: utilityHelper.localPhone(session.phone)});
        }
        const values = {
            title: String(data.title || ''),
            first_name: (data.first_name || '').trim(),
            last_name: (data.last_name || '').trim(),
            id_number: (data.id_number || '').trim().toUpperCase(),
            email: (data.email || '').trim().toLowerCase(),
            mobile: (data.mobile || '').trim(),
        };
        const title = (await merchantApi.titles()).find(t => String(t.id) === values.title);
        if (!title) return contactScreen(values, 'Choose a title.');
        if (values.first_name.length < 2 || values.last_name.length < 2) return contactScreen(values, 'Enter the first and last name.');
        if (values.id_number.length < 6) return contactScreen(values, 'Enter the ID number.');
        if (!utilityHelper.isValidEmail(values.email)) return contactScreen(values, 'That doesn’t look like a valid email.');
        if (!utilityHelper.isValidMobile(values.mobile)) return contactScreen(values, 'Enter a valid mobile number.');

        const user = await userModel.findOne({where: {phone: session.phone}});
        try {
            await merchantSession.withToken(session.phone, token => merchantApi.createContact(token, {
                accountId: Number(user.merchant_account_id),
                titleName: title.titleName,
                titleId: title.id,
                firstName: values.first_name,
                lastName: values.last_name,
                idNumber: values.id_number,
                email: values.email,
                mobile: utilityHelper.normalizePhone(values.mobile),
                // The CRM's legal contact, as Smatpay creates for individuals itself.
                roleTypeName: 'Legal',
                roleTypeId: 1,
            }));
        } catch (e) {
            return contactScreen(values, e.message);
        }
        await flowSessionHelper.complete(session, 'merchant_contact_saved');
        return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_contact_saved'});
    },
};

const FEE_OPTIONS = [
    {id: 'merchant', title: 'My business pays the fees'},
    {id: 'customer', title: 'The customer pays the fees'},
];
const FISCAL_OPTIONS = [{id: 'no', title: 'No'}, {id: 'yes', title: 'Yes, fiscalise payments'}];

async function profileScreen(phone, values, error = null) {
    const user = await userModel.findOne({where: {phone}});
    const banks = await merchantSession.withToken(phone, token => merchantApi.bankAccounts(token, user.merchant_account_id)).catch(() => []);
    return flowSessionHelper.screen('PROFILE', {
        fee_options: FEE_OPTIONS,
        fiscal_options: FISCAL_OPTIONS,
        banks: [
            ...(banks || []).map(b => ({id: String(b.Id ?? b.id), title: `${b.bankName} ••••${String(b.bankAccount || '').slice(-4)} (${b.bankCurrency})`})),
            {id: 'none', title: 'Not now'},
        ],
        name: values.name || '',
        description: values.description || '',
        fees: values.fees || 'merchant',
        fiscalise: values.fiscalise || 'no',
        bank: values.bank || ((banks || [])[0] ? String(banks[0].Id ?? banks[0].id) : 'none'),
    }, error);
}

const profile = {
    FLOW: 'merchant_profile',

    /** plane: 'production' for a live profile, 'sandbox' for a test one (kept as the session's purpose). */
    send: async function (sender, plane) {
        const flowToken = await flowSessionHelper.create('+' + sender, this.FLOW, plane === 'production' ? 'production' : 'sandbox');
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_MERCHANT_PROFILE_ID,
            flowToken,
            cta: plane === 'production' ? 'New live profile' : 'New test profile',
            body: plane === 'production'
                ? 'Set up a live payment profile in the secure form. Smatpay approves live profiles before they take real payments.'
                : 'Set up a test (sandbox) payment profile in the secure form.',
        });
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || screen !== 'PROFILE') return profileScreen(session.phone, {});
        const values = {
            name: (data.name || '').trim(),
            description: (data.description || '').trim(),
            fees: String(data.fees || ''),
            fiscalise: String(data.fiscalise || ''),
            bank: String(data.bank || 'none'),
        };
        if (values.name.length < 2) return profileScreen(session.phone, values, 'Give the profile a name.');
        if (values.description.length < 2) return profileScreen(session.phone, values, 'Say what the profile is for.');
        if (!FEE_OPTIONS.some(o => o.id === values.fees)) return profileScreen(session.phone, values, 'Choose who pays the fees.');
        if (!FISCAL_OPTIONS.some(o => o.id === values.fiscalise)) return profileScreen(session.phone, values, 'Choose whether to fiscalise payments.');
        const bankAccountId = values.bank !== 'none' ? Number(values.bank) : null;

        const user = await userModel.findOne({where: {phone: session.phone}});
        const accountId = user.merchant_account_id;
        const plane = session.purpose === 'production' ? 'production' : 'sandbox';
        try {
            const before = new Set((await merchantSession.withToken(session.phone, t => merchantApi.paymentProfiles(t, accountId, plane))).map(p => p.id));
            await merchantSession.withToken(session.phone, token => merchantApi.createPaymentProfile(token, {
                accountId, name: values.name, description: values.description,
                chargeCustomer: values.fees === 'customer', fiscalise: values.fiscalise === 'yes', bankAccountId,
            }, plane));
            if (bankAccountId) {
                // The create call doesn't return the profile; find the new one to link its bank account.
                const created = (await merchantSession.withToken(session.phone, t => merchantApi.paymentProfiles(t, accountId, plane)))
                    .filter(p => !before.has(p.id)).sort((a, b) => b.id - a.id)[0];
                if (created) await merchantSession.withToken(session.phone, t => merchantApi.linkProfileBank(t, created.id, bankAccountId, plane));
            }
        } catch (e) {
            return profileScreen(session.phone, values, e.message);
        }
        await flowSessionHelper.complete(session, 'merchant_profile_saved');
        return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_profile_saved'});
    },
};

module.exports = {bank, contact, profile};
