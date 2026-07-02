# Railway Deployment — One-Time Setup

This repo deploys the static site in `site/` to [Railway](https://railway.app)
via the GitHub Actions workflow at `.github/workflows/railway.yml`. Railway
builds the root `Dockerfile` (Caddy) and serves `site/` on the port Railway
assigns (`$PORT`).

The workflow runs on every push to `main` (and via manual "Run workflow").
It will **fail until you complete the steps below** — that is expected.

## Steps (require your Railway account — must be done by you)

1. **Create a Railway account / project**
   - Go to https://railway.app and sign in (GitHub login is easiest).
   - Create a new project.

2. **Create a service**
   - Either: "Deploy from GitHub repo" and pick `gocarisrael-hub/dugri`, or
   - Create an **empty service** and name it `dugri`.
   - If you name the service something other than `dugri`, note the name for
     step 5.

3. **Generate a token**
   - Project Settings → **Tokens** → create a **Project token**.
   - Copy it (you only see it once).

4. **Add the token to GitHub as a repo secret**
   - Name it exactly `RAILWAY_TOKEN`.
   - Via UI: https://github.com/gocarisrael-hub/dugri/settings/secrets/actions
     → "New repository secret".
   - Or via CLI:
     ```bash
     gh secret set RAILWAY_TOKEN
     ```
     (paste the token when prompted)

5. **(Optional) Set the service name variable**
   - Only needed if your service is **not** named `dugri`.
   - Add a repo **variable** (not secret) named `RAILWAY_SERVICE` with your
     service name:
     https://github.com/gocarisrael-hub/dugri/settings/variables/actions
     - Or: `gh variable set RAILWAY_SERVICE --body "your-service-name"`

6. **Trigger a deploy**
   - Push any commit to `main`, or run the workflow manually from the Actions
     tab. Railway will build the Dockerfile and serve `site/` on the domain it
     assigns (Settings → Networking → Generate Domain if you don't have one).

## Staging environment

A separate **staging** Railway environment lets every merge deploy to a
throwaway copy, run an automated smoke test against it, and only then be
promoted to production by an explicit second click.

### Promotion flow

1. Merge a PR to `main`.
2. Run the **Deploy to Railway** workflow with `environment = staging` (the
   default). It deploys to the staging environment.
3. The workflow then **auto-runs the smoke test** (`node scripts/smoke.mjs`)
   against the staging domain. If it's red, the run fails and you stop here.
4. If staging is green, run the same workflow again with
   `environment = production` to deploy the same commit to production.
   (Production does **not** run smoke — it's the deliberate, separate click.)

### One-time Railway dashboard setup (must be done by you)

1. In the Railway project, create a new environment named **`staging`**, forked
   from production (Project → Environments → New → fork from production) so it
   inherits the service and its variables.
2. Attach a **separate Volume** to the staging service, mounted at `/data`, and
   set **`DATA_DIR=/data`** on staging. This MUST be its own volume — staging and
   production must never share a data file (`dugri-data.json`).
3. Set the staging-only variables (see below), then generate a **staging domain**
   (Settings → Networking → Generate Domain).
4. Add a repo **variable** **`STAGING_BASE_URL`** = that staging domain
   (e.g. `https://dugri-staging.up.railway.app`). The smoke step reads it:
   `gh variable set STAGING_BASE_URL --body "https://dugri-staging.up.railway.app"`

### Variables that MUST differ in staging

Staging must never take a real charge, send real email, or share admin access
with production. Set these on the staging environment specifically:

- **`PELECARD_TERMINAL` / `PELECARD_USER` / `PELECARD_PASSWORD`** — use a
  **test/sandbox** terminal, or leave them **unset**. Unset means the card button
  is disabled and no real charge can happen (`card_enabled` is `false`); the
  smoke test still passes because it only asserts the flag is a boolean.
- **`SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `NOTIFY_TO`** — leave **unset** (email
  sends become silent no-ops) or point them at a **test inbox**. Do not send
  staging notifications to the real business inbox.
- **`ADMIN_KEY`** — a distinct **staging admin key** (not the production one).
- **`PUBLIC_BASE_URL`** — the **staging domain** (so any payment return/callback
  URLs, if a sandbox terminal is used, point back at staging — never production).

### Token

Confirm **`RAILWAY_TOKEN`** is a **project token** (not scoped to a single
environment) so the workflow can deploy both `staging` and `production` with the
same secret.

## Simpler native alternative

Instead of this workflow, you can connect the GitHub repo directly in the
Railway dashboard for automatic deploys on every push (no Actions, no token
needed) — but the GitHub Actions workflow above is the configured primary path.

## Word-collection backend (Node service + volume)

The site is now a small **Node/Express** service (it serves `site/` AND the
`/api` for the collaborative word-collection feature) instead of a static Caddy
container. After connecting the repo:

1. Railway builds the `Dockerfile` (node:20-alpine) and runs `node server/index.js`.
2. Add a **Volume** to the service, mounted at `/data`.
3. Add an env var **`DATA_DIR=/data`** so the JSON store (`dugri-data.json`)
   persists across redeploys. (`$PORT` is provided by Railway automatically.)

Without the volume + `DATA_DIR`, collected words are lost on every redeploy.

## Admin orders page

The private orders page is at `/admin.html?key=YOUR_ADMIN_KEY`. Set a strong
**`ADMIN_KEY`** env var on the Railway service; only that key can open the page
or call `/api/admin/collections`. (Locally it defaults to `dugri-admin`.)

## Card payment (PeleCard)

Online credit-card payment via the PeleCard Iframe is **off until you set the
credentials** — without them the pay panel shows Bit only. To turn it on, add
these env vars on the Railway service (see `server/PELECARD.md` for the full
checklist and how to get them from PeleCard):

- **`PELECARD_TERMINAL`** — your internet/CNP terminal number.
- **`PELECARD_USER`** — API user.
- **`PELECARD_PASSWORD`** — API password.
- **`PUBLIC_BASE_URL`** — the site's public origin, e.g. `https://dugri.co.il`
  (used to build the payment return + server-callback URLs PeleCard calls).

Optional: `PELECARD_BASE_URL` overrides the gateway host (defaults to
`https://gateway21.pelecard.biz`); set this only if PeleCard gives you a
different test/production gateway.

## Email notifications (optional)

The server can email the owner on two events: a payment comes in, and a
collection is closed (the word list is finished and ready to produce). This is
**off until the SMTP vars are set** — with no config the sends are silent no-ops
and the site works exactly the same.

Set these env vars on the Railway service to turn it on:

- **`SMTP_HOST`** — SMTP server host (e.g. `smtp.gmail.com`).
- **`SMTP_USER`** — SMTP username (the sending mailbox).
- **`SMTP_PASS`** — SMTP password. For Gmail this must be an **app-password**
  (Google Account → Security → 2-Step Verification → App passwords), not your
  normal login password.
- **`NOTIFY_TO`** — where notifications are sent (your inbox).

Optional: `SMTP_PORT` (defaults to `465`; the connection is TLS/secure when the
port is `465`) and `NOTIFY_FROM` (the From address; defaults to `SMTP_USER`).

Gmail example: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` your
Gmail address, `SMTP_PASS` a 16-char app-password, `NOTIFY_TO` your inbox.
