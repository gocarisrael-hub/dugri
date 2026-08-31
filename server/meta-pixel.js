// meta-pixel.js — the Meta (Facebook/Instagram) Pixel, injected server-side.
//
// Why server-side and not a <script> in each page: the id belongs to the owner's
// ad account and is editable from the admin (settings analytics.meta_pixel_id),
// so it cannot be baked into HTML; and fetching it from the browser before the
// pixel could load would delay every PageView behind a round trip. The HTML
// middleware already rewrites each page (it injects the module import map), so
// the snippet rides along at zero cost.
//
// EMPTY id means OFF. No id, no injection, nothing sent to Meta — which is the
// state the site ships in.

// Meta's own loader, rewritten so it is readable and so the network script is
// conditional. `fbq` is installed unconditionally as a QUEUEING stub: page code
// (and the tests) may call fbq() whether or not the real library ever arrives,
// exactly as GA's gtag stub queues into dataLayer. The <script src> is appended
// only off localhost, so development and E2E never reach Meta.
//
// Meta's snippet also ships a <noscript><img src="facebook.com/tr?…"> beacon. It
// is deliberately NOT reproduced: markup cannot be host-guarded, so it would fire
// from staging and from every JS-less crawler and link-preview bot that touches a
// page, putting events that are not customers into the ad account. Nothing is
// lost — the wizard and the checkout require JavaScript, so a client that cannot
// run the loader was never going to buy.
function snippet(pixelId) {
  return `<script>
      (function (w, d) {
        if (w.fbq) return;
        var n = (w.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        });
        if (!w._fbq) w._fbq = n;
        n.push = n;
        n.loaded = true;
        n.version = '2.0';
        n.queue = [];
        var host = location.hostname;
        if (host !== 'localhost' && host !== '127.0.0.1') {
          var t = d.createElement('script');
          t.async = true;
          t.src = 'https://connect.facebook.net/en_US/fbevents.js';
          d.head.appendChild(t);
        }
      })(window, document);
      fbq('init', '${pixelId}');
      fbq('track', 'PageView');
    </script>
    `;
}

// An id is a bare numeric string; anything else is refused rather than
// interpolated into a <script>. The same shape settings.js validates on save —
// re-checked here because this is the layer that writes it into a page.
const ID_RE = /^\d{5,20}$/;

// The pages that carry the GA stub ARE the buyer-facing pages: that list is
// deliberate (admin screens are excluded so the owner's own work never colours
// the numbers) and is enforced by tests/unit/analytics-coverage.test.js. Keying
// off it means the pixel covers exactly the same pages as GA4, with one list to
// maintain instead of two that drift.
const BUYER_PAGE_MARKER = 'window.dataLayer = window.dataLayer || []';

// Insert the pixel immediately before </head>, after the GA stub, so a PageView
// is queued as early as the page allows. Returns the html untouched whenever
// there is nothing to do — no id, a malformed id, an admin page, or a document
// with no </head>.
function inject(html, pixelId) {
  if (!pixelId || !ID_RE.test(String(pixelId))) return html;
  if (!html.includes(BUYER_PAGE_MARKER)) return html;
  const at = html.search(/<\/head>/i);
  if (at === -1) return html;
  return html.slice(0, at) + snippet(String(pixelId)) + html.slice(at);
}

module.exports = { inject, snippet, ID_RE, BUYER_PAGE_MARKER };
