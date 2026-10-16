// REDESIGN MODE: one switch that puts the whole site into the new design.
//
// Two ways in, and they are NOT equal:
//   • the setting `redesign.enabled` (admin-features.html, "עיצוב חדש לכל האתר")
//     turns the mode on for every visitor. This is the flip.
//   • a session cookie `rd=1`, set by opening any page with ?rd=1 and cleared by
//     ?rd=0, previews the mode in ONE browser. It never turns the mode on for
//     anyone else, and a page served to a preview is always noindex, so a crawler
//     that follows a ?rd=1 link can never index the variant.
//
// In the mode, every served page except the admin pages gets class="rd" on
// <html>, the stylesheet /css/redesign.css and the script /js/redesign-shell.js
// at the end of <head> (each only once it exists in site/, so the gate can ship
// before the files do), and the home page is new.html's content, served at the
// same URL. With the setting off and no cookie nothing here touches a byte.

const path = require('path');

const COOKIE = 'rd';
const SET_COOKIE = COOKIE + '=1; Path=/; SameSite=Lax';
const CLEAR_COOKIE = COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax';
const CSS_URL = '/css/redesign.css';
const JS_URL = '/js/redesign-shell.js';
const HOME_FILE = 'index.html';
const NEW_HOME_FILE = 'new.html';

function readCookie(header) {
  const m = String(header || '').match(/(?:^|;\s*)rd=([^;]*)/);
  return m ? m[1].trim() : null;
}

// The admin pages stay exactly as they are, in or out of the mode.
function isAdminFile(file) {
  return /^admin(?:[-.]|$)/.test(path.basename(String(file || '')));
}

// What this request gets. `enabled` is the live setting.
//   active      — serve the redesign
//   live        — the setting is on (the flip): the swapped home is indexable
//   previewOnly — on only through the cookie: everything served is noindex
//   setCookie   — a Set-Cookie value to send, or null
function forRequest(req, { enabled }) {
  const q = req.query ? req.query.rd : undefined;
  let preview = readCookie(req.headers && req.headers.cookie) === '1';
  let setCookie = null;
  if (q === '1') {
    preview = true;
    setCookie = SET_COOKIE;
  } else if (q === '0') {
    preview = false;
    setCookie = CLEAR_COOKIE;
  }
  const live = enabled === true;
  return { active: live || preview, live, previewOnly: !live && preview, setCookie };
}

// The file to read for a resolved page: in the mode, the home page is new.html.
// Returns null when there is no swap (not the home page, or no new.html).
function homeSwap(file, siteDir, fs) {
  if (path.basename(file) !== HOME_FILE || path.dirname(file) !== path.resolve(siteDir)) {
    return null;
  }
  const next = path.join(siteDir, NEW_HOME_FILE);
  return fs.existsSync(next) ? next : null;
}

// new.html carries its own noindex while it is private. Served at "/" after the
// flip it IS the home page, so that tag goes; /new.html itself keeps it.
function dropRobotsMeta(html) {
  return html.replace(/[ \t]*<meta\s+name="robots"[^>]*>[ \t]*\r?\n?/gi, '');
}

function addHtmlClass(html) {
  return html.replace(/<html\b([^>]*)>/i, (whole, attrs) => {
    const m = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    if (!m) return '<html' + attrs + ' class="rd">';
    if (/(?:^|\s)rd(?:\s|$)/.test(m[2])) return whole;
    const cls = (m[2] ? m[2] + ' ' : '') + 'rd';
    return '<html' + attrs.replace(m[0], 'class=' + m[1] + cls + m[1]) + '>';
  });
}

// class="rd" on <html>, then the stylesheet and the shell script as the LAST
// things in <head>, after the page's own stylesheets so the redesign wins the
// cascade. The urls are the bare logical ones; the caller runs the asset-hashing
// tag rewrite afterwards, which swaps them for their hashed names. `has(url)`
// says whether a file exists to link to.
function apply(html, has) {
  let out = addHtmlClass(html);
  const tags = [];
  if (has(CSS_URL)) tags.push(`<link rel="stylesheet" href="${CSS_URL}" />`);
  if (has(JS_URL)) tags.push(`<script src="${JS_URL}" defer></script>`);
  if (tags.length) {
    const i = out.search(/<\/head>/i);
    if (i !== -1) out = out.slice(0, i) + '  ' + tags.join('\n    ') + '\n  ' + out.slice(i);
  }
  return out;
}

module.exports = {
  COOKIE,
  SET_COOKIE,
  CLEAR_COOKIE,
  CSS_URL,
  JS_URL,
  readCookie,
  isAdminFile,
  forRequest,
  homeSwap,
  dropRobotsMeta,
  addHtmlClass,
  apply,
};
