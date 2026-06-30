# PeleCard card payment — setup & how it works

Dugri takes online credit-card payments through the **PeleCard Iframe (V2)**:
the customer enters their card on PeleCard's hosted page (shown in an iframe on
`collect.html`), so card data never touches our server and we stay on the easy
PCI path. The code is already in place and **dormant until the credentials are
set**; with no credentials the pay panel falls back to Bit only.

## What to get from PeleCard (the only thing blocking go-live)

Call PeleCard and ask for:

1. An **internet / card-not-present (CNP) terminal** — not the telephone (MOTO)
   terminal you use today. It may be a separate terminal profile.
2. The **API credentials** for that terminal: terminal number, user, password.
3. To **whitelist the site domain** (e.g. `dugri.co.il`) for the iframe.
4. Confirm **עוסק פטור** is fine (it is for clearing) and how **receipts (קבלה)**
   are issued per charge — PeleCard can issue them, or you issue manually. No VAT
   is charged.

## Turning it on

Set these env vars on the Railway service (see `RAILWAY_SETUP.md`):

| Variable            | Value                                           |
| ------------------- | ----------------------------------------------- |
| `PELECARD_TERMINAL` | internet/CNP terminal number                    |
| `PELECARD_USER`     | API user                                        |
| `PELECARD_PASSWORD` | API password                                    |
| `PUBLIC_BASE_URL`   | public origin, e.g. `https://dugri.co.il`       |
| `PELECARD_BASE_URL` | _optional_ gateway override (default gateway20) |

Once set, `collect.html` shows a **תשלום בכרטיס אשראי** button next to Bit.

## How the flow works (in this codebase)

1. Owner clicks the card button → `POST /api/collections/:id/pay/init`
   (`server/index.js`). The server validates the order, then `server/pelecard.js`
   `init()` POSTs to `PaymentGW/init` and gets back an **iframe URL** +
   **ConfirmationKey** (stored on the order).
2. The browser loads that URL in a modal iframe; the customer pays on PeleCard.
3. PeleCard POSTs the result to **`/api/payment/callback`**. The server verifies
   status `000` + the ConfirmationKey matches + the amount matches, then marks
   the order paid (the same `paid` flag the admin page sets manually). Words /
   premium prompts unlock automatically.
4. The in-iframe `pay-done.html` tells the page to close the modal and refresh.

## ⚠️ One thing to verify against a real test terminal

The exact field names PeleCard posts to the **server-side callback** can vary by
account/version. `pelecard.js` `parseCallback()` is intentionally lenient (it
checks several common names and a nested `ResultData`), but before launch, do
one real test charge on the PeleCard **test terminal** and confirm the callback
actually marks the order paid. If it doesn't, log the raw callback body once and
adjust the field names in `parseCallback()` — that's the only field-mapping risk.

The anti-forgery guarantee is the **ConfirmationKey**: only PeleCard knows the
key it handed us at init, so a forged callback can't mark an order paid.
