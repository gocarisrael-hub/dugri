/* start-explainer.js — the full-page "4 steps" explainer that precedes the order
   wizard.

   WHY: shoppers used to land in options.html cold and meet a 4-step wizard with no
   idea what was coming (upload photos? collect words? how long does this take?).
   This overlay is the 30-second briefing that runs BEFORE the wizard: what the four
   stages are, what we need from them at each one, and one button that continues
   into exactly the wizard URL the trigger already pointed at.

   IT NEVER BLOCKS THE PURCHASE. It intercepts the click, shows the explainer, and
   the continue button carries the trigger's OWN href forward — including
   product.js's `options.html?design=<id>&step=2`, so design preselection survives.
   The continue button appears TWICE — above the four steps (title → sub → CTA →
   steps) so a buyer who is already sold can act without reading the briefing, and
   again after step 4 so a reader who scrolled the whole thing is not left with
   nothing to press. They are one button shown twice: same shared handler, same live
   href, same data-edit key (see buildCta).
   Escape / the X / an overlay-backdrop click all close it and hand focus back to
   the trigger, and a modified click (⌘/ctrl/shift/middle) is left alone so
   "open in new tab" still works.

   BINDING: one delegated document-level listener on `a[data-start-explainer]`, so
   it also covers triggers injected AFTER load (products.html paints its fallback
   CTA from JS). Add the attribute to an anchor and it is wired — no per-page code.

   COPY IS OWNER-EDITABLE: every text node carries a data-edit key
   (`start-explainer-*`). Because the markup is injected, we call
   window.dugriEditor.notifyInjected() right after building it so the content editor
   overlays saved text for every visitor and binds the nodes in edit mode (see the
   contract at the top of js/editor.js). Overrides are stored PER PAGE, so the copy
   is edited separately on index / products / product — same defaults everywhere.

   Written as a classic script (no ESM export) so a plain
   `<script src="js/start-explainer.js" defer>` works on every page, including
   products.html which loads no modules. Pure helpers are hung on
   window.__dugriStartExplainer for unit tests; the browser bootstrap only runs when
   the file is loaded as a real <script> (document.currentScript is set), never when
   a test imports it — the same trick editor.js uses. */
