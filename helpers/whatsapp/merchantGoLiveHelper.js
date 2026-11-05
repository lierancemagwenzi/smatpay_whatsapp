const {Op} = require('sequelize');
const models = require('../../models');
const userModel = models.user;
const messagingHelper = require('./messagingHelper');
const mediaHelper = require('./mediaHelper');
const merchantApi = require('../smatpay/merchantApiHelper');
const merchantSession = require('../smatpay/merchantSessionHelper');
const goLiveForms = require('../flows/merchantGoLiveFlowHelper');
const lockHelper = require('../lockHelper');

/**
 * Merchant menu → Go live: what Smatpay needs before approving a business — a payout bank account,
 * the documents for its account type (sent as photos or PDFs in the chat), a contact person for
 * companies — then the approval request. The bot then watches for approval and switches the
 * business to its production keys.
 */

const UPLOAD_STEP = 'mgolive_doc_upload';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Shorter names for WhatsApp list rows (24 characters); the full name goes in the description.
const SHORT_NAMES = {
    1: 'Memorandum & articles', 2: 'Certificate of incorp.', 4: 'Directors’ IDs', 5: 'Directors’ addresses',
    6: 'Tax clearance', 7: 'CR5', 8: 'CR6', 9: 'Board resolution', 10: 'Account mandate', 11: 'Directors’ photos',
    12: 'ID or passport', 13: 'Proof of residence', 14: 'Landlord affidavit', 15: 'Bank confirmation', 16: 'Bank statement',
};
// "Where applicable" in Smatpay's list.
const OPTIONAL = new Set([14]);
const EXTENSIONS = {'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf'};

const menuButton = {id: 'MAIN_MENU', title: 'Menu'};

/** Everything Go live needs to know, in one read. */
async function status(user) {
    const keys = merchantSession.keys(user);
    const accountId = user.merchant_account_id;
    const [profile, banks, documents, contacts, types] = await Promise.all([
        merchantApi.keyProfile(keys),
        merchantSession.withToken(user.phone, token => merchantApi.bankAccounts(token, accountId)),
        merchantSession.withToken(user.phone, token => merchantApi.documents(token, accountId)),
        merchantSession.withToken(user.phone, token => merchantApi.contacts(token, accountId)),
        merchantApi.documentTypes(),
    ]);
    const company = String(profile?.accountType || '').toLowerCase() === 'company';
    const required = types.filter(t => t.documentTypeAccountTypeName === (company ? 'Company' : 'Individual'));
    const uploaded = new Set((documents || []).map(d => Number(d.fileTypeId)).filter(Boolean));
    const missing = required.filter(t => !OPTIONAL.has(t.id) && !uploaded.has(t.id));
    return {
        profile,
        company,
        approved: profile?.accountApproved === true,
        requested: profile?.accountRequestApproval === true || Boolean(user.merchant_approval_requested_at),
        bank: (banks || [])[0] || null,
        required,
        uploaded,
        missing,
        // Smatpay adds an individual's contact itself; a company must add one.
        contactNeeded: company && !(contacts || []).length,
    };
}

