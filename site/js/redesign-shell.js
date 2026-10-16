// The redesign's shell for the pages not built in it yet (css/redesign.css has the why). Loaded with defer, only in redesign mode:
// the server adds it, with class="rd" on <html>, when the setting redesign.enabled is on or the visitor previews with ?rd=1.
// ES5, so the owner's old Safari runs it. What it does, once per page:
//   1. a page already built in the redesign (new.html, new-faq.html, served at / in the mode too) is marked html.rd-native and
//      left alone
//   2. <dialog> and replaceChildren for Safari before 15.4 / 14 (the same fallbacks as js/home-legacy.js, for pages without it)
//   3. the shared header: logo, ≡ and the order button, with the menu sheet. It stands in for the page's own header.hdr, or fills
//      an element marked data-rd-header; the page's header stays in the DOM, hidden, so its ids and scripts keep working
//   4. the shared footer: into data-rd-footer, or in place of the page's own <footer> when the header was replaced
//   5. window.dugriRd.toast(text)
// A page opts out of 3 and 4 with data-rd-no-header / data-rd-no-footer on <body> (the wizard keeps its own bar, for example).
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
    ['/#order', 'העיצובים'],
    ['how.html', 'איך זה עובד'],
    ['/#recs', 'ממליצים עלינו'],
    ['new-faq.html', 'שאלות נפוצות'],
    ['pickup.html', 'איסוף עצמי'],
    ['/#biz', 'פניות עסקיות'],
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
      ' aria-expanded="false" aria-controls="rdMenu">' +
      ICON +
      '</button>' +
      '<a class="rd-logo" href="/"><img src="/assets/logo-pink-original.png" alt="דוגרי, לעמוד הבית" /></a>' +
      '</div>' +
      '<a class="rd-btn" href="/#order" data-ga="nav_order">הזמינו עכשיו</a>'
    );
  }

  function menuHtml() {
    var items = '';
    for (var i = 0; i < LINKS.length; i++) {
      var cur = LINKS[i][0] === here ? ' aria-current="page"' : '';
      items +=
        '<li><a href="' + esc(LINKS[i][0]) + '"' + cur + '>' + esc(LINKS[i][1]) + '</a></li>';
    }
    return (
      '<button class="rd-x" type="button" id="rdMenuX" aria-label="סגירת התפריט">✕</button>' +
      '<nav aria-label="ניווט"><ul>' +
      items +
      '</ul></nav>' +
      '<a class="rd-btn block" href="/#order">הזמינו עכשיו</a>'
    );
  }

  function footerHtml() {
    return (
      '<span><a href="terms.html">תקנון ותנאי שימוש</a><a href="new-faq.html">שאלות נפוצות</a>' +
      '<a href="pickup.html">איסוף עצמי</a></span>' +
      '<img src="/assets/logo-pink-original.png" alt="" />'
    );
  }

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

  var body = doc.body;
  var noHeader = body.hasAttribute('data-rd-no-header');
  var noFooter = body.hasAttribute('data-rd-no-footer');
  var replacedHeader = false;
  if (!noHeader) {
    var slot = doc.querySelector('[data-rd-header]');
    var old = slot ? null : doc.querySelector('header.hdr');
    if (slot || old) {
      var hdr = doc.createElement('header');
      hdr.className = 'rd-hdr';
      hdr.innerHTML = headerHtml();
      if (slot) slot.appendChild(hdr);
      else {
        old.parentNode.insertBefore(hdr, old);
        old.setAttribute('data-rd-replaced', '');
        root.className += ' rd-hdr-swapped';
        replacedHeader = true;
      }
      mountMenu(hdr.querySelector('#rdMenuBtn'));
    }
  }
  if (!noFooter) {
    var fslot = doc.querySelector('[data-rd-footer]');
    var oldF = fslot ? null : replacedHeader ? doc.querySelector('body > footer') : null;
    if (fslot || oldF) {
      var ftr = doc.createElement('footer');
      ftr.className = 'rd-ftr';
      ftr.innerHTML = footerHtml();
      if (fslot) fslot.appendChild(ftr);
      else {
        oldF.parentNode.insertBefore(ftr, oldF);
        oldF.setAttribute('data-rd-replaced', '');
      }
    }
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
