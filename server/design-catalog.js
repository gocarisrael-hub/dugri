// design-catalog.js — the ONE merged design catalog every ADMIN screen reads.
//
// A sellable design reaches the storefront through TWO different doors:
//   • BUILT-IN — an entry of the static catalog (site/js/designs.js DESIGNS,
//     generated from site/js/designs.generated.js). Its art is committed to the
//     repo under site/assets/designs/<id>/ and mapped to a generator theme by
//     THEME_BY_DESIGN.
//   • OWNER TEMPLATE — a generator/themes.json entry that NO built-in design maps
//     to. The owner uploads it from the admin, it becomes an orderable product the
//     moment it is in-store (GET /api/custom-designs), and its art lives in the
//     template dir, served by GET /api/template-image/<slug>/<slot>.
//
// The STOREFRONT has always merged the two. The admin side did not: both
// "עיצובים" (admin-designs.html) and "גלריית מוצר" (admin-images.html) read only
// the built-in catalog, so an uploaded template like `grapefruit` was on sale and
// yet invisible in every admin design screen — the owner could sell a design whose
// pictures they could not curate. Every future upload had the same hole.
//
// This module is the single merge BOTH admin screens now consume (via
// GET /api/admin/designs). One implementation, one ordering, one asset checklist
// per design — two independent merges is exactly how the two screens drifted apart
// in the first place.
//
// HONESTY over uniformity: the two kinds keep their art in different places, so
// they get DIFFERENT asset checklists (`source` says which one was applied and
// where it looked). A template is never reported as "missing" the built-in files
// it was never supposed to have.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const templates = require('./templates');

// ---- built-in expectations -------------------------------------------------

// The full set of files a COMPLETE built-in design ships under
// site/assets/designs/<id>/, grouped by product part so the UI can label a gap by
// group (e.g. "חסר: לוח"). board-group files are legitimately absent for a
// boardless design (kids) — still reported missing on purpose, so the gap stays
// visible and tracked.
const DESIGN_ASSET_GROUPS = [
  { group: 'front', label: 'חזית', files: ['front.svg', 'thumb-front.webp', 'gallery-front.webp'] },
  { group: 'back', label: 'גב', files: ['back.svg', 'thumb-back.webp', 'gallery-back.webp'] },
  { group: 'board', label: 'לוח', files: ['board.svg', 'thumb-board.webp', 'gallery-board.webp'] },
  { group: 'picker', label: 'ממוזערת', files: ['thumb.webp'] },
  { group: 'cover', label: 'שער', files: ['cover.webp'] },
  { group: 'store', label: 'חנות', files: ['store.webp'] },
];

// Flat list of every expected built-in file with its group, in a stable display order.
const EXPECTED_DESIGN_ASSETS = DESIGN_ASSET_GROUPS.flatMap((g) =>
  g.files.map((file) => ({ file, group: g.group, groupLabel: g.label }))
);

// ---- owner-template expectations -------------------------------------------

// What an owner template is checked for: the three FILLED SVGs behind its
// storefront pictures. Deliberately NOT the template's whole file list (18 clean +
// 18 filled cards + fonts on a single-card template) — that inventory already has
// its own screen (admin-templates.html, templates.computeTemplateStatus). Here the
// question is the same one the built-in checklist answers: "can this design show a
// front, a back and a board?", so the group ids + labels match the built-in ones.
const TEMPLATE_ASSET_GROUPS = [
  { group: 'front', label: 'חזית', slot: 'front' },
  { group: 'back', label: 'גב', slot: 'back' },
  { group: 'board', label: 'לוח', slot: 'board' },
];

// The picture slots a design's gallery can hold (server/design-images.js
// BASE_SLOTS). A design reports a SHIPPED render per slot or null — see slotsFor*.
const GALLERY_SLOTS = ['store', 'front', 'back', 'photo', 'board'];

// ---- shared shaping --------------------------------------------------------

