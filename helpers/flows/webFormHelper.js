const fs = require('fs');
const path = require('path');

/**
 * Renders the WhatsApp Flow screens in flows/*.json as plain web pages, so the same forms work
 * over a link while Flows are unavailable. Only the components those files use are supported:
 * TextBody, TextCaption, TextInput and Footer.
 */

const FILES = {
    signup: 'flows/signup_flow.json',
    login: 'flows/login_flow.json',
    pin: 'flows/pin_flow.json',
    confirm_pin: 'flows/confirm_pin_flow.json',
    merchant_signup: 'flows/merchant_signup_flow.json',
    merchant_login: 'flows/merchant_login_flow.json',
    merchant_business: 'flows/merchant_business_flow.json',
    merchant_bank: 'flows/merchant_bank_flow.json',
    merchant_contact: 'flows/merchant_contact_flow.json',
    merchant_profile: 'flows/merchant_profile_flow.json',
};

const definitions = {};

function definition(flow) {
    if (!definitions[flow]) {
        definitions[flow] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', FILES[flow]), 'utf8'));
    }
    return definitions[flow];
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
}

/** "${data.x}" → data.x; anything else unchanged. */
function resolve(value, data) {
    if (typeof value !== 'string') return value;
    const whole = value.match(/^\$\{data\.(\w+)\}$/);
    if (whole) return data[whole[1]];
    return value.replace(/\$\{data\.(\w+)\}/g, (_, key) => data[key] ?? '');
}

const AUTOCOMPLETE = {
    email: 'email',
    password: 'current-password',
    confirm_password: 'new-password',
    first_name: 'given-name',
    last_name: 'family-name',
    phone: 'tel',
};

function input(component, data, flow) {
    const type = component['input-type'];
    const attrs = [
        `name="${escapeHtml(component.name)}"`,
        `id="${escapeHtml(component.name)}"`,
        component.required ? 'required' : '',
        component['min-chars'] ? `minlength="${component['min-chars']}"` : '',
        component['max-chars'] ? `maxlength="${component['max-chars']}"` : '',
    ];
    if (type === 'passcode') {
        attrs.push('type="password"', 'inputmode="numeric"', 'pattern="[0-9]*"', 'autocomplete="off"');
    } else {
        attrs.push(`type="${{phone: 'tel', number: 'number'}[type] || type || 'text'}"`);
        let autocomplete = AUTOCOMPLETE[component.name];
        if (component.name === 'password' && flow === 'signup') autocomplete = 'new-password';
        if (autocomplete) attrs.push(`autocomplete="${autocomplete}"`);
    }
    const initValue = resolve(component['init-value'], data);
    if (initValue && type !== 'password' && type !== 'passcode') attrs.push(`value="${escapeHtml(initValue)}"`);
    const helper = component['helper-text'] ? `<small>${escapeHtml(component['helper-text'])}</small>` : '';
    return `<label for="${escapeHtml(component.name)}">${escapeHtml(component.label)}</label>
      <input ${attrs.filter(Boolean).join(' ')}>${helper}`;
}

/** A Flow Dropdown: "data-source" is a list of {id, title}; the chosen id is submitted. */
function dropdown(component, data) {
    const options = resolve(component['data-source'], data) || [];
    const selected = resolve(component['init-value'], data);
    const opts = options.map(o => `<option value="${escapeHtml(o.id)}"${String(o.id) === String(selected) ? ' selected' : ''}>${escapeHtml(o.title)}</option>`).join('');
    return `<label for="${escapeHtml(component.name)}">${escapeHtml(component.label)}</label>
      <select name="${escapeHtml(component.name)}" id="${escapeHtml(component.name)}"${component.required ? ' required' : ''}>
        <option value=""${selected ? '' : ' selected'} disabled>Choose…</option>${opts}
      </select>`;
}

function page(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Smatpay</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#0f172a; --muted:#64748b; --line:#d7dce3; --accent:#0a7c5a; --accent-text:#fff; --error-bg:#fdecec; --error:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f14; --card:#141a21; --text:#e8edf2; --muted:#94a3b8; --line:#2a333d; --accent:#34c38f; --accent-text:#06231a; --error-bg:#3a1414; --error:#ff8a80; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 440px; margin: 0 auto; padding: 24px 16px 40px; }
  .brand { font-weight: 700; letter-spacing: -.01em; color: var(--accent); margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px 20px; }
  h1 { font-size: 22px; line-height: 1.25; margin: 0 0 16px; }
  p { margin: 0 0 16px; }
  .caption { color: var(--muted); font-size: 14px; }
  .error { background: var(--error-bg); color: var(--error); border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; }
  label { display:block; font-weight: 600; font-size: 14px; margin: 16px 0 6px; }
  select { width:100%; font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-height: 48px; }
  input { width:100%; font: inherit; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-height: 48px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  small { display:block; color: var(--muted); font-size: 13px; margin-top: 6px; }
  button { width:100%; margin-top: 24px; min-height: 48px; border: 0; border-radius: 12px; background: var(--accent); color: var(--accent-text); font: 600 16px/1 inherit; cursor: pointer; }
  button:disabled { opacity: .6; }
  .back { display:inline-block; margin-top: 16px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body><main><div class="brand">Smatpay</div><div class="card">${body}</div></main></body>
</html>`;
}

module.exports = {
    escapeHtml,
    page,

    isKnownFlow: function (flow) {
        return Boolean(FILES[flow]);
    },

    /** The form fields a screen submits, mapped from its Footer payload ("${form.x}"). */
    payloadFields: function (flow, screenId) {
        const screen = definition(flow).screens.find(s => s.id === screenId);
        const footer = screen?.layout.children.find(c => c.type === 'Footer');
        const payload = footer?.['on-click-action']?.payload || {};
        return Object.entries(payload).map(([key, value]) => [key, String(value).match(/^\$\{form\.(\w+)\}$/)?.[1] || key]);
    },

    renderScreen: function (flow, screenId, data, formUrl) {
        const def = definition(flow);
        const screen = def.screens.find(s => s.id === screenId);
        if (!screen) throw new Error(`Unknown screen ${flow}/${screenId}`);
        const isFirst = def.screens[0].id === screenId;

        let submitLabel = 'Continue';
        const parts = screen.layout.children.map(component => {
            if (component.visible !== undefined && !resolve(component.visible, data)) return '';
            switch (component.type) {
                case 'TextBody': {
                    const text = resolve(component.text, data);
                    if (!text) return '';
                    return component.text.includes('error_message')
                        ? `<div class="error" role="alert">${escapeHtml(text)}</div>`
                        : `<p>${escapeHtml(text)}</p>`;
                }
                case 'TextCaption':
                    return `<p class="caption">${escapeHtml(resolve(component.text, data))}</p>`;
                case 'TextInput':
                    return input(component, data, flow);
                case 'Dropdown':
                    return dropdown(component, data);
                case 'Footer':
                    submitLabel = component.label;
                    return '';
                default:
                    return '';
            }
        });

        return page(screen.title, `
      <h1>${escapeHtml(screen.title)}</h1>
      <form method="post" action="${escapeHtml(formUrl)}" onsubmit="this.querySelector('button').disabled=true">
        <input type="hidden" name="_screen" value="${escapeHtml(screenId)}">
        ${parts.join('\n')}
        <button type="submit">${escapeHtml(submitLabel)}</button>
      </form>
      ${isFirst ? '' : `<a class="back" href="${escapeHtml(formUrl)}">Back</a>`}`);
    },

    renderMessage: function (title, message) {
        return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
      <p class="caption">You can close this page and go back to WhatsApp.</p>`);
    },
};
