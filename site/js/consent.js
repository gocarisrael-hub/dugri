// Analytics loader + passive cookie notice — "track everyone" (no consent gate).
// GA4 loads on every visit (except localhost), and a small dismissible notice
// informs visitors that cookies are used. The notice does NOT gate analytics.
// The GA4 Measurement ID lives ONLY in this file.
(function () {
  var GA_ID = 'G-H1W3PQGNYF';
  var NOTICE_KEY = 'dugri_cookie_notice';

  // Inject gtag.js + run config. NO-OP on localhost so dev never hits GA.
  function loadGA() {
    var host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    gtag('config', GA_ID);
  }

  // Track everyone: grant analytics consent + load GA immediately on every visit.
  gtag('consent', 'update', { analytics_storage: 'granted' });
  loadGA();

  // Passive, dismissible cookie notice (informational only — never blocks analytics).
  var dismissed = null;
  try {
    dismissed = localStorage.getItem(NOTICE_KEY);
  } catch {}
  if (dismissed === 'dismissed') return;

  // A transparent, click-through wrapper pins the visible pill without
  // intercepting clicks on the rest of the page (page CTAs stay reachable).
  var wrap = document.createElement('div');
  wrap.setAttribute(
    'style',
    'position:fixed;left:0;right:0;bottom:0;z-index:9999;pointer-events:none;' +
      'display:flex;justify-content:center;padding:10px 12px;box-sizing:border-box;font-family:inherit'
  );
  // On narrow phones a full-width bottom CTA sits where a bottom bar would —
  // dock the pill to the top there so it never covers page CTAs.
  if (window.innerWidth < 720) {
    wrap.style.bottom = '';
    wrap.style.top = '0';
  }

  var bar = document.createElement('div');
  bar.id = 'cookieNotice';
  bar.setAttribute(
    'style',
    'pointer-events:auto;display:flex;align-items:center;gap:10px;background:#2c1a29;' +
      'color:#fff;font-size:13px;line-height:1.4;padding:8px 12px;border-radius:12px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:420px'
  );

  var text = document.createElement('span');
  text.textContent = '🍪 האתר משתמש בעוגיות לשיפור החוויה';
  text.setAttribute('style', 'flex:1 1 auto');

  var close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'סגירה');
  close.textContent = '×';
  close.setAttribute(
    'style',
    'border:0;cursor:pointer;background:transparent;color:#fff;font-size:20px;line-height:1;padding:0 4px'
  );
  close.addEventListener('click', function () {
    try {
      localStorage.setItem(NOTICE_KEY, 'dismissed');
    } catch {}
    wrap.remove();
  });

  bar.appendChild(text);
  bar.appendChild(close);
  wrap.appendChild(bar);
  document.body.appendChild(wrap);
})();
