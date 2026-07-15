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

  // Cross-module coordination. Some pages inject editable content AFTER this
  // engine's initial scan (product.js renders the per-design name / about text and
  // the photo carousel once its ?design resolves). We keep the fetched overrides
  // and, in edit mode, a rebind hook so late-injected [data-edit] / [data-edit-img]
  // / [data-edit-photos] nodes still get overlaid + wired. A cooperating page calls
  // window.dugriEditor.notifyInjected() after it injects (see the export below).
  var _overrides = null; // last fetched page overrides (applied for every visitor)
  var _rebind = null; // edit-mode (root)=>void: overlay + bind newly-injected nodes
  var _editActive = false;
  var _ready = false; // true once the overrides fetch has settled (success OR fail)
  var _readyCbs = []; // onReady() callbacks, flushed with _overrides when ready

  // The overrides fetch has settled — normalise a failure to {} and flush any
  // onReady() waiters (product.js reuses this single fetch instead of a second GET
  // of the hottest endpoint). Idempotent.
  function markReady() {
    if (_ready) return;
    if (_overrides == null) _overrides = {};
    _ready = true;
    var cbs = _readyCbs;
    _readyCbs = [];
    cbs.forEach(function (cb) {
      try {
        cb(_overrides);
      } catch {
        /* a bad callback must not break the others */
      }
    });
  }

  // The site's editable pages, in toolbar order. The page picker lets the owner
  // jump between them WITHOUT leaving edit mode. Each `page` is the html filename
  // the server serves (matches <meta name="dugri:page">); `label` is the RTL name.
  var EDITABLE_PAGES = [
    { page: 'index.html', label: 'בית' },
    { page: 'options.html', label: 'הזמנה' },
    { page: 'collect.html', label: 'איסוף מילים' },
    { page: 'how.html', label: 'איך זה עובד' },
    { page: 'products.html', label: 'מוצרים' },
    { page: 'product.html', label: 'מוצר' },
    { page: 'timer.html', label: 'טיימר' },
  ];

  // Build the URL that lands the owner on `page` STILL in edit mode: keep ?edit=1
  // and carry the key forward (?key=) so the picker preserves the owner session.
  // encodeURIComponent keeps a stray char from breaking the query or an [attr]
  // when the value is embedded in the toolbar's option markup.
  function pageEditUrl(page, key) {
    var url = page + '?edit=1';
    if (key) url += '&key=' + encodeURIComponent(key);
    return url;
  }

  // The URL to leave edit mode: drop ?edit (reload as a normal visitor) but keep
  // any other params intact. Same behavior the old exit button had inline.
  function exitHref(pathname, search) {
    var params = new URLSearchParams(search || '');
    params.delete('edit');
    var qs = params.toString();
    return String(pathname || '') + (qs ? '?' + qs : '');
  }

  // Save STATE, derived from DOM-vs-last-persisted (NOT from in-flight events). This
  // removes the whole class of ordering/flag races: dirtiness is a pure function of
  // "does the current value differ from what was LAST SUCCESSFULLY saved", so nothing
  // an out-of-order or failed save does can make a still-changed field look saved.
  //
  //  • Text fields: lastSavedText[key] = the text value last SUCCESSFULLY persisted
  //    (initialised to the loaded/override value). It is updated ONLY inside a save's
  //    success handler, to the EXACT value that save sent — never before the POST and
  //    never on failure. A field is dirty iff its current DOM text !== lastSavedText.
  //    So a failed save simply stays dirty (retryable by editing again or "שמור"),
  //    and an older save's late success that writes an older value still leaves the
  //    field dirty (DOM holds newer text) → it gets re-saved. No edit is ever lost.
  //  • Image fields: an <img>/bg only changes its DOM src on a SUCCESSFUL upload, so
  //    DOM-vs-last can't see an in-flight or failed upload. We mark such a field
  //    'pending' when a file starts uploading and 'failed' if it errors; it counts as
  //    unsaved until the upload succeeds (cleared), retryable by re-picking a file.
  function createContentState() {
    var lastSavedText = Object.create(null); // key -> last successfully saved text
    var imgState = Object.create(null); // key -> 'pending' | 'failed'
    return {
      initText: function (key, value) {
        if (!(key in lastSavedText)) lastSavedText[key] = value;
      },
      // Call ONLY on a successful save, with the value that save actually sent.
      markTextSaved: function (key, value) {
        lastSavedText[key] = value;
      },
      isTextDirty: function (key, current) {
        return current !== lastSavedText[key];
      },
      textKeys: function () {
        return Object.keys(lastSavedText);
      },
      setImg: function (key, s) {
        if (s) imgState[key] = s;
        else delete imgState[key];
      },
      isImgUnsaved: function (key) {
        return imgState[key] === 'pending' || imgState[key] === 'failed';
      },
      imgKeys: function () {
        return Object.keys(imgState);
      },
    };
  }

  // ONE flow behind "שמור" / "שמירה ויציאה" / the page picker (the review flagged the
  // 3-way copy-paste). saveDirty() re-POSTs every dirty field with its CURRENT value
  // and awaits all writes (text saves + any in-flight image uploads); THEN, if nothing
  // is still unsaved, onClean() proceeds (confirm status / navigate). If something is
  // still dirty/failed, the error is shown and onBlocked() offers recovery — a
  // discard-and-leave / discard-and-switch confirm, or reverting the picker — so the
  // owner is never stranded and an unsaved edit is never silently dropped.
  // deps = { saveDirty, hasUnsaved, setStatus, onClean, onBlocked }.
  function attemptCommit(deps) {
    deps.setStatus('שומר…');
    return deps.saveDirty().then(function () {
      if (deps.hasUnsaved()) {
        deps.setStatus('שגיאה בשמירה');
        if (deps.onBlocked) deps.onBlocked();
      } else if (deps.onClean) {
        deps.onClean();
      }
    });
  }

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

  // Keep DUPLICATED editable content in sync DURING a live edit session. On page
  // load applyOverrides sets textContent on EVERY [data-edit="key"] node, so
  // clones ship identical. But a live edit only mutates the ONE node the owner
  // clicked, so same-key duplicates (e.g. the hero marquee's two identical halves
  // and repeated phrase groups) would desync until the next reload. Mirror the new
  // text onto every same-key node so the duplicates stay pixel-identical mid-edit,
  // matching what applyOverrides already does on load. Guarded so we never touch a
  // node whose text already matches (no redundant DOM writes / caret churn).
  function syncSameKey(root, key, text) {
    if (!root || !key) return;
    root.querySelectorAll(attrSel('data-edit', key)).forEach(function (n) {
      if (n.textContent !== text) n.textContent = text;
    });
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
        _overrides = (data && data.overrides) || {};
        applyOverrides(document, _overrides);
      })
      .catch(function () {
        /* fail soft — shipped defaults stay */
      })
      .then(function () {
        // The fetch has settled (success or failure) — publish readiness so pages
        // that reuse these overrides (product.js) proceed. Done BEFORE edit mode is
        // resolved: a normal visitor still needs the overrides, and in edit mode the
        // injected nodes are already present (product renders synchronously), so
        // enableEditMode's own rebind binds them regardless of callback ordering.
        markReady();
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
    var toolbar = buildToolbar(page, key);
    var status = toolbar.querySelector('[data-role="status"]');
    var saveBtn = toolbar.querySelector('[data-role="save"]');
    var exitBtn = toolbar.querySelector('[data-role="exit"]');
    var pageSelect = toolbar.querySelector('[data-role="pageselect"]');
    var importBtn = toolbar.querySelector('[data-role="import-staging"]');

    // Per-field save state + the representative DOM node per text key (same-key
    // clones stay in sync, so any one node reflects the field's current value). One
    // list of in-flight image uploads is kept only to AWAIT them (dirtiness itself is
    // derived from state, never from this list).
    var state = createContentState();
    var textNodeByKey = Object.create(null);
    var pendingUploads = [];
    var inflightText = Object.create(null); // key -> { value, promise } of a live save

    function setStatus(txt) {
      if (status) status.textContent = txt;
    }

    // Save one text field: POST its CURRENT value; on SUCCESS record it as the last
    // saved value (so the field is no longer dirty); on failure leave it dirty.
    // Never rejects — resolves once settled. syncSameKey keeps clones identical. The
    // live save is recorded in inflightText so a follow-up commit of the SAME value
    // can await it instead of firing a redundant second POST.
    function saveTextField(fieldKey, value) {
      syncSameKey(document, fieldKey, value);
      setStatus('שומר…');
      var p = postText(page, key, fieldKey, value).then(
        function () {
          state.markTextSaved(fieldKey, value);
          setStatus('נשמר');
          return true;
        },
        function () {
          setStatus('שגיאה בשמירה');
          return false;
        }
      );
      var rec = { value: value, promise: p };
      inflightText[fieldKey] = rec;
      var clear = function () {
        if (inflightText[fieldKey] === rec) delete inflightText[fieldKey];
      };
      p.then(clear, clear);
      return p;
    }

    // Re-save every currently-dirty text field with its CURRENT DOM value, and await
    // those plus any in-flight image uploads. This is the single saver used by Save /
    // Save&Exit / the page picker, so a failed field is retried on the next commit.
    // If a field already has a LIVE save for its current value (an auto-save from a
    // blur to empty space), await that instead of POSTing the same value again.
    function saveDirtyFields() {
      var awaits = [];
      Object.keys(textNodeByKey).forEach(function (fieldKey) {
        var cur = textNodeByKey[fieldKey].textContent;
        if (!state.isTextDirty(fieldKey, cur)) return;
        var live = inflightText[fieldKey];
        if (live && live.value === cur) awaits.push(live.promise);
        else awaits.push(saveTextField(fieldKey, cur));
      });
      return Promise.all(awaits.concat(pendingUploads.slice()));
    }

    // Is anything still unsaved? Pure function of DOM-vs-last-saved (text) and the
    // image pending/failed marks — no in-flight bookkeeping decides this.
    function hasUnsavedNow() {
      var textDirty = Object.keys(textNodeByKey).some(function (fieldKey) {
        return state.isTextDirty(fieldKey, textNodeByKey[fieldKey].textContent);
      });
      var imgDirty = state.imgKeys().some(function (k) {
        return state.isImgUnsaved(k);
      });
      return textDirty || imgDirty;
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

    // Track an in-flight write so Save / Save&Exit / the page picker WAIT for it
    // (dirtiness itself is derived from state; this list only lets a commit await
    // still-settling uploads). Self-cleans on settle.
    function trackPending(p) {
      pendingUploads.push(p);
      var rm = function () {
        var i = pendingUploads.indexOf(p);
        if (i > -1) pendingUploads.splice(i, 1);
      };
      p.then(rm, rm);
      return p;
    }

    // Bind ONE editable text leaf: make it editable and auto-save on blur when the
    // text differs from what was last saved. Idempotent — a node injected AFTER the
    // initial scan (product.js's per-design name/about) is bound on the next
    // rebindEditable() with no double-wiring.
    function bindTextNode(el) {
      if (el.__dugriEditBound) return;
      el.__dugriEditBound = true;
      el.classList.add('dugri-edit-target');
      el.setAttribute('contenteditable', 'plaintext-only');
      // Safari/Firefox ignore plaintext-only — fall back to plain contenteditable.
      if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
      el.setAttribute('tabindex', '0');
      var fieldKey = el.getAttribute('data-edit');
      if (!(fieldKey in textNodeByKey)) textNodeByKey[fieldKey] = el;
      state.initText(fieldKey, el.textContent);
      el.addEventListener('blur', function (e) {
        var next = el.textContent;
        if (next.length > TEXT_CAP) {
          next = next.slice(0, TEXT_CAP);
          el.textContent = next;
        }
        // Mirror the edited node's value onto EVERY same-key clone FIRST — including
        // the representative node saveDirtyFields/hasUnsavedNow read. The owner may
        // have edited a NON-first clone (the marquee ships 8 identical spans), so the
        // field's dirty state must reflect whichever clone was typed into, not a
        // stale representative. This runs even when we hand the save to the toolbar.
        syncSameKey(document, fieldKey, next);
        // If focus moved to a TOOLBAR control (Save / Save&Exit / the page picker),
        // let that action's saveDirty do the single save — all clones already hold
        // the latest text — so we don't double-POST the same field.
        var to = e.relatedTarget;
        if (to && to.closest && to.closest('.dugri-editbar')) return;
        // Dirty iff it differs from the last SUCCESSFULLY saved value (retry-safe: a
        // previously failed field is still dirty and re-saves here).
        if (!state.isTextDirty(fieldKey, next)) return;
        saveTextField(fieldKey, next);
      });
    }

    // Bind ONE photo / CSS-background hero: click to pick a replacement image.
    // Idempotent, same as bindTextNode.
    function bindImgNode(el) {
      if (el.__dugriEditBound) return;
      el.__dugriEditBound = true;
      el.classList.add('dugri-edit-target', 'dugri-edit-img');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('title', 'לחצו להחלפת התמונה');
      var editKey = el.getAttribute('data-edit-img') || el.getAttribute('data-edit-bg');
      var isBg = el.hasAttribute('data-edit-bg');
      function pick() {
        openImagePicker(
          page,
          key,
          editKey,
          setStatus,
          function (img) {
            if (isBg) el.style.backgroundImage = 'url("' + img + '")';
            else el.setAttribute('src', img);
          },
          {
            // Track the upload so Save / Save&Exit / the picker WAIT for it, and mark
            // the field unsaved (pending → cleared on success, 'failed' on error) so
            // an in-flight or failed upload counts as unsaved (retry by re-picking).
            onPending: function () {
              state.setImg(editKey, 'pending');
            },
            onSaved: function () {
              state.setImg(editKey, null);
            },
            onFailed: function () {
              state.setImg(editKey, 'failed');
            },
            trackUpload: trackPending,
          }
        );
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
    }

    // A small square control button used inside the photo manager.
    function mkPhotoCtl(glyph, label, disabled, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dugri-photos__btn';
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.disabled = !!disabled;
      b.addEventListener('click', onClick);
      return b;
    }

    // Bind ONE per-product PHOTO ARRAY manager. A [data-edit-photos="<key>"]
    // container (product.js tags the PDP gallery with product-<id>-photos) gets an
    // owner-only panel to ADD / REMOVE / REORDER the carousel photos. Each action
    // persists immediately to the server (like a single-image replace) and fires
    // 'dugri:photos-changed' so the page rebuilds its carousel live. The photos live
    // in the same content-overrides store under the key's `imgs` array; an empty
    // array means the page falls back to its shipped default photos.
    function bindPhotoManager(container) {
      if (container.__dugriPhotoBound) return;
      container.__dugriPhotoBound = true;
      var photoKey = container.getAttribute('data-edit-photos');
      if (!photoKey) return;

      var panel = document.createElement('div');
      panel.className = 'dugri-photos';
      panel.setAttribute('dir', 'rtl');
      var head = document.createElement('div');
      head.className = 'dugri-photos__head';
      var list = document.createElement('div');
      list.className = 'dugri-photos__list';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'dugri-photos__add';
      addBtn.textContent = '➕ הוסף תמונה';
      panel.append(head, list, addBtn);

      // `working` is the LIVE local truth for this carousel's order. Move/remove
      // mutate it SYNCHRONOUSLY (so indices resolve against what's on screen, never
      // a stale base), and every write is a full-array PUT queued in order — the
      // last one wins with the correct final order, so rapid consecutive clicks
      // never drop an edit (the concurrency fix).
      var working = (((_overrides || {})[photoKey] || {}).imgs || []).slice();
      var saveQueue = Promise.resolve();

      // Reflect the new order locally (store + carousel + panel) right away.
      function applyImgs(next) {
        working = next.slice();
        if (!_overrides) _overrides = {};
        _overrides[photoKey] = Object.assign({}, _overrides[photoKey], { imgs: working.slice() });
        document.dispatchEvent(
          new CustomEvent('dugri:photos-changed', {
            detail: { key: photoKey, imgs: working.slice() },
          })
        );
        render();
      }
      // Serialize a full-array PUT after `saveQueue`, so writes land in click order.
      function queuePut() {
        var snapshot = working.slice();
        setStatus('שומר…');
        var p = saveQueue.then(function () {
          return putPhotoOrder(page, key, photoKey, snapshot).then(
            function () {
              setStatus('נשמר');
            },
            function () {
              setStatus('שגיאה בשמירה');
            }
          );
        });
        saveQueue = p;
        trackPending(p);
      }
      function move(from, to) {
        if (to < 0 || to >= working.length) return;
        var next = working.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        applyImgs(next); // optimistic + synchronous → indices stay correct
        queuePut();
      }
      function removeAt(i) {
        var next = working.slice();
        next.splice(i, 1);
        applyImgs(next);
        queuePut();
      }
      function addPhoto() {
        // A DETACHED input — never added to the DOM — so a cancelled picker (which
        // fires no 'change') leaves no leaked node/listener behind (the leak fix).
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) return;
          setStatus('מעלה תמונה…');
          // Chain the upload after any pending order writes so appends and reorders
          // stay in order; the server returns the whole array we then adopt.
          var p = saveQueue.then(function () {
            return postPhotoUpload(page, key, photoKey, file).then(
              function (data) {
                if (data && data.imgs) {
                  applyImgs(data.imgs);
                  setStatus('נשמר');
                } else {
                  setStatus('שגיאה בהעלאה');
                }
              },
              function (err) {
                // The server rejects a drop (cap reached / duplicate) with a clear
                // Hebrew message — surface it instead of a generic error.
                setStatus((err && err.userMessage) || 'שגיאה בהעלאה');
              }
            );
          });
          saveQueue = p;
          trackPending(p);
        });
        input.click();
      }
      function render() {
        var cur = working;
        head.textContent = 'תמונות המוצר (' + cur.length + ')';
        list.textContent = '';
        cur.forEach(function (src, i) {
          var item = document.createElement('figure');
          item.className = 'dugri-photos__item';
          var im = document.createElement('img');
          im.src = src;
          im.alt = '';
          var ctl = document.createElement('div');
          ctl.className = 'dugri-photos__ctl';
          ctl.append(
            mkPhotoCtl('◀', 'הזזה אחורה', i <= 0, function () {
              move(i, i - 1);
            }),
            mkPhotoCtl('▶', 'הזזה קדימה', i >= cur.length - 1, function () {
              move(i, i + 1);
            })
          );
          var del = mkPhotoCtl('✕', 'הסרת התמונה', false, function () {
            removeAt(i);
          });
          del.classList.add('dugri-photos__del');
          ctl.appendChild(del);
          item.append(im, ctl);
          list.appendChild(item);
        });
      }

      addBtn.addEventListener('click', addPhoto);
      render();
      container.insertAdjacentElement('afterend', panel);
    }

    // Overlay overrides + (re)bind every editable node under `root`. Called once on
    // enable and again whenever a page injects late content (notifyInjected). All
    // three binders are idempotent, so re-scanning the whole document is safe.
    function rebindEditable(root) {
      var scope = root || document;
      if (_overrides) applyOverrides(scope, _overrides);
      scope.querySelectorAll('[data-edit]').forEach(bindTextNode);
      scope.querySelectorAll('[data-edit-img],[data-edit-bg]').forEach(bindImgNode);
      scope.querySelectorAll('[data-edit-photos]').forEach(bindPhotoManager);
    }
    rebindEditable(document);
    // Expose the rebind hook + edit-active flag for late-injecting pages.
    _rebind = rebindEditable;
    _editActive = true;

    // Import ALL content from the STAGING service, overwriting every live override
    // on THIS service (staging + prod have separate volumes). Confirm first (this is
    // destructive), then on success show the summary + reload; on failure show the
    // server's error. The server backs up the current store before overwriting.
    if (importBtn) {
      importBtn.addEventListener('click', function () {
        if (
          !window.confirm(
            'פעולה זו תדרוס את כל התוכן החי באתר ותחליף אותו בתוכן מהסטייג׳ינג. להמשיך?'
          )
        ) {
          return;
        }
        setStatus('מייבא…');
        postImportFromStaging(key).then(
          function (data) {
            var summary =
              'הייבוא הושלם: ' + (data.fields || 0) + ' שדות, ' + (data.images || 0) + ' תמונות';
            setStatus(summary);
            window.alert(summary);
            location.reload();
          },
          function (err) {
            setStatus((err && err.userMessage) || 'שגיאה בייבוא');
          }
        );
      });
    }

    function leaveEditMode() {
      location.href = exitHref(location.pathname, location.search);
    }

    // "שמור": save every dirty field (retrying a previously failed one), then confirm.
    // Stays in edit mode. Reports an error if anything is still unsaved afterwards.
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        attemptCommit({
          saveDirty: saveDirtyFields,
          hasUnsaved: hasUnsavedNow,
          setStatus: setStatus,
          onClean: function () {
            setStatus('נשמר');
          },
        });
      });
    }

    // "שמירה ויציאה": save everything, then leave edit mode. On a save failure it does
    // NOT silently leave (that would drop the edit); it surfaces the error and offers
    // an explicit discard-and-leave confirm so the owner is never stranded (e.g. a
    // rotated key that fails every save).
    if (exitBtn) {
      exitBtn.addEventListener('click', function () {
        attemptCommit({
          saveDirty: saveDirtyFields,
          hasUnsaved: hasUnsavedNow,
          setStatus: setStatus,
          onClean: leaveEditMode,
          onBlocked: function () {
            if (window.confirm('השמירה נכשלה. לצאת ממצב עריכה בלי לשמור את השינויים?')) {
              leaveEditMode();
            }
          },
        });
      });
    }

    // Page picker: save everything first, then switch pages only when clean, so no
    // in-flight save is aborted by the navigation. On a save failure, offer the same
    // discard-and-switch confirm (never permanently block the picker); if declined,
    // revert the <select> to the current page.
    if (pageSelect) {
      var currentValue = pageSelect.value;
      pageSelect.addEventListener('change', function () {
        var target = pageSelect.value;
        attemptCommit({
          saveDirty: saveDirtyFields,
          hasUnsaved: hasUnsavedNow,
          setStatus: setStatus,
          onClean: function () {
            location.href = target;
          },
          onBlocked: function () {
            if (window.confirm('השמירה נכשלה. לעבור לעמוד אחר בלי לשמור את השינויים?')) {
              location.href = target;
            } else {
              pageSelect.value = currentValue;
            }
          },
        });
      });
    }

    document.documentElement.classList.add('dugri-editing');
  }

  function openImagePicker(page, key, editKey, setStatus, onDone, hooks) {
    // A DETACHED input — never added to the DOM — so a cancelled picker (no
    // 'change' event) can't leak a node/listener on every open/cancel cycle.
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      // Mark the field unsaved (pending) and TRACK the upload so Save / Save&Exit /
      // the page picker WAIT for it and won't navigate away mid-upload (losing the
      // new image). Success clears the field; failure marks it 'failed' (stays unsaved,
      // retry by re-picking). onDone applies the returned src on success only.
      if (hooks && hooks.onPending) hooks.onPending();
      setStatus('מעלה תמונה…');
      var upload = postImage(page, key, editKey, file).then(function (data) {
        if (data && data.img) {
          onDone(data.img);
          return data;
        }
        throw new Error('upload returned no image');
      });
      var settled = upload.then(
        function () {
          if (hooks && hooks.onSaved) hooks.onSaved();
          setStatus('נשמר');
          return true;
        },
        function () {
          if (hooks && hooks.onFailed) hooks.onFailed();
          setStatus('שגיאה בהעלאה');
          return false;
        }
      );
      if (hooks && hooks.trackUpload) hooks.trackUpload(settled);
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
  // Trigger the cross-service "import content from staging" on the server. Resolves
  // to the server's summary { pages, fields, images, backup }; rejects with an Error
  // whose userMessage carries the server's Hebrew reason so the toolbar can show WHY
  // (missing STAGING_URL, self-import, staging unreachable, …). A 403 self-heals the
  // remembered key, exactly like adminResult, so a rotated key doesn't lock edit mode.
  function postImportFromStaging(key) {
    return fetch(adminUrl('/api/admin/content/import-from-staging', key), {
      method: 'POST',
    }).then(function (r) {
      if (r.status === 403) {
        try {
          if (window.localStorage.getItem(LS_KEY) === key) {
            window.localStorage.removeItem(LS_KEY);
          }
        } catch {
          /* storage blocked — nothing to clear */
        }
      }
      return r.json().then(
        function (data) {
          if (!r.ok) {
            var e = new Error((data && data.error) || 'import failed');
            e.userMessage = (data && data.error) || 'שגיאה בייבוא';
            throw e;
          }
          return data;
        },
        function () {
          var e = new Error('import failed');
          e.userMessage = 'שגיאה בייבוא';
          throw e;
        }
      );
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
  // APPEND one uploaded photo to a per-key photo array (a product carousel).
  // Resolves to { ok, img, imgs } — the whole new array so the client re-renders.
  function postPhotoUpload(page, key, editKey, file) {
    var fd = new window.FormData();
    fd.append('page', page);
    fd.append('key', editKey);
    fd.append('file', file);
    return fetch(adminUrl('/api/admin/content/photos', key), {
      method: 'POST',
      body: fd,
    }).then(function (r) {
      // A 409 means the photo was DROPPED (at the 12-photo cap, or a duplicate) —
      // surface the server's Hebrew message on the rejection so the owner sees WHY,
      // not a generic error.
      if (r.status === 409) {
        return r.json().then(
          function (d) {
            var e = new Error((d && d.error) || 'לא ניתן להוסיף תמונה');
            e.userMessage = (d && d.error) || 'לא ניתן להוסיף תמונה';
            throw e;
          },
          function () {
            var e = new Error('לא ניתן להוסיף תמונה');
            e.userMessage = 'לא ניתן להוסיף תמונה';
            throw e;
          }
        );
      }
      return adminResult(r, 'upload failed', key);
    });
  }
  // REPLACE a per-key photo array (remove + reorder send the desired full order).
  function putPhotoOrder(page, key, editKey, imgs) {
    return fetch(adminUrl('/api/admin/content/photos', key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: page, key: editKey, imgs: imgs }),
    }).then(function (r) {
      return adminResult(r, 'save failed', key);
    });
  }

  // ---- toolbar + styles ------------------------------------------------------

  function buildToolbar(page, key) {
    var bar = document.createElement('div');
    bar.className = 'dugri-editbar';
    bar.setAttribute('dir', 'rtl');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'עריכת תוכן');
    // Page picker: an <option> per editable page whose value is the STILL-editing
    // URL (?edit=1&key=…) so selecting one navigates there without leaving edit
    // mode. The current page starts selected.
    var options = EDITABLE_PAGES.map(function (p) {
      var selected = p.page === page ? ' selected' : '';
      return (
        '<option value="' + pageEditUrl(p.page, key) + '"' + selected + '>' + p.label + '</option>'
      );
    }).join('');
    bar.innerHTML =
      '<span class="dugri-editbar__title">מצב עריכה</span>' +
      '<label class="dugri-editbar__page">עריכת עמוד:' +
      '<select class="dugri-editbar__select" data-role="pageselect" aria-label="עריכת עמוד">' +
      options +
      '</select></label>' +
      '<span class="dugri-editbar__status" data-role="status" aria-live="polite"></span>' +
      '<button type="button" class="dugri-editbar__btn" data-role="import-staging">ייבוא תוכן מהסטייג׳ינג</button>' +
      '<button type="button" class="dugri-editbar__btn" data-role="save">שמור</button>' +
      '<button type="button" class="dugri-editbar__btn dugri-editbar__btn--exit" data-role="exit">שמירה ויציאה</button>';
    // The picker's change handler is wired in enableEditMode (it must save-then-nav,
    // which needs the tracker/status) — buildToolbar only builds the DOM.
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
      'display:flex;flex-wrap:wrap;max-width:calc(100vw - 32px);gap:10px;align-items:center;',
      'background:#1c1a17;color:#fff;',
      'padding:10px 14px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);',
      'font-family:inherit;font-size:14px;direction:rtl;}',
      '.dugri-editbar__title{font-weight:700;}',
      '.dugri-editbar__page{display:flex;align-items:center;gap:6px;color:#e7c98a;font-size:13px;}',
      '.dugri-editbar__select{background:#fff;color:#1c1a17;border:0;border-radius:8px;',
      'padding:5px 8px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;}',
      '.dugri-editbar__status{min-width:64px;color:#e7c98a;font-size:13px;}',
      '.dugri-editbar__btn{background:#fff;color:#1c1a17;border:0;border-radius:8px;',
      'padding:6px 12px;font-weight:700;font-size:13px;cursor:pointer;transition:opacity .15s ease;}',
      '.dugri-editbar__btn:hover{opacity:.85;}',
      '.dugri-editbar__btn:disabled{opacity:.4;cursor:default;}',
      '.dugri-editbar__btn--exit{background:#c98a2b;color:#fff;}',
      '@media (prefers-reduced-motion: reduce){.dugri-editbar__btn{transition:none;}}',
      // per-product photo manager (edit mode only)
      '.dugri-photos{margin-top:12px;padding:12px;border:2px dashed #c98a2b;border-radius:12px;',
      'background:rgba(201,138,43,.06);direction:rtl;}',
      '.dugri-photos__head{font-weight:700;font-size:14px;margin-bottom:8px;color:#1c1a17;}',
      '.dugri-photos__list{display:flex;flex-wrap:wrap;gap:10px;}',
      '.dugri-photos__item{width:96px;margin:0;}',
      '.dugri-photos__item img{width:96px;height:72px;object-fit:cover;border-radius:8px;display:block;',
      'border:1px solid rgba(0,0,0,.15);}',
      '.dugri-photos__ctl{display:flex;gap:4px;justify-content:center;margin-top:4px;}',
      '.dugri-photos__btn{background:#1c1a17;color:#fff;border:0;border-radius:6px;padding:3px 7px;',
      'font-size:12px;line-height:1;cursor:pointer;}',
      '.dugri-photos__btn:disabled{opacity:.35;cursor:default;}',
      '.dugri-photos__del{background:#a8322b;}',
      '.dugri-photos__add{margin-top:10px;background:#c98a2b;color:#fff;border:0;border-radius:8px;',
      'padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;}',
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
    syncSameKey: syncSameKey,
    resolveEdit: resolveEdit,
    LS_KEY: LS_KEY,
    EDITABLE_PAGES: EDITABLE_PAGES,
    pageEditUrl: pageEditUrl,
    exitHref: exitHref,
    createContentState: createContentState,
    attemptCommit: attemptCommit,
    buildToolbar: buildToolbar,
  };
  if (typeof window !== 'undefined') window.__dugriEditor = api;

  // Public runtime hook for pages that inject editable content AFTER this engine's
  // initial scan (product.js renders the per-design name / about / photo carousel
  // once ?design resolves). notifyInjected() (re)overlays the fetched overrides on
  // the whole document and, in edit mode, binds any newly-injected editable nodes
  // (idempotent). In edit mode rebindEditable() already overlays the overrides, so
  // we let it own that; only outside edit mode do we overlay directly. Safe to call
  // before the engine is ready — it no-ops until the overrides load and edit mode is
  // resolved, and the bootstrap then covers the already-present injected nodes.
  // Fail-closed: no edit affordance without an active edit session.
  function notifyInjected() {
    if (_rebind)
      _rebind(document); // rebindEditable overlays AND binds
    else if (_overrides) applyOverrides(document, _overrides); // public: overlay only
  }
  if (typeof window !== 'undefined') {
    window.dugriEditor = {
      notifyInjected: notifyInjected,
      isEditActive: function () {
        return _editActive;
      },
      // The already-fetched page overrides (or null before the fetch settles), so a
      // cooperating page reuses this single GET instead of a second round-trip.
      getOverrides: function () {
        return _overrides;
      },
      // Call `cb(overrides)` once the overrides fetch has settled (immediately if
      // already ready). Lets product.js await the shared fetch without its own GET.
      onReady: function (cb) {
        if (typeof cb !== 'function') return;
        if (_ready) cb(_overrides);
        else _readyCbs.push(cb);
      },
    };
  }

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