(function () {
  'use strict';

  var OVERLAY_ID = 'startExplainer';
  var STYLE_ID = 'dugri-start-explainer-styles';
  var WA_HREF = 'https://wa.me/972546577715';

  // GA4 events. The trigger keeps its own data-ga="order_started" — analytics.js's
  // delegated listener still sees the click (we preventDefault, never
  // stopPropagation), so the existing funnel is untouched. These two are additional:
  // how many shoppers see the briefing, and how many of them go on into the wizard.
  var EV_OPEN = 'order_explainer_opened';
  var EV_CONTINUE = 'order_explainer_continue';

  // Local mirror of analytics.js's track(): that module is ESM and this file is a
  // classic script loaded on pages (products.html) that import no modules. Same
  // guard — gtag queues into dataLayer before GA loads, and is simply absent when
  // consent hasn't loaded it, in which case this is a no-op.
  function track(name, params) {
    if (typeof gtag === 'function') gtag('event', name, params || {});
  }

  // ---- copy -----------------------------------------------------------------
  // The four stages, in her words. Each step's `note` is the soft/secondary aside.
  var TITLE = 'ככה בונים את המשחק — 4 שלבים';
  var SUB = 'לפני שמתחילים, הנה כל מה שמחכה לכם בדרך. זה לוקח כמה דקות.';
  var CONTINUE = 'יאללה, מתחילים ›';
  var STEPS = [
    {
      key: 'step1',
      title: 'התאמה אישית',
      text: 'מתאימים את המשחק שיהיה שלכם: השם של בעל או בעלת השמחה, או כל כותרת שבא לכם — ורואים בזמן אמת איך הקלף הולך להיראות.',
      note: 'אנחנו עדיין בהרצה, אז ייתכן שלא הכול מושלם. אם משהו נתקע או לא ברור — אל תפחדו, שלחו לנו הודעה בוואטסאפ ונסדר.',
    },
    {
      key: 'step2',
      title: '4 תמונות',
      text: 'מעלים 4 תמונות, אנחנו חותכים אותן אוטומטית והן הופכות לפיונים שלכם במשחק. כמה שיותר מצחיקות ואישיות — ככה זה יוצא מושלם.',
    },
    {
      key: 'step3',
      title: 'פרטי קשר',
      text: 'משאירים מייל וטלפון כדי שנכיר אתכם, ונשלח לכם את הקישור לחברים — ככה שתוכלו להתחיל את המסיבה לפני שהיא התחילה.',
    },
    {
      key: 'step4',
      title: 'אוספים מילים',
      text: 'עכשיו תורכם: שולחים לחברים ולמשפחה את האפשרות לאסוף מילים על בעל או בעלת השמחה. אפשר לפתוח קבוצת וואטסאפ ולהוסיף אותנו — ואנחנו נכניס את המילים לאתר אוטומטית. ואפשר כמובן גם להוסיף אותן ידנית.',
      wa: 'להוספה לקבוצה: 054-657-7715',
    },
  ];

  // ---- pure helpers (unit-tested) -------------------------------------------

  // A "plain" left click is ours to intercept. A modified or non-primary click is
  // the browser's (new tab / new window / paste-and-go), so we must let it through
  // or we'd break "open the wizard in a new tab".
  function isPlainClick(event) {
    if (!event) return false;
    if (event.defaultPrevented) return false;
    if (typeof event.button === 'number' && event.button !== 0) return false;
    return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  // The continue button must go wherever the TRIGGER currently points — read live at
  // open time, because product.js rewrites #pdpBuy.href to
  // options.html?design=<id>&step=2 only once its ?design resolves. Falls back to the
  // bare wizard so a malformed trigger still sells.
  function resolveContinueHref(trigger) {
    var href = trigger && trigger.getAttribute ? trigger.getAttribute('href') : null;
    return href && href.trim() ? href.trim() : 'options.html';
  }

  // Tab-cycle candidates inside the overlay: the X, the WhatsApp link and the
  // continue CTA. [hidden] / aria-hidden nodes are skipped. Deliberately does NOT
  // probe layout (offsetParent) — everything inside an open sheet is visible, and a
  // layout probe would make this untestable under jsdom.
  function focusablesIn(root) {
    if (!root || !root.querySelectorAll) return [];
    var sel = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(sel), function (el) {
      return !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true';
    });
  }

  // Where Tab / Shift+Tab should land, wrapping at both ends. Returns -1 when
  // there is nothing to focus. Pure, so the wrap-around is unit-testable without a
  // real keyboard.
  function nextFocusIndex(count, current, back) {
    if (!count || count < 1) return -1;
    if (current < 0) return back ? count - 1 : 0;
    return back ? (current - 1 + count) % count : (current + 1) % count;
  }

  // ---- markup ---------------------------------------------------------------

  function el(tag, cls, attrs) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs)
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    return node;
  }

  // One continue CTA. The sheet renders TWO of these — 'top' (above the steps) and
  // 'bottom' (after step 4) — because the briefing is taller than a phone and a
  // reader who scrolls it all would otherwise end with no button in view.
  //
  // They are the SAME button shown twice, and everything downstream treats them that
  // way: both carry `data-sx-continue`, which is what the runtime binds and what
  // open() stamps the live href onto, so there is exactly one handler and they can
  // never drift apart. `data-sx-place` is the only thing that differs, and it rides
  // along on the analytics event so we learn which one gets used without emitting
  // two event names.
  //
  // They deliberately SHARE one data-edit key. That is the editor's supported
  // pattern for duplicated content, not a conflict: applyOverrides writes to every
  // [data-edit=key] match on load and syncSameKey mirrors a live edit onto all of
  // them (see js/editor.js) — the homepage marquee already ships eight nodes on one
  // key. So the owner retitles the button once and both update, which is what "one
  // button shown twice" should do. Distinct keys would be the change to make only if
  // she ever wants the bottom one worded differently.
  function buildCta(place) {
    var wrap = el('div', 'sx-cta sx-cta--' + place);
    var go = el('a', 'sx-go', {
      href: 'options.html',
      'data-edit': 'start-explainer-continue',
      'data-sx-continue': '',
      'data-sx-place': place,
      'data-testid': 'start-explainer-continue' + (place === 'top' ? '' : '-bottom'),
    });
    go.textContent = CONTINUE;
    wrap.appendChild(go);
    return wrap;
  }

  // Build the overlay DOM (hidden). Exported for unit tests; the runtime builds it
  // once, lazily, on the first open and then reuses it.
  function buildOverlay(doc) {
    doc = doc || document;
    var overlay = doc.createElement('div');
    overlay.className = 'sx-overlay';
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'sxTitle');
    overlay.setAttribute('data-testid', 'start-explainer');

    var inner = el('div', 'sx-inner');

    var x = el('button', 'sx-x', {
      type: 'button',
      'aria-label': 'סגירה',
      'data-testid': 'start-explainer-close',
    });
    x.textContent = '×';
    inner.appendChild(x);

    var head = el('div', 'sx-head');
    var h2 = el('h2', null, { id: 'sxTitle', 'data-edit': 'start-explainer-title' });
    h2.textContent = TITLE;
    var sub = el('p', 'sx-sub', { 'data-edit': 'start-explainer-sub' });
    sub.textContent = SUB;
    head.appendChild(h2);
    head.appendChild(sub);
    inner.appendChild(head);

    // TOP continue CTA — above the four steps so a buyer who is already sold can act
    // the instant the sheet opens, without scrolling past the explanation.
    // Placement note — it is a full-width block BELOW the title/sub, NOT beside the
    // X. The X keeps its own absolute top corner and the head separates the two, so
    // on a 390px phone they are far apart, unmistakably different targets, and
    // neither overlaps the title.
    inner.appendChild(buildCta('top'));

    var list = el('ol', 'sx-steps');
    STEPS.forEach(function (step, i) {
      var li = el('li', 'sx-step', { 'data-testid': 'start-explainer-step' });
      var num = el('span', 'sx-num', { 'aria-hidden': 'true' });
      num.textContent = String(i + 1);
      li.appendChild(num);

      var body = el('div', 'sx-body');
      var h3 = el('h3', null, { 'data-edit': 'start-explainer-' + step.key + '-title' });
      h3.textContent = step.title;
      body.appendChild(h3);
      var p = el('p', null, { 'data-edit': 'start-explainer-' + step.key + '-text' });
      p.textContent = step.text;
      body.appendChild(p);
      if (step.wa) {
        // The number lives in its OWN anchor rather than inside the paragraph: the
        // content editor overwrites textContent, which would swallow a nested link.
        // This way the owner can reword the label and the href survives.
        var wa = el('a', 'sx-wa', {
          href: WA_HREF,
          target: '_blank',
          rel: 'noopener',
          'data-edit': 'start-explainer-' + step.key + '-wa',
          'data-testid': 'start-explainer-wa',
        });
        wa.textContent = step.wa;
        body.appendChild(wa);
      }
      if (step.note) {
        var note = el('p', 'sx-note', { 'data-edit': 'start-explainer-' + step.key + '-note' });
        note.textContent = step.note;
        body.appendChild(note);
      }
      li.appendChild(body);
      list.appendChild(li);
    });
    inner.appendChild(list);

    // BOTTOM continue CTA — the same button again, after step 4. Without it a phone
    // reader who scrolls the whole briefing ends on the last step with nothing to
    // act on and has to scroll back up. On a short/desktop sheet margin-top:auto
    // parks it at the foot rather than leaving it floating mid-page.
    inner.appendChild(buildCta('bottom'));

    overlay.appendChild(inner);
    return overlay;
  }

  // ---- styles ---------------------------------------------------------------
  // Injected once from here (same approach as editor.js) so a page opts in with a
  // single <script> tag and no extra <link>. Built on tokens.css: sharp corners
  // (--radius: 0), thin Heebo headings, warm-sand --accent for the numerals.
  function injectStyles(doc) {
    doc = doc || document;
    if (doc.getElementById(STYLE_ID)) return;
    var css = [
      /* Full VIEWPORT sheet, not a small centered modal. 100dvh keeps the continue
         CTA reachable on mobile where the URL bar eats 100vh. */
      '.sx-overlay{position:fixed;inset:0;z-index:9000;display:none;',
      'background:var(--bg,#fff);overflow-y:auto;-webkit-overflow-scrolling:touch;',
      'padding:0;}',
      '.sx-overlay.is-open{display:block;}',
      '.sx-inner{position:relative;box-sizing:border-box;min-height:100vh;min-height:100dvh;',
      'max-width:640px;margin:0 auto;padding:64px 22px calc(34px + env(safe-area-inset-bottom,0px));',
      'display:flex;flex-direction:column;gap:26px;text-align:right;}',
      /* X — top-LEFT in RTL (the far corner from the text). */
      '.sx-x{position:absolute;top:14px;left:14px;width:42px;height:42px;line-height:1;',
      'font-size:27px;background:transparent;border:1px solid var(--line,#e6e6e6);',
      'border-radius:var(--radius,0);color:var(--ink,#141414);cursor:pointer;padding:0;}',
      '.sx-x:hover{background:var(--sage-tint,#f0f0f0);}',
      '.sx-head h2{font-family:var(--display,sans-serif);font-weight:var(--h-weight,300);',
      'letter-spacing:var(--h-spacing,0.1em);font-size:25px;line-height:1.35;color:var(--ink,#141414);}',
      '.sx-sub{margin-top:9px;color:var(--muted,#6b6b6b);font-size:15.5px;line-height:1.6;',
      'font-weight:var(--sub-weight,200);}',
      '.sx-steps{list-style:none;display:grid;gap:22px;margin:0;padding:0;}',
      '.sx-step{display:flex;align-items:flex-start;gap:15px;',
      'border-top:1px solid var(--line,#e6e6e6);padding-top:20px;}',
      '.sx-step:first-child{border-top:0;padding-top:0;}',
      /* The numeral is the one splash of warm sand. */
      '.sx-num{flex:0 0 auto;font-family:var(--display,sans-serif);font-size:31px;line-height:1;',
      'font-weight:300;color:var(--accent,#b7a389);min-width:31px;}',
      '.sx-body{flex:1 1 auto;min-width:0;}',
      '.sx-body h3{font-family:var(--display,sans-serif);font-weight:400;font-size:18.5px;',
      'letter-spacing:0.02em;color:var(--ink,#141414);margin-bottom:6px;}',
      '.sx-body p{font-size:15.5px;line-height:1.65;color:var(--ink,#141414);}',
      '.sx-note{margin-top:9px;font-size:13.5px;line-height:1.6;color:var(--muted,#6b6b6b);}',
      '.sx-wa{display:inline-block;margin-top:9px;font-size:14.5px;color:var(--ink,#141414);',
      'border-bottom:1px solid var(--accent,#b7a389);text-decoration:none;padding-bottom:2px;}',
      /* Two copies of the same CTA. The TOP one sits between the head and the steps,
         so it is on screen the moment the sheet opens — no scrolling past the
         explanation to reach it. The BOTTOM one catches the reader who scrolled the
         whole briefing; margin-top:auto parks it at the foot of the sheet when the
         content is shorter than the viewport instead of leaving it floating. */
      '.sx-cta{padding-bottom:4px;}',
      '.sx-cta--bottom{margin-top:auto;padding-top:6px;padding-bottom:0;}',
      '.sx-go{display:block;width:100%;box-sizing:border-box;text-align:center;',
      'background:var(--sage,#141414);color:#fff;text-decoration:none;padding:17px 26px;',
      'border-radius:var(--radius,0);font-size:18px;letter-spacing:0.03em;}',
      '.sx-go:hover{background:var(--sage-deep,#000);}',
      /* Desktop: the CTA shrinks to its own width and aligns with the text it now
         follows (start edge — right in RTL), rather than being centred like the
         footer button it used to be. */
      '@media (min-width:700px){.sx-inner{padding-top:78px;gap:30px;}',
      '.sx-head h2{font-size:31px;}.sx-go{width:auto;display:inline-block;min-width:290px;}}',
      /* Motion is opt-in. The slide-up runs on .sx-inner, never on the fixed
         .sx-overlay: an animated transform on the overlay would move the sheet's own
         box for the first ~200ms (and make it a containing block for its
         descendants), so the full-bleed geometry is kept animation-free. */
      '@media (prefers-reduced-motion: no-preference){',
      '.sx-overlay.is-open{animation:sx-fade .18s var(--ease,ease) both;}',
      '.sx-overlay.is-open .sx-inner{animation:sx-rise .24s var(--ease,ease) both;}',
      '@keyframes sx-fade{from{opacity:0;}to{opacity:1;}}',
      '@keyframes sx-rise{from{transform:translateY(9px);}to{transform:none;}}}',
      /* Background scroll lock while the sheet is open. */
      'html.sx-locked,body.sx-locked{overflow:hidden;}',
    ].join('');
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    doc.head.appendChild(style);
  }

  // ---- runtime --------------------------------------------------------------

  function start() {
    injectStyles(document);

    var overlay = null;
    var goBtns = []; // every [data-sx-continue] — the top and bottom copies
    var lastTrigger = null;

    // ONE continue handler, shared by both buttons, so their behaviour cannot drift.
    // Fires the event exactly once per continue (only the clicked button runs this),
    // tagged with which copy was used — one event name, one extra field, rather than
    // two events to reconcile later.
    function onContinue(e) {
      var place = (e.currentTarget && e.currentTarget.getAttribute('data-sx-place')) || 'unknown';
      track(EV_CONTINUE, {
        cta: (lastTrigger && lastTrigger.dataset.gaCta) || 'unknown',
        place: place,
      });
      // Let the anchor navigate normally; no preventDefault. The overlay is torn
      // down first so a bfcache back-navigation doesn't restore it wide open.
      close({ keepFocus: true });
    }

    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = buildOverlay(document);
      document.body.appendChild(overlay);
      goBtns = Array.prototype.slice.call(overlay.querySelectorAll('[data-sx-continue]'));

      overlay.querySelector('.sx-x').addEventListener('click', function () {
        close();
      });
      // A click on the sheet's margin (outside .sx-inner) closes too.
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close();
      });
      goBtns.forEach(function (btn) {
        btn.addEventListener('click', onContinue);
      });
      // Keyboard handling sits on the DOCUMENT, not the overlay: after a backdrop
      // click focus can land on <body>, and a listener bound to the overlay would
      // never see the Escape. Guarded by is-open so it is inert when closed.
      document.addEventListener('keydown', onKeydown);

      // The markup was injected AFTER editor.js's initial scan — hand it over so the
      // owner's saved copy is overlaid for every visitor and bound in edit mode.
      if (window.dugriEditor && typeof window.dugriEditor.notifyInjected === 'function') {
        window.dugriEditor.notifyInjected();
      }
      return overlay;
    }

    function onKeydown(e) {
      if (!overlay || !overlay.classList.contains('is-open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: the sheet covers the whole viewport, so Tab must never reach
      // the page behind it.
      var items = focusablesIn(overlay);
      if (!items.length) return;
      var current = items.indexOf(document.activeElement);
      var next = nextFocusIndex(items.length, current, e.shiftKey);
      if (next < 0) return;
      e.preventDefault();
      items[next].focus();
    }

    function open(trigger) {
      ensureOverlay();
      lastTrigger = trigger;
      // Live read: product.js may have rewritten the trigger's href (design + step).
      // Stamped on EVERY copy, so top and bottom always go to the same place.
      var href = resolveContinueHref(trigger);
      goBtns.forEach(function (btn) {
        btn.setAttribute('href', href);
      });
      overlay.classList.add('is-open');
      document.documentElement.classList.add('sx-locked');
      document.body.classList.add('sx-locked');
      overlay.scrollTop = 0;
      // Focus the X: it is first in the tab order and announces the dialog without
      // reading the whole sheet before the user asks for it.
      var x = overlay.querySelector('.sx-x');
      if (x) x.focus();
      track(EV_OPEN, { cta: (trigger && trigger.dataset.gaCta) || 'unknown' });
    }

    function close(opts) {
      if (!overlay || !overlay.classList.contains('is-open')) return;
      overlay.classList.remove('is-open');
      document.documentElement.classList.remove('sx-locked');
      document.body.classList.remove('sx-locked');
      // Focus returns to the trigger the shopper came from — except when we are
      // closing because they hit continue and the page is already navigating.
      if (!(opts && opts.keepFocus) && lastTrigger && typeof lastTrigger.focus === 'function') {
        lastTrigger.focus();
      }
    }

    // One delegated listener covers triggers that exist now AND ones injected later
    // (products.html renders its fallback CTA from JS).
    document.addEventListener('click', function (e) {
      var trigger = e.target.closest && e.target.closest('a[data-start-explainer]');
      if (!trigger) return;
      if (!isPlainClick(e)) return; // ⌘/ctrl/middle click → let the browser have it
      e.preventDefault(); // NOT stopPropagation: analytics.js still logs order_started
      open(trigger);
    });

    return { open: open, close: close };
  }

  var api = {
    isPlainClick: isPlainClick,
    resolveContinueHref: resolveContinueHref,
    focusablesIn: focusablesIn,
    nextFocusIndex: nextFocusIndex,
    buildOverlay: buildOverlay,
    injectStyles: injectStyles,
    start: start,
    STEPS: STEPS,
  };
  if (typeof window !== 'undefined') window.__dugriStartExplainer = api;

  // Only bootstrap when loaded as a real <script> — an ESM import in a unit test
  // leaves document.currentScript null and gets the pure helpers, nothing else.
  if (typeof document !== 'undefined' && document.currentScript) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }
})();
