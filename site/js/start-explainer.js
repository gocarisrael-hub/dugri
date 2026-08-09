/* start-explainer.js — the full-page "4 steps" explainer that precedes the order
   wizard.

   WHY: shoppers used to land in options.html cold and meet a 4-step wizard with no
   idea what was coming (upload photos? collect words? how long does this take?).
   This overlay is the 30-second briefing that runs BEFORE the wizard: what the four
   stages are, what we need from them at each one, and one button that continues
   into exactly the wizard URL the trigger already pointed at.

   IT IS ONE PAGE, AND THE BUTTON IS AT THE FOOT OF IT (owner's call). Two separate
   promises, and only one of them is absolute:

     • THE BUTTON IS ALWAYS ON SCREEN. `.sx-cta` is `position:sticky;bottom:0`, so
       when the briefing does fit it simply sits at the foot, and when it does not it
       pins to the bottom edge instead of dropping below the fold. This is what makes
       a single bottom CTA safe; without it, a landscape phone or a 200%-text reader
       opens the sheet with no visible way forward — which is exactly why a second
       copy used to sit above the steps.
     • ONE PAGE, on the screens it can be. The type scales with `dvh` so the whole
       briefing lands inside a single viewport on a modern phone held upright
       (390x844 and taller) and on any desktop. It does NOT fit a 320x568 phone, a
       landscape phone, or a short window: this much Hebrew copy cannot be set at a
       readable size in 400px of height, so those readers get a short scroll with the
       button still pinned. Shortening the step copy is what would buy the last few
       screens — every string is owner-editable, and the type grows back on its own.

   The scale has a counter-intuitive trap worth knowing before touching it: because
   the text column stays ~350px wide on a phone, a larger face re-wraps every
   paragraph, so content height grows FASTER than the viewport it is fitting into.
   Turning the dvh multipliers up therefore breaks the TALL phones first, not the
   short ones (measured: ~87px of sheet per 1px of body size at 390px wide, against
   ~58px of screen per 100px of viewport). tests/e2e/start-explainer.spec.js sweeps
   real device viewports for this; do not tune it against one screen size.

   IT NEVER BLOCKS THE PURCHASE. It intercepts the click, shows the explainer, and
   the continue button carries the trigger's OWN href forward — including
   product.js's `options.html?design=<id>&step=2`, so design preselection survives.
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

  // THE continue CTA — one button, once, at the foot of the sheet. It used to be
  // rendered twice (above the steps and after them) because the briefing scrolled and
  // a reader who reached the end had nothing in view; now the briefing fits one
  // screen, so a second copy would just be the same button twice on one page.
  //
  // `data-sx-continue` stays the hook the runtime binds and open() stamps the live
  // href onto, so the button's wiring is unchanged and independent of where it sits.
  function buildCta() {
    var wrap = el('div', 'sx-cta');
    var go = el('a', 'sx-go', {
      href: 'options.html',
      'data-edit': 'start-explainer-continue',
      'data-sx-continue': '',
      'data-testid': 'start-explainer-continue',
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

    // The continue CTA, after step 4 — the last thing on the page, which is where the
    // reader's eye already is once the briefing is read. `margin-top:auto` parks it
    // against the foot of the sheet when the steps come up short of the viewport,
    // rather than leaving it floating under the last step.
    inner.appendChild(buildCta());

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
      /* Full VIEWPORT sheet, not a small centered modal, and ONE PAGE of it: the
         briefing is sized to land inside a single screen so nothing has to scroll to
         reach the button. 100dvh (not 100vh) is what makes that true on mobile, where
         the URL bar eats the difference. overflow-y:auto stays as a safety valve for
         the cases the scale cannot absorb — enlarged text, a landscape phone — so the
         CTA is never unreachable even when the one-page fit gives out. */
      '.sx-overlay{position:fixed;inset:0;z-index:9000;display:none;',
      'background:var(--bg,#fff);overflow-y:auto;-webkit-overflow-scrolling:touch;',
      'padding:0;}',
      '.sx-overlay.is-open{display:block;}',
      /* EVERY clamp() below is preceded by the plain fixed value it replaces. A
         browser without `dvh` (iOS <15.4, Chrome <108, older Android WebViews) drops
         the whole declaration as invalid at parse time, and without the pair in front
         of it this sheet would render with NO padding at all — Hebrew flush to both
         edges, the title under the close button. Same belt-and-braces the
         `min-height:100vh;min-height:100dvh` pair on the next line already uses. */
      '.sx-inner{position:relative;box-sizing:border-box;min-height:100vh;min-height:100dvh;',
      'max-width:640px;margin:0 auto;',
      /* The top padding is the X's keep-out: it must always exceed the X's own
         top + height, or the title rides up underneath it. The X caps at 14+42=56,
         so 58px is the floor here and in the desktop override below — the number is
         a CONSEQUENCE of the X's box, not a taste, so the two move together. */
      'padding:58px 22px calc(34px + env(safe-area-inset-bottom,0px));',
      'padding:clamp(58px,7dvh,64px) 22px calc(clamp(14px,2.6dvh,34px) + env(safe-area-inset-bottom,0px));',
      'display:flex;flex-direction:column;gap:18px;gap:clamp(9px,2dvh,26px);text-align:right;}',
      /* X — top-LEFT in RTL (the far corner from the text). */
      '.sx-x{position:absolute;top:14px;left:14px;width:42px;height:42px;font-size:27px;',
      'top:clamp(8px,1.4dvh,14px);left:clamp(8px,1.4dvh,14px);',
      'width:clamp(34px,5dvh,42px);height:clamp(34px,5dvh,42px);line-height:1;',
      'font-size:clamp(22px,3.4dvh,27px);background:transparent;border:1px solid var(--line,#e6e6e6);',
      'border-radius:var(--radius,0);color:var(--ink,#141414);cursor:pointer;padding:0;}',
      '.sx-x:hover{background:var(--sage-tint,#f0f0f0);}',
      '.sx-head h2{font-family:var(--display,sans-serif);font-weight:var(--h-weight,300);',
      'letter-spacing:var(--h-spacing,0.1em);font-size:25px;font-size:clamp(18px,3.1dvh,25px);',
      'line-height:1.28;color:var(--ink,#141414);}',
      '.sx-sub{margin-top:9px;margin-top:clamp(3px,0.9dvh,9px);color:var(--muted,#6b6b6b);',
      'font-size:15.5px;font-size:clamp(12.5px,1.9dvh,15.5px);line-height:1.5;',
      'font-weight:var(--sub-weight,200);}',
      '.sx-steps{list-style:none;display:grid;gap:16px;gap:clamp(9px,1.75dvh,22px);margin:0;padding:0;}',
      '.sx-step{display:flex;align-items:flex-start;gap:15px;gap:clamp(11px,1.6dvh,15px);',
      'border-top:1px solid var(--line,#e6e6e6);padding-top:16px;',
      'padding-top:clamp(8px,1.55dvh,20px);}',
      '.sx-step:first-child{border-top:0;padding-top:0;}',
      /* The numeral is the one splash of warm sand. */
      '.sx-num{flex:0 0 auto;font-family:var(--display,sans-serif);',
      'font-size:31px;min-width:31px;font-size:clamp(20px,3.6dvh,31px);',
      'min-width:clamp(20px,3.6dvh,31px);line-height:1;',
      'font-weight:300;color:var(--accent,#b7a389);}',
      '.sx-body{flex:1 1 auto;min-width:0;}',
      '.sx-body h3{font-family:var(--display,sans-serif);font-weight:400;',
      'font-size:18.5px;font-size:clamp(14.5px,2.2dvh,18.5px);',
      'letter-spacing:0.02em;color:var(--ink,#141414);',
      'margin-bottom:5px;margin-bottom:clamp(2px,0.6dvh,6px);}',
      /* The body scale is what decides whether the briefing is one page, and it is
         NOT free to grow with the screen: the column stays ~350px wide on a phone, so
         a bigger face re-wraps every paragraph and the content grows FASTER than the
         viewport it is trying to fit into. Measured at 390px wide, each extra 1px of
         body size costs ~87px of sheet height while the screen only gains ~58px per
         100px of height. Hence the modest 15.5px ceiling and the 1.55dvh slope —
         above that the sheet outgrew exactly the tall phones it was meant to fit. */
      '.sx-body p{font-size:15.5px;font-size:clamp(13px,1.55dvh,15.5px);',
      'line-height:1.5;color:var(--ink,#141414);}',
      /* `.sx-body p.sx-note`, not `.sx-note`: the note IS one of those paragraphs, so
         the plain class (0,1,0) loses to `.sx-body p` (0,1,1) no matter what order
         they are written in — which is why the aside had been rendering at full body
         size in full ink, never small and muted the way it reads here. */
      '.sx-body p.sx-note{margin-top:9px;margin-top:clamp(3px,0.9dvh,9px);',
      'font-size:13.5px;font-size:clamp(11px,1.35dvh,13.5px);',
      'line-height:1.45;color:var(--muted,#6b6b6b);}',
      '.sx-wa{display:inline-block;margin-top:9px;margin-top:clamp(4px,0.9dvh,9px);',
      'font-size:14.5px;font-size:clamp(12px,1.7dvh,14.5px);color:var(--ink,#141414);',
      'border-bottom:1px solid var(--accent,#b7a389);text-decoration:none;padding-bottom:2px;}',
      /* ONE CTA, at the foot, and ALWAYS on screen. Two rules do that job:
         `margin-top:auto` parks it against the bottom padding when the briefing comes
         up short of the viewport, and `position:sticky;bottom:0` keeps it pinned to
         the bottom edge when it does NOT — a landscape phone, a short window, a
         reader at 200% text. Without the sticky, the single bottom button is simply
         below the fold on those screens and the sheet opens with no visible way
         forward, which is the whole reason a second copy used to sit above the steps.
         The background is opaque because the steps scroll underneath it. */
      '.sx-cta{margin-top:auto;position:sticky;bottom:0;background:var(--bg,#fff);',
      'padding-top:8px;padding-top:clamp(6px,1dvh,10px);}',
      '.sx-go{display:block;width:100%;box-sizing:border-box;text-align:center;',
      'background:var(--sage,#141414);color:#fff;text-decoration:none;',
      'padding:17px 26px;padding:clamp(12px,2dvh,17px) 26px;',
      'border-radius:var(--radius,0);font-size:18px;font-size:clamp(15px,2.2dvh,18px);',
      'letter-spacing:0.03em;}',
      '.sx-go:hover{background:var(--sage-deep,#000);}',
      /* Desktop: the sheet has room, so the CTA shrinks to its own width and aligns
         with the start edge (right in RTL) instead of spanning the column. The
         padding-top floor stays 58px for the same X keep-out reason as above — it was
         40px, which is BELOW the close button's 42px bottom edge, so a short desktop
         window put the title underneath the X. */
      '@media (min-width:700px){.sx-inner{padding-top:78px;',
      'padding-top:clamp(58px,8dvh,78px);}',
      '.sx-go{width:auto;display:inline-block;min-width:290px;}',
      /* The column is 640px wide here, not ~350: the same paragraph takes barely half
         the lines, so the size that makes a phone overflow is comfortable on a laptop.
         The body scale is raised back toward its original 15.5px accordingly — the
         narrow-screen ceiling exists for the narrow screen, not for this one. */
      '.sx-body p{font-size:15.5px;font-size:clamp(14px,1.9dvh,15.5px);}',
      '.sx-body p.sx-note{font-size:13.5px;font-size:clamp(12px,1.6dvh,13.5px);}}',
      /* The full 31px title needs a screen with the height to carry it; below that it
         stays on the fluid scale rather than crowding the steps. */
      '@media (min-width:700px) and (min-height:760px){.sx-head h2{font-size:31px;}',
      '.sx-inner{gap:30px;gap:clamp(20px,2.6dvh,30px);}}',
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
    var goBtn = null; // the one [data-sx-continue]
    var lastTrigger = null;

    function onContinue() {
      // `place` is kept, pinned to 'bottom'. The sheet has one CTA now, so the field
      // no longer distinguishes anything — but order_explainer_continue has been
      // reporting it since the two-copy version, and dropping a dimension mid-stream
      // silently splits the existing GA4 funnel report in two. It stays until the
      // owner retires the breakdown on her side.
      track(EV_CONTINUE, {
        cta: (lastTrigger && lastTrigger.dataset.gaCta) || 'unknown',
        place: 'bottom',
      });
      // Let the anchor navigate normally; no preventDefault. The overlay is torn
      // down first so a bfcache back-navigation doesn't restore it wide open.
      close({ keepFocus: true });
    }

    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = buildOverlay(document);
      document.body.appendChild(overlay);
      goBtn = overlay.querySelector('[data-sx-continue]');

      overlay.querySelector('.sx-x').addEventListener('click', function () {
        close();
      });
      // A click on the sheet's margin (outside .sx-inner) closes too.
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close();
      });
      goBtn.addEventListener('click', onContinue);
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
      // Live read: product.js may have rewritten the trigger's href (design + step),
      // so the button is re-stamped on every open with the URL THIS trigger asks for.
      goBtn.setAttribute('href', resolveContinueHref(trigger));
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