// Roll a per-file existence list into the { present, missing, missingGroups,
// complete } summary both kinds report. `groups` is the ordered group list the
// checklist came from, so a gap is labelled by the part it belongs to.
function summarize(assets, groups) {
  const present = assets.filter((a) => a.exists).map((a) => a.file);
  const missing = assets.filter((a) => !a.exists).map((a) => a.file);
  const missingGroups = groups
    .map((g) => ({
      group: g.group,
      label: g.label,
      files: assets.filter((a) => a.group === g.group && !a.exists).map((a) => a.file),
    }))
    .filter((g) => g.files.length > 0);
  return { assets, present, missing, missingGroups, complete: missing.length === 0 };
}

// ---- built-in designs ------------------------------------------------------

// Where a built-in design's committed art lives, relative to the site root.
function builtInAssetRel(id, file) {
  return 'assets/designs/' + id + '/' + file;
}

// The SHIPPED gallery render per slot for a built-in design, or null when the
// design ships none. store/front/back always ship; the OPTIONAL slots (board,
// photo) ship only when the design carries that thumb — `thumbs.<slot>` is the
// catalog's canonical "this design ships that render" indicator (designs.js
// designShipsBoard, site/js/design-images.js shipsRender), so the admin can never
// disagree with the buyer-facing pages about what exists.
function slotsForBuiltIn(d) {
  const thumbs = (d && d.thumbs) || {};
  const out = {};
  for (const slot of GALLERY_SLOTS) {
    const optional = slot === 'board' || slot === 'photo';
    const ships = optional ? !!thumbs[slot] : true;
    out[slot] = ships
      ? builtInAssetRel(d.id, slot === 'store' ? 'store.webp' : 'gallery-' + slot + '.webp')
      : null;
  }
  return out;
}

function builtInDesign(d, siteDir) {
  const dir = path.join(siteDir, 'assets', 'designs', d.id);
  const assets = EXPECTED_DESIGN_ASSETS.map((a) => ({
    ...a,
    exists: fs.existsSync(path.join(dir, a.file)),
  }));
  const summary = summarize(assets, DESIGN_ASSET_GROUPS);
  return {
    id: d.id,
    name: d.name,
    theme: d.theme,
    custom: false,
    visibility: d.visibility,
    public: d.public,
    // A built-in design is always on the shop floor; only a template can be taken
    // off it (themes.json in_store), so this is reported for BOTH kinds and the UI
    // needs no per-kind branch.
    inStore: true,
    // The picker thumbnail, or null when the file isn't on disk — the UI shows its
    // "no thumbnail" placeholder rather than a broken <img>.
    thumb: summary.present.includes('thumb.webp') ? builtInAssetRel(d.id, 'thumb.webp') : null,
    slots: slotsForBuiltIn(d),
    // Which checklist was applied and where it looked, so a design is never
    // reported against expectations that don't belong to it.
    source: { kind: 'builtin', label: 'קבצי אתר', dir: 'site/assets/designs/' + d.id },
    ...summary,
  };
}

// ---- owner templates -------------------------------------------------------

// The absolute path of a template's FILLED SVG for a storefront slot, resolved
// through the persistent owner overlay and confined to the template dir (null on
// an unknown slot or an escape) — the same resolution GET /api/template-image
// serves from, so the admin reports exactly what the storefront can show.
function templateSlotFile(templateRoot, key, slot) {
  try {
    return templates.templateImagePath(templateRoot, key, slot);
  } catch {
    return null;
  }
}

// The public URL of a template's picture slot — identical to what
// /api/custom-designs hands the storefront.
function templateSlotUrl(key, slot) {
  return '/api/template-image/' + encodeURIComponent(key) + '/' + slot;
}

