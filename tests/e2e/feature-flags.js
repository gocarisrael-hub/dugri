// Shared helper for the buyer-wizard feature flags (GET /api/features).
//
// The wizard blocks on GET /api/features at load and hides four gated features
// when their flag is off. On the e2e server every flag DEFAULTS OFF, so any spec
// that exercises colour picking, the chasers add-on, the word-font picker or the
// live name preview must stub the endpoint ON. We stub PER PAGE (page.route)
// rather than seeding settings.json: a reused dev server won't re-read a seeded
// file, and the two device projects share one server — a live endpoint would
// race the admin-features spec's writes. A per-page route is isolated and
// race-free, and each spec declares exactly the flag state it needs.

// All four flags on — the pre-flag behaviour (every feature visible). Import and
// pass to stubFeatures() in a beforeEach so an existing wizard spec keeps working
// unchanged.
export const ALL_ON = {
  color_picking: true,
  chasers_choice: true,
  font_choice: true,
  name_preview: true,
};

// All four flags off — the launch default (every gated feature hidden).
export const ALL_OFF = {
  color_picking: false,
  chasers_choice: false,
  font_choice: false,
  name_preview: false,
};

// Intercept GET /api/features for this page and answer with `flags` (missing
// keys default to false). Register it BEFORE the page navigates so the wizard's
// load-time fetch is served the stub.
export async function stubFeatures(page, flags = {}) {
  const body = {
    color_picking: !!flags.color_picking,
    chasers_choice: !!flags.chasers_choice,
    font_choice: !!flags.font_choice,
    name_preview: !!flags.name_preview,
  };
  await page.route('**/api/features', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  );
}
