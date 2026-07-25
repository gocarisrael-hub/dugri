# Arming the WhatsApp bot (Whapi Cloud)

The WhatsApp bot is **dormant by default** — with no env set, `server/whatsapp.js`
makes no network calls and every hook is a no-op. Arming it is an ops task: connect
a dedicated WhatsApp number to a Whapi Cloud channel, then set four env vars on the
Railway service. No code change or deploy of new code is needed to arm — only env +
a restart.

## What you need

- A **dedicated phone + SIM** with its own number (not a personal WhatsApp). Once it
  is the bot line, don't use it for personal chats.
- The phone **online** (WiFi is fine). Whapi connects as a _linked device_, so the
  phone must stay reachable.
- A **Whapi Cloud** account (panel.whapi.cloud).
- Access to the **Railway** service env (owner-only) and the live domain
  (currently `dugri-israel.co.il`).

## Steps

### 1. WhatsApp Business on the phone

Install **WhatsApp Business** (not the regular app, not the Cloud API), register the
business number, verify by SMS (or "Call me"), and set up the business profile
(name Dugri, logo, hours).

### 2. Whapi channel + link the device

1. In panel.whapi.cloud create a **Channel**.
2. The channel shows a **QR code** on your computer.
3. On the phone: WhatsApp Business → **Settings → Linked Devices → Link a device** →
   scan the QR **on the computer screen**. Wait for "connected".
   - Scan-then-fail is almost always an **expired QR** (they rotate every ~30–60s):
     refresh and rescan fast. Also clear old linked devices (max 4) and make sure the
     phone clock is on **automatic**.

### 3. Copy the channel token

Copy the channel's **API token** → this is `WHAPI_TOKEN`. Keep it private.

### 4. Configure the Whapi webhook

Set the channel **Webhook URL** to:

```
https://<YOUR-DOMAIN>/api/whatsapp/webhook?secret=<YOUR_SECRET>
```

- `<YOUR-DOMAIN>` = the live site domain (e.g. `dugri-israel.co.il`).
- `<YOUR_SECRET>` = a strong random string **you invent** (e.g. `openssl rand -hex 24`).
  It is a password on the webhook so only real Whapi calls are accepted. The **same**
  value goes into `WHAPI_WEBHOOK_SECRET` below — they must match exactly.
- **Mode: Body.**
- **Enable these webhook events (this exact set):**
  - `messages` → **POST** — inbound words typed in the group.
  - `groups` → **POST** — group created.
  - `groups` → **PUT** — **a member is ADDED to the group.** REQUIRED for the
    "member joined" welcome; without it Whapi sends nothing on a join and the bot
    can't greet newcomers. (This one is easy to miss — the default is off.)
  - `groups` → **PATCH** — group metadata updated.

  Note: a member add arrives as a `groups`/**PUT** event carrying a
  `groups_participants` array — which `server/whatsapp.js parseWebhook` already
  handles. So enabling `groups:PUT` is all it takes; no code change.

### 5. Railway env (owner-only), then restart

On the Dugri service set:

| Var                    | Value                                       |
| ---------------------- | ------------------------------------------- |
| `WHAPI_TOKEN`          | the channel token from step 3               |
| `WHAPI_WEBHOOK_SECRET` | the same `<YOUR_SECRET>` as the webhook URL |
| `WHATSAPP_ENABLED`     | `1` — **set this last**                     |
| `WHAPI_BASE_URL`       | only if not the default `gate.whapi.cloud`  |

**Order matters.** Set the token + secret first, `WHATSAPP_ENABLED=1` last. A bot
enabled with a token but no webhook secret can _send_ but rejects every inbound
webhook (403), so no words come in — the server logs a warning at boot in that state.

Redeploy / restart so the new env is read.

## Verify it's live

Open **admin → הודעות וטקסטים** (`/admin-texts.html?key=<ADMIN_KEY>`). The banner at
the top of the WhatsApp section reads the non-secret status endpoint and shows:

| Banner                 | Meaning                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **פעיל ✓** (green)     | `ready` — connected, can send messages AND receive words. Fully armed.                                      |
| **פעיל חלקית** (amber) | `configured` but no webhook secret — can send, but won't receive inbound words. Set `WHAPI_WEBHOOK_SECRET`. |
| **לא מוכן** (amber)    | Some env present but incomplete — the banner lists exactly which var is missing.                            |
| **רדום** (red)         | Nothing set — bot is off.                                                                                   |

The same data is available at `GET /api/whatsapp/status?key=<ADMIN_KEY>` (admin-gated,
returns presence booleans only — never the token/secret values):

```json
{
  "enabled": true,
  "tokenPresent": true,
  "webhookSecretPresent": true,
  "baseUrl": "https://gate.whapi.cloud",
  "configured": true,
  "ready": true
}
```

Then do a real end-to-end check: place a paid order → the bot should open a
word-collection WhatsApp group for the buyer (the `group_opened` trigger fires).

## Disarming

Set `WHATSAPP_ENABLED` to `0` (or unset it) and restart — the module goes inert
again with no other change. The trigger catalog and message templates stay
owner-editable in הודעות וטקסטים regardless of armed state.
