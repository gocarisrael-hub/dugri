# Tranzila card payment: setup and how it works

Tranzila is the second card provider, next to PeleCard (`server/PELECARD.md`).
Which one opens new payments is chosen **per Railway environment** with
`PAYMENT_PROVIDER`, so staging can run on Tranzila while production stays on
PeleCard until the switch.

Everything that takes money goes through it: the order (pay/init), coupons
(partial ones charge the discounted amount; 100% coupons never reach a card),
delivery orders, and the delivery upgrade on a paid order (shipping/init).

## Variables

| Variable                         | Value                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `PAYMENT_PROVIDER`               | `tranzila` (unset or anything else = PeleCard)                                             |
| `TRANZILA_TERMINAL`              | the charge terminal name, e.g. `fxpdugri` (not the `...tok`)                               |
| `TRANZILA_APP_KEY`               | API app (public) key, from My Tranzila                                                     |
| `TRANZILA_SECRET`                | API secret key, from My Tranzila                                                           |
| `TRANZILA_TOKEN_FIELD`           | _optional_, default `dugri_token` (see below)                                              |
| `TRANZILA_HANDSHAKE`             | _optional_, `1` only once Tranzila turns handshake on                                      |
| `TRANZILA_APPLE_PAY`             | _optional_, `1` once Apple Pay is active for this domain                                   |
| `TRANZILA_GOOGLE_PAY`            | _optional_, `1` once Google Pay is active for this domain                                  |
| `PUBLIC_BASE_URL`                | the environment's own origin (staging domain on staging)                                   |
| `PAYMENT_ENV`                    | _optional_: `production` / `staging`; defaults to Railway's own `RAILWAY_ENVIRONMENT_NAME` |
| `TRANZILA_SWEEP_MIN_SPACING_MS`  | _optional_, 10000: at most one notify-triggered sweep this often                           |
| `TRANZILA_SWEEP_OVERLAP_MS`      | _optional_, 3600000: how far before the last sweep the next reads                          |
| `TRANZILA_SWEEP_FAIL_ALERT_MS`   | _optional_, 900000: alert once sweeps have failed this long                                |
| `TRANZILA_ALERT_RATE_LIMIT`      | _optional_, 5 alert batches an hour                                                        |
| `TRANZILA_ALERT_CHUNK`           | _optional_, 15 lines per alert message                                                     |
| `TRANZILA_HTTP_TIMEOUT_MS`       | _optional_, 10000: every call to Tranzila is aborted after this                            |
| `PAY_INIT_RATE_LIMIT_IP`         | _optional_, 60 Tranzila pay/inits per client per 10 minutes                                |
| `PAY_INIT_RATE_LIMIT_COLLECTION` | _optional_, 20 Tranzila pay/inits per collection per 10 minutes                            |
| `PAYMENT_PROXY_HOPS`             | _optional_, 1: proxies appending to X-Forwarded-For (Railway)                              |
| `TRANZILA_LOG_CLIENT_IP`         | _optional_, `1` only for the go-live check below, then remove                              |
| `TRANZILA_SWEEP_TICK_MS`         | _optional_, 15000: how often the periodic sweep checks whether it is due                   |

`PAYMENT_PROVIDER=tranzila` with a missing Tranzila variable turns card payment
**off** (`card_enabled: false`). It never silently falls back to PeleCard. Any
numeric setting that is not a positive number falls back to its default.

## One-time setup in My Tranzila

1. **API keys.** Create an app key + secret for the terminal. These sign every
   call to Tranzila (HMAC-SHA256). The passwords in the welcome email (refunds,
   TranzilaPW, app) are not these.
2. **User-defined field `dugri_token`.** Add a text field whose API parameter
   name is `dugri_token` (or set `TRANZILA_TOKEN_FIELD` to the name you used).
   If Tranzila support has to add it, ask for exactly that. **Without it no
   charge can be matched to its order**: the charge goes through, the order is
   not marked paid, and production reports it to the owner as a charge that
   belongs to no order.
3. **Notify / return addresses** come with each payment, nothing to configure.

## How a payment is settled

