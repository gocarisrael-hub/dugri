'use strict';
// THE DESIGN SWITCH on the collection page (Agent C): which designs a buyer may move
// her order to, and whether one particular move is allowed.
//
// Pure — no fs, no require of the app — so the route, the list the page draws and
// the unit tests all ask the same function. Every input the answer depends on is
// passed in: the built-in catalog (site/js/designs.js PUBLIC_DESIGNS), the LIVE
// themes view (shipped themes.json + the owner's overlay on the volume, the one
// POST /api/collections checks an order's theme against) and the templates helpers
// that hold the rules (shownOnSite, displayNameForDesign).
//
// "Available" means exactly what the storefront offers, by the same two rules:
//   - a BUILT-IN design (THEME_BY_DESIGN) whose theme the owner has not hidden —
//     /api/design-names' `hidden` rule;
//   - a CUSTOM design: any other theme shown on the site — /api/custom-designs'.
// Plus one this page needs and the storefront does not: the theme must have an
// entry at all, because the switch writes it onto the order and production
// renders from it. A built-in whose theme is missing is shown on the storefront
// (the bundle has it) but could not print, so it is not offered here.
//
// Prices are not consulted: the owner's rule is that every design costs the same
// for this purpose, so a switch never charges or refunds.

function own(obj, key) {
  return !!obj && typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * @param {{publicDesigns: object[], themeByDesign: object, themes: object, templates: object}} deps
 * @returns {{id:string, name:string, theme:string, custom:boolean, language:string}[]}
 */
function availableDesigns({ publicDesigns, themeByDesign, themes, templates }) {
  const out = [];
  const seen = new Set();
  const builtInThemes = new Set(Object.values(themeByDesign || {}));
  for (const d of Array.isArray(publicDesigns) ? publicDesigns : []) {
    if (!d || typeof d.id !== 'string' || !d.theme) continue;
    if (!own(themes, d.theme)) continue;
    const entry = themes[d.theme];
    if (!templates.shownOnSite(entry)) continue;
    if (seen.has(d.theme)) continue;
    seen.add(d.theme);
    out.push({
      id: d.id,
      name: templates.displayNameForDesign(themes, d),
      theme: d.theme,
      custom: false,
      language: entry.language === 'english' ? 'english' : 'hebrew',
    });
  }
  for (const key of Object.keys(themes || {})) {
    if (builtInThemes.has(key) || seen.has(key)) continue;
    const entry = themes[key] || {};
    if (!templates.shownOnSite(entry)) continue;
    if (!templates.isSafeSlug(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      name: templates.displayNameForDesign(themes, { id: key, theme: key }),
      theme: key,
      custom: true,
      language: entry.language === 'english' ? 'english' : 'hebrew',
    });
  }
  return out;
}

/**
 * Whether THIS order can print on that design. Every order placed through the
 * wizard carries its own title, so every design fits it. An order that predates
 * the typed title prints a title the theme COMPOSES from the honoree's name and
 * extra fields, and production refuses it on a design whose name language or
 * required fields it does not have (validate.validateOrderForProduction) — so the
 * switch refuses it here, where she can still do something about it (write a
 * title), rather than at the printer.
 *
 * @returns {string|null} the Hebrew reason, or null when it fits
 */
function designMisfit(collection, themeEntry, validate) {
  // One word stands in for the word list: the switch is about the design, and an
  // order with no words yet is not a reason to refuse one.
  const problems = validate.validateOrderForProduction(collection, themeEntry, 1);
  return problems.length ? problems[0] : null;
}

/**
 * The list the page draws: every available design, the current one marked, and
 * any this order cannot move to carrying the reason.
 */
function designsForCollection(collection, list, { themes, validate }) {
  const current = collection && collection.theme ? String(collection.theme) : '';
  return list.map((d) => {
    const reason = d.theme === current ? null : designMisfit(collection, themes[d.theme], validate);
    return { ...d, current: d.theme === current, ok: !reason, reason };
  });
}

module.exports = { availableDesigns, designMisfit, designsForCollection };
