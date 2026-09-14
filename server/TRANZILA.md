# Tranzila card payment: setup and how it works

Tranzila is the second card provider, next to PeleCard (`server/PELECARD.md`).
Which one opens new payments is chosen **per Railway environment** with
`PAYMENT_PROVIDER`, so staging can run on Tranzila while production stays on
PeleCard until the switch.

Everything that takes money goes through it: the order (pay/init), coupons
(partial ones charge the discounted amount; 100% coupons never reach a card),
delivery orders, and the delivery upgrade on a paid order (shipping/init).

## Variables

| Variable               | Value                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `PAYMENT_PROVIDER`     | `tranzila` (unset or anything else = PeleCard)               |
| `TRANZILA_TERMINAL`    | the charge terminal name, e.g. `fxpdugri` (not the `...tok`) |
| `TRANZILA_APP_KEY`     | API app (public) key, from My Tranzila                       |
| `TRANZILA_SECRET`      | API secret key, from My Tranzila                             |
| `TRANZILA_TOKEN_FIELD` | _optional_, default `dugri_token` (see below)                |
| `TRANZILA_HANDSHAKE`   | _optional_, `1` only once Tranzila turns handshake on        |
| `TRANZILA_APPLE_PAY`   | _optional_, `1` once Apple Pay is active for this domain     |
| `TRANZILA_GOOGLE_PAY`  | _optional_, `1` once Google Pay is active for this domain    |
| `PUBLIC_BASE_URL`      | the environment's own origin (staging domain on staging)     |

`PAYMENT_PROVIDER=tranzila` with a missing Tranzila variable turns card payment
**off** (`card_enabled: false`). It never silently falls back to PeleCard.

Both callbacks stay live whichever provider is chosen, so a pay window opened
just before a switch still settles.

## One-time setup in My Tranzila

1. **API keys.** Create an app key + secret for the terminal. These sign every
   call to Tranzila (HMAC-SHA256). The passwords in the welcome email (refunds,
   TranzilaPW, app) are not these.
2. **User-defined field `dugri_token`.** Add a text field whose API parameter
   name is `dugri_token` (or set `TRANZILA_TOKEN_FIELD` to the name you used).
   If Tranzila support has to add it, ask for exactly that. **Without it every
   payment charges the card but never marks the order paid** (fails closed,
   logged as `token=false`).
3. **Notify / return addresses** come with each payment, nothing to configure.

## Apple Pay and Google Pay

They appear as buttons on Tranzila's own page, inside the same pay modal, and
settle through the same verified notify as a card. What makes them appear:

1. **The site** (done in code): the pay iframe carries `allow="payment"` and
   `allowpaymentrequest`, and every environment serves Tranzila's Apple domain
   file at `/.well-known/apple-developer-merchantid-domain-association`
   (`server/apple-pay/`, from
   `api.tranzila.com/assets/apple_pay/merchant_authentication_file.zip`).
2. **Tranzila** (owner, by phone 073-2224444): activate Apple Pay and Google Pay
   on the terminal and register each domain buyers pay on
   (`dugri-israel.co.il`, and the staging domain to test there). Apple Pay does
   not work until Tranzila confirms the registration.
3. **The environment**: set `TRANZILA_APPLE_PAY=1` / `TRANZILA_GOOGLE_PAY=1`
   once step 2 is confirmed for that environment's domain.

Apple Pay shows only on Apple devices with a supported browser; everyone else
sees the card form as before.

## Accounting documents (חשבונית / קבלה)

Issued by Tranzila's documents module, not by this code, so the document type
follows the business details in the Tranzila account. Ask Tranzila to issue a
document automatically for every iframe transaction and email it to the buyer.
The payment page is pre-filled with the order's email and phone (`email`,
`phone`) so the document reaches the buyer. Our own "payment received" email is
a confirmation, not an accounting document.

## How the flow works

1. The buyer presses pay → `POST /api/collections/:id/pay/init`. The server
   prices the order (coupon re-validated server-side), stores a pay session
   `{ token, charged_total, provider: 'tranzila' }` and returns the iframe URL
   `https://directng.tranzila.com/<terminal>/iframenew.php?sum=…&dugri_token=<token>`
   with `notify_url_address=/api/payment/tranzila/notify?t=<token>`.
2. The buyer pays inside the modal on `collect.html`. Card data never touches us.
3. Tranzila POSTs to the notify URL. **That POST is not signed**, so we use it
   only to learn the transaction `index`. We re-fetch the transaction from the
   Reports API (`report.tranzila.com/v1/transaction`) with our secret key and
   mark the purchase paid only when **all** hold:
   - `processor_response_code` is `000`, and it is a charge (not credit/cancel/verify),
   - currency is shekels,
   - `amount` (agorot) equals the session's `charged_total` exactly,
   - the transaction carries the session's token (the user-defined field),
   - that index has not already paid for another purchase.

   Indexes are sequential, so the token check is what stops a buyer from
   claiming someone else's charge by guessing its index.

4. Tranzila returns the window to `pay-done.html` by POST; the server bounces it
   to a GET, and the page tells the checkout to finish, as with PeleCard.

If the report does not have the transaction yet, the notify answers 502 so
Tranzila retries. A rejected transaction is logged with its code, type,
currency, amount, expected amount and whether the token matched (no card data).

## Testing on staging

1. Staging variables: `PAYMENT_PROVIDER=tranzila`, the three `TRANZILA_*`
   values, `PUBLIC_BASE_URL` = the staging domain.
2. The terminal is live, so a staging payment is a **real charge**. Keep it
   small: create a 99% coupon on staging (79 ₪ → 1 ₪) and pay with your own card.
3. Check: the order shows paid in the staging admin, `paid_method` is
   `tranzila`, the Railway staging log has no `[tranzila] … did not verify`.
4. Also test a declined card (the order must stay unpaid) and a delivery upgrade.
5. Refund the test charges in My Tranzila.

## Switching production

Set the same variables on production with `PAYMENT_PROVIDER=tranzila`
(owner only). To go back, unset `PAYMENT_PROVIDER`; PeleCard is untouched.
