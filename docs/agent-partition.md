# Agent partition (detail behind CLAUDE.md → "Multi-agent workflow")

Four domain agents work in parallel, each in its own git worktree. A single **integrator**
(not the agents) reviews and merges every PR to main, then deploys to staging + smokes.
This file is the detailed ownership map; the short version lives in `CLAUDE.md`.

## The core constraint

The backend is a monolith: **`server/index.js`** (every route registers here inline) and
**`server/db.js`** (one JSON store for all domains) are touched by everyone. Rule: edit ONLY
your domain's block in those two files; never reorder or reflow another domain's code. Rebase
often. Everything else partitions cleanly.

## Agent A — Commerce (the money path)

Pricing, coupons, orders, checkout, payment.

- `server/pelecard.js`; `site/js/pricing.js`, `site/js/product.js`, `site/js/configurator.js`
- the checkout/address block of `site/collect.html`
- Pages: `product.html`, `options.html`, `coupons.html`, `pay-done.html`, `dashboard.html`, `admin-pricing.html`
- In `index.js`: `/api/pricing`, `/api/collections/:id/order`, `/pay/init`, `/api/payment/callback`, `/coupon/validate`, `/api/admin/coupons*`, `/api/stats/orders`
- In `db.js`: the coupons block + `ORDER_PRICES`/pricing
- Tests: `pricing-*`, `coupon*`, `order*`, `pelecard*`, `thankyou`, `free-order-emails`, `custom-product`

## Agent B — Catalog & Design (what exists, how it looks, its imagery)

Designs, gallery/images, templates, themes, storefront carousels.

- `server/templates.js`, `server/design-images.js`; `scripts/tokenize-svg.mjs`, `render-design-assets.mjs`, `product-thumbs.mjs` (need `magick`)
- `site/js/designs.js` (+ `designs.generated.js` — BUILD OUTPUT, never hand-edit), `site/js/design-images.js`, `site/js/carousel.js`
- Pages: `products.html`, `index.html` (catalog/carousel), `admin-designs.html`, `admin-images.html`, `admin-templates.html`, `design-codes.html`
- CSS: `site/css/tokens.css`, `site/css/carousel.css`
- In `index.js`: the designs/templates/preview region, `/api/design-names`, `/api/design-images*`, `/api/admin/templates*`, `/api/custom-designs`, `/api/template-image/*`
- In `db.js`: the design-codes block
- Tests: `design-*`, `design-images-*`, `design-code*`, `colors`, `page-tint`, `carousel`, `marquee`, `reviews`, `render-design-assets`, `admin-designs/images/templates.spec`
- NOTE: the Python generator (`generator/*.py`) is Agent C's, not B's — coordinate on rendering that spans both.

## Agent C — Wizard & Word-collection (the buyer funnel → PDF)

Buyer wizard, word collection, name preview, the Python generator + print PDF.

- `server/validate.js`; `site/js/collect.js`, `site/js/word-prompts.js`; wizard portions of `site/options.html`
- `generator/*.py` (build/render_page/preview/config/pack/topup), `generator/themes.json` (per-theme render knobs), `server/preview-cache.js`
- Pages: `collect.html` (EXCEPT its checkout/address block, which is A's), `admin.html` collections
- In `index.js`: the collections routes, `/api/preview`, `/api/admin/collections/:id/generate` + the generator spawn logic
- In `db.js`: the collections + words blocks
- Tests: `collect*`, `collection-*`, `word-*`, `generate-routes`, `name-preview*`, `wizard-*`, `custom-title*`, `theme-extra-fields`, `production-validation`, `render_page`/`config`/`topup` (python)

## Agent D — Platform & Comms (chrome, messaging, infra)

Settings, content editor, WhatsApp/Whapi, emails/reminders, and the test/CI harness.

- `server/settings.js`, `content.js`, `content-import.js`, `whatsapp.js`, `wa-state.js`, `notify.js`, `playbook.js`, `reminders*`
- `site/js/editor.js` (loaded on every page), `header.js`, `analytics.js`, `timer.js`, `consent.js` (shared w/ C)
- Pages: `admin.html` chrome, `admin-features.html`, `admin-texts.html`, `admin-playbook.html`, `how.html`, `timer.html`, homepage marketing shell
- In `index.js`: content/settings/features routes, `/api/whatsapp/webhook`, the reminder/nudge scans, the SPA `GET *` catch-all
- Test/CI harness (D arbitrates): `package.json`, `vitest.config.js`, `playwright.config.js`, `eslint.config.js`, `tests/e2e/{tpl-fixture,global-setup,feature-flags}.js`
- Tests: `settings*`, `content-*`, `whatsapp*`, `wa-*`, `notify*`, `reminder*`, `playbook*`, `analytics`, `editor`, `feature-flags`, `admin-features/texts/playbook.spec`, `content-editor.spec`, `server-routing`, `smoke`

## Shared / coordination points

- `server/index.js`, `server/db.js` — edit only your block (above).
- `site/js/designs.js`, `site/css/tokens.css` — B owns; others read-only; never hand-edit `designs.generated.js`.
- `site/js/editor.js`, `server/settings.js`, the test/CI harness — D owns; others request changes.
- `site/js/configurator.js` — A primary, used by C via collect; coordinate.
- `generator/themes.json` is the source of truth but mirrored in `site/js/designs.js` (B) and `server/validate.js` (C) — changing a theme's fields/visibility must be synced across all three (drift hazard; a future cleanup collapses it).
- Renaming/removing an exported symbol (e.g. in `design-images.js`/`designs.js`) → grep EVERY consumer and update it; a missing named import is a hard ES-module error that kills a whole page (this once broke the home page: #167→#169).

## Workflow (every agent)

Own worktree off `origin/main` · edit only your block in the monolith files · `git fetch && git rebase origin/main` before every push · open your OWN PR, CI green (Prettier/ESLint/Vitest/Playwright + pytest over `generator/`; E2E runs on push:main too) · **never merge — the integrator merges** · never deploy (Railway owner-only; integrator deploys staging + smoke, owner promotes production).
