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

| Variable            | Value                                             |
| ------------------- | ------------------------------------------------- |
| `PELECARD_TERMINAL` | internet/CNP terminal number                      |
| `PELECARD_USER`     | API user                                          |
| `PELECARD_PASSWORD` | API password                                      |
| `PUBLIC_BASE_URL`   | public origin, e.g. `https://dugri.co.il`         |
| `PELECARD_BASE_URL` | _optional_ gateway override (default gateway21)   |
| `PELECARD_DEBUG`    | _optional_ `1` to log init/callback shapes (test) |

Once set, `collect.html` shows a **תשלום בכרטיס אשראי** button next to Bit.

## How the flow works (in this codebase)

Implemented against PeleCard's official **Iframe/Redirect** (11/2024) and
**Services ReST API** (01/2025) manuals — gateway `gateway21.pelecard.biz`.

1. Owner clicks the card button → `POST /api/collections/:id/pay/init`
   (`server/index.js`). The server validates the order and `server/pelecard.js`
   `init()` POSTs to `/PaymentGW/init`, which returns a **payment URL** (with a
   `TransactionId` embedded). Init does **not** return a ConfirmationKey. We send
   a short per-payment **ParamX token** (≤19 chars) and store it on the order.
2. The browser loads that URL in a modal iframe; the customer pays on PeleCard.
3. PeleCard POSTs the result to **`/api/payment/callback`**. The body is
   **untrusted** — we take only the `TransactionId` from it and call
   `GetTransaction` (server-to-server, with our secret terminal credentials) to
   get the authoritative status + amount + token. We locate the order by the
   token PeleCard echoes back (`AdditionalDetailsParamX`), confirm status `000`
   and that the charged amount equals the order total, then mark it paid.
4. The in-iframe `pay-done.html` tells the page to close the modal and refresh.

Because verification re-fetches the transaction from PeleCard with our secret
credentials, a **forged callback cannot mark an order paid** — the only field we
take from the callback is the `TransactionId`, and an unknown/foreign one either
fails the `GetTransaction` lookup or maps to a different order's token.

## Testing with PELECARD_DEBUG

Set `PELECARD_DEBUG=1` for the first test charge. It logs (field NAMES only, no
secret values) the `[pelecard init]` response keys and the
`[pelecard gettransaction]` status + result keys — enough to confirm the mapping
against your terminal. Turn it off (`0`) once verified.

Test with PeleCard's **test terminal** (their test card numbers); `QAResultStatus`
can simulate a success/error on test terminals. The sandbox lives at
`https://gateway21.pelecard.biz/sandbox`.