**Only the terminal's own transaction rows settle anything.** Tranzila's notify
is unsigned and nothing documents it being retried, so it decides nothing.

1. The buyer presses pay → `POST /api/collections/:id/pay/init`. The server
   prices the order (coupon re-validated server-side), stores a pay session
   `{ token, charged_total, provider: 'tranzila' }` and returns the iframe URL
   `https://directng.tranzila.com/<terminal>/iframenew.php?sum=…&dugri_token=<token>`.
   The token is `d`, the environment (`p` production, `s` staging, `l` other),
   and 16 random hex characters.
2. The buyer pays inside the modal on `collect.html`. Card data never touches us.
3. Tranzila POSTs to the notify URL (`/api/payment/tranzila/notify?t=<token>`).
   For a real, unpaid Tranzila session whose window is still open (not closed by
   the buyer, opened within the 20-minute session TTL) the server only **asks for a sweep**
   (at most one per `TRANZILA_SWEEP_MIN_SPACING_MS`) and answers 200. No lookup,
   no store write, nothing per session.
4. **The sweep** (`server/tranzila-sweep.js`) reads the terminal's rows from the
   Reports API (`report.tranzila.com/v1/transaction`) with our secret key, from
   the persisted `last_swept_at` minus `TRANZILA_SWEEP_OVERLAP_MS` to today,
   following every page (a reply carrying an error code, or no transactions
   list, is a failed sweep, never "no rows"; it throws past 200,000 rows rather than return part of
   the report). Each row is matched to a session by the token it carries, and
   marks the purchase paid only when **all** hold:
   - `processor_response_code` is `000`,
   - it is the charge we asked for, checked as an **allowlist**: `txn_type` is
     `DEBIT` (missing or anything else is refused), `tranmode` is `A` and
     `payment_plan` is `1` or `3` whenever the report carries them. The buyer can
     edit the iframe URL, so an authorization hold (J5, `tranmode=V`), a card
     check (J2, `N`) or installments (`cred_type` 6/8) must never count as paid,
   - currency is shekels,
   - `amount` (agorot) equals the session's `charged_total` exactly,
   - the row carries the session's token,
   - that index has not already paid for another purchase,
   - the order is still priced as it was when that pay window opened (version,
     copies, unit price, delivery fee, total; the fee for a shipping upgrade),
     stored on the session at pay/init. A charge from a cheaper window the buyer
     closed before changing the order does not pay for the changed order; the
     owner is told instead.

   A session closed by the buyer (resolved) still settles: sessions are found by
   token whatever their state and skipped only once their purchase is paid.

5. Tranzila returns the window to `pay-done.html` by POST; the server bounces it
   to a GET, and the checkout's own polling shows the order paid once the sweep
   has settled it.

The sweep runs once at boot (so a deploy gap is read back), every minute while
an unpaid Tranzila session was opened in the last half hour, every 10 minutes
otherwise, and when a notify asks. One sweep at a time. `last_swept_at` is
written when a sweep settled or queued something, or at most every 10 minutes,
so a flood of notifies writes nothing. Invented indexes and tokens are not rows:
they can neither settle nor alert anything.

### Staging and production share the terminal

Each environment's sweep reads the other's rows. A row whose token was minted in
the other environment is ignored: not settled, not reported. A row with no
session token at all (an old or manual charge in My Tranzila, or the token field
missing) is reported by **production only**.

## What the owner is told

From real rows only, by email with WhatsApp as the fallback:

- an approved row that carries one of our sessions' tokens but does not settle:
  a hold, a wrong amount, a foreign currency, or **a second charge on a purchase
  that is already paid**;
- a verified charge whose order changed after its pay window opened;
- on production, an approved `DEBIT` carrying this environment's token whose
  collection no longer exists (deleted, or its session evicted);
- on production, an approved `DEBIT` carrying no session token;

Refunds and cancellations (`CREDIT`, `CANCEL`, `REFUTE`, `REVERSAL`) are never
reported, though they carry the order's token.

- sweeps that have failed for `TRANZILA_SWEEP_FAIL_ALERT_MS` (Reports API down,
  timeouts, the page limit), repeated at most every 3 hours while it goes on, and
  a short note once a sweep works again.

