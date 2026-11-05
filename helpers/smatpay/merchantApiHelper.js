const {request, SmatpayError} = require('./smatpayApiHelper');
const planeHelper = require('./planeHelper');

/**
 * Merchant accounts on account_service, as the merchant portal (and tese-backend) use them.
 *
 * Signing in with email and password needs the emailed code once (and only once the account is
 * activated); after that the bot works with the merchant's keys: key sign-in needs no code
 * (account_service marks MERCHANT_LOGIN verified) and is repeated whenever the 5-hour token expires.
 */

function expectSuccess(response, fallback) {
    if (!response || response.status === 'Failed' || response.status === 'false') {
        throw new SmatpayError(response?.message || fallback, 'validation', 400);
    }
    return response;
}

module.exports = {
    /** Creates the merchant user; Smatpay emails an activation link. */
    signup: async function ({title, firstName, lastName, email, password}) {
        const res = await request('post', '/auth/signup', {
            body: {title, firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim().toLowerCase(), password},
        });
        return expectSuccess(res, 'Sign up failed. Please try again.');
    },

    /** { token, user: {id, activationActivated, isTeamMember, teamMerchantUserId, …} }; the code is emailed if activated. */
    login: async function (email, password) {
        const res = await request('post', '/auth/authenticate', {body: {email: email.trim().toLowerCase(), password}});
        if (!res?.token) throw new SmatpayError(res?.errorResponse?.errorMessage || 'Incorrect email or password.', 'unauthorized', 401);
        return res;
    },

    verifyOtp: async function (email, otpCode, token) {
        try {
            const res = await request('post', '/auth/verifyOtp', {body: {email: email.trim().toLowerCase(), otpCode: String(otpCode), token}});
            return expectSuccess(res, 'That code is not right. Check the email and try again.');
        } catch (e) {
            if (e.code === 'validation') throw new SmatpayError('That code is not right. Check the email and try again.', 'validation', 400);
            throw e;
        }
    },

    resendOtp: async function (email, token) {
        const res = await request('post', '/auth/resendOtp', {body: {email: email.trim().toLowerCase(), token}});
        return expectSuccess(res, 'We could not send a new code. Please try again.');
    },

    /** The merchant account of a user (keys included), or null when they have none yet. */
    profile: async function (token, userId) {
        try {
            const res = await request('get', `/api/merchant/profile/${userId}`, {token});
            return res?.id ? res : null;
        } catch (e) {
            if (e.code === 'validation' && /no merchant profile/i.test(e.message)) return null;
            throw e;
        }
    },

    /** Creates the merchant account; sandbox keys and a sandbox payment profile come with it. */
    createMerchant: async function (token, body) {
        const res = await request('post', '/api/merchant', {token, body});
        return expectSuccess(res, 'We could not create your business account. Please try again.');
    },

    /** Key sign-in on the current plane: sandbox keys for sandbox, production keys for production. */
    keyLogin: async function (merchantId, merchantKey, merchantApiKey) {
        const path = planeHelper.isSandbox() ? '/auth/authenticate/sandbox/merchant' : '/auth/authenticate/merchant';
        const res = await request('post', path, {body: {merchantId, merchantKey, merchantApiKey}});
        if (!res?.token) throw new SmatpayError(res?.errorResponse?.errorMessage || 'Merchant sign-in failed.', 'unauthorized', 401);
        return res;
    },

    /** Money customers have paid the merchant, less payouts: [{currency, amount}]. */
    payoutBalance: async function (token, merchantId) {
        const res = await request('get', `${planeHelper.merchantApiBase()}/merchantPayoutBalance?merchantId=${encodeURIComponent(merchantId)}`, {token});
        return Array.isArray(res?.data) ? res.data : [];
    },

    /**
     * The prepaid (VAS) wallet a merchant tops up to sell airtime and electricity. Only the sandbox
     * has a merchant-level endpoint; production only has the POS device one. Null when unavailable.
     */
    prepaidBalance: async function (token, merchantId) {
        if (!planeHelper.isSandbox()) return null;
        const res = await request('get', `/sandbox/api/merchantWalletBalances?merchantId=${encodeURIComponent(merchantId)}`, {token});
        return Array.isArray(res?.data) ? res.data : [];
    },

    /**
     * The prepaid wallet dashboard, the merchant-level twin of the POS one
     * (/init/pos/wallet-transactions-dashboard): { walletBalance, transactionValue,
     * transactionValueMonth, mostRecentTransactions }. Only the sandbox has it for merchants;
     * production only has the POS device route, so this returns null there.
     */
    walletDashboard: async function (token, merchantId, year) {
        if (!planeHelper.isSandbox()) return null;
        const params = new URLSearchParams({merchantId, year: String(year)});
        return request('get', `/sandbox/api/walletTransactionsDashboard?${params}`, {token});
    },

    /**
     * Tops up the merchant's prepaid wallet (sandbox: /sandbox/init/authenticate/merchant/wallet-top-up,
     * keys in the body). Production has no merchant top-up yet, only the POS device one; returns
     * null there. Resolves to the provider's initiation: {status, paymentReference, paymentCode,
     * paymentQrCode, paymentRedirectUrl, …}. The response also echoes a login token, which is dropped.
     */
    walletTopUp: async function ({merchantId, merchantKey, merchantApiKey, accountId, walletName, amount, currency, payerName, payerReference, payerMobile}) {
        if (!planeHelper.isSandbox()) return null;
        const res = await request('post', '/sandbox/init/authenticate/merchant/wallet-top-up', {
            body: {
                merchantId, merchantKey, merchantApiKey, walletName,
                amount: Number(amount).toFixed(2),
                paymentCurrency: currency,
                paymentDescription: 'Wallet top-up',
                payerName,
                payerReference,
                payerAccountId: String(accountId),
                ...(payerMobile ? {payerMobile} : {}),
                isTopUp: true,
            },
            timeoutMs: 60000,
        });
        const init = res?.paymentInitiationResponse;
        const failure = res?.auth?.errorResponse?.errorMessage || res?.errorResponse?.errorMessage;
        if (!init || /^(failed|failure|error|rejected)$/i.test(init.status || '')) {
            throw new SmatpayError(init?.paymentResponseMessage || failure || 'The top-up couldn’t be started.', 'validation', 400);
        }
        return init;
    },

    /**
     * Sells from the merchant's prepaid wallet (sandbox /sandbox/api/merchant/…): Smatpay checks the
     * balance, then calls the biller in the same request. Needs the merchant token and the keys.
     * Production has only the POS device routes; returns null there.
     * kind: 'electricity' | 'water' | 'airtime'.
     */
    sell: async function (token, keys, kind, {account, amount, currency, reference, network}) {
        if (!planeHelper.isSandbox()) return null;
        const credentials = {merchantId: keys.merchantId, merchantKey: keys.sandbox?.key, merchantApiKey: keys.sandbox?.apiKey};
        const path = {
            electricity: '/sandbox/api/merchant/purchase-electricity',
            water: '/sandbox/api/merchant/purchase-water',
            airtime: '/sandbox/api/merchant/airtime-purchase',
        }[kind];
        const body = kind === 'airtime'
            ? {...credentials, airtimeType: network, mobileNumber: account, amount: Number(amount), currency, paymentReference: reference, transactionType: 'AIRTIME'}
            : {...credentials, utilityAccount: account, amount: Number(amount), currency, paymentReference: reference};
        const res = await request('post', path, {token, body, timeoutMs: 60000});
        return expectSuccess(res, 'The sale didn’t go through.');
    },

    /**
     * The merchant's profile as the biller service sees it (it refuses sales unless
     * accountApproved is true, even in sandbox). Keys in the body, no token.
     */
    keyProfile: async function (keys) {
        const sandbox = planeHelper.isSandbox();
        const pair = sandbox ? keys.sandbox : keys.production;
        const res = await request('post', sandbox ? '/auth/authenticate/sandbox/merchant/profile' : '/auth/authenticate/merchant/profile', {
            body: {merchantId: keys.merchantId, merchantKey: pair?.key, merchantApiKey: pair?.apiKey},
        });
        return res?.data || null;
    },

    /**
     * The merchant's payment profiles: [{id, paymentProfileNumber, paymentProfileApproved, …}].
     * plane: 'sandbox' | 'production', defaulting to the bot's current one.
     */
    paymentProfiles: async function (token, accountId, plane = null) {
        const sandbox = plane ? plane === 'sandbox' : planeHelper.isSandbox();
        const base = sandbox ? '/api/merchant/sandbox/paymentprofile/' : '/api/merchant/paymentprofile/';
        const res = await request('get', `${base}${accountId}`, {token});
        return Array.isArray(res) ? res : [];
    },

    /**
     * Creates a payment profile on the current plane. Sandbox profiles are approved at once;
     * production ones need the business approved and start unapproved. paymentProfileApproved is
     * never sent: approval is Smatpay's to give.
     */
    createPaymentProfile: async function (token, {accountId, name, description, chargeCustomer, fiscalise, bankAccountId}, plane = null) {
        const sandbox = plane ? plane === 'sandbox' : planeHelper.isSandbox();
        const path = sandbox ? '/api/merchant/sandbox/createPaymentProfile' : '/api/merchant/createPaymentProfile';
        const res = await request('post', path, {
            token,
            body: {
                paymentAccountId: Number(accountId),
                paymentProfileName: name,
                paymentProfileDescription: description,
                paymentChargeCustomer: Boolean(chargeCustomer),
                paymentChargeFiscalization: Boolean(fiscalise),
                ...(bankAccountId ? {bankAccountId: Number(bankAccountId)} : {}),
            },
        });
        return expectSuccess(res, 'The payment profile couldn’t be created.');
    },

    /** Links a bank account to a payment profile (its internal id, not the seven-digit number). */
    linkProfileBank: async function (token, profileId, bankAccountId, plane = null) {
        const sandbox = plane ? plane === 'sandbox' : planeHelper.isSandbox();
        const path = sandbox ? '/api/merchant/sandbox/createPaymentProfileBanks' : '/api/merchant/createPaymentProfileBanks';
        const res = await request('post', path, {token, body: {paymentProfileId: Number(profileId), paymentProfileBankId: Number(bankAccountId)}});
        return expectSuccess(res, 'The bank account couldn’t be linked.');
    },

    /** A payment profile's links, newest first (profileId is the profile's id, not its number). */
    paymentLinks: async function (token, profileId, {pageNo = 1, pageSize = 10} = {}) {
        const base = planeHelper.isSandbox() ? '/api/merchant/sandbox/paymentLinksList' : '/api/merchant/paymentLinksList';
        const query = new URLSearchParams({start: '', end: '', profileId: String(profileId), pageNo: String(pageNo), pageSize: String(pageSize), orderBy: 'desc'});
        const res = await request('get', `${base}?${query}`, {token});
        return {links: Array.isArray(res?.content) ? res.content : [], total: Number(res?.totalElements) || 0};
    },

    /**
     * Creates a payment link, as tese-backend does (multipart; no image). type is ONCE_OFF_FIXED,
     * OPEN_FIXED_AMOUNT or OPEN_DYNAMIC_AMOUNT (no amount). Links other than once-off stop working
     * after endDate. Resolves to the saved link {Id, paymentLinkUrl, paymentLinkShortUrl, …}.
     */
    createPaymentLink: async function (token, {profileNumber, type, name, description, reference, amount, currency, currencyId, startDate, endDate, email}) {
        const form = new FormData();
        form.append('paymentLinkName', name);
        form.append('paymentLinkDescription', description);
        form.append('paymentLinkReference', reference);
        if (type !== 'OPEN_DYNAMIC_AMOUNT') form.append('paymentLinkAmount', Number(amount).toFixed(2));
        form.append('paymentLinkType', type);
        form.append('paymentLinkImageType', 'NONE');
        form.append('paymentLinkProfileId', String(profileNumber));
        form.append('paymentLinkStartDate', startDate);
        form.append('paymentLinkEndDate', endDate);
        form.append('paymentLinkCurrency', currency);
        form.append('paymentLinkCurrencyId', String(currencyId));
        form.append('paymentLinkOtherCurrencies', 'false');
        if (email) form.append('paymentLinkEmail', email);
        const path = planeHelper.isSandbox() ? '/api/merchant/sandbox/paymentLink' : '/api/merchant/paymentLink';
        const res = await request('post', path, {token, body: form, timeoutMs: 30000});
        if (!/^success$/i.test(res?.status || '')) {
            throw new SmatpayError(res?.message || 'The payment link couldn’t be created.', 'validation', 400);
        }
        // The backend reports success even when saving failed; a saved link has an id and a URL.
        const link = res.paymentLink;
        if (!link?.id || !(link.paymentLinkShortUrl || link.paymentLinkUrl)) {
            throw new SmatpayError('The payment link couldn’t be created.', 'validation', 400);
        }
        return link;
    },

    /**
     * Rewrites a link (the backend replaces every field, so pass the link as listed). Used to turn
     * links off and on through their end date: deleting goes through S3, which is broken on dev.
     */
    updatePaymentLink: async function (token, link, {type, endDate, reference}) {
        const form = new FormData();
        form.append('id', String(link.id));
        form.append('paymentLinkName', link.paymentProfileName || '');
        form.append('paymentLinkDescription', link.paymentProfileDescription || '');
        form.append('paymentLinkReference', reference ?? link.paymentLinkReference ?? '');
        if (link.paymentLinkAmount != null) form.append('paymentLinkAmount', String(link.paymentLinkAmount));
        form.append('paymentLinkType', type || link.paymentLinkType);
        form.append('paymentLinkImageType', 'NONE');
        form.append('paymentLinkProfileId', String(link.profileNumber));
        // Dates come back as Harare midnight in UTC (e.g. 2026-10-04T22:00Z for the 5th).
        const start = link.paymentLinkStartDate ? new Date(Date.parse(link.paymentLinkStartDate) + 2 * 3600 * 1000).toISOString().slice(0, 10) : endDate;
        form.append('paymentLinkStartDate', start);
        form.append('paymentLinkEndDate', endDate);
        form.append('paymentLinkCurrency', link.paymentLinkCurrency || '');
        if (link.paymentLinkCurrencyId != null) form.append('paymentLinkCurrencyId', String(link.paymentLinkCurrencyId));
        const path = planeHelper.isSandbox() ? '/api/merchant/sandbox/updatePaymentLink' : '/api/merchant/updatePaymentLink';
        const res = await request('patch', path, {token, body: form, timeoutMs: 30000});
        if (!/^success$/i.test(res?.status || '')) {
            throw new SmatpayError(res?.message || 'The payment link couldn’t be changed.', 'validation', 400);
        }
        return res.paymentLink;
    },

    /**
     * Charges a customer (the merchant "requests payment"), as tese and the NetOne bot do:
     * /init/authenticate/merchant/wallet (sandbox: /sandbox/init/…) with the merchant's keys and a
     * seven-digit payment profile number. Resolves to the provider initiation
     * {status, paymentReference, paymentCode, paymentRedirectUrl, …}; the echoed login token is dropped.
     */
    requestPayment: async function ({keys, accountId, profileNumber, walletName, amount, currency, payerName, reference, payerMobile, description}) {
        const sandbox = planeHelper.isSandbox();
        const pair = sandbox ? keys.sandbox : keys.production;
        const res = await request('post', sandbox ? '/sandbox/init/authenticate/merchant/wallet' : '/init/authenticate/merchant/wallet', {
            body: {
                merchantId: keys.merchantId, merchantKey: pair?.key, merchantApiKey: pair?.apiKey,
                walletName,
                amount: Number(amount).toFixed(2),
                paymentCurrency: currency,
                paymentDescription: description,
                payerName,
                payerReference: reference,
                payerAccountId: String(accountId),
                profileId: Number(profileNumber),
                ...(payerMobile ? {payerMobile} : {}),
            },
            timeoutMs: 60000,
        });
        const init = res?.paymentInitiationResponse;
        const failure = res?.auth?.errorResponse?.errorMessage || res?.errorResponse?.errorMessage;
        if (!init || /^(failed|failure|error|rejected)$/i.test(init.status || '')) {
            throw new SmatpayError(init?.paymentResponseMessage || failure || 'The payment request couldn’t be started.', 'validation', 400);
        }
        return init;
    },

    /** Where a payment stands, by its reference: Pending, Paid, Failed, Cancelled, REFUNDED… */
    trackPayment: async function (reference) {
        const rows = await request('post', `${planeHelper.cardsBase()}/trackPaymentTransaction`, {body: {transactionReference: reference}});
        const row = Array.isArray(rows) ? (rows.find(r => r.paymentReference === reference) || rows[0]) : null;
        return row || null;
    },

    /** The merchant's latest transactions, newest first. */
    recentTransactions: async function (token, merchantId, pageSize = 5) {
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const params = new URLSearchParams({
            merchantId, start: '2020-01-01', end: tomorrow, pageNo: '1', pageSize: String(pageSize),
            // The backend fails without orderBy.
            orderBy: 'desc',
        });
        const res = await request('get', `${planeHelper.merchantApiBase()}/merchantReportList?${params}`, {token});
        return res?.content || [];
    },

    // Going live: bank account, documents, contact person, approval (account_service).

    bankAccounts: async (token, accountId) => request('get', `/api/merchant/bankAccounts/${accountId}`, {token}),
    documents: async (token, accountId) => request('get', `/api/merchant/documentsList/${accountId}`, {token}),
    contacts: async (token, accountId) => request('get', `/api/merchant/contacts/${accountId}`, {token}),

    createBankAccount: async function (token, body) {
        return expectSuccess(await request('post', '/api/merchant/createBankAccount', {token, body}), 'We couldn’t save the bank account.');
    },

    createContact: async function (token, body) {
        return expectSuccess(await request('post', '/api/merchant/createContact', {token, body}), 'We couldn’t save the contact person.');
    },

    /** Multipart upload; Smatpay stores the file under its name, so the caller makes the name unique. */
    uploadDocument: async function (token, {accountId, typeName, typeId, buffer, filename, mimeType}) {
        const form = new FormData();
        form.append('merchantId', String(accountId));
        form.append('documentType', typeName);
        form.append('documentTypeId', String(typeId));
        form.append('document', new Blob([buffer], {type: mimeType || 'application/octet-stream'}), filename);
        const res = await request('post', '/auth/merchantInfo/documentUpload', {token, body: form, timeoutMs: 60000});
        return expectSuccess(res, 'The document couldn’t be uploaded.');
    },

    /** Sends the business to Smatpay's accounts team (a CRM ticket) for approval. */
    requestApproval: async function (token, accountId) {
        return expectSuccess(await request('post', `/api/merchant/requestApproval/${accountId}`, {token}), 'The approval request couldn’t be sent. Please contact support.');
    },

    documentTypes: async () => (await request('get', '/param/documentTypes')).filter(t => t.documentTypeName),
    banks: async () => (await request('get', '/param/banks')).filter(b => b.bankName),
    titles: async () => (await request('get', '/param/titles')).filter(t => t.titleName),
    currencies: async () => (await request('get', '/init/currencies/all')).filter(c => c.currencyCode),

    // Public lists for the business form.
    accountTypes: async () => (await request('get', '/param/accountTypes')).filter(t => t.accountTypeName && t.accountTypeName !== 'Customer'),
    sectors: async () => (await request('get', '/param/sectors')).filter(s => s.sectorName),
    subSectors: async (sectorId) => (await request('get', `/param/sub-sectors/${encodeURIComponent(sectorId)}`)).filter(s => s.sectorName),
    provinces: async () => (await request('get', '/param/provinces')).filter(p => p.provinceName),
};
