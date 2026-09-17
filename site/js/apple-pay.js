// APPLE PAY ON TRANZILA'S HOSTED PAGE NEEDS A SCRIPT ON *OUR* PAGE.
//
// The wallet button lives inside Tranzila's iframe, but the iframe does NOT open
// the Apple Pay sheet. Its in-frame handler posts a message OUT to whatever page
// framed it, and a parent-side script — theirs, on our origin — is what calls
// `new ApplePaySession(...)`, validates the merchant and settles the charge.
//
// With no parent listening, the button renders, passes its own gate and simply
// does nothing when tapped: the message goes out and nobody answers. That is the
// bug this file fixes, and it is why "visible but inert" was the symptom rather
// than a missing button.
//
// THREE THINGS ARE DELIBERATE HERE.
//
// 1. NOTHING LOADS UNTIL A BUYER OPENS THE PAYMENT WINDOW, and then only if the
//    charge is actually going to Tranzila and this browser could open a sheet at
//    all. jQuery is 89KB and their script is a third-party fetch; a buyer reading
//    a word list, or paying by card on Chrome, should pay neither.
//
// 2. REAL JQUERY, NOT A SHIM. Their script calls `$n.ajax` and `$n.each`, `$n`
//    being what `jQuery.noConflict(true)` hands back. A hand-written stand-in for
//    those two methods would work today and break silently the day they use a
//    third — at settlement, with money taken and nothing said. It is vendored on
//    our own origin like the segmenter (site/vendor/), never a CDN.
//
// 3. THEIR `window.onload` IS AN ASSIGNMENT, AND IT IS LOAD-BEARING. The last
//    line of their script is `window.onload = function(){…}` — it CLOBBERS any
//    handler the page already had, and the work it does (a POST to validate_apple
//    carrying `merchant_domain`) is plausibly what registers us with Apple for
//    the session about to start. Loading it after `load` has already fired means
//    it never runs at all. So: capture what was there, let them assign, put the
//    old one back, and invoke theirs by hand at the moment the window opens.
//    Dropping it would risk disabling the very thing we are turning on.
//
// EVERYTHING IS BEST-EFFORT. Apple Pay is an extra button on a page whose card
// payment already works; no failure in here may ever reach the card path.

// Their script's own origin gate is this literal string (`e.origin !== …`), so a
// frame served from anywhere else cannot talk to it even if we loaded it. Testing
// the frame url against the same constant is therefore not a guess about which
// provider we are on — it is the exact condition under which any of this works.
export const TRANZILA_ORIGIN = 'https://directng.tranzila.com';
const PARENT_SCRIPT = TRANZILA_ORIGIN + '/assets/js/tranzilanapple_v3.js';
// Served by express.static from our own origin (see site/vendor/jquery/README.md).
const JQUERY_SRC = '/vendor/jquery/jquery-3.6.0.min.js';

/** Is this payment window Tranzila's — i.e. can the wallet flow work at all? */
export function isTranzilaFrame(url) {
  try {
    return new URL(String(url), document.baseURI).origin === TRANZILA_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Can this browser open an Apple Pay sheet? Chrome, Firefox and every Android
 * browser cannot, and for them the button never appears inside the frame either —
 * so loading 89KB of jQuery for them buys nothing at all.
 */
export function canApplePay() {
  return typeof window !== 'undefined' && typeof window.ApplePaySession !== 'undefined';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    // Order matters: `$n` has to exist before their script's handlers run.
    s.async = false;
    s.addEventListener('load', () => resolve());
    s.addEventListener('error', () => reject(new Error('apple-pay: could not load ' + src)));
    document.head.appendChild(s);
  });
}

let arming = null;

/**
 * Put the parent half of Tranzila's Apple Pay flow on this page, once.
 *
 * Call it when the payment window opens, with the url going into the frame.
 * Resolves to true when the scripts are in place, false when there was nothing to
 * do (another provider, or a browser with no Apple Pay) — and NEVER rejects: the
 * card payment underneath must not depend on any of this.
 */
export function armApplePay(frameUrl) {
  if (!isTranzilaFrame(frameUrl) || !canApplePay()) return Promise.resolve(false);
  if (arming) return arming;
  arming = (async () => {
    await loadScript(JQUERY_SRC);
    // `noConflict(true)` gives us the instance AND takes `$`/`jQuery` back off
    // window — this page has its own `$`, and jQuery must not shadow it.
    const jq = window.jQuery;
    if (!jq || !jq.noConflict) throw new Error('apple-pay: jQuery did not load');
    window.$n = jq.noConflict(true);

    const pageOnload = window.onload;
    await loadScript(PARENT_SCRIPT);
    const theirOnload = window.onload;
    // Undo the clobber (see note 3), then run what it was there to do — after the
    // modal has painted, because their call is a SYNCHRONOUS XHR and would
    // otherwise block the frame from appearing.
    if (theirOnload !== pageOnload) window.onload = pageOnload;
    if (typeof theirOnload === 'function') {
      setTimeout(() => {
        try {
          theirOnload();
        } catch {
          /* their validation ping failed; the sheet may still work */
        }
      }, 0);
    }
    return true;
  })().catch(() => {
    // Let a later attempt try again — a dropped connection on the first open
    // should not disable the wallet for the rest of the session.
    arming = null;
    return false;
  });
  return arming;
}
