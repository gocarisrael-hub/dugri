// Old Safari on the redesigned pages (new.html, new-faq.html). A classic script, loaded first in <head>, in ES5 so it runs anywhere.
// The owner's Mac runs a Safari that shows no WebP (macOS 10.15 or older, so Safari 15.6 at most). What it fills in there:
//   1. a WebP picture that will not decode is swapped for its JPEG twin (PNG for the transparent logos), for the images in the
//      page and the ones home-new.js writes later; the twins sit beside the WebPs in assets/home/
//   2. <dialog> before Safari 15.4: open, show(), showModal(), close(), a 'close' event, Esc, and a backdrop that closes on a tap
//   3. Element.replaceChildren before Safari 14 (faq.js and home-new.js use it)
//   4. Element.animate before Safari 13.1: no animation, but onfinish still fires so a closing overlay still closes
// Anything this file adds is a no-op in a current browser: each part checks for the real feature first.
(function () {
  var doc = document;
  var root = doc.documentElement;

  // 1. WebP: error events do not bubble, so listen in the capture phase, from before the first <img> is parsed
  var WEBP = /^(.*\/assets\/home\/(cards|boards|logos)\/[^/?#]+?)(@2x)?\.webp(\?.*)?$/;
  doc.addEventListener(
    'error',
    function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      // an uploaded design's rendered picture (a WebP from /home-art/) goes back to its template picture
      var fb = img.getAttribute('data-fallback');
      if (fb && /\/home-art\//.test(img.currentSrc || img.src || '')) {
        img.removeAttribute('srcset');
        img.removeAttribute('data-fallback');
        img.src = fb;
        return;
      }
      // only a WebP is swapped, so a missing twin cannot loop; home-new.js may point the same <img> at another WebP later
      var m = WEBP.exec(img.currentSrc || img.src || '');
      if (!m) return;
      img.removeAttribute('srcset');
      // a card the screen wanted sharp keeps its sharp JPEG twin; boards and logos have 1x twins only
      img.src =
        m[1] + (m[3] && m[2] === 'cards' ? m[3] : '') + (m[2] === 'logos' ? '.png' : '.jpg');
    },
    true
  );

  // 2. <dialog>
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
    var open = function (el, modal) {
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
      open(this, false);
    };
    proto.showModal = function () {
      open(this, true);
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

  // 3. replaceChildren
  var withReplace = [window.Element, window.Document, window.DocumentFragment];
  for (var i = 0; i < withReplace.length; i++) {
    var P = withReplace[i] && withReplace[i].prototype;
    if (!P || P.replaceChildren) continue;
    P.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      for (var j = 0; j < arguments.length; j++) {
        var n = arguments[j];
        this.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
      }
    };
  }

  // 4. animate
  if (window.Element && !window.Element.prototype.animate) {
    window.Element.prototype.animate = function () {
      var a = {
        playState: 'finished',
        cancel: function () {},
        finish: function () {},
        play: function () {},
        pause: function () {},
      };
      a.finished = Promise.resolve(a);
      setTimeout(function () {
        if (typeof a.onfinish === 'function') a.onfinish();
      }, 0);
      return a;
    };
  }
})();
