/* editor.js — the inline content-editor engine, loaded on EVERY page.
   Two jobs:
   1. For ALL visitors: fetch this page's overrides and overlay them on the
      shipped HTML — tagged text nodes ([data-edit]), photos ([data-edit-img])
      and CSS-background heroes ([data-edit-bg]). Fails soft: any fetch error
      leaves the shipped defaults in place.
   2. For the owner ONLY (?edit=1 + the admin key): turn on an edit mode —
      editable text, click-to-replace photos, and a fixed RTL toolbar. No edit
      affordance is ever exposed without BOTH ?edit=1 AND a key (fail closed).

   Written as a classic script (no ESM export) so a plain
   `<script src="js/editor.js" defer>` can run it. The pure helpers are also hung
   on window.__dugriEditor for unit tests; the browser bootstrap only runs when
   the file is loaded as a real <script> (document.currentScript is set), never
   when a test imports it. */
(function () {
  'use strict';

  // Same admin key the gated admin pages read from ?key=; when the owner enters
  // edit mode we also remember it here so she doesn't paste it on every page.
  var LS_KEY = 'dugri_admin_key';
  var TEXT_CAP = 5000;

  // The page name is the html filename that the server actually serves for this
  // URL. The server maps extension-less routes to "<name>.html" (express.static
  // extensions:['html'] — e.g. "/how" -> how.html), so we must do the same or the
  // wrong page's overrides load. Rules: an explicit ".html" tail is taken as-is; a
  // bare "/" (empty last segment) is the homepage; an extension-less segment
  // becomes "<segment>.html"; any other real asset extension falls back to home.
  function derivePage(pathname) {
    var last = String(pathname || '')
      .split('/')
      .pop();
    if (!last) return 'index.html';
    if (/\.html$/i.test(last)) return last;
    if (/\.[a-z0-9]+$/i.test(last)) return 'index.html';
    return last + '.html';
  }

  // Resolve the page identity from the SERVED DOCUMENT itself, not the URL. Each
  // page carries <meta name="dugri:page" content="how.html">, so a vanity/unknown
  // route the server answers with index.html (its catch-all) correctly reads as
  // index.html — and a real page served at its extension-less path reads as its
  // own file. Falls back to the URL heuristic if the meta is missing.
  function resolvePage(doc, pathname) {
    var meta = doc && doc.querySelector && doc.querySelector('meta[name="dugri:page"]');
    var declared = meta && meta.getAttribute('content');
    if (declared && /^[a-z0-9-]+\.html$/.test(declared)) return declared;
    return derivePage(pathname);
  }

  // Escape a key for use inside a [attr="..."] selector (keys are validated
  // kebab on the server, but stay defensive on the client too).
  function attrSel(attr, key) {
    return '[' + attr + '="' + String(key).replace(/["\\]/g, '\\$&') + '"]';
  }

  // Overlay a page's overrides onto a DOM root. Text overrides win only when
  // present (ov.text != null); an unknown key simply matches nothing (no-op).
  function applyOverrides(root, overrides) {
    if (!root || !overrides) return;
    Object.keys(overrides).forEach(function (key) {
      var ov = overrides[key] || {};
      if (ov.text != null) {
        root.querySelectorAll(attrSel('data-edit', key)).forEach(function (el) {
          el.textContent = ov.text;
        });
      }
      if (ov.img != null && ov.img !== '') {
        root.querySelectorAll(attrSel('data-edit-img', key)).forEach(function (el) {
          el.setAttribute('src', ov.img);
        });
        root.querySelectorAll(attrSel('data-edit-bg', key)).forEach(function (el) {
          el.style.backgroundImage = 'url("' + ov.img + '")';
        });
      }
    });
  }

  // Resolve whether edit mode should be active, WITHOUT any side effect (no
  // prompt). active requires ?edit=1 AND a key from ?key= or storage. Bootstrap
  // layers the one-time prompt on top of this.
  function resolveEdit(searchStr, storage) {
    var params = new URLSearchParams(searchStr || '');
    var edit = params.get('edit') === '1';
    var key = params.get('key') || '';
    if (!key && storage) {
      try {
        key = storage.getItem(LS_KEY) || '';
      } catch {
        key = '';
      }
    }
    return { edit: edit, key: key, active: edit && !!key };
  }

  // ---- browser-only edit mode ------------------------------------------------

  function bootstrap() {
    var page = resolvePage(document, location.pathname);
    var resolved = resolveEdit(location.search, window.localStorage);

    // Overlay overrides for everyone, as early as possible; tolerate failure.
    fetch('/api/content?page=' + encodeURIComponent(page))
      .then(function (r) {
        return r.ok ? r.json() : { overrides: {} };
      })
      .then(function (data) {
        applyOverrides(document, (data && data.overrides) || {});
      })
      .catch(function () {
        /* fail soft — shipped defaults stay */
      })
      .then(function () {
        // Edit mode is owner-only and layered AFTER overrides are applied, so the
        // owner edits the current copy. Fail closed: no ?edit → never enable.
        if (!resolved.edit) return;
        // Trim the resolved key (from ?key= or storage) as the prompt branch does,
        // so a stray space never silently 403s every save. We deliberately do NOT
        // persist a key that arrived via ?key= here: that would store an UNVALIDATED
        // value, so a stale/typo'd key in a bookmarked ?edit=1&key=… link would
        // poison storage and lock edit mode into silent 403s. The only writer of a
        // remembered key is the dashboard "edit the site" button, which stores a key
        // that already authenticated the dashboard; and an invalid stored key
        // self-heals (a 403 on save clears it — see the admin fetch helpers).
        var key = (resolved.key || '').trim();
        if (!key) {
          key = (window.prompt('מפתח ניהול לעריכת התוכן:') || '').trim();
          if (!key) return; // cancelled → stay a normal visitor
          try {
            window.localStorage.setItem(LS_KEY, key);
          } catch {
            /* storage blocked — key still works for this session */
          }
        }
        enableEditMode(page, key);
      });
  }

  function enableEditMode(page, key) {
    injectStyles();
    var toolbar = buildToolbar();
    var status = toolbar.querySelector('[data-role="status"]');
    var resetBtn = toolbar.querySelector('[data-role="reset"]');
    var current = null; // the element the reset action targets

    function setStatus(txt) {
      if (status) status.textContent = txt;
    }
    function focusTarget(el) {
      current = el;
      if (resetBtn) resetBtn.disabled = !el;
    }

    // Disclosure content (<details>/<summary>) must be fully reachable AND stay put
    // while editing. Editable answers can live inside a normally-CLOSED <details>
    // (e.g. the FAQ answers on index.html), so force every <details> open — else
    // that content is display:none and can't be clicked/edited. And hold it open:
    // the summary click-toggle is already guarded below, but a stray keyboard
    // toggle (Space/Enter on a focused summary) would still collapse it mid-edit,
    // so a toggle guard snaps it back open. Setting open=true here re-fires toggle,
    // but the `if (!d.open)` check makes that a no-op (no loop).
    document.querySelectorAll('details').forEach(function (d) {
      d.open = true;
      d.addEventListener('toggle', function () {
        if (!d.open) d.open = true;
      });
    });

    // An editable element that is ALSO interactive — a link, a button (with its
    // own click handler), a <summary> (toggles its <details>), a role="button" or
    // an inline onclick — has native/own key+click behavior other than placing a
    // caret. In edit mode those must be neutralized so the owner can edit the LABEL.
    function interactiveEditable(target) {
      var el = target && target.closest && target.closest('[data-edit]');
      if (!el || !el.isContentEditable) return null;
      var interactive =
        /^(a|button|summary)$/i.test(el.tagName) ||
        el.hasAttribute('onclick') ||
        el.getAttribute('role') === 'button';
      return interactive ? el : null;
    }

    // Click guard. MUST sit on `document` in the CAPTURE phase: the page binds its
    // own handler at load (e.g. #closeBtn.onclick = closeCollection), and at the
    // TARGET node listeners fire in REGISTRATION order regardless of the capture
    // flag — so a later per-element listener would run after the page's handler. A
    // document-level capture listener runs during the capturing phase, before the
    // target's handlers, and stopPropagation there prevents them from ever firing
    // (and preventDefault stops link nav / form submit / the <details> toggle).
    document.addEventListener(
      'click',
      function (e) {
        var el = interactiveEditable(e.target);
        if (!el) return; // plain text keeps normal caret placement
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement !== el) el.focus();
      },
      true
    );

    // Ensure a collapsed caret sits inside `el` before an execCommand insert. A
    // programmatic/Tab focus can leave the selection empty or outside the element,
    // which would drop the inserted text or land it in a different editable; place
    // the caret at the end of `el` in that case.
    function ensureCaretIn(el) {
      var sel = window.getSelection && window.getSelection();
      if (!sel) return;
      if (sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
        var r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false); // caret at the end
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    // Newlines never render in these single-run plain-text overrides (applied via
    // textContent), so a '\n' would save but silently collapse to a space on
    // reload. Treat any newline INTENT as "commit" (blur → save) instead. We catch
    // it two ways so it is robust across keyboards:
    //  • beforeinput (insertParagraph/insertLineBreak) — the reliable signal on
    //    desktop, IME and MOBILE soft keyboards (whose keydown often reports
    //    e.key 'Unidentified' / keyCode 229, so a keydown-only guard would miss it).
    //  • keydown Enter — a belt-and-suspenders catch on hardware keyboards; when it
    //    fires first it preventDefaults, so beforeinput never runs (no double blur).
    document.addEventListener(
      'beforeinput',
      function (e) {
        var edit = e.target && e.target.closest && e.target.closest('[data-edit]');
        if (!edit || !edit.isContentEditable) return;
        if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
          e.preventDefault();
          e.stopPropagation();
          edit.blur();
        }
      },
      true
    );

    // Keydown guard (hardware keyboards):
    //  • Enter COMMITS (see above). Skipped mid-IME-composition so a candidate is
    //    confirmed, not committed as raw pre-composition text.
    //  • Space on an INTERACTIVE editable (<button>/<summary>) is consumed by native
    //    activation, so a space is never typed (labels like "לרכישה ›" and FAQ
    //    questions need spaces) — insert it as text instead. Plain editables keep
    //    native Space. Runs in the capture phase so native behavior never wins.
    document.addEventListener(
      'keydown',
      function (e) {
        if (e.isComposing || e.keyCode === 229) return; // let IME/mobile compose
        var edit = e.target && e.target.closest && e.target.closest('[data-edit]');
        if (!edit || !edit.isContentEditable) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          edit.blur();
          return;
        }
        if ((e.key === ' ' || e.key === 'Spacebar') && interactiveEditable(e.target)) {
          e.preventDefault();
          e.stopPropagation();
          ensureCaretIn(edit);
          document.execCommand('insertText', false, ' ');
        }
      },
      true
    );

    // Text leaves become editable; save on blur when the text actually changed.
    document.querySelectorAll('[data-edit]').forEach(function (el) {
      el.classList.add('dugri-edit-target');
      el.setAttribute('contenteditable', 'plaintext-only');
      // Safari/Firefox ignore plaintext-only — fall back to plain contenteditable.
      if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
      el.setAttribute('tabindex', '0');
      var original = el.textContent;
      el.addEventListener('focus', function () {
        original = el.textContent;
        focusTarget(el);
      });
      el.addEventListener('blur', function () {
        var next = el.textContent;
        if (next === original) return;
        if (next.length > TEXT_CAP) {
          next = next.slice(0, TEXT_CAP);
          el.textContent = next;
        }
        original = next;
        setStatus('שומר…');
        postText(page, key, el.getAttribute('data-edit'), next)
          .then(function () {
            setStatus('נשמר');
          })
          .catch(function () {
            setStatus('שגיאה בשמירה');
          });
      });
    });

    // Photos + CSS-background heroes: click to pick a replacement image.
    document.querySelectorAll('[data-edit-img],[data-edit-bg]').forEach(function (el) {
      el.classList.add('dugri-edit-target', 'dugri-edit-img');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('title', 'לחצו להחלפת התמונה');
      var editKey = el.getAttribute('data-edit-img') || el.getAttribute('data-edit-bg');
      var isBg = el.hasAttribute('data-edit-bg');
      function pick() {
        focusTarget(el);
        openImagePicker(page, key, editKey, setStatus, function (img) {
          if (isBg) el.style.backgroundImage = 'url("' + img + '")';
          else el.setAttribute('src', img);
        });
      }
      el.addEventListener('click', function (e) {
        e.preventDefault();
        pick();
      });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
    });

    // Reset the focused element to its shipped default (DELETE + reload so the
    // fresh HTML — the default — is served again with no override applied).
    if (resetBtn) {
      resetBtn.disabled = true;
      resetBtn.addEventListener('click', function () {
        if (!current) return;
        var editKey =
          current.getAttribute('data-edit') ||
          current.getAttribute('data-edit-img') ||
          current.getAttribute('data-edit-bg');
        setStatus('מאפס…');
        deleteOverride(page, key, editKey)
          .then(function () {
            location.reload();
          })
          .catch(function () {
            setStatus('שגיאה באיפוס');
          });
      });
    }

    document.documentElement.classList.add('dugri-editing');
  }

  function openImagePicker(page, key, editKey, setStatus, onDone) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      setStatus('מעלה תמונה…');
      postImage(page, key, editKey, file)
        .then(function (data) {
          if (data && data.img) {
            onDone(data.img);
            setStatus('נשמר');
          } else {
            setStatus('שגיאה בהעלאה');
          }
        })
        .catch(function () {
          setStatus('שגיאה בהעלאה');
        });
    });
    input.click();
  }

  // ---- network helpers (all admin writes carry ?key=) ------------------------

  function adminUrl(pathBase, key) {
    return pathBase + '?key=' + encodeURIComponent(key);
  }
  // Shared handler for an admin write response. A 403 means the key used for THIS
  // request is invalid (wrong or rotated) — SELF-HEAL by dropping the remembered
  // key so the owner isn't locked into a broken edit mode. But only clear storage
  // when the FAILING key IS the stored one: a 403 from a stale URL ?key= must not
  // wipe a DIFFERENT, still-valid key that a previous dashboard launch remembered.
  function adminResult(r, failMsg, usedKey) {
    if (r.status === 403) {
      try {
        if (window.localStorage.getItem(LS_KEY) === usedKey) {
          window.localStorage.removeItem(LS_KEY);
        }
      } catch {
        /* storage blocked — nothing to clear */
      }
    }
    if (!r.ok) throw new Error(failMsg);
    return r.json();
  }
  function postText(page, key, editKey, text) {
    return fetch(adminUrl('/api/admin/content', key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: page, key: editKey, text: text }),
    }).then(function (r) {
      return adminResult(r, 'save failed', key);
    });
  }
  function deleteOverride(page, key, editKey) {
    return fetch(adminUrl('/api/admin/content', key), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: page, key: editKey }),
    }).then(function (r) {
      return adminResult(r, 'reset failed', key);
    });
  }
  function postImage(page, key, editKey, file) {
    var fd = new window.FormData();
    fd.append('page', page);
    fd.append('key', editKey);
    fd.append('file', file);
    return fetch(adminUrl('/api/admin/content/image', key), {
      method: 'POST',
      body: fd,
    }).then(function (r) {
      return adminResult(r, 'upload failed', key);
    });
  }

  // ---- toolbar + styles ------------------------------------------------------

  function buildToolbar() {
    var bar = document.createElement('div');
    bar.className = 'dugri-editbar';
    bar.setAttribute('dir', 'rtl');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'עריכת תוכן');
    bar.innerHTML =
      '<span class="dugri-editbar__title">מצב עריכה</span>' +
      '<span class="dugri-editbar__status" data-role="status" aria-live="polite"></span>' +
      '<button type="button" class="dugri-editbar__btn" data-role="reset">אפס לברירת מחדל</button>' +
      '<button type="button" class="dugri-editbar__btn dugri-editbar__btn--exit" data-role="exit">יציאה</button>';
    var exit = bar.querySelector('[data-role="exit"]');
    exit.addEventListener('click', function () {
      // Drop ?edit (keep any ?key) and reload as a normal visitor.
      var params = new URLSearchParams(location.search);
      params.delete('edit');
      var qs = params.toString();
      location.href = location.pathname + (qs ? '?' + qs : '');
    });
    document.body.appendChild(bar);
    return bar;
  }

  function injectStyles() {
    if (document.getElementById('dugri-editor-styles')) return;
    var css = [
      '.dugri-edit-target{outline:2px dashed #c98a2b;outline-offset:2px;cursor:text;}',
      '.dugri-edit-target.dugri-edit-img{cursor:pointer;}',
      '.dugri-edit-target:focus{outline:2px solid #c98a2b;}',
      '.dugri-editbar{position:fixed;inset-block-end:16px;inset-inline-start:16px;z-index:2147483647;',
      'display:flex;gap:10px;align-items:center;background:#1c1a17;color:#fff;',
      'padding:10px 14px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);',
      'font-family:inherit;font-size:14px;direction:rtl;}',
      '.dugri-editbar__title{font-weight:700;}',
      '.dugri-editbar__status{min-width:64px;color:#e7c98a;font-size:13px;}',
      '.dugri-editbar__btn{background:#fff;color:#1c1a17;border:0;border-radius:8px;',
      'padding:6px 12px;font-weight:700;font-size:13px;cursor:pointer;transition:opacity .15s ease;}',
      '.dugri-editbar__btn:hover{opacity:.85;}',
      '.dugri-editbar__btn:disabled{opacity:.4;cursor:default;}',
      '.dugri-editbar__btn--exit{background:#c98a2b;color:#fff;}',
      '@media (prefers-reduced-motion: reduce){.dugri-editbar__btn{transition:none;}}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'dugri-editor-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Expose the pure helpers for unit tests (no auto-run on import).
  var api = {
    derivePage: derivePage,
    resolvePage: resolvePage,
    applyOverrides: applyOverrides,
    resolveEdit: resolveEdit,
    LS_KEY: LS_KEY,
  };
  if (typeof window !== 'undefined') window.__dugriEditor = api;

  // Auto-run ONLY when loaded as a real <script> (classic load sets
  // document.currentScript); an ESM test import leaves it null, so tests get the
  // helpers without the network bootstrap firing.
  if (typeof document !== 'undefined' && document.currentScript) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
      bootstrap();
    }
  }
})();
