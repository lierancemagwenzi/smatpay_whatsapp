const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('../whatsapp/messagingHelper');
const utilityHelper = require('../whatsapp/utilityHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const cryptoHelper = require('../cryptoHelper');
const flowSessionHelper = require('./flowSessionHelper');

/**
 * Merchant registration, part 2 (flows/merchant_business_flow.json): the business. Creating it
 * on Smatpay issues sandbox keys and a sandbox payment profile straight away; going live
 * (documents, bank account, approval) comes later.
 */

const FLOW = 'merchant_business';

const TYPE_LABELS = {Individual: 'Individual (sole trader)', Company: 'Company'};

async function businessScreen(details, error = null) {
    const [types, sectors] = await Promise.all([merchantApi.accountTypes(), merchantApi.sectors()]);
    return flowSessionHelper.screen('BUSINESS', {
        account_types: types.map(t => ({id: t.accountTypeName, title: TYPE_LABELS[t.accountTypeName] || t.accountTypeName})),
        sectors: sectors.map(s => ({id: String(s.id), title: s.sectorName})),
        account_type: details.account_type || '',
        trading_name: details.trading_name || '',
        business_description: details.business_description || '',
        sector: details.sector || '',
    }, error);
}

async function contactScreen(session, values, error = null) {
    const business = session.data.business;
    const [subSectors, provinces] = await Promise.all([merchantApi.subSectors(business.sector), merchantApi.provinces()]);
    return flowSessionHelper.screen('CONTACT', {
        sub_sectors: subSectors.map(s => ({id: String(s.id), title: s.sectorName})),
        provinces: provinces.map(p => ({id: p.provinceName, title: p.provinceName})),
        is_company: business.account_type === 'Company',
        sub_sector: values.sub_sector || '',
        registered_name: values.registered_name || '',
        registration_number: values.registration_number || '',
        trading_address: values.trading_address || '',
        province: values.province || '',
        phone: values.phone || utilityHelper.localPhone(session.phone),
        email: values.email || session.data.email || '',
    }, error);
}

module.exports = {
    FLOW,

    send: async function (sender, email = null) {
        const flowToken = await flowSessionHelper.create('+' + sender, FLOW, null, {email});
        await messagingHelper.sendForm(sender, {
            flowId: process.env.FLOW_MERCHANT_BUSINESS_ID,
            flowToken,
            cta: 'Add business',
            header: 'Your business',
            body: 'Tell us about your business in the secure form. You can start taking test payments as soon as it’s created.',
        });
        await messagingHelper.setStep(sender, 'merchant_business_sent');
    },

    handle: async function (session, action, screen, data, flowToken) {
        if (action === 'INIT' || action === 'BACK' || !screen) return businessScreen(session.data.business || {});

        if (screen === 'BUSINESS') {
            const business = {
                account_type: (data.account_type || '').trim(),
                trading_name: (data.trading_name || '').trim(),
                business_description: (data.business_description || '').trim(),
                sector: String(data.sector || '').trim(),
            };
            if (!['Individual', 'Company'].includes(business.account_type)) return businessScreen(business, 'Choose how the business is registered.');
            if (business.trading_name.length < 2) return businessScreen(business, 'Enter the trading name.');
            if (business.business_description.length < 3) return businessScreen(business, 'Say briefly what the business does.');
            const sector = (await merchantApi.sectors()).find(s => String(s.id) === business.sector);
            if (!sector) return businessScreen(business, 'Choose a business sector.');
            await flowSessionHelper.saveData(session, {business: {...business, sector_name: sector.sectorName}});
            return contactScreen(session, {});
        }

        if (screen === 'CONTACT') {
            const business = session.data.business;
            if (!business) return businessScreen({}, 'Please start with the business details.');
            const values = {
                sub_sector: String(data.sub_sector || ''),
                registered_name: (data.registered_name || '').trim(),
                registration_number: (data.registration_number || '').trim(),
                trading_address: (data.trading_address || '').trim(),
                province: (data.province || '').trim(),
                phone: (data.phone || '').trim(),
                email: (data.email || '').trim().toLowerCase(),
            };
            const subSector = (await merchantApi.subSectors(business.sector)).find(s => String(s.id) === values.sub_sector);
            if (!subSector) return contactScreen(session, values, 'Choose a sub-sector.');
            if (business.account_type === 'Company' && values.registered_name.length < 2) return contactScreen(session, values, 'Enter the registered company name.');
            if (values.trading_address.length < 5) return contactScreen(session, values, 'Enter the business address.');
            if (!values.province) return contactScreen(session, values, 'Choose a province.');
            if (!utilityHelper.isValidMobile(values.phone)) return contactScreen(session, values, 'Enter a valid phone number.');
            if (!utilityHelper.isValidEmail(values.email)) return contactScreen(session, values, 'That doesn’t look like a valid email.');

            const user = await userModel.findOne({where: {phone: session.phone}});
            const token = cryptoHelper.decrypt(user?.merchant_token_enc);
            const expired = !token || !user.merchant_token_expires_at || new Date(user.merchant_token_expires_at) < new Date();
            if (expired || !user.merchant_user_id) {
                await flowSessionHelper.complete(session, 'merchant_relogin');
                return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_relogin'});
            }

            const phone = utilityHelper.normalizePhone(values.phone);
            const company = business.account_type === 'Company';
            try {
                await merchantApi.createMerchant(token, {
                    userId: Number(user.merchant_user_id),
                    accountType: business.account_type,
                    tradingName: business.trading_name,
                    businessDescription: business.business_description,
                    accountBusinessSector: business.sector_name,
                    accountBusinessSubSector: subSector.sectorName,
                    registeredLegalCompanyName: company ? values.registered_name : '',
                    registrationNumber: company ? values.registration_number : '',
                    tradingAddress: values.trading_address,
                    province: values.province,
                    country: 'Zimbabwe',
                    telephoneNumber: phone,
                    companyMobile: company ? phone : '',
                    individualMobile: company ? '' : phone,
                    companyEmailAddress: company ? values.email : '',
                    emailAddress: values.email,
                });
            } catch (e) {
                return contactScreen(session, values, e.message);
            }

            const account = await merchantApi.profile(token, user.merchant_user_id);
            if (!account) return contactScreen(session, values, 'Your business was saved but isn’t showing yet. Please try again in a minute.');
            await merchantSession.saveAccount(session.phone, user.merchant_user_id, account);
            await flowSessionHelper.complete(session, 'merchant_ready');
            return flowSessionHelper.closeResponse(flowToken, {result: 'merchant_ready'});
        }

        return businessScreen({});
    },
};
