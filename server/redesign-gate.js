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
// In the mode, every served page except the exempt ones (isExemptFile) gets class="rd" on
// <html>, and at the end of <head>: the stylesheet /css/redesign.css (the shell),
// /css/rd/chrome.css (the shared header and consent chip), /css/rd/<page>.css
// (that one page's restyle, named after the file served: how.html -> how.css),
// and the script /js/redesign-shell.js. Each is linked only once it exists in
// site/, so the gate ships before the files do and a page with no restyle of its
// own simply gets none. Every rule under css/rd/ is scoped to html.rd
// (tests/unit/rd-css-scope.test.js), so a page restyle never reaches the site
// out of the mode. The home page is new.html's content, served at the same URL. With the setting off and no cookie nothing here touches a byte.

const path = require('path');

const COOKIE = 'rd';
const SET_COOKIE = COOKIE + '=1; Path=/; SameSite=Lax';
const CLEAR_COOKIE = COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax';
const CSS_URL = '/css/redesign.css';
const JS_URL = '/js/redesign-shell.js';
const CHROME_CSS_URL = '/css/rd/chrome.css';
const HOME_FILE = 'index.html';
const NEW_HOME_FILE = 'new.html';

function readCookie(header) {
  const m = String(header || '').match(/(?:^|;\s*)rd=([^;]*)/);
  return m ? m[1].trim() : null;
}

// Pages the mode never touches, in or out of it:
//   • the admin pages (admin.html, admin-*.html);
//   • the owner's other key-gated tools, which are admin pages without the
//     prefix: the coupon manager and the dashboard;
//   • rd-kit.html, the shell's own component sheet, which links the shell
//     itself — injecting it again would load the shell twice.
const EXEMPT_FILES = new Set(['coupons.html', 'dashboard.html', 'rd-kit.html']);
function isExemptFile(file) {
  const name = path.basename(String(file || ''));
  return /^admin(?:[-.]|$)/.test(name) || EXEMPT_FILES.has(name);
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

// The restyle of one page: /css/rd/<name>.css for site/<name>.html. Null for a
// name that is not a plain page name, so a url can never be built from one.
function pageCssUrl(file) {
  const name = path.basename(String(file || ''), '.html');
  return /^[a-z0-9][a-z0-9-]*$/i.test(name) && name !== 'chrome' ? `/css/rd/${name}.css` : null;
}

// class="rd" on <html>, then the stylesheets and the shell script as the LAST
// things in <head>, after the page's own stylesheets so the redesign wins the
// cascade: the shell, the shared chrome, the page's own restyle (most specific
// last), then the script. The urls are the bare logical ones; the caller runs
// the asset-hashing tag rewrite afterwards, which swaps them for their hashed
// names. `has(url)` says whether a file exists to link to; `file` is the page
// being served.
function apply(html, has, file) {
  let out = addHtmlClass(html);
  const tags = [];
  const pageCss = pageCssUrl(file);
  for (const url of [CSS_URL, CHROME_CSS_URL, pageCss]) {
    if (url && has(url)) tags.push(`<link rel="stylesheet" href="${url}" />`);
  }
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
  CHROME_CSS_URL,
  pageCssUrl,
  readCookie,
  isExemptFile,
  forRequest,
  homeSwap,
  dropRobotsMeta,
  addHtmlClass,
  apply,
};
