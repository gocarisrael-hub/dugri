// The PERSISTENT owner template store — the half of the template config that
// survives a redeploy.
//
// Why this exists: templates used to be written straight into the repo checkout
// (resources/canva/templates/<slug>/, generator/themes.json,
// generator/recipes/<slug>.json). In production that checkout is the Docker
// image at /app, whose filesystem is EPHEMERAL — so every template the owner
// uploaded and every calibration they saved was silently lost on the next
// deploy. Only the volume mounted at DATA_DIR persists.
//
// Pointing everything at DATA_DIR instead does NOT work either: the shipped
// templates live in the image, so the app would come up seeing zero designs.
// Hence an OVERLAY — the image stays the read-only base, DATA_DIR/templates is
// the owner's writable layer on top:
//
//   DATA_DIR/templates/themes.json          owner theme entries { "<slug>": {…} },
//                                           same shape as generator/themes.json
//   DATA_DIR/templates/<slug>/              owner template assets: clean/ filled/ fonts/
//   DATA_DIR/templates/recipes/<slug>.json  owner recipes
//
// Resolution (applied identically by the Python generator half):
//   themes  -> { ...shipped, ...owner }        owner entry WINS whole-entry
//   assets  -> owner <slug>/ if it exists, else the image's copy
//   recipe  -> owner recipes/<slug>.json if it exists, else the image's
// ALL writes go here, never into the image. Editing a SHIPPED template is
// copy-on-write: the edit lands here and shadows the pristine shipped one.
//
// With DATA_DIR unset (local dev, unit tests) every accessor returns null and
// the callers behave exactly as they did before this store existed.
//
// This module owns ONLY the layout + path safety. Reading/merging/writing the
// JSON is server/templates.js's job (it already owns the atomic-write and
// corrupt-file posture).
const path = require('path');

// The store root, or null when there is no persistent volume (DATA_DIR unset).
// Read from the environment on EVERY call, never cached at require() time: the
// unit tests set DATA_DIR after loading the module, and the server reads it
// before any request anyway.
function storeRoot() {
  const dir = process.env.DATA_DIR;
  return dir ? path.resolve(path.join(dir, 'templates')) : null;
}

// True when the owner store is active at all.
function enabled() {
  return storeRoot() !== null;
}

// DATA_DIR/templates/themes.json — the owner theme entries. null when disabled.
function ownerThemesPath() {
  const root = storeRoot();
  return root ? path.join(root, 'themes.json') : null;
}

// DATA_DIR/templates/recipes — the owner recipe dir. null when disabled.
function ownerRecipesDir() {
  const root = storeRoot();
  return root ? path.join(root, 'recipes') : null;
}

// DATA_DIR/templates/recipes/<key>.json. null when disabled or the key is unsafe.
function ownerRecipePath(key) {
  const dir = ownerRecipesDir();
  if (!dir) return null;
  const name = path.basename(String(key || ''));
  if (!name || name === '.' || name === '..' || name !== String(key)) return null;
  return path.join(dir, name + '.json');
}

// The two names inside the store root that are NOT per-template asset dirs. A
// template keyed with one of them would collide with the store's own layout, so
// onboarding rejects them (see RESERVED_KEYS in templates.js).
const RESERVED_KEYS = ['recipes', 'themes.json'];

// DATA_DIR/templates/<key> — the owner asset dir for one theme, resolved BY KEY
// (the themes.json key, which is what every admin route and the generator's
// theme(name) lookup are keyed on). Deliberately NOT derived from the entry's
// `dir` field: an owner template's `dir` still reads
// "resources/canva/templates/<slug>", which does not exist in the image.
//
// Returns null when the store is disabled, the key is reserved, or the resolved
// path would land on / escape the store root — so a doctored key can never
// traverse out.
function ownerTemplateDir(key) {
  const root = storeRoot();
  if (!root) return null;
  const raw = String(key == null ? '' : key);
  if (!raw || RESERVED_KEYS.includes(raw)) return null;
  const abs = path.resolve(root, raw);
  if (abs === root || !abs.startsWith(root + path.sep)) return null;
  // Only a DIRECT child of the store root is a template dir (no nesting), which
  // also rejects keys carrying a separator.
  if (path.dirname(abs) !== root) return null;
  return abs;
}

// Is `abs` inside the owner store? Used to describe where a write landed.
function isInStore(abs) {
  const root = storeRoot();
  if (!root || !abs) return false;
  const p = path.resolve(abs);
  return p === root || p.startsWith(root + path.sep);
}

module.exports = {
  storeRoot,
  enabled,
  ownerThemesPath,
  ownerRecipesDir,
  ownerRecipePath,
  ownerTemplateDir,
  isInStore,
  RESERVED_KEYS,
};