function templateDesign(key, entry, templateRoot) {
  const assets = TEMPLATE_ASSET_GROUPS.map((g) => {
    const file = templateSlotFile(templateRoot, key, g.slot);
    return {
      // The template-relative path (e.g. `filled/2.svg`) — what the owner would go
      // looking for. Falls back to the slot name when the layout can't be resolved.
      file: templates.filledImageRel(entry, g.slot) || g.slot,
      group: g.group,
      groupLabel: g.label,
      exists: !!(file && fs.existsSync(file)),
    };
  });
  const summary = summarize(assets, TEMPLATE_ASSET_GROUPS);
  const slots = {};
  for (const slot of GALLERY_SLOTS) {
    const g = TEMPLATE_ASSET_GROUPS.find((x) => x.slot === slot);
    const asset = g && assets.find((a) => a.group === g.group);
    // store + photo have no template art at all: no shipped render, so the gallery
    // manager offers them as empty "upload one" slots exactly like a built-in
    // design's un-shipped board.
    slots[slot] = asset && asset.exists ? templateSlotUrl(key, slot) : null;
  }
  return {
    id: key,
    name: (typeof entry.display_he === 'string' && entry.display_he.trim()) || key,
    // A template IS its own theme — the themes.json key is both the design id and
    // the generator theme, so there is no slug↔id table to keep in sync.
    theme: key,
    custom: true,
    visibility: entry.visibility === 'private' ? 'private' : 'public',
    public: (entry.visibility || 'public') !== 'private',
    inStore: templates.inStore(entry),
    thumb: slots.front || slots.back || slots.board || null,
    slots,
    source: {
      kind: 'template',
      label: 'קבצי תבנית',
      dir: (typeof entry.dir === 'string' && entry.dir) || 'resources/canva/templates/' + key,
    },
    ...summary,
  };
}

// ---- the merge -------------------------------------------------------------

/**
 * Load the built-in catalog (the ESM site/js/designs.js, dynamically imported into
 * this CommonJS server and Node-cached). Throws with a readable message so the
 * route can 500 instead of serving a silently half-empty catalog.
 */
async function loadBuiltInModule(siteDir) {
  try {
    return await import(pathToFileURL(path.join(siteDir, 'js', 'designs.js')));
  } catch (e) {
    throw new Error('failed to load design catalog: ' + e.message);
  }
}

/**
 * The MERGED admin catalog: every built-in design (catalog order) followed by
 * every owner template (themes.json order), each with its own asset inventory.
 *
 * A template is listed whatever its state — uncalibrated, hidden, or taken off the
 * shop floor — because the admin is where the owner FIXES those states; hiding a
 * design from the screen that manages it is the bug this module exists to close.
 * `visibility` / `inStore` are reported so the UI can say so out loud. Only an
 * unsafe slug is skipped (it could never be served as a picture URL anyway).
 *
 * A themes.json that is missing or corrupt degrades to "built-ins only" rather
 * than failing the whole screen.
 */
async function mergedDesigns({ siteDir, templateRoot }) {
  const mod = await loadBuiltInModule(siteDir);
  const catalog = mod.DESIGNS || [];
  const designs = catalog.map((d) => builtInDesign(d, siteDir));

  const builtInThemes = new Set(Object.values(mod.THEME_BY_DESIGN || {}));
  let themes = null;
  try {
    themes = templates.loadThemesCached(templates.themesPathFor(templateRoot));
  } catch {
    themes = null;
  }
  for (const key of Object.keys(themes || {})) {
    if (builtInThemes.has(key)) continue; // a built-in design's theme, not a template product
    if (!templates.isSafeSlug(key)) continue;
    const entry = templates.ownTheme(themes, key);
    if (!entry || typeof entry !== 'object') continue;
    designs.push(templateDesign(key, entry, templateRoot));
  }
  return designs;
}

module.exports = {
  mergedDesigns,
  DESIGN_ASSET_GROUPS,
  EXPECTED_DESIGN_ASSETS,
  TEMPLATE_ASSET_GROUPS,
  GALLERY_SLOTS,
  // exported for tests
  builtInDesign,
  templateDesign,
};
