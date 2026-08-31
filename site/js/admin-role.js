// WHAT THE PERSON HOLDING THIS KEY IS ALLOWED TO SEE.
//
// There are two admin keys now: the owner's, and a staff key for someone who
// works the orders but has no business with the money. This file is the polite
// half of that — it trims the nav down to the pages a worker may use, and puts a
// plain Hebrew refusal on the ones she may not, so she is never staring at a
// page that half-loads and then 403s.
//
// It is NOT the security. Every admin route re-checks the key's scope on the
// server (requireAdmin), on every request. Hiding a link has never stopped
// anyone typing a URL, and nothing here is trusted to.
(function () {
  'use strict';

  // The worker's three pages: the orders themselves, the template list, and the
  // typography editor the list opens. The editor has no nav of its own and is
  // reachable only through the list, which is why the list is here too.
  var STAFF_PAGES = ['admin.html', 'admin-templates.html', 'admin-bench.html'];

  function currentPage() {
    var last = location.pathname.split('/').pop();
    return last || 'index.html';
  }

  // The key as the page itself resolves it: the URL first, then the slot the
  // dashboard writes when the owner launches edit mode.
  function adminKey() {
    var fromUrl = new URLSearchParams(location.search).get('key');
    if (fromUrl) return fromUrl;
    try {
      return localStorage.getItem('dugri_admin_key') || '';
    } catch {
      return ''; // private mode — the URL was the only source anyway
    }
  }

  function trimNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    var links = nav.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var page = a.dataset.page || (a.getAttribute('href') || '').split('?')[0];
      if (STAFF_PAGES.indexOf(page) === -1) a.remove();
    }
  }

  // A page the worker may not open. Say so in her own language, name what she
  // CAN do, and give her the way there — a bare 403 reads as "the key is wrong"
  // and sends her looking for a better one, which is the opposite of true.
  function refuse() {
    var key = adminKey();
    var qs = key ? '?key=' + encodeURIComponent(key) : '';
    var wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'staff-no-access');
    wrap.setAttribute(
      'style',
      'max-width:34rem;margin:14vh auto;padding:0 1.25rem;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
        'direction:rtl;text-align:right;color:#141414;line-height:1.7'
    );
    var h = document.createElement('h1');
    h.textContent = 'אין הרשאה לעמוד הזה';
    h.setAttribute('style', 'font-size:1.6rem;font-weight:600;margin:0 0 .6rem');
    var p = document.createElement('p');
    p.textContent = 'המפתח שלך תקין, אבל העמוד הזה מיועד לבעלת העסק בלבד.';
    p.setAttribute('style', 'margin:0 0 1.4rem;color:#5f5a54');
    var a = document.createElement('a');
    a.href = 'admin.html' + qs;
    a.textContent = 'לניהול ההזמנות ›';
    a.setAttribute(
      'style',
      'display:inline-block;background:#141414;color:#fff;padding:.7rem 1.4rem;text-decoration:none;font-weight:500'
    );
    wrap.appendChild(h);
    wrap.appendChild(p);
    wrap.appendChild(a);
    document.body.textContent = '';
    document.body.appendChild(wrap);
  }

  var key = adminKey();
  if (!key) return; // no key at all — the page's own missing-key message covers it

  fetch('/api/admin/whoami?key=' + encodeURIComponent(key))
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      // Anything other than a confirmed staff key leaves the page exactly as it
      // was — including a failed request, so a blip can never lock the owner out
      // of her own admin.
      if (!data || data.role !== 'staff') return;
      document.documentElement.setAttribute('data-admin-role', 'staff');
      if (STAFF_PAGES.indexOf(currentPage()) === -1) refuse();
      else trimNav();
    })
    .catch(function () {
      /* leave the page alone */
    });
})();
