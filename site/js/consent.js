// Cookie-consent banner. Loads GA4 only after the visitor accepts.
// Modeled on the injected-bar pattern in demo-banner.js.
// The GA4 Measurement ID lives ONLY in this file.
(function () {
  var GA_ID = 'G-H1W3PQGNYF';
  var STORAGE_KEY = 'dugri_consent';

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

  function grant() {
    gtag('consent', 'update', { analytics_storage: 'granted' });
    loadGA();
  }

  function showBanner() {
    // A transparent, click-through wrapper pins the visible pill to the bottom
    // without intercepting clicks on the rest of the page (so page CTAs / the
    // timer controls stay reachable). Only the pill itself captures clicks.
    var wrap = document.createElement('div');
    wrap.setAttribute(
      'style',
      'position:fixed;left:0;right:0;bottom:0;z-index:9999;pointer-events:none;' +
        'display:flex;justify-content:center;padding:10px 12px;' +
        'box-sizing:border-box;font-family:inherit'
    );
    // On narrow phones a full-width bottom CTA / centered controls sit exactly
    // where a bottom bar would. Dock the pill to the top there instead so it
    // never covers page CTAs; keep it bottom on wider (desktop) viewports.
    if (window.innerWidth < 720) {
      wrap.style.bottom = '';
      wrap.style.top = '0';
    }

    var bar = document.createElement('div');
    bar.id = 'cookieConsent';
    bar.setAttribute(
      'style',
      'pointer-events:auto;display:flex;flex-wrap:wrap;align-items:center;' +
        'justify-content:center;gap:10px;background:#2c1a29;color:#fff;' +
        'font-size:13px;line-height:1.4;padding:10px 14px;border-radius:12px;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:560px;width:100%'
    );

    var text = document.createElement('span');
    text.textContent = 'אנחנו משתמשים בעוגיות כדי לשפר את האתר 🍪';
    text.setAttribute('style', 'flex:1 1 auto;min-width:180px;text-align:center');

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = 'מקובל';
    accept.setAttribute(
      'style',
      'border:0;cursor:pointer;background:#ff2e93;color:#fff;font-weight:700;' +
        'font-size:13px;padding:7px 16px;border-radius:8px'
    );

    var decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = 'לא תודה';
    decline.setAttribute(
      'style',
      'border:0;cursor:pointer;background:transparent;color:#fff;' +
        'text-decoration:underline;font-size:13px;padding:7px 8px'
    );

    accept.addEventListener('click', function () {
      try {
        localStorage.setItem(STORAGE_KEY, 'granted');
      } catch {}
      grant();
      wrap.remove();
    });

    decline.addEventListener('click', function () {
      try {
        localStorage.setItem(STORAGE_KEY, 'denied');
      } catch {}
      wrap.remove();
    });

    bar.appendChild(text);
    bar.appendChild(accept);
    bar.appendChild(decline);
    wrap.appendChild(bar);
    document.body.appendChild(wrap);
  }

  var consent = null;
  try {
    consent = localStorage.getItem(STORAGE_KEY);
  } catch {}

  if (consent === 'granted') {
    grant();
  } else if (consent === 'denied') {
    // no banner, no GA
  } else {
    showBanner();
  }
})();