module.exports = {
    UPLOAD_STEP,

    handlesPayload: function (payload) {
        return /^MGOLIVE_/.test(payload || '');
    },

    show: async function (msg, user) {
        let s;
        try {
            s = await status(user);
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, `Your go-live details couldn’t be loaded: ${e.message}`, [{id: 'MERCHANT_GO_LIVE', title: 'Try again'}, menuButton]);
        }
        // Approved businesses keep managing documents and bank accounts here; only the request goes.
        if (s.approved && !user.merchant_approved) await this.applyApproval(user);

        const docsDone = s.required.filter(t => !OPTIONAL.has(t.id)).length - s.missing.length;
        const docsNeeded = s.required.filter(t => !OPTIONAL.has(t.id)).length;
        const ready = s.bank && !s.missing.length && !s.contactNeeded;
        const lines = [
            `*${s.approved ? 'Business documents' : 'Go live'}: ${user.merchant_name}*`,
            s.approved ? '✅ Approved by Smatpay. You can keep your documents and bank details up to date here.' : 'Smatpay needs these before approving your business:',
            '',
            `${s.bank ? '✅' : '⬜'} Bank account${s.bank ? `: ${s.bank.bankName} ••••${String(s.bank.bankAccount || '').slice(-4)}` : ''}`,
            `${s.missing.length ? '⬜' : '✅'} Documents: ${docsDone} of ${docsNeeded}`,
            ...(s.company ? [`${s.contactNeeded ? '⬜' : '✅'} Contact person`] : []),
        ];
        if (s.approved) {
            // nothing more to ask for
        } else if (s.requested) lines.push('', '⏳ Approval requested. Smatpay’s accounts team is reviewing it; I’ll message you when it’s approved.');
        else if (ready) lines.push('', 'Everything’s in. Request approval when you’re ready.');

        const rows = [
            {id: 'MGOLIVE_BANK', title: s.bank ? 'Add another bank account' : 'Add bank account', description: 'Where Smatpay pays out your money'},
            {id: 'MGOLIVE_DOCS', title: 'Documents', description: `${docsDone} of ${docsNeeded} uploaded`},
            {id: 'MGOLIVE_PROFILES', title: 'Payment profiles', description: 'Fees, fiscalisation and payout account'},
            ...(s.company ? [{id: 'MGOLIVE_CONTACT', title: 'Contact person', description: s.contactNeeded ? 'Needed for a company' : 'Added'}] : []),
            ...(ready && !s.requested && !s.approved ? [{id: 'MGOLIVE_REQUEST', title: 'Request approval', description: 'Send your business to Smatpay for review'}] : []),
            {id: 'MAIN_MENU', title: 'Back to menu'},
        ];
        await messagingHelper.sendList(msg.sender, lines.join('\n'), 'Choose', [{title: s.approved ? 'Business' : 'Go live', rows}], s.approved ? 'Business documents' : 'Go live');
        await messagingHelper.setStep(msg.sender, 'merchant_go_live');
    },

    /** The required documents, 8 to a page (companies have 11). */
    /** The business's live and test payment profiles, and a way to add either. */
    showProfiles: async function (msg, user) {
        const accountId = user.merchant_account_id;
        let live;
        let test;
        let banks = [];
        try {
            [live, test, banks] = await Promise.all([
                merchantSession.withToken(user.phone, t => merchantApi.paymentProfiles(t, accountId, 'production')),
                merchantSession.withToken(user.phone, t => merchantApi.paymentProfiles(t, accountId, 'sandbox')),
                merchantSession.withToken(user.phone, t => merchantApi.bankAccounts(t, accountId)).catch(() => []),
            ]);
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, `Payment profiles couldn’t be loaded: ${e.message}`, [{id: 'MGOLIVE_PROFILES', title: 'Try again'}, menuButton]);
        }
        const bankName = id => {
            const b = (banks || []).find(x => String(x.Id ?? x.id) === String(id));
            return b ? `${b.bankName} ••••${String(b.bankAccount || '').slice(-4)}` : null;
        };
        const describe = p => [
            `*${p.paymentProfileName}* · ${p.paymentProfileNumber}`,
            [
                p.paymentProfileApproved ? '✅ Approved' : '⏳ Awaiting Smatpay approval',
                p.paymentChargeCustomer ? 'customer pays fees' : 'you pay fees',
                p.paymentChargeFiscalization ? 'fiscalised' : 'not fiscalised',
                bankName(p.bankAccountId) ? `pays out to ${bankName(p.bankAccountId)}` : null,
            ].filter(Boolean).join(' · '),
        ].join('\n');

        const lines = [`*Payment profiles: ${user.merchant_name}*`, '', '*Live* (real payments)'];
        lines.push(live.length ? live.map(describe).join('\n\n') : 'None yet. You need one to take real payments.');
        lines.push('', '*Test* (sandbox)');
        lines.push(test.length ? test.map(describe).join('\n\n') : 'None yet.');
        await messagingHelper.sendButtons(msg.sender, lines.join('\n'), [
            {id: 'MGOLIVE_PROFILE_NEW:production', title: 'New live profile'},
            {id: 'MGOLIVE_PROFILE_NEW:sandbox', title: 'New test profile'},
            {id: 'MERCHANT_GO_LIVE', title: 'Back'},
        ]);
    },

    showDocuments: async function (msg, user, offset = 0) {
        const s = await status(user);
        const page = s.required.slice(offset, offset + 8);
        const rows = page.map(t => ({
            id: `MGOLIVE_DOC:${t.id}`,
            title: `${s.uploaded.has(t.id) ? '✅ ' : ''}${SHORT_NAMES[t.id] || t.documentTypeName}`,
            description: `${OPTIONAL.has(t.id) ? 'If applicable. ' : ''}${t.documentTypeName}`,
        }));
        if (offset + 8 < s.required.length) rows.push({id: `MGOLIVE_DOCS:${offset + 8}`, title: 'More documents', description: `${s.required.length - offset - 8} more`});
        rows.push({id: 'MERCHANT_GO_LIVE', title: 'Back to Go live'});
        await messagingHelper.sendList(msg.sender,
            `Tap a document, then send it here as a photo or PDF.${s.missing.length ? ` Still needed: ${s.missing.length}.` : ' All the required ones are in.'}`,
            'Choose document', [{title: s.company ? 'Company documents' : 'Your documents', rows: rows.slice(0, 10)}], 'Documents');
    },

    askForDocument: async function (msg, user, typeId) {
        const type = (await merchantApi.documentTypes()).find(t => String(t.id) === String(typeId));
        if (!type) return this.showDocuments(msg, user);
        await user.update({draft: {service: 'merchant_doc', typeId: type.id, typeName: type.documentTypeName}});
        await messagingHelper.sendButtons(msg.sender,
            `Send a clear photo or PDF of:\n*${type.documentTypeName}*\n\nMake sure every corner is visible and the text is readable.`,
            [{id: 'MGOLIVE_DOCS', title: 'Back to documents'}]);
        await messagingHelper.setStep(msg.sender, UPLOAD_STEP);
    },

    /** A photo or PDF sent while a document is being asked for. */
    receiveDocument: async function (msg, user) {
        const d = user.draft;
        if (user.last_bot_message !== UPLOAD_STEP || d?.service !== 'merchant_doc') {
            return messagingHelper.sendButtons(msg.sender, 'To upload a document, open Documents and tap the one you’re sending, then send the photo or PDF.', [{id: 'MGOLIVE_DOCS', title: 'Documents'}, menuButton]);
        }
        let file;
        try {
            file = await mediaHelper.download(msg.content.mediaId);
        } catch (e) {
            console.error('Downloading a merchant document failed:', e.message);
            return messagingHelper.sendMessage(msg.sender, 'I couldn’t download that file. Please send it again.');
        }
        const mimeType = (file.mimeType || msg.content.mimeType || '').split(';')[0];
        const ext = EXTENSIONS[mimeType];
        if (!ext) return messagingHelper.sendMessage(msg.sender, 'Please send a photo (JPG or PNG) or a PDF.');
        if (file.buffer.length > MAX_UPLOAD_BYTES) return messagingHelper.sendMessage(msg.sender, 'That file is over 10 MB. Please send a smaller photo or PDF.');

        try {
            await merchantSession.withToken(user.phone, token => merchantApi.uploadDocument(token, {
                accountId: user.merchant_account_id,
                typeName: d.typeName,
                typeId: d.typeId,
                buffer: file.buffer,
                // Smatpay stores files under their name: make it unique to this business and upload.
                filename: `merchant-${user.merchant_account_id}-doc${d.typeId}-${Date.now()}.${ext}`,
                mimeType,
            }));
        } catch (e) {
            console.error(`Document upload for account ${user.merchant_account_id} failed: [${e.status}] ${e.reason || e.message}`);
            // Storage failures are Smatpay's side; the details stay in the log.
            const reason = /\bS3\b|AWS/i.test(e.reason || '')
                ? 'Smatpay couldn’t store the document right now (a problem on Smatpay’s side). Please try again later.'
                : (e.reason || e.message);
            return messagingHelper.sendButtons(msg.sender, `The upload didn’t work: ${reason}`, [{id: `MGOLIVE_DOC:${d.typeId}`, title: 'Try again'}, menuButton]);
        }
        await user.update({draft: null});
        await messagingHelper.sendMessage(msg.sender, `✅ ${SHORT_NAMES[d.typeId] || d.typeName} uploaded.`);
        return this.showDocuments(msg, user);
    },

    requestApproval: async function (msg, user) {
        const s = await status(user);
        if (!s.bank || s.missing.length || s.contactNeeded) return this.show(msg, user);
        try {
            await merchantSession.withToken(user.phone, token => merchantApi.requestApproval(token, user.merchant_account_id));
        } catch (e) {
            return messagingHelper.sendButtons(msg.sender, `The approval request didn’t go through: ${e.message}`, [{id: 'MGOLIVE_REQUEST', title: 'Try again'}, menuButton]);
        }
        await user.update({merchant_approval_requested_at: new Date()});
        return messagingHelper.sendButtons(msg.sender,
            'Sent. Smatpay’s accounts team will review your business and documents. I’ll message you here as soon as it’s approved.',
            [menuButton]);
    },

    /** Approved: store the production keys Smatpay issued and stop watching. */
    applyApproval: async function (user) {
        const account = await merchantSession.withToken(user.phone, token => merchantApi.profile(token, user.merchant_user_id));
        if (account) await merchantSession.saveAccount(user.phone, user.merchant_user_id, account);
        await userModel.update({merchant_approved: true, merchant_approval_requested_at: null}, {where: {phone: user.phone}});
    },

    /** Checks businesses waiting for approval; run every few minutes. */
    watchApprovals: async function () {
        const waiting = await userModel.findAll({where: {user_type: 'merchant', merchant_approved: false, merchant_approval_requested_at: {[Op.ne]: null}}, limit: 50});
        for (const user of waiting) {
            await lockHelper.withLock(`msg:${user.phone.replace(/^\+/, '')}`, async () => {
                const profile = await merchantApi.keyProfile(merchantSession.keys(user));
                if (profile?.accountApproved !== true) return;
                await this.applyApproval(user);
                await messagingHelper.sendButtons(user.phone.replace(/^\+/, ''),
                    `🎉 *${user.merchant_name}* is approved by Smatpay. You can now sell ZESA, water and airtime from your wallet.`,
                    [{id: 'MERCHANT_SELL', title: 'Sell now'}, menuButton]);
            }).catch(e => console.error(`Approval check for ${user.phone} failed:`, e.message));
        }
    },

    manageButtons: async function (msg, user) {
        const [action, value] = msg.content.payload.split(':');
        switch (action) {
            case 'MGOLIVE_BANK':
                return require('./merchantHelper').requirePin(msg, user, {service: 'merchant_bank'}, 'Add a bank account for payouts.');
            case 'MGOLIVE_CONTACT': return goLiveForms.contact.send(msg.sender);
            case 'MGOLIVE_DOCS': return this.showDocuments(msg, user, Number(value) || 0);
            case 'MGOLIVE_DOC': return this.askForDocument(msg, user, value);
            case 'MGOLIVE_REQUEST': return this.requestApproval(msg, user);
            case 'MGOLIVE_PROFILES': return this.showProfiles(msg, user);
            case 'MGOLIVE_PROFILE_NEW':
                if (value === 'production') {
                    return require('./merchantHelper').requirePin(msg, user, {service: 'merchant_profile_live'}, 'Create a live payment profile.');
                }
                return goLiveForms.profile.send(msg.sender, 'sandbox');
            default: return this.show(msg, user);
        }
    },
};
