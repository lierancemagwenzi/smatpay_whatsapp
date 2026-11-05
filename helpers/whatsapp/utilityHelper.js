const models = require('../../models');
const userModel = models.user;

const GREETINGS = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'menu', 'start'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZW_MOBILE_RE = /^(\+263|263|0)7[0-9]{8}$/;
// Customers abroad (e.g. +27) use their WhatsApp number in international form.
const INTERNATIONAL_RE = /^\+?[1-9][0-9]{7,14}$/;

module.exports = {
    permittedMessages: ['text', 'button', 'interactive', 'image', 'document'],

    findOrCreateUser: async function (msg) {
        const phone = '+' + msg.sender;
        const [user] = await userModel.findOrCreate({
            where: {phone},
            defaults: {phone, wa_name: msg.name, current_flow: 'onboarding'},
        });
        return user;
    },

    /**
     * Normalises a 360dialog webhook into { id, sender, name, type, content }.
     * content.payload is the id of the button or list row pressed; content.flow is a completed Flow.
     */
    parseIncomingMessage: function (reqBody) {
        const value = reqBody?.entry?.[0]?.changes?.[0]?.value;
        if (!value) return null;

        if (value.statuses) {
            const status = value.statuses[0];
            return {id: status.id, sender: status.recipient_id, name: null, type: 'status', content: {status: status.status}};
        }

        const message = value.messages?.[0];
        if (!message) return null;
        const content = {text: null, payload: null};

        switch (message.type) {
            case 'text':
                content.text = message.text?.body ?? null;
                break;
            case 'button':
                // Quick reply on a template.
                content.text = message.button?.text ?? null;
                content.payload = message.button?.payload ?? null;
                break;
            case 'interactive': {
                const interactive = message.interactive || {};
                if (interactive.type === 'button_reply') {
                    content.text = interactive.button_reply.title;
                    content.payload = interactive.button_reply.id;
                } else if (interactive.type === 'list_reply') {
                    content.text = interactive.list_reply.title;
                    content.payload = interactive.list_reply.id;
                } else if (interactive.type === 'nfm_reply') {
                    let response = {};
                    try {
                        response = JSON.parse(interactive.nfm_reply?.response_json || '{}');
                    } catch {
                        response = {};
                    }
                    content.flow = response;
                }
                break;
            }
            case 'image':
                // A photo, e.g. of a merchant's QR code.
                content.mediaId = message.image?.id ?? null;
                content.mimeType = message.image?.mime_type ?? null;
                content.text = message.image?.caption ?? null;
                break;
            case 'document':
                // A file, e.g. a merchant's PDF for going live.
                content.mediaId = message.document?.id ?? null;
                content.mimeType = message.document?.mime_type ?? null;
                content.filename = message.document?.filename ?? null;
                content.text = message.document?.caption ?? null;
                break;
            default:
                content.raw = message;
        }

        return {
            id: message.id,
            sender: message.from,
            name: value.contacts?.[0]?.profile?.name || null,
            type: message.type,
            content,
        };
    },

    /**
     * ALLOWED_NUMBERS (comma separated, e.g. +27824208001) limits the bot to those numbers during
     * development. Empty means everyone is served.
     */
    isAllowedNumber: function (phone) {
        const list = (process.env.ALLOWED_NUMBERS || '').split(',').map(n => n.replace(/[^\d]/g, '')).filter(Boolean);
        return !list.length || list.includes(String(phone).replace(/[^\d]/g, ''));
    },

    isGreeting: function (text) {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return GREETINGS.some(g => normalized === g || normalized.startsWith(g + ' '));
    },

    isValidEmail: function (email) {
        return EMAIL_RE.test(String(email || '').trim());
    },

    isValidZimMobile: function (phone) {
        return ZW_MOBILE_RE.test(String(phone || '').replace(/[\s-]/g, ''));
    },

    /** A Zimbabwean mobile (07…), or any number in international form (+27…, 263…). */
    isValidMobile: function (phone) {
        const digits = String(phone || '').replace(/[\s-]/g, '');
        return ZW_MOBILE_RE.test(digits) || (!digits.startsWith('0') && INTERNATIONAL_RE.test(digits));
    },

    /** 07… / 2637… → +2637…, the format the app sends to Smatpay. */
    normalizePhone: function (phone) {
        const digits = String(phone || '').replace(/[\s-]/g, '');
        if (digits.startsWith('+')) return digits;
        if (digits.startsWith('0')) return `+263${digits.slice(1)}`;
        return `+${digits}`;
    },

    /** +263771234567 → 0771234567 for prefilling forms; other countries stay international. */
    localPhone: function (phone) {
        const digits = String(phone || '').replace(/[^\d]/g, '');
        return digits.startsWith('263') ? `0${digits.slice(3)}` : `+${digits}`;
    },

    isValidOtp: function (code) {
        return /^\d{6}$/.test(String(code || '').trim());
    },

    isValidPin: function (pin) {
        return /^\d{4}$/.test(String(pin || ''));
    },

    /** Rejects 0000, 1111, 1234, 4321 and the like. */
    isWeakPin: function (pin) {
        if (/^(\d)\1{3}$/.test(pin)) return true;
        const d = pin.split('').map(Number);
        const steps = d.slice(1).map((n, i) => n - d[i]);
        return steps.every(s => s === 1) || steps.every(s => s === -1);
    },
};
