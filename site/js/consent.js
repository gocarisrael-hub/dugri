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

  // Passive cookie notice (informational only — never blocks analytics).
  // Shows ONCE EVER: the moment it renders we mark it 'shown', so it never
  // pops up again on any page. Auto-fades after a few seconds.
  var seen = null;
  try {
    seen = localStorage.getItem(NOTICE_KEY);
  } catch {}
  if (seen) return;

  // A transparent, click-through wrapper pins the visible pill in the
  // bottom-left corner without intercepting clicks on the rest of the page.
  var wrap = document.createElement('div');
  wrap.setAttribute(
    'style',
    'position:fixed;left:0;bottom:0;z-index:9999;pointer-events:none;font-family:inherit'
  );

  var bar = document.createElement('div');
  bar.id = 'cookieNotice';
  bar.setAttribute(
    'style',
    'pointer-events:auto;position:fixed;left:12px;bottom:12px;display:flex;align-items:center;' +
      'gap:6px;font-size:11px;line-height:1.4;padding:4px 9px;border-radius:999px;' +
      'background:rgba(44,26,41,.9);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);' +
      'transition:opacity .4s ease,bottom .2s ease'
  );

  var text = document.createElement('span');
  text.textContent = '🍪 עוגיות';

  var close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'סגירה');
  close.textContent = '×';
  close.setAttribute(
    'style',
    'border:0;cursor:pointer;background:transparent;color:#fff;font-size:14px;line-height:1;padding:0 2px'
  );
  close.addEventListener('click', function () {
    wrap.remove();
  });

  bar.appendChild(text);
  bar.appendChild(close);
  wrap.appendChild(bar);
  document.body.appendChild(wrap);

  // CLEAR OF A BOTTOM BAR. The corner is only free on a page with nothing fixed
  // to the foot of the screen. The order wizard's Back/Next bar, the word
  // collection's pay bar and how.html's order bar all sit there, and on the
  // wizard at 390 px the chip lay over "הבא", so a first-time buyer's tap could
  // land on the chip. So the chip stands just above whatever short bar is FIXED
  // to the bottom under it, found by asking what is on top at the foot of the
  // screen across the chip's own width (a few hit-tests, not a walk of the page).
  // Only bars count: something 200 px or taller is a sheet or a panel, and a
  // sticky footer inside one (the start explainer's continue button) already
  // lifts itself clear of the corner. Measured again while the chip is up,
  // because a page may draw its bar after this script runs, or change it.
  var BASE_BOTTOM = 12;
  var BAR_MAX = 200;
  function barUnderChip() {
    if (!document.elementsFromPoint) return 0;
    var vh = window.innerHeight;
    var r = bar.getBoundingClientRect();
    var xs = [r.left + 4, r.left + r.width / 2, r.right - 4];
    var lift = 0;
    for (var i = 0; i < xs.length; i++) {
      var stack = document.elementsFromPoint(xs[i], vh - 2);
      // Only what is ON TOP at the foot of the screen: a bar covered by an open
      // sheet is not what the chip would sit on.
      var top = null;
      for (var j = 0; j < stack.length && !top; j++) {
        if (!wrap.contains(stack[j])) top = stack[j];
      }
      for (var n = top; n && n !== document.body; n = n.parentElement) {
        if (window.getComputedStyle(n).position !== 'fixed') continue;
        var b = n.getBoundingClientRect();
        if (b.bottom >= vh - 4 && b.height > 0 && b.height < BAR_MAX) {
          lift = Math.max(lift, vh - b.top);
        }
        break;
      }
    }
    return lift;
  }
  function place() {
    if (!wrap.isConnected) return;
    var lift = barUnderChip();
    bar.style.bottom = (lift ? Math.ceil(lift) + 8 : BASE_BOTTOM) + 'px';
  }
  place();
  if (window.requestAnimationFrame) window.requestAnimationFrame(place);
  window.addEventListener('resize', place);
  var placeTimer = setInterval(function () {
    if (!wrap.isConnected) return clearInterval(placeTimer);
    place();
  }, 300);

  // Mark as shown the moment it renders, so it never appears again anywhere.
  try {
    localStorage.setItem(NOTICE_KEY, 'shown');
  } catch {}

  // Auto-fade and remove after ~6s so it never lingers.
  setTimeout(function () {
    bar.style.opacity = '0';
    setTimeout(function () {
      wrap.remove();
    }, 450);
  }, 6000);
})();
