# smatpay_whatsapp

The Smatpay customer app on WhatsApp, through [360dialog](https://app.360dialog.com/). Same shape as
`smatpay_whatsapp_api` (Express webhook → controller → a helper per feature, state on the `users`
row), but it talks to the real Smatpay customer API (`subscriber_customer_service`), the same one
`Smatpay-Customer-Mobile-App` uses.

## What it does so far

1. A new number chooses **customer** or **merchant** (merchant is "coming soon").
2. A customer taps **Create account** or **I have an account**. Both open a WhatsApp Flow (a native
   form), so the password is typed into a masked field and never appears in the chat.
3. After signup, Smatpay emails a 6-digit activation code; the user types it in the chat.
4. The user sets a 4-digit payment PIN in another Flow (masked; only a scrypt hash is kept).
5. Main menu. My account (details, change PIN, sign out) and Help work.
6. **Buy airtime, electricity (ZESA) and water** (helpers/whatsapp/vasHelper.js): provider (skipped when
   there's one) → number, or meter number (looked up: "Is this the right meter?" with the holder's
   name) → amount → how to pay → Smatpay quote → PIN on a secure form → purchase. Ways to pay:
   - a saved card (charged at once), or **Add a card**: the bank's hosted page opens from a link,
     the bot follows the save and carries on with the purchase;
   - EcoCash, InnBucks or O'mari: the bot relays the step (approve the prompt, pay the InnBucks
     code, type the O'mari code);
   - ZimSwitch: ZimSwitch's card widget on our page, `/pay/zimswitch/<token>`.
   The bot polls Smatpay every 5 seconds and sends the receipt. Receipts for meters list the
   token(s) in groups of four, in entry order.
   **Buy data**: NetOne sells its bundles as products of its USD airtime biller. After the number,
   the bundles are grouped as in the app (Social, A day or less, A week, A month, Data, More) and
   listed cheapest first, 9 to a page with "More bundles".
7. **Pay a merchant** (helpers/whatsapp/payHelper.js): send the merchant's Smatpay payment link, the
   code under their QR, or a photo of the QR (read with jsqr). A Smatpay link pasted at any time
   also starts a payment. The link is resolved to show the merchant, reference and amount (typed
   when the till doesn't set one), then the same pay → quote → PIN → follow-up as purchases.
8. **Transactions**: the 10 most recent as a list (in sandbox, sandbox and production rows together,
   labelled, as the app shows them); tapping one shows amount, fee, how it was paid, status,
   time, reference and any token.

### Merchant side (helpers/whatsapp/merchantHelper.js)

"As a merchant" (or **Business account** in the customer menu) switches the number to merchant mode:
**Register business** (person + password form → activation link by email) or **Sign in** (email and
password, then the emailed code, once). If the merchant has no business yet, a business form
(account type, trading name, sector and sub-sector, address, province, contact) creates it, which
issues sandbox keys straight away. The bot stores the merchant's keys encrypted and signs in with
them (`/auth/authenticate/[sandbox/]merchant`, no code) whenever its 5-hour token expires.
Request payment, Wallet and Go live are next.

`ALLOWED_NUMBERS` limits the bot to listed numbers while in development; others are told they're
not authorised.

`SMATPAY_PLANE=sandbox` points every call at Smatpay's sandbox (simulated payments); the menu then
says "Smatpay (sandbox)".

Five wrong PINs lock payments for 30 minutes.

## Forms: WhatsApp Flows or web pages

`FORMS_MODE` picks how the signup, login and PIN forms are shown:

- `web` (current): the bot sends a button that opens the form as a page on this server,
  `PUBLIC_URL/forms/<token>`. Pages are drawn from the same `flows/*.json` screens and submitted to
  the same handlers; when one finishes, the chat carries on by itself. Links work once, for an hour.
- `flows`: native WhatsApp Flows. Needs Meta to allow Flows on the account (it currently answers
  `139000 Blocked by Integrity`, pending business verification).

## How sign-in stays alive

- Login returns a 5-hour access token and a 30-day refresh token. We store both AES-256-GCM
  encrypted; the password is never stored.
- Refresh tokens are single-use and rotated (reusing an old one ends the session on Smatpay), so
  every refresh for a number runs under a lock and saves the new tokens first.
- A daily job (03:00) renews refresh tokens that expire within 5 days for users who messaged in the
  last `SESSION_KEEPALIVE_DAYS` (90). Inactive users' sessions expire and they sign in again.
- The lock is in-process: **run a single instance** until it's replaced with a shared lock.

## Layout

```
app.js                         Express, routes, daily refresh job
routes/whatsAppRoutes.js       /api/whatsapp/webhook, /api/whatsapp/flows, /health
controllers/WhatsappController 360dialog webhook: parse → per-number lock → buttons / text / flow reply
controllers/FlowController     WhatsApp Flows data endpoint (encrypted)
helpers/whatsapp/              messaging, parsing, onboarding, activation, menu, buttons, text
helpers/flows/                 Flow crypto, flow_token sessions, signup / login / PIN forms
helpers/smatpay/               Smatpay API client and session store
flows/*.json                   Flow definitions to publish in WhatsApp Manager
models/, migrations/           users, flow_sessions
```

## Setup

```bash
npm install
cp .env.example .env            # fill in D360_API_KEY, DB_*, TOKEN_ENCRYPTION_KEY
npm run db:create               # creates the new smatpay_whatsapp database
npm run db:migrate
npm run flow:keys               # keys/flow_private.pem (keep secret) + keys/flow_public.pem
npm run flow:upload-key         # registers the public key with WhatsApp through 360dialog
npm run dev
```

Then:

1. Point the 360dialog webhook at `https://<host>/api/whatsapp/webhook`. If `WEBHOOK_SECRET` is
   set, add it as an `X-Webhook-Secret` header on the webhook.
2. Create the flows through 360dialog (no WhatsApp Manager access needed):
   `npm run flow:setup -- https://<host>`. It creates or updates `smatpay_signup`,
   `smatpay_login` and `smatpay_pin` as drafts pointing at `https://<host>/api/whatsapp/flows`,
   uploads the JSON, prints validation errors and writes the IDs into `.env`. Run it again after
   editing a file in `flows/`. Keep `FLOW_MODE=draft` while testing; when ready, add `--publish`
   (irreversible) and set `FLOW_MODE=published`.
3. Message the number "hi".

The endpoint must be public HTTPS (use a tunnel such as ngrok locally), and answers WhatsApp's
health-check ping on its own.

## Tests

```bash
npm test
```

Covers Flow encryption against a simulated WhatsApp request, token encryption, PIN hashing, the
per-number lock and webhook parsing.
