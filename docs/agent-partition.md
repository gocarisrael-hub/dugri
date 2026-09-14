# Agent partition (detail behind CLAUDE.md → "Multi-agent workflow")

Four domain agents work in parallel, each in its own git worktree. A single **integrator**
(not the agents) reviews and merges every PR to main, then deploys staging. This file is the
detailed ownership map; the rules live in `CLAUDE.md`, the integrator's procedure in
`docs/integrator.md`.

## The core constraint

The backend is a monolith: **`server/index.js`** (every route registers here inline) and
**`server/db.js`** (one JSON store for all domains) are touched by everyone. Rule: edit ONLY
your domain's block in those two files; never reorder or reflow another domain's code. Rebase
often. Everything else partitions cleanly.

## Agent A — Commerce (the money path)

Pricing, coupons, orders, checkout, payment, shipping and pickup.

- `server/pelecard.js` (+ `server/PELECARD.md`), `server/hfd.js`; `site/js/pricing.js`, `site/js/product.js`, `site/js/configurator.js`, `site/js/admin-role.js` (what the staff key may see of the money)
- the checkout/address block of `site/collect.html`
- `generator/pickup_stickers.py` (the pickup labels; the rest of `generator/` is C's)
- Pages: `product.html`, `options.html` (pricing/checkout parts), `coupons.html`, `partner.html`, `pay-done.html`, `pay-success.html`, `pickup.html`, `dashboard.html` (revenue), `admin-pricing.html`, `admin-inventory.html`, the orders view of `admin.html`
- In `index.js`: `/api/pricing`, `/api/collections/:id/order`, `/pay/init`, `/api/payment/callback`, `/coupon/validate`, `/api/admin/coupons*`, `/api/partner/*`, `/api/stats/orders`, `/api/admin/stock`, `/api/admin/pickup-stickers`, `/api/admin/hfd/*` + `/api/admin/collections/:id/hfd*`, `/api/admin/orders/ready-batch`
- In `db.js`: the coupons block, `ORDER_PRICES`/pricing, the stock block, order totals
- Tests: `pricing-*`, `price-row*`, `struck-price`, `sale-mode*`, `sale-switch`, `how-price`, `coupon*`, `partner-*`, `dashboard-coupons`, `order*` (except `order-wordlist`), `pelecard*`, `pay-*`, `payment-*`, `thankyou`, `free-order-emails`, `custom-product`, `hfd*`, `admin-hfd`, `shipping-upgrade`, `remote-towns`, `pickup-*`, `stock`, `admin-inventory`, `ready-batch`, `admin-ready-batch`, `revenue-agrees`, `admin-order-edit`, `admin-edit-order`, `staff-key*`, `purchase-event`

## Agent B — Catalog & Design (what exists, how it looks, its imagery)

Designs, gallery/images, templates and their artwork, themes, storefront carousels.

- `server/templates.js`, `server/template-store.js`, `server/design-catalog.js`, `server/design-images.js`, `server/image-thumbs.js`, `server/promo.js`; `scripts/tokenize-svg.mjs`, `render-design-assets.mjs`, `product-thumbs.mjs` (need `magick`), `backup-templates.mjs`, `icon-contact-sheet.py`, `icon-clearance-proof.py`
- `site/js/designs.js` (+ `designs.generated.js` — BUILD OUTPUT, never hand-edit), `site/js/design-images.js`, `site/js/carousel.js`, `site/js/lazy-media.js`, `site/js/pinch-zoom.js`, `site/js/promo.js`
- Pages: `products.html`, `index.html` (catalog/carousel), `admin-designs.html`, `admin-images.html`, `admin-templates.html`, `admin-newgame.html`, `design-codes.html`
- CSS: `site/css/tokens.css`, `site/css/carousel.css`
- In `index.js`: the designs/templates/preview region, `/api/design-names`, `/api/design-images*`, `/api/admin/templates*` (upload, artwork/asset SVGs, fonts), `/api/custom-designs`, `/api/template-image/*`, `/api/promo` + `/api/admin/promo/*`
- In `db.js`: the design-codes block
- Tests: `design-*`, `custom-designs*`, `storefront-custom-designs`, `colors`, `page-tint`, `carousel`, `color-step-carousel`, `marquee`, `reviews`, `gallery-weight`, `image-thumbs`, `picture-letterbox`, `pinch-zoom`, `product-portrait`, `products`, `promo*`, `render-design-assets`, `backup-templates`, `templates-store`, `admin-templates*`, `admin-template-fonts`, `template-alt-fonts`, `template-read-asset`, `admin-designs*`, `admin-images`
- NOTE: B owns template artwork and assets; C owns how they are rendered (generator, template editor). Coordinate on changes that span both.

## Agent C — Wizard & Word-collection (the buyer funnel → PDF)

Buyer wizard, word collection, word lists, name preview, pawn/player cards, the Python generator, print output and the template editor.

- `server/validate.js`, `server/wordlists.js`, `server/wordlist-options.js`, `server/word-bank.js`, `server/preview-cache.js`, `server/generator-proc.js`, `server/deck-jobs.js`, `server/redetect-job.js`, `server/proof.js`, `server/press-marks.js`, `server/pdf-name.js`, `server/photo-fallback.js`
- `site/js/collect.js`, `site/js/word-prompts.js`, `site/js/name-preview-instant.js`, `site/js/emoji.js`, `site/js/niqqud.js`, `site/js/pawn-cutout.js`, `site/js/pawn-frame.js`, `site/js/proof.js`, `site/js/start-explainer.js`; wizard portions of `site/options.html`
- `generator/*.py` (build/render_page/render_card/deck_html/preview/config/pack/topup/typefit/calibrate/recipe/order_to_pdf/press/press_marks/pawn_three_views/word_demand …, except `pickup_stickers.py`), `generator/themes.json` (per-theme render knobs), `generator/recipes/`; `scripts/set-word-pitch.mjs`, `scripts/set_photo_card_copy.py`
- Pages: `collect.html` (EXCEPT its checkout/address block, which is A's), `wordlists.html`, `proof.html`, `admin-wordlists.html`, `admin-bench.html` (template editor), the collections view of `admin.html`
- In `index.js`: the collections routes (incl. `/pawns`, `/pawn-view`, `/players`, `/pawn-card`, `/proof*`), `/api/preview`, `/api/wordlist-options`, `/api/wordlist-preview`, `/api/admin/wordlists*`, `/api/admin/collections/:id/generate`, `/api/admin/collections/:id/proof`, `/api/admin/collections/:id/press` + the generator spawn logic, redetect and calibration routes
- In `db.js`: the collections + words blocks, the word bank
- Tests: `collect*`, `collection-*`, `word-*`, `wordlist*`, `wordlists*`, `personal-first-bank`, `free-word-limit*`, `authored-list`, `generate-*`, `name-preview*`, `wizard-*`, `custom-title*`, `title-*`, `template-title*`, `template-word-*`, `template-card-structure`, `template-type-ceilings`, `template-key-vs-recipe`, `gendered-title`, `honoree-name`, `theme-extra-fields`, `production-*`, `produce-on-close`, `undo-production`, `deck-*`, `small-cards`, `card-order`, `admin-card-order`, `pawn-*`, `players`, `photo-card`, `photo-fallback-*`, `proof-*`, `press-*`, `pdf-name*`, `generator-proc`, `redetect-*`, `typefit-route`, `refuse-emoji`, `refuse-niqqud`, `emoji`, `niqqud`, `start-explainer*`, `render-portrait-cards`, `admin-order-wordlist`, `order-wordlist`, and `generator/test_*.py`

## Agent D — Platform & Comms (chrome, messaging, ads, infra)

Settings, content editor, WhatsApp/Whapi, SMS, emails/reminders, ads attribution and Meta, store mirroring, and the test/CI harness.

- `server/settings.js`, `content.js`, `content-import.js`, `store-import.js`, `template-import.js`, `store-backup.js`, `whatsapp.js`, `wa-state.js`, `wa-guard.js`, `sms.js`, `notify.js`, `message-preview.js`, `unsubscribe.js`, `reminders.js`, `playbook.js`, `faq.js`, `attribution.js`, `meta-capi.js`, `meta-insights.js`, `meta-pixel.js`, `asset-hashing.js`
- `site/js/editor.js` (loaded on every page), `header.js`, `analytics.js`, `attribution.js`, `timer.js`, `faq.js`, `consent.js` (shared w/ C), `demo-banner.js` (no-op)
- Pages: `admin.html` chrome, `admin-features.html`, `admin-texts.html`, `admin-preview.html`, `admin-playbook.html`, `admin-faq.html`, `admin-ads.html`, `admin-analytics.html` (pixel/analytics settings), `how.html`, `timer.html`, `terms.html`, `unsubscribe.html`, homepage marketing shell
- Docs: `docs/sms-gateway.md`, `docs/whatsapp-arming.md`, `RAILWAY_SETUP.md`
- In `index.js`: content/settings/features routes, `/api/whatsapp/webhook`, `/api/sms/*` + `/api/admin/sms`, `/api/track`, `/api/admin/ads*`, `/api/admin/meta-capi/*`, `/api/admin/message-preview*`, `/api/faq`, `/api/unsubscribe*` + `/api/resubscribe`, the store/template import routes, the reminder/nudge scans, the SPA `GET *` catch-all
- Test/CI harness (D arbitrates): `package.json`, `vitest.config.js`, `playwright.config.js`, `eslint.config.js`, `.github/workflows/*`, `scripts/smoke.mjs`, `scripts/stress/`, `scripts/fetch-fonts.mjs`, `scripts/localize-font-links.mjs`, `tests/e2e/{tpl-fixture,global-setup,feature-flags,server-target}.js`
  - The e2e server's port is derived per checkout (`server-target.js`), so worktrees can run E2E concurrently; `E2E_PORT=<n>` overrides. global-setup FAILS the run if that port answers with another checkout's config.
- Tests: `settings*`, `content-*`, `store-import`, `template-import`, `whatsapp*`, `wa-*`, `sms-*`, `admin-texts-sms`, `admin-whatsapp-groups`, `notify*`, `close-emails`, `email-toggles`, `message-preview`, `admin-preview`, `unsubscribe`, `reminder*`, `playbook*`, `admin-playbook`, `faq*`, `admin-faq`, `terms`, `analytics*`, `attribution*`, `ads-base-url`, `admin-ads`, `admin-analytics`, `meta-*`, `track-routes`, `editor*`, `site-editability`, `feature-flags`, `options-feature-flags`, `admin-features`, `admin-nav`, `content-editor`, `server-routing`, `api-no-store`, `asset-hashing`, `runtime-assets`, `fonts-self-hosted`, `manifest`, `pwa-icons`, `db-atomic-write`, `eslint-server-coverage`, `e2e-harness`, `stress-harness`, `smoke`

## Shared / coordination points

- `server/index.js`, `server/db.js` — edit only your block (above).
- `site/admin.html` — split by view: chrome/nav D, orders A, collections C.
- `site/options.html` — pricing/checkout A, wizard C.
- `site/index.html` — catalog/carousel/promo B, marketing shell/FAQ D, the start explainer hook C.
- `site/js/designs.js`, `site/css/tokens.css` — B owns; others read-only; never hand-edit `designs.generated.js`.
- `site/js/editor.js`, `server/settings.js`, the test/CI harness — D owns; others request changes. Each domain still owns its own settings keys' meaning (A pricing, D messages).
- `site/js/configurator.js` — A primary, used by C via collect; coordinate.
- `generator/themes.json` is the source of truth but mirrored in `site/js/designs.js` (B) and `server/validate.js` (C) — changing a theme's fields/visibility must be synced across all three (drift hazard; a future cleanup collapses it).
  - Partly collapsed for `extra_fields` / `language` / `name_form`: `GET /api/design-names` now serves them LIVE (merged with the owner's admin overrides) and `syncDesignNames` stamps them onto the catalog objects, which every design resolver prefers. `THEME_EXTRA_FIELDS` / `LANGUAGE_BY_THEME` in `designs.js` are now the first-paint fallback only — still keep them in step, but an admin edit no longer needs a deploy to reach the wizard. `server/validate.js` already reads themes.json live.
- `dugri_playbook.html`, `docs/deck-rendering.md`, `docs/card-structure-schema.md`, `docs/photo-card.md` — whoever changes the behaviour a doc describes updates it in the same PR.
- Renaming/removing an exported symbol (e.g. in `design-images.js`/`designs.js`) → grep EVERY consumer and update it; a missing named import is a hard ES-module error that kills a whole page.

## Workflow (every agent)

Own worktree off `origin/main` · edit only your block in the monolith files · `git fetch origin && git rebase origin/main` before every push · open your OWN PR to main, CI green · **never merge, never push to main, never deploy** · the integrator reviews (a `## Integrator review:` comment for the head SHA) and merges with `gh pr merge` · the integrator deploys staging after each merge batch · production is owner-only. Full rules: `CLAUDE.md`; integrator procedure: `docs/integrator.md`.
