// The redesign's shell for the pages not built in it yet (docs/redesign-mode.md is the guide; css/redesign.css has the look).
// Loaded with defer, only in redesign mode: the server's gate (server/redesign-gate.js) adds it, with class="rd" on <html>, when
// the setting redesign.enabled is on or the visitor previews with ?rd=1. ES5, so the owner's old Safari runs it.
// A page's HTML is never edited for the mode: a page tells the shell what it wants from its own /css/rd/<page>.css, through
// custom properties on html.rd (read here once, at start):
//   --rd-header: replace | top | none        the shared header in place of the page's own (default: replace, when there is one)
//   --rd-header-replace: '<selector>'        which element is the page's own header (default 'header.hdr')
//   --rd-footer: replace | end | none        the shared footer (default none: a page's own footer holds the owner's contacts)
//   --rd-footer-replace: '<selector>'        which element is the page's own footer (default 'body > footer')
//   --rd-as-<component>: '<selectors>'       the page's own elements that take a shared component's look, e.g.
//                                            --rd-as-btn: '.cta, .next'; the shell adds the class, now and as the page adds more
// What it does, once per page:
//   1. a page already built in the redesign (new.html, new-faq.html, served at / in the mode too) is marked html.rd-native and
//      left alone
//   2. <dialog> and replaceChildren for Safari before 15.4 / 14 (the same fallbacks as js/home-legacy.js)
//   3. the shared header (logo, ≡ and the order button, with the menu sheet) and footer; a page's own stays in the DOM, hidden,
//      so its ids, scripts (header.js) and tests keep working
//   4. the component classes from --rd-as-*
//   5. window.dugriRd.toast(text)
(function () {
  var doc = document;
  var root = doc.documentElement;
  if (window.__dugriRdShell || !/(^|\s)rd(\s|$)/.test(root.className)) return;
  window.__dugriRdShell = true;

  var NATIVE = ['new.html', 'new-faq.html'];
  var meta = doc.querySelector('meta[name="dugri:page"]');
  if (meta && NATIVE.indexOf(meta.getAttribute('content')) > -1) {
    root.className += ' rd-native';
    return;
  }

  // ---------- 2. old Safari ----------
  var Dlg = window.HTMLDialogElement;
  if (!Dlg || typeof Dlg.prototype.showModal !== 'function') {
    root.className += ' no-dialog';
    var proto = (Dlg || window.HTMLUnknownElement || window.HTMLElement).prototype;
    var fire = function (el, type, cancelable) {
      var ev = doc.createEvent('Event');
      ev.initEvent(type, false, !!cancelable);
      return el.dispatchEvent(ev);
    };
    var modals = [];
    var openDlg = function (el, modal) {
      if (el.hasAttribute('open')) return;
      el.setAttribute('open', '');
      if (!modal) return;
      var bd = doc.createElement('div');
      bd.className = 'dlg-bd';
      bd.addEventListener('click', function () {
        if (fire(el, 'cancel', true)) el.close();
      });
      el.parentNode.insertBefore(bd, el);
      el._bd = bd;
      el._back = doc.activeElement;
      modals.push(el);
      var first = el.querySelector('[autofocus], button, a[href], input, select, textarea');
      if (first) first.focus();
    };
    Object.defineProperty(proto, 'open', {
      configurable: true,
      get: function () {
        return this.hasAttribute('open');
      },
      set: function (v) {
        if (v) this.setAttribute('open', '');
        else this.removeAttribute('open');
      },
    });
    proto.show = function () {
      openDlg(this, false);
    };
    proto.showModal = function () {
      openDlg(this, true);
    };
    proto.close = function (value) {
      if (!this.hasAttribute('open')) return;
      if (value !== undefined) this.returnValue = value;
      this.removeAttribute('open');
      if (this._bd) {
        this._bd.parentNode.removeChild(this._bd);
        this._bd = null;
      }
      var i = modals.indexOf(this);
      if (i > -1) modals.splice(i, 1);
      if (this._back && this._back.focus) this._back.focus();
      this._back = null;
      fire(this, 'close', false);
    };
    doc.addEventListener('keydown', function (e) {
      var top = modals[modals.length - 1];
      if (!top || (e.key !== 'Escape' && e.key !== 'Esc')) return;
      e.preventDefault();
      if (fire(top, 'cancel', true)) top.close();
    });
  }
  var withReplace = [window.Element, window.Document, window.DocumentFragment];
  for (var r = 0; r < withReplace.length; r++) {
    var P = withReplace[r] && withReplace[r].prototype;
    if (!P || P.replaceChildren) continue;
    P.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      for (var j = 0; j < arguments.length; j++) {
        var n = arguments[j];
        this.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
      }
    };
  }

  // ---------- 3, 4. header and footer ----------
  // In the mode / is the redesigned homepage (new.html): its sections are the designs (#order), the story, the reviews, business
  var LINKS = [
    // [href, label, the nav_click target GA reports it under (the same names as the homepage's own menu)]
    ['/#order', 'העיצובים', 'designs'],
    ['/#recs', 'ממליצים עלינו', 'recs'],
    ['new-faq.html', 'שאלות נפוצות', 'faq'],
    ['pickup.html', 'איסוף עצמי', 'pickup'],
    ['/#biz', 'פניות עסקיות', 'biz'],
  ];
  var here = (location.pathname.split('/').pop() || '').toLowerCase();
  var ICON =
    '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
    '<path class="l1" d="M24 8H4"/><path class="l2" d="M24 14H4"/><path class="l3" d="M24 20H4"/></svg>';
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  function headerHtml() {
    return (
      '<div class="rd-start">' +
      '<button class="rd-menu-btn" id="rdMenuBtn" type="button" aria-label="תפריט" aria-haspopup="dialog"' +
      ' aria-expanded="false" aria-controls="rdMenu" data-ga="menu_open">' +
      ICON +
      '</button>' +
      '<a class="rd-logo" href="/" data-ga="nav_click" data-ga-target="home" data-ga-where="header"><img src="/assets/logo-pink-original.png" alt="דוגרי, לעמוד הבית" /></a>' +
      '</div>' +
      '<a class="rd-btn" href="/#order" data-ga="nav_order">הזמינו עכשיו</a>'
    );
  }

  function menuHtml() {
    var items = '';
    for (var i = 0; i < LINKS.length; i++) {
      var cur = LINKS[i][0] === here ? ' aria-current="page"' : '';
      items +=
        '<li><a href="' +
        esc(LINKS[i][0]) +
        '" data-ga="nav_click" data-ga-target="' +
        LINKS[i][2] +
        '" data-ga-where="menu"' +
        cur +
        '>' +
        esc(LINKS[i][1]) +
        '</a></li>';
    }
    return (
      '<button class="rd-x" type="button" id="rdMenuX" aria-label="סגירת התפריט">✕</button>' +
      '<nav aria-label="ניווט"><ul>' +
      items +
      '</ul></nav>' +
      '<a class="rd-btn block" href="/#order" data-ga="nav_order" data-ga-where="menu">הזמינו עכשיו</a>'
    );
  }

  // ---- B (Catalog & Design): the site footer ----
  // new.html's own footer, the same markup on every page in the mode (tests/unit/site-footer.test.js keeps the two identical).
  // The labels are read-only here: no data-edit, so no inline-edit affordance; the owner's edits to new.html's footer are
  // saved in the index.html bucket (its data-edit-scope) and fillFooterText() copies them onto these labels.
  function footerHtml() {
    return (
      '<div class="ft-contact"> ' +
      '<div class="ft-icons"> ' +
      '<a class="ft-icon wa" href="https://wa.me/972552441334?text=%D7%94%D7%99%D7%99!%20%D7%90%D7%A0%D7%99%20%D7%A8%D7%95%D7%A6%D7%94%20%D7%9C%D7%94%D7%96%D7%9E%D7%99%D7%9F%20%D7%9E%D7%A9%D7%97%D7%A7%20%D7%93%D7%95%D7%92%D7%A8%D7%99" target="_blank" rel="noopener" aria-label="וואטסאפ" data-ga="contact_click" data-ga-channel="whatsapp" data-ga-where="footer" ><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"> ' +
      '<path d="M19.05 4.91A9.82 9.82 0 0 0 12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.91-7.02ZM12.05 20.15h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.24-8.23a8.2 8.2 0 0 1 8.23 8.24c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.51.11-.11.25-.29.37-.43.13-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.42-.14-.01-.31-.01-.48-.01a.92.92 0 0 0-.66.31c-.23.25-.87.85-.87 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28Z" /></svg ></a> ' +
      '<a class="ft-icon" href="tel:+972552441334" aria-label="התקשרו" data-ga="contact_click" data-ga-channel="call" data-ga-where="footer" ><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"> ' +
      '<path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.24.2 2.45.57 3.57a1 1 0 0 1-.24 1.02l-2.21 2.2Z" /></svg ></a> ' +
      '<a class="ft-icon" href="https://instagram.com/dugri_israel" target="_blank" rel="noopener" aria-label="אינסטגרם @dugri_israel" data-ga="contact_click" data-ga-channel="instagram" data-ga-where="footer" ><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"> ' +
      '<path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.72 3.72 0 0 1-1.38-.9 3.72 3.72 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 1.62c-3.15 0-3.52.01-4.76.07-1.15.05-1.77.24-2.19.41-.55.21-.94.47-1.35.88-.41.41-.67.8-.88 1.35-.16.42-.36 1.04-.41 2.19-.06 1.24-.07 1.61-.07 4.76s.01 3.52.07 4.76c.05 1.15.24 1.77.41 2.19.21.55.47.94.88 1.35.41.41.8.67 1.35.88.42.16 1.04.36 2.19.41 1.24.06 1.61.07 4.76.07s3.52-.01 4.76-.07c1.15-.05 1.77-.24 2.19-.41.55-.21.94-.47 1.35-.88.41-.41.67-.8.88-1.35.16-.42.36-1.04.41-2.19.06-1.24.07-1.61.07-4.76s-.01-3.52-.07-4.76c-.05-1.15-.24-1.77-.41-2.19a3.63 3.63 0 0 0-.88-1.35 3.63 3.63 0 0 0-1.35-.88c-.42-.16-1.04-.36-2.19-.41-1.24-.06-1.61-.07-4.76-.07Zm0 4.18a5.04 5.04 0 1 0 0 10.08 5.04 5.04 0 0 0 0-10.08Zm0 8.31a3.27 3.27 0 1 1 0-6.54 3.27 3.27 0 0 1 0 6.54Zm6.41-8.51a1.18 1.18 0 1 1-2.36 0 1.18 1.18 0 0 1 2.36 0Z" /></svg ></a> </div> ' +
      '<p class="ft-tag" data-rd-key="index-footer-tag">צילמתם? תייגו אותנו</p> ' +
      '<p class="ft-lines"> <span >' +
      '<span class="lb" data-rd-key="index-footer-wa-label">וואטסאפ / טלפון:</span> ' +
      '<a href="tel:+972552441334" dir="ltr" data-ga="contact_click" data-ga-channel="call" data-ga-where="footer" >0552441334</a ></span > <span >' +
      '<span class="lb" data-rd-key="index-footer-mail-label">מייל:</span> ' +
      '<a href="mailto:dugri.israel@gmail.com" data-ga="contact_click" data-ga-channel="email" data-ga-where="footer" >dugri.israel@gmail.com</a ></span > </p> </div> ' +
      '<nav class="ft-links" aria-label="קישורים"> ' +
      '<a href="new-faq.html" data-ga="nav_click" data-ga-target="faq" data-ga-where="footer" data-testid="footer-faq" >שאלות נפוצות</a > ' +
      '<a href="pickup.html" data-ga="nav_click" data-ga-target="pickup" data-ga-where="footer" data-testid="footer-pickup" >איסוף עצמי</a > ' +
      '<a href="wordlists.html" data-ga="nav_click" data-ga-target="wordlists" data-ga-where="footer" data-testid="footer-wordlists" >רשימות המילים</a > ' +
      '<a href="timer.html" data-ga="nav_click" data-ga-target="timer" data-ga-where="footer" data-testid="footer-timer" >טיימר למשחק</a > ' +
      '<a href="terms.html" data-ga="nav_click" data-ga-target="terms" data-ga-where="footer" data-testid="footer-terms" >תקנון ותנאי שימוש</a > ' +
      '</nav> ' +
      '<img class="ft-logo" src="/assets/logo-pink-original.png" alt="" />'
    );
  }
  // the owner's footer edits: GET /api/content?page=index.html, the index-footer-* texts onto [data-rd-key] (fail-soft: the
  // shipped words stay on any error)
  function fillFooterText(ftr) {
    var xhr = new window.XMLHttpRequest();
    xhr.open('GET', '/api/content?page=index.html');
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      var ov;
      try {
        ov = JSON.parse(xhr.responseText).overrides || {};
        // eslint-disable-next-line no-unused-vars -- ES5 has no catch without a binding
      } catch (e) {
        return;
      }
      var els = ftr.querySelectorAll('[data-rd-key]');
      for (var i = 0; i < els.length; i++) {
        var o = ov[els[i].getAttribute('data-rd-key')];
        if (o && typeof o.text === 'string') els[i].textContent = o.text;
      }
    };
    xhr.send();
  }
  // ---- end B ----

  // focus stays inside the open menu and visits every link and button (Safari's own Tab skips links by default)
  function trapTab(dlg) {
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var all = dlg.querySelectorAll('a[href], button:not([disabled])');
      var f = [];
      for (var i = 0; i < all.length; i++) if (all[i].offsetParent !== null) f.push(all[i]);
      if (!f.length) return;
      e.preventDefault();
      var k = f.indexOf(doc.activeElement);
      f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    });
  }

  function mountMenu(btn) {
    var menu = doc.createElement('dialog');
    menu.className = 'rd-menu';
    menu.id = 'rdMenu';
    menu.setAttribute('aria-label', 'תפריט');
    menu.innerHTML = menuHtml();
    doc.body.appendChild(menu);
    btn.addEventListener('click', function () {
      menu.showModal();
      btn.setAttribute('aria-expanded', 'true');
    });
    menu.addEventListener('close', function () {
      btn.setAttribute('aria-expanded', 'false');
    });
    menu.querySelector('#rdMenuX').addEventListener('click', function () {
      menu.close();
    });
    menu.addEventListener('click', function (e) {
      if (e.target === menu) menu.close(); // the dimmed page around the sheet
    });
    var links = menu.querySelectorAll('a');
    for (var i = 0; i < links.length; i++)
      links[i].addEventListener('click', function () {
        menu.close();
      });
    trapTab(menu);
  }

  // a page's settings: a custom property's value, without the quotes a string needs in CSS
  var cs = window.getComputedStyle(root);
  var conf = function (name, dflt) {
    var v = (cs.getPropertyValue(name) || '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    return v || dflt;
  };
  var pick = function (sel) {
    try {
      return doc.querySelector(sel);
      // eslint-disable-next-line no-unused-vars -- ES5 has no catch without a binding
    } catch (e) {
      return null; // a selector this browser cannot read
    }
  };

  var body = doc.body;
  var hMode = conf('--rd-header', 'replace');
  if (hMode !== 'none') {
    var old = pick(conf('--rd-header-replace', 'header.hdr'));
    if (hMode === 'top' || old) {
      var hdr = doc.createElement('header');
      hdr.className = 'rd-hdr';
      hdr.innerHTML = headerHtml();
      if (hMode === 'replace' && old) {
        old.parentNode.insertBefore(hdr, old);
        old.setAttribute('data-rd-replaced', '');
        root.className += ' rd-hdr-swapped';
      } else body.insertBefore(hdr, body.firstChild);
      mountMenu(hdr.querySelector('#rdMenuBtn'));
    }
  }
  var fMode = conf('--rd-footer', 'none');
  if (fMode !== 'none') {
    var oldF = pick(conf('--rd-footer-replace', 'body > footer'));
    if (fMode === 'end' || oldF) {
      var ftr = doc.createElement('footer');
      ftr.className = 'rd-ftr';
      ftr.innerHTML = footerHtml();
      fillFooterText(ftr);
      if (fMode === 'replace' && oldF) {
        oldF.parentNode.insertBefore(ftr, oldF);
        oldF.setAttribute('data-rd-replaced', '');
      } else body.appendChild(ftr);
    }
  }

  // ---------- 4. the page's own elements in a shared component's look ----------
  var AS = {
    btn: 'rd-btn',
    'btn-secondary': 'rd-btn secondary',
    'btn-ghost': 'rd-btn ghost',
    'btn-arrow': 'rd-btn arrow',
    field: 'rd-field',
    select: 'rd-select',
    check: 'rd-check',
    card: 'rd-card',
    'card-hot': 'rd-card hot',
    box: 'rd-box',
    tag: 'rd-tag',
    chip: 'rd-chip',
    title: 'rd-title',
    x: 'rd-x',
    price: 'rd-price',
    steps: 'rd-steps',
    sheet: 'rd-sheet',
  };
  var maps = [];
  for (var key in AS) {
    if (!Object.prototype.hasOwnProperty.call(AS, key)) continue;
    var sel = conf('--rd-as-' + key, '');
    if (sel) maps.push([sel, AS[key].split(' ')]);
  }
  var applyAs = function (scope) {
    for (var m = 0; m < maps.length; m++) {
      var els;
      try {
        els = scope.querySelectorAll(maps[m][0]);
        // eslint-disable-next-line no-unused-vars -- ES5 has no catch without a binding
      } catch (e) {
        continue;
      }
      for (var k = 0; k < els.length; k++)
        for (var c = 0; c < maps[m][1].length; c++) els[k].classList.add(maps[m][1][c]);
    }
  };
  if (maps.length) {
    applyAs(doc);
    // the wizard and the word lists draw more as you go: give what they add the same look
    var queued = false;
    if (window.MutationObserver)
      new MutationObserver(function () {
        if (queued) return; // one pass per frame, however many nodes arrived
        queued = true;
        window.requestAnimationFrame(function () {
          queued = false;
          applyAs(doc);
        });
      }).observe(body, { childList: true, subtree: true });
  }

  // ---------- 5. the page's API ----------
  var toastEl = null;
  var toastTimer = 0;
  window.dugriRd = {
    toast: function (text, ms) {
      if (!toastEl) {
        toastEl = doc.createElement('div');
        toastEl.className = 'rd-toast';
        toastEl.setAttribute('role', 'status');
        body.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.className = 'rd-toast';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.className = 'rd-toast out';
      }, ms || 3200);
    },
  };
})();