Alerts wait in a persisted queue and a transaction is marked reported only once
an alert has really gone out, so a restart or a full hourly cap loses nothing
and nothing is reported twice. Everything queued goes in one batch, split into
messages of `TRANZILA_ALERT_CHUNK` lines; nothing is trimmed. Each message counts
as delivered on its own (a failed one is sent again alone, one that arrived is
never repeated), and a batch takes an hourly slot only once something reached
the owner. Messages carry
order numbers, transaction indexes and amounts: no tokens, card data or keys.
With no alert channel configured at all, the alert is written to the log.

## Apple Pay and Google Pay

They appear as buttons on Tranzila's own page, inside the same pay modal, and
settle through the same sweep as a card. What makes them appear:

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

## Limits on opening payments

Every Tranzila pay/init and shipping/init mints a pay session, so both are
limited per client (`PAY_INIT_RATE_LIMIT_IP`) and per collection
(`PAY_INIT_RATE_LIMIT_COLLECTION`, counted after the owner check). PeleCard is
not limited. The client is the address our own proxy saw: the `X-Forwarded-For`
entry `PAYMENT_PROXY_HOPS` from the right, counted on the raw list, or
Cloudflare's `CF-Connecting-IP` when that entry is a Cloudflare edge address;
never the leftmost entry, which the client writes. An IPv6 client counts as its
whole /64.

## Sources

Read on 14 Sep 2026. The docs site renders client-side; a plain HTTP fetch can
show "No content yet", open it in a browser.

- `txn_type` values (DEBIT, CREDIT, FORCE, VERIFY, REFUTE, J2, CANCEL),
  `tranmode`, `payment_plan` (1 regular, 3 debit card, 6 special credit,
  8 installments), `processor_response_code` "000", `amount` "in smallest
  currency unit (agorot for ILS)", and the date-range query with paging:
  Tranzila Transaction Reports API,
  https://docs.tranzila.com/docs/reports/tranzila-transaction-reports-api
- iframe parameters (`tranmode` A/V/K/N/J, `cred_type` 1/6/8, `notify_url_address`,
  `apple_pay`, `google_pay`) and the notify fields:
  https://docs.tranzila.com/docs/payments-and-billing/iframe-integration-directng
- HMAC headers: https://docs.tranzila.com/docs/payments-and-billing/authentication
- Handshake (locks the **sum** only, not the mode):
  https://docs.tranzila.com/docs/payments-and-billing/handshake-v2
- Apple Pay in the iframe:
  https://docs.tranzila.com/docs/payments-and-billing/apple-pay-iframe

Not yet confirmed against a real transaction, so the staging test must show
them: the `amount` unit, the exact `txn_type` / `tranmode` a normal iframe charge
reports, that the report always carries `tranmode` (a DEBIT reported without one
still settles), and that the user-defined field appears on the row. Any of these
being different fails closed (charged, not marked paid, reported) rather than open.

## Before going live, on each environment

1. **Proxy hops.** Set `TRANZILA_LOG_CLIENT_IP=1`, open one payment, and read the
   `[tranzila] client key …` line in the Railway log: the key must be your own
   address, not a Railway or Cloudflare one. Then remove the variable. If it is
   wrong, set `PAYMENT_PROXY_HOPS` to the number of proxy entries after yours.
2. **Staging test.** Staging variables: `PAYMENT_PROVIDER=tranzila`, the three
   `TRANZILA_*` values, `PUBLIC_BASE_URL` = the staging domain. The terminal is
   live, so a staging payment is a **real charge**: create a 99% coupon on
   staging (79 ₪ → 1 ₪) and pay with your own card. Check the order shows paid in
   the staging admin within a minute, with `paid_method` `tranzila`. Also try a
   declined card (stays unpaid), a delivery upgrade, and Apple Pay if active.
   Refund the test charges in My Tranzila.

## Switching production

Set the same variables on production with `PAYMENT_PROVIDER=tranzila`
(owner only), after the proxy-hop check. To go back, unset `PAYMENT_PROVIDER`;
PeleCard is untouched, and Tranzila charges already made are still settled by
the sweep while the Tranzila variables stay set.
