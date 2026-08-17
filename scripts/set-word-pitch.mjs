// Write the owner's chosen LINE SPACING to every template on a live instance.
//
// One number per design, in card units: the gap between two printed lines of
// words. It is a PIN — the deck prints at it, and a card's own measured need no
// longer pulls it tighter (generator/config.py word_pitch, build.deck_pitch_for).
//
// The numbers below are the owner's, picked off rendered cards: every template
// was rendered at five candidate spacings with the same sample card — three
// ordinary entries and one phrase long enough to wrap — and she chose one per
// design looking at the result. They are recorded here rather than in
// generator/themes.json because the calibrated templates live on the Railway
// volume (DATA_DIR/templates), where the repo's themes.json never reaches.
//
// Node 20+, ES module, zero dependencies. Run as a CLI:
//
//   node scripts/set-word-pitch.mjs --url https://dugri-staging.up.railway.app \
//     --key "$ADMIN_KEY" [--dry]
//
// Importing has no side effects. A template the instance does not have is
// reported and skipped, never created.
const PITCH = {
  'trip comeback': 27.58,
  bachelorette: 28.38,
  'birthday-girls': 20.62,
  'birthday-boys-basketball': 20.11,
  anniversary: 29.23,
  japanese: 31.65,
  'football-boys': 23.34,
  grapefruit: 26.84,
  'daniel-amit': 29.27,
  tarifa: 26.57,
};

export async function setWordPitch({ url, key, pitch = PITCH, dry = false, log = console.log }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base || !key) throw new Error('need --url and --key');
  const q = `k=${encodeURIComponent(key)}`;
  const listed = await fetch(`${base}/api/admin/templates?${q}`);
  if (!listed.ok) throw new Error(`GET /api/admin/templates -> ${listed.status}`);
  const have = new Set(((await listed.json()).templates || []).map((t) => t.key));

  const done = [];
  for (const [template, value] of Object.entries(pitch)) {
    if (!have.has(template)) {
      log(`skip ${template} — not on this instance`);
      continue;
    }
    if (dry) {
      log(`would set ${template} -> ${value}`);
      continue;
    }
    // One field per request, so a rejected value never carries anything else
    // with it: the settings route merges what it is given onto the stored entry.
    const res = await fetch(
      `${base}/api/admin/templates/${encodeURIComponent(template)}/settings?${q}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word_pitch: value }),
      }
    );
    if (!res.ok) throw new Error(`${template} -> ${res.status} ${await res.text()}`);
    log(`${template} -> ${value}`);
    done.push(template);
  }
  return done;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setWordPitch({
    url: arg('url'),
    key: arg('key') || process.env.ADMIN_KEY,
    dry: process.argv.includes('--dry'),
  }).catch((e) => {
    console.error(String((e && e.message) || e));
    process.exit(1);
  });
}

export { PITCH };
