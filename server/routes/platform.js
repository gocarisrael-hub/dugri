// Agent D (Platform & Comms): the HTTP routes, moved out of server/index.js.
//
// Slice 1 of splitting the monolith (see docs/agent-partition.md, "Splitting the
// monolith"). Every block below is a VERBATIM move; only the glue is new.
//
// How it is wired, and why:
//   - Each function registers ONE contiguous block that used to sit inline in
//     index.js, and index.js calls it at exactly the spot the block occupied.
//     Express matches in registration order, so a block mounted anywhere else could
//     change which handler answers (the /api 404 and the SPA `GET *` are
//     order-sensitive). tests/unit/route-order.test.js pins the resulting order.
//   - Everything a block uses from index.js is passed in explicitly. This module
//     never requires index.js (that would be a cycle), and it requires NOTHING at
//     the top level: the unit tests reload the app by purging require.cache for
//     server/*.js, and a module-level require or module-level state here would
//     survive that purge and hand a freshly loaded app a stale instance.
//   - Whatever index.js still calls from a block comes back as the return value.

// The owner's operational playbook (server/playbook.js).
function registerPlaybook(app, { requireAdmin, playbook }) {
  // Admin: operational playbook / notebook. The owner's organized notes (recipes,
  // prompts, reminders) — read + add + edit + delete, all behind the admin key.
  // Data persists under DATA_DIR (see server/playbook.js). The static page shell is
  // site/admin-playbook.html; it holds no content until it loads this gated API.
  app.get('/api/admin/playbook', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ notes: playbook.list() });
  });
  app.post('/api/admin/playbook', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { section, title, body, pinned } = req.body || {};
    if (!String(title || '').trim() && !String(body || '').trim()) {
      return res.status(400).json({ error: 'title or body required' });
    }
    res.status(201).json({ note: playbook.add({ section, title, body, pinned }) });
  });
  app.patch('/api/admin/playbook/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const note = playbook.update(req.params.id, req.body || {});
    if (!note) return res.status(404).json({ error: 'not found' });
    res.json({ note });
  });
  app.delete('/api/admin/playbook/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!playbook.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
}

// "Stop emailing me", the SMS gateway on the owner's phone, and the public read
// of the content-editor overrides.
function registerUnsubscribeSmsContent(
  app,
  { requireAdmin, paymentBaseUrl, crypto, settings, unsubscribe, sms, content }
) {
  // Inline content editor. The owner edits any tagged text/photo on the live site
  // in an admin-key-gated edit mode; the overrides persist under DATA_DIR (see
  // server/content.js) and overlay the shipped defaults for EVERY visitor. The
  // public GET is unauthenticated on purpose — every visitor must render the
  // current copy — while all writes are behind requireAdmin.
  // --- "stop emailing me" -------------------------------------------------------
  // PUBLIC and unauthenticated, gated by a signature instead: the whole point is a
  // person with an email and no account being able to stop the mail in one tap. The
  // token is an HMAC of their own address (server/unsubscribe.js), so a query
  // string cannot be edited to silence somebody else.
  //
  // Suppression is TOTAL — receipts and "your order is ready" included. See the
  // gate in notify.send() for why that is the strict reading.

  // The state of one address, for the landing page to render (and to say "you are
  // already unsubscribed" rather than pretending the tap did something).
  app.get('/api/unsubscribe/status', (req, res) => {
    const email = String(req.query.e || '');
    if (!unsubscribe.verify(email, req.query.t))
      return res.status(403).json({ error: 'bad token' });
    res.json({ email: unsubscribe.norm(email), unsubscribed: unsubscribe.isUnsubscribed(email) });
  });

  // STOP. Answers both the page's button and the one-click POST that Gmail/Outlook
  // send from their own unsubscribe control (RFC 8058) — same route, so the two can
  // never drift apart.
  app.post('/api/unsubscribe', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || req.query.e || '');
    const token = body.token || req.query.t;
    if (!unsubscribe.verify(email, token)) return res.status(403).json({ error: 'bad token' });
    unsubscribe.unsubscribe(email, 'link');
    res.json({ ok: true, email: unsubscribe.norm(email), unsubscribed: true });
  });

  // …and back. One tap in a mail client is easy to do by accident, and without this
  // the only way back is a phone call.
  app.post('/api/resubscribe', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || req.query.e || '');
    const token = body.token || req.query.t;
    if (!unsubscribe.verify(email, token)) return res.status(403).json({ error: 'bad token' });
    unsubscribe.resubscribe(email);
    res.json({ ok: true, email: unsubscribe.norm(email), unsubscribed: false });
  });

  // Admin: who has stopped their mail. The orders table annotates its rows from
  // this too (see /api/admin/collections), because an owner who cannot see it just
  // finds out that "the emails stopped working".
  app.get('/api/admin/unsubscribed', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ addresses: unsubscribe.list() });
  });

  // Admin: stop (or resume) mail to an address BY HAND. People ask on WhatsApp, in
  // a reply, or on the phone — and the owner should be able to honour that without
  // asking them to go and find the link in an email they may have deleted. Also the
  // way back for someone who pressed it by accident and cannot find the mail again.
  app.post('/api/admin/unsubscribed', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = req.body || {};
    const email = unsubscribe.norm(body.email);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad email' });
    if (body.unsubscribed === false) unsubscribe.resubscribe(email);
    else unsubscribe.unsubscribe(email, 'admin');
    res.json({ ok: true, email, unsubscribed: unsubscribe.isUnsubscribed(email) });
  });

  // --- the SMS gateway on the owner's phone -------------------------------------
  // The phone POLLS: it is behind a home router with no address of its own, so the
  // server cannot call it. Everything here is gated by SMS_GATEWAY_KEY — a shared
  // secret in the app's config, separate from ADMIN_KEY so a phone left in a drawer
  // never carries the key to the whole admin.
  //
  // Dormant until that env var is set: with no key, these routes answer 404 rather
  // than 403, so an unconfigured deployment does not advertise a feature it has not
  // got.
  function requireSmsGateway(req, res) {
    const key = process.env.SMS_GATEWAY_KEY || '';
    if (!key) {
      res.status(404).json({ error: 'sms gateway not configured' });
      return false;
    }
    const given = String(req.get('x-sms-key') || req.query.key || '');
    // Length check first so timingSafeEqual cannot throw on a mismatched length.
    const ok =
      given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
    if (!ok) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  // What to send now. Leased, so a second poll does not hand out the same message
  // twice; see server/sms.js for why a lease rather than a delete.
  //
  // Each message carries its own `ack_url`: the complete address to call once it is
  // sent. The phone used to BUILD that address — string concatenation inside an
  // Automate formula — and one slip there reported every message to an address
  // that matched nothing. The phone saw a successful request (an HTTP block does
  // not fail on a 404), the message stayed leased, and the customer was texted
  // again when the lease ran out. A ready-made link needs no formula at all.
  //
  // THE LINK CARRIES THE MESSAGE'S OWN TOKEN, not SMS_GATEWAY_KEY. A URL is the
  // least private thing in the system: it is written into Railway's access log,
  // Cloudflare's, and Automate's flow log on a phone that lives in a drawer. The
  // shared key opens the whole outbox — every customer's number and text — so it
  // does not belong in any of those. sms.claim mints a token per message that
  // unlocks exactly one "that went out" and nothing else.
  //
  // And the address it is built on is PUBLIC_BASE_URL or nothing — never the Host
  // header, for the same reason paymentBaseUrl refuses to (see its comment above).
  // A spoofed or internal Host would hand the phone an address that answers
  // nothing, every report would 404 in silence, and the message would go out again
  // — the exact bug this route exists to remove. With no base configured the field
  // is simply absent and the phone falls back to the documented POST with the
  // header, which needs no address from us.
  let _warnedNoSmsBase = false;
  app.get('/api/sms/outbox', (req, res) => {
    if (!requireSmsGateway(req, res)) return;
    sms.markPolled();
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    const base = paymentBaseUrl();
    if (!base && !_warnedNoSmsBase) {
      _warnedNoSmsBase = true;
      console.warn('[sms] PUBLIC_BASE_URL is not set — messages ship without ack_url');
    }
    // ONE value for the whole poll, alongside the messages rather than inside them:
    // it names this batch, and it is the only thing the fixed batch-report address
    // needs. `ack_batch_url` is that address with the value already in it, so a
    // flow that can copy a field reports without building anything — and it is
    // there on EVERY poll, including one with nothing to send, because the report
    // block has no condition in front of it and an empty address would stop the
    // flow on the quiet cycles, which are most of them.
    const { batch, messages } = sms.claim({ limit });
    const out = {
      batch,
      messages: messages.map((m) => {
        const { ack_token, ...rest } = m;
        if (!base || !ack_token) return rest;
        return {
          ...rest,
          ack_url:
            base +
            '/api/sms/outbox/' +
            encodeURIComponent(m.id) +
            '/ack?t=' +
            encodeURIComponent(ack_token),
        };
      }),
    };
    if (base) out.ack_batch_url = base + '/api/sms/outbox/ack-taken?b=' + encodeURIComponent(batch);
    res.json(out);
  });

  // The phone's report on one message. `ok:false` carries the SIM's reason, which
  // is what makes a failure legible on the admin screen instead of a silence.
  //
  // Accepted as GET as well as POST. An automation app's HTTP block sends GET
  // unless told otherwise, and this is an idempotent "that one went out" behind the
  // gateway key — refusing it over the method would re-send a customer's SMS
  // because of a setting nobody can see. A GET carries a failure as
  // ?ok=false&error=…, having no body.
  //
  // TWO WAYS IN. The per-message token from `ack_url` (?t=…), which opens this one
  // message and nothing else; or the shared gateway key, which is how the phone was
  // first set up and stays supported. Either is enough — the token is the one to
  // prefer, because the link it sits in is logged in four places.
  function smsAck(req, res) {
    // Dormant when the gateway is not configured at all — a 404, so an unset
    // deployment does not advertise the feature. Checked before the token so a
    // stale token cannot reach a feature that is switched off.
    if (!process.env.SMS_GATEWAY_KEY) {
      return res.status(404).json({ error: 'sms gateway not configured' });
    }
    const body = req.method === 'GET' ? req.query : req.body || {};
    const token = req.query.t || body.t;
    if (!sms.checkAckToken(req.params.id, token) && !requireSmsGateway(req, res)) return;
    sms.markPolled();
    const ok = !(body.ok === false || body.ok === 'false' || body.ok === '0');
    const m = sms.ack(req.params.id, { ok, error: body.error });
    if (!m) {
      // Logged, because this is the one failure the phone cannot see: its request
      // succeeded, the message stays leased, and it goes out again later.
      //
      // SANITISED, because the id is whatever was in the path: a %0A decodes to a
      // real newline, and a newline in a log line is a second log line. Someone
      // who can reach this route could otherwise write a convincing "[sms] sent"
      // into the record the owner reads when she is working out why a customer
      // heard nothing. Printable ASCII only, and short.
      const shown = String(req.params.id)
        .replace(/[^\x20-\x7e]/g, '.')
        .slice(0, 60);
      console.warn('[sms] report for an unknown message id: ' + shown);
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true, state: m.state });
  }
  app.post('/api/sms/outbox/:id/ack', smsAck);
  app.get('/api/sms/outbox/:id/ack', smsAck);

  // The batch at once, from ONE fixed address.
  //
  // The per-message report needs the phone to build an address out of the message
  // it is holding, and that step is where this broke twice on the owner's own
  // phone: a formula that resolved to nothing, then the same field left as plain
  // text. Both are silent from here — the message stays leased, the lease runs out,
  // and the customer is texted again.
  //
  // This address is a constant. What it carries is the batch token from the poll
  // that handed the messages over — one value for the whole run, copied straight
  // across, nothing built and nothing evaluated per message — and it settles that
  // batch and nothing else. "Everything I am holding" with no name on it would
  // settle a second poll's messages, a second phone's, or a whole batch mid-flight
  // the moment the owner opened the URL in a browser to check she had pasted it
  // right; and `sent` is terminal, so those customers are never told at all.
  //
  // THE TOKEN IS THE KEY, and SMS_GATEWAY_KEY is not. A URL is written into
  // Railway's access log, Cloudflare's and Automate's flow log, and the shared key
  // opens the whole outbox — every customer's number and text — which is exactly
  // why `ack_url` carries a per-message token instead. The same reasoning applies
  // here, so the batch token authorises the report on its own and the address the
  // owner pastes need never contain the shared key. It is read from the query
  // (`b`), a form or JSON body, or an `x-sms-batch` header, so the one value can go
  // wherever the app makes it easiest to drop a plain variable.
  //
  // NOTHING HERE 4xx's A PHONE THAT BROUGHT A TOKEN. A token can only ever settle
  // its own batch, so one we do not recognise — forged, or simply stale because the
  // lease ran out and those messages were handed to a later batch — changes nothing
  // whatever we answer. Answering 200 with ok:false is therefore free, and the
  // alternative is not: an Automate flow stops dead on an error status, and a phone
  // that stopped polling for a whole night is the failure this area exists to undo.
  // The messages stay leased and go out again on the next lease — a duplicate,
  // which is the trade this module makes on purpose.
  //
  // A request with NO token at all is a different thing — a flow that was never
  // wired up, or the address opened in a browser — and that one still has to prove
  // it is the phone, so the route is not an open target. It is told what is missing
  // rather than being allowed to settle "everything", which is the whole defect.
  //
  // GET as well as POST, because "GET" is what an automation app sends when nobody
  // picks a method.
  function smsAckTaken(req, res) {
    if (!process.env.SMS_GATEWAY_KEY) {
      return res.status(404).json({ error: 'sms gateway not configured' });
    }
    const body = req.method === 'GET' ? req.query : req.body || {};
    const batch = String(
      req.query.b || req.query.batch || body.b || body.batch || req.get('x-sms-batch') || ''
    );
    if (!batch && !requireSmsGateway(req, res)) return;
    const { known, sent } = sms.ackTaken({ batch });
    if (!known) {
      // The one failure the phone cannot see for itself: its request succeeded,
      // nothing moved, and the messages go out again on the next lease. Said out
      // loud so the log shows a report landing nowhere. Sanitised for the same
      // reason the per-message route sanitises an id — this comes off the wire.
      const shown = batch.replace(/[^\x20-\x7e]/g, '.').slice(0, 60);
      console.warn('[sms] batch report for an unknown batch: ' + (shown || '(none given)'));
      return res.json({ ok: false, sent: 0, error: batch ? 'unknown batch' : 'missing batch' });
    }
    // Only a token we issued counts as the phone saying hello — the number on the
    // admin screen has to mean the gateway is alive, not that someone opened a URL.
    sms.markPolled();
    res.json({ ok: true, sent: sent.length });
  }
  app.post('/api/sms/outbox/ack-taken', smsAckTaken);
  app.get('/api/sms/outbox/ack-taken', smsAckTaken);

  // Admin: the queue, and when the phone last asked for work. That second number is
  // the one that matters — pending messages plus a poll from two days ago is a
  // phone that is off, not a server that is broken.
  app.get('/api/admin/sms', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({
      enabled: !!settings.get('sms', 'enabled'),
      gateway_configured: !!process.env.SMS_GATEWAY_KEY,
      last_poll_at: sms.lastPollAt(),
      counts: sms.counts(),
      messages: sms.list({ limit: 30 }),
    });
  });

  app.get('/api/content', (req, res) => {
    res.json({ overrides: content.getPage(req.query.page) });
  });
}

// Content-editor images and writes.
function registerContentUploads(
  app,
  { requireAdmin, express, fs, path, content, templates, CONTENT_IMAGE_UPLOAD_LIMIT }
) {
  // Serve an uploaded content image. The files live in DATA_DIR/content-uploads,
  // which is OUTSIDE SITE_DIR, so express.static never reaches them — this route is
  // the only way out. The name is validated to the exact shape saveImageBytes
  // produces (hash + allowlisted ext), so there is no traversal or arbitrary read.
  app.get('/content-uploads/:name', (req, res) => {
    const name = String(req.params.name || '');
    // Raster only (webp/jpg/png) — SVG is never stored (see content.extFromMagic).
    if (!/^[a-f0-9]{16}\.(webp|jpe?g|png)$/.test(name)) {
      return res.status(404).type('txt').send('Not found');
    }
    const file = path.join(content._uploadDir, name);
    if (!fs.existsSync(file)) return res.status(404).type('txt').send('Not found');
    // Content-addressed names never change contents, so cache hard + immutable.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Defense in depth: never let a browser MIME-sniff an uploaded file into an
    // executable type, so a served image can't be interpreted as HTML/script.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  });

  // Admin: set a text override for page/key (text may be "" to blank the node).
  app.post('/api/admin/content', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { page, key, text } = req.body || {};
    if (!content.pageOk(page) || !content.keyOk(key)) {
      return res.status(400).json({ error: 'bad page or key' });
    }
    content.setText(page, key, text);
    res.json({ ok: true });
  });

  // Admin: remove a page/key override entirely (revert to the shipped default).
  app.delete('/api/admin/content', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { page, key } = req.body || {};
    if (!content.pageOk(page) || !content.keyOk(key)) {
      return res.status(400).json({ error: 'bad page or key' });
    }
    content.remove(page, key);
    res.json({ ok: true });
  });

  // Admin: replace a tagged photo. Multipart upload (fields page,key + a file
  // part) parsed with the same in-repo parser the templates upload uses. The bytes
  // are typed by their magic bytes (not the client name) and saved under a
  // content-hash filename; the override then points every tagged node at it.
  app.post(
    '/api/admin/content/image',
    // Authenticate (on ?key=, available before the body) BEFORE buffering up to
    // several MB, so an unauthenticated client can't force large allocations.
    (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      next();
    },
    express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
    (req, res) => {
      const boundary = templates.boundaryFromContentType(req.headers['content-type']);
      if (!boundary || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'expected multipart/form-data upload' });
      }
      const { fields, files } = templates.parseMultipart(req.body, boundary);
      const page = fields.page;
      const key = fields.key;
      if (!content.pageOk(page) || !content.keyOk(key)) {
        return res.status(400).json({ error: 'bad page or key' });
      }
      const file = files.file || files.image || Object.values(files)[0];
      if (!file || !Buffer.isBuffer(file.data)) {
        return res.status(400).json({ error: 'no image file part' });
      }
      let img;
      try {
        img = content.saveImageBytes(file.data).path;
      } catch (e) {
        return res.status(400).json({ error: String((e && e.message) || e) });
      }
      content.setImg(page, key, img);
      res.json({ ok: true, img });
    }
  );

  // Admin: APPEND a photo to a page/key's photo ARRAY (a product carousel). Same
  // multipart shape + magic-byte typing as the single-image route; the difference
  // is the bytes are pushed onto the key's `imgs` array (not set as its `img`), and
  // the response returns the whole array so the client re-renders the carousel.
  app.post(
    '/api/admin/content/photos',
    (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      next();
    },
    express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
    (req, res) => {
      const boundary = templates.boundaryFromContentType(req.headers['content-type']);
      if (!boundary || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'expected multipart/form-data upload' });
      }
      const { fields, files } = templates.parseMultipart(req.body, boundary);
      const page = fields.page;
      const key = fields.key;
      if (!content.pageOk(page) || !content.keyOk(key)) {
        return res.status(400).json({ error: 'bad page or key' });
      }
      const file = files.file || files.image || Object.values(files)[0];
      if (!file || !Buffer.isBuffer(file.data)) {
        return res.status(400).json({ error: 'no image file part' });
      }
      const before = content.getPhotos(page, key);
      let img, created;
      try {
        ({ path: img, created } = content.saveImageBytes(file.data));
      } catch (e) {
        return res.status(400).json({ error: String((e && e.message) || e) });
      }
      const imgs = content.addPhoto(page, key, img);
      if (imgs == null) {
        // Bad page/key AFTER the file was written — reclaim the orphan, but ONLY if THIS
        // request created it (content-addressed: created:false means the bytes already
        // existed on the volume before us — a pre-existing file we must never delete).
        if (created && !content.isImageReferenced(img)) content.deleteUpload(img);
        return res.status(400).json({ error: 'bad page or key' });
      }
      // The upload was DROPPED (array already at PHOTO_CAP, or a content-hash
      // duplicate) → the array didn't grow. Don't report a false success: delete the
      // just-written orphan — but only when THIS request created the file (created:true)
      // AND nothing else references this shared, content-addressed file.
      if (imgs.length <= before.length) {
        if (created && !content.isImageReferenced(img)) content.deleteUpload(img);
        const atCap = before.length >= content.PHOTO_CAP;
        const error = atCap
          ? `הגעת למקסימום ${content.PHOTO_CAP} תמונות`
          : 'התמונה כבר קיימת בגלריה';
        return res.status(409).json({ error, imgs });
      }
      res.json({ ok: true, img, imgs });
    }
  );

  // Admin: REPLACE a page/key's whole photo array (used for remove + reorder — the
  // client sends the desired full order as JSON `imgs`). Each entry is re-validated
  // server-side to an our-own /content-uploads path, so the array can never point
  // off-origin. An empty array is valid (reverts that carousel to its defaults).
  app.put('/api/admin/content/photos', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { page, key, imgs } = req.body || {};
    if (!content.pageOk(page) || !content.keyOk(key)) {
      return res.status(400).json({ error: 'bad page or key' });
    }
    if (!Array.isArray(imgs)) return res.status(400).json({ error: 'imgs must be an array' });
    const next = content.setPhotos(page, key, imgs);
    if (next == null) return res.status(400).json({ error: 'bad page or key' });
    res.json({ ok: true, imgs: next });
  });
}

// The staging -> production mirrors: content overrides, owner stores, owner templates.
function registerStagingImports(
  app,
  {
    requireAdmin,
    ADMIN_KEY,
    TEMPLATE_ROOT,
    fs,
    settings,
    playbook,
    content,
    contentImport,
    storeImport,
    templateImport,
    designImages,
    wordlists,
  }
) {
  // Admin: the FULL overrides object (every page). The public GET /api/content
  // returns only ONE page; this admin-gated route returns the whole store so the
  // cross-service import below can mirror it. Gated by requireAdmin (unlike the
  // public per-page GET) since it exposes every page's overrides in one shot.
  app.get('/api/admin/content/all', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ overrides: content.getAll() });
  });

  // Admin: one-click import — mirror ALL content overrides from the STAGING service
  // onto THIS one. Staging and prod have SEPARATE volumes, so edits made in staging's
  // editor never reach prod otherwise. Config (PRODUCTION service only — see
  // RAILWAY_SETUP.md): STAGING_URL = the staging base URL; STAGING_ADMIN_KEY = staging's
  // admin key (the two services use DIFFERENT keys, so prod's own ADMIN_KEY can't
  // authenticate against staging — falls back to ADMIN_KEY only when they happen to
  // match). Refuses a self-import (STAGING_URL == this origin) and a missing STAGING_URL;
  // backs up the current store before overwriting; fetches + re-saves every referenced
  // image. Fail-soft: any error leaves the live store intact.
  app.post('/api/admin/content/import-from-staging', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const ownOrigins = [];
    if (process.env.PUBLIC_BASE_URL) ownOrigins.push(process.env.PUBLIC_BASE_URL);
    try {
      ownOrigins.push(req.protocol + '://' + req.get('host'));
    } catch {
      /* no Host header — PUBLIC_BASE_URL still guards the self-import check */
    }
    let result;
    try {
      result = await contentImport.importFromStaging({
        stagingUrl: process.env.STAGING_URL || '',
        ownOrigins,
        adminKey: process.env.STAGING_ADMIN_KEY || ADMIN_KEY || '',
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  });

  // Admin: what another service may mirror FROM this one — the owner-authored
  // stores (settings/prices/emails, playbook, design gallery, word lists). This is
  // the endpoint production calls against staging. Admin-gated and deliberately
  // narrow: owner configuration only, never orders, customers, collected words,
  // owner tokens, or any secret.
  app.get('/api/admin/stores/export', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({
      stores: storeImport.exportAll({ settings, playbook, designImages, wordlists }),
    });
  });

  // Admin: mirror those stores from STAGING onto this service — the destructive
  // twin of the export above, and the counterpart to content/import-from-staging
  // (which moves the content overrides). MIRROR semantics: anything present here
  // but absent on staging is DELETED. So the import refuses an empty payload, backs
  // up every store, and fetches every gallery image BEFORE replacing anything.
  // Same config as the content import: STAGING_URL + STAGING_ADMIN_KEY.
  app.post('/api/admin/stores/import-from-staging', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // Self-import guard, same as the content import: under mirror semantics a
    // STAGING_URL misconfigured to point here is destructive, not a no-op.
    const stagingUrl = process.env.STAGING_URL || '';
    const ownOrigins = [];
    if (process.env.PUBLIC_BASE_URL) ownOrigins.push(process.env.PUBLIC_BASE_URL);
    try {
      ownOrigins.push(req.protocol + '://' + req.get('host'));
    } catch {
      /* no Host header — PUBLIC_BASE_URL still guards the check */
    }
    if (contentImport.isSelfOrigin(stagingUrl, ownOrigins)) {
      return res
        .status(400)
        .json({ error: 'STAGING_URL points at this same service — refusing self-import' });
    }
    let result;
    try {
      result = await storeImport.importFromStaging({
        stagingUrl,
        adminKey: process.env.STAGING_ADMIN_KEY || ADMIN_KEY || '',
        deps: { settings, playbook, designImages, wordlists },
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });

  // Admin: the manifest of THIS service's owner template store — the designs the
  // owner onboarded through the admin UI, which live on the volume
  // (DATA_DIR/templates) and therefore do NOT travel with a deploy. Metadata only:
  // theme entries, recipes, and a {key, rel, bytes, sha256} row per file. The bytes
  // come from the per-file route below, so a store with tens of MB of artwork is
  // never marshalled into one JSON response. Admin-gated; the shipped templates
  // baked into the image are deliberately excluded (the target already has them).
  app.get('/api/admin/templates/export', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let manifest;
    try {
      manifest = templateImport.exportManifest();
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    res.json(manifest);
  });

  // Admin: raw bytes of ONE file named by that manifest. The template key comes in
  // as `template` (not `key`, which is reserved for the admin secret) and the path
  // is resolved strictly inside the owner dir — an unsafe key or path 404s without
  // touching the filesystem. Owner layer only: the image's shipped assets are not
  // reachable through here.
  app.get('/api/admin/templates/export/file', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = templateImport.ownerFilePath(req.query.template, req.query.path);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(404).json({ error: 'not found' });
    }
    res.type('application/octet-stream').sendFile(file);
  });

  // Admin: mirror staging's owner templates onto this service — the third of the
  // staging→prod imports, alongside content (texts + photos) and stores
  // (settings/playbook/gallery/word lists). Neither of those carries a template:
  // a design is a DIRECTORY of SVGs and fonts on the volume, so an owner who
  // onboarded and calibrated a design on staging had no way to get it to
  // production short of re-uploading it by hand.
  //
  // ADDITIVE, unlike the stores mirror: a template that exists only here is left
  // alone, never deleted. Removing one stays an explicit act (DELETE
  // /api/admin/templates/:key). Same config as the other two imports: STAGING_URL
  // + STAGING_ADMIN_KEY, and the same self-import refusal.
  app.post('/api/admin/templates/import-from-staging', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const stagingUrl = process.env.STAGING_URL || '';
    const ownOrigins = [];
    if (process.env.PUBLIC_BASE_URL) ownOrigins.push(process.env.PUBLIC_BASE_URL);
    try {
      ownOrigins.push(req.protocol + '://' + req.get('host'));
    } catch {
      /* no Host header — PUBLIC_BASE_URL still guards the check */
    }
    if (contentImport.isSelfOrigin(stagingUrl, ownOrigins)) {
      return res
        .status(400)
        .json({ error: 'STAGING_URL points at this same service — refusing self-import' });
    }
    let result;
    try {
      result = await templateImport.importFromStaging({
        stagingUrl,
        adminKey: process.env.STAGING_ADMIN_KEY || ADMIN_KEY || '',
        // OUR shipped designs, so a staging entry carrying only metadata (a renamed
        // shipped template — no artwork by design) is accepted rather than aborting
        // the whole import.
        templateRoot: TEMPLATE_ROOT,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });
}

// Ad attribution and the Meta Conversions API, owner settings, the WhatsApp bot
// routes, message previews and the public feature flags. Returns the Meta helpers
// the payment routes call and the webhook helpers index.js exports for tests.
function registerAdsSettingsWhatsapp(
  app,
  {
    requireAdmin,
    paymentBaseUrl,
    clientKey,
    makeRateLimiter,
    db,
    settings,
    attribution,
    metaCapi,
    metaInsights,
    notify,
    whatsapp,
    waState,
    messagePreview,
    handleWaEvent,
    openWhatsappGroup,
    ilPhoneToWaId,
    resolveProductImageUrl,
  }
) {
  // --- Ad attribution (first-party) --------------------------------------------
  // The site's own answer to "which ad produced this order", independent of GA4
  // and of Meta's Ads Manager. The browser (site/js/attribution.js) remembers the
  // landing URL it arrived on and replays it with each funnel event; the parsing
  // and the money both happen HERE, so a page can neither invent a campaign nor
  // declare a revenue figure.

  // Its own bucket, generous: this is one small POST per visitor per session (plus
  // two per buyer), and a measurement call must never be the thing that 429s a
  // real shopper. The cap exists only to stop a script pointed at the endpoint
  // from filling the ledger.
  const trackRate = makeRateLimiter({
    limit: Number(process.env.TRACK_RATE_LIMIT || 60),
    windowMs: 60 * 1000,
    maxKeys: Number(process.env.COUPON_RATE_MAX_KEYS || 10000),
  });

  // Is the Conversions API armed? One answer, so the capture, the send and the
  // status card cannot disagree about it.
  function metaCapiArmed() {
    return metaCapi.isArmed({
      pixelId: settings.get('analytics', 'meta_pixel_id'),
      token: process.env.META_CAPI_TOKEN || '',
    });
  }

  /**
   * Everything about the BUYER's own request that the sale will need later, taken
   * at the one moment they are certainly present: the pay/init they made to open
   * the payment.
   *
   * Meta needs this. A website event is documented as requiring client_user_agent
   * and event_source_url, and matching leans on the IP and on Meta's own _fbc /
   * _fbp cookies — all of which are properties of a browser, and none of which
   * exist in the PeleCard callback that actually tells us the sale happened. So
   * they are captured here and carried forward.
   *
   * Returns null when the API is not armed: a shop that never reports to Meta has
   * no business storing a buyer's IP address.
   */
  function metaAdContext(req, body = {}) {
    if (!metaCapiArmed()) return null;
    const cookies = metaCapi.fbCookies(req.headers && req.headers.cookie);
    return {
      ip: clientIpForMeta(req),
      ua: String(req.get('user-agent') || '').slice(0, 500),
      // Meta's cookies as the browser holds them. The _fbc one carries Meta's OWN
      // click timestamp, which is why it is always preferred over one we rebuild.
      fbc: String(cookies.fbc || '').slice(0, 255),
      fbp: String(cookies.fbp || '').slice(0, 255),
      // THE CLICK ID ONLY — never the URL it came in. The landing URL a browser
      // replays is whatever page it first arrived on, and on this site that is
      // very often collect.html?c=…&k=<owner_token>: the buyer's own credential,
      // which reads and WRITES her order. It is not stored and it is not sent.
      fbclid: metaCapi.fbclidFrom(body.landing),
      // Required for a website event, and stripped of its query for the same
      // reason: the page that starts a payment here carries that token, and a
      // browser's default Referrer-Policy hands us the whole thing.
      source_url: metaCapi.pageUrl(body.source_url || req.get('referer') || ''),
      // When WE saw this click. Not the click itself (the touch the browser
      // replays carries no timestamp of its own), but the start of a checkout is
      // far closer to it than the payment is, and it is the earliest instant we
      // can prove.
      seen_at: Date.now(),
    };
  }

  // An address that is nobody's on the public internet: loopback, the private
  // ranges, link-local, and IPv6's unique-local block. Sending one to Meta is
  // worse than sending nothing, since Meta would try to MATCH on it — every buyer
  // behind the same office NAT looking like the same person, and 127.0.0.1 (a
  // local run, a health check) looking like everybody.
  function isNonPublicIp(ip) {
    if (!ip) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (v4) {
      const o = v4.slice(1, 5).map(Number);
      // FOUR DOTTED NUMBERS IS NOT AN ADDRESS. The shape alone would pass
      // 999.1.1.1 and 256.0.0.1 straight through to Meta as a match key, because
      // no range test below can fire on an octet that cannot exist.
      if (o.some((n) => n > 255)) return true;
      const [a, b] = o;
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 169 && b === 254) return true; // link-local / cloud metadata
      if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
      // Multicast (224/4) and reserved (240/4, and 255.255.255.255 inside it) are
      // as much nobody's address as 10/8 is.
      if (a >= 224) return true;
      return false;
    }
    if (!ip.includes(':')) return true; // not an address at all
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link-local
    return /^[0-9a-f:.]+$/.test(v6) ? false : true;
  }

  // The buyer's address as Meta should see it.
  //
  // req.ip is the LEFTMOST X-Forwarded-For entry, because app.set('trust proxy',
  // true) tells Express every hop in that header is trustworthy — and Cloudflare
  // APPENDS to X-Forwarded-For rather than replacing it, so anything a client puts
  // there arrives ahead of the address Cloudflare actually saw. A client could
  // therefore CHOOSE the address we hand to an ad platform as the buyer's, and
  // have every one of its sales attributed to somebody else's neighbourhood.
  //
  // So this field prefers the header a caller is least likely to be able to set:
  //   • CF-Connecting-IP. Cloudflare writes it itself and overwrites whatever
  //     arrived under that name, so for a request that came through Cloudflare —
  //     which is every request to the site's own domain — it is the real client;
  //   • with no Cloudflare header AND no X-Forwarded-For, req.ip is the socket
  //     peer, which nobody but the peer can decide. That is the local run;
  //   • an X-Forwarded-For with no CF-Connecting-IP means SOMETHING proxied this
  //     and we cannot tell a proxy's word from a client's. Send nothing. Meta
  //     always has external_id to match on, so the sale still counts.
  //
  // WHAT THIS IS NOT: proof. Nothing here verifies the request came through
  // Cloudflare — the origin stays reachable on its own generated host, and a caller
  // that posts pay/init straight there with a CF-Connecting-IP of its choosing and
  // no X-Forwarded-For is believed. Verifying it properly means checking that the
  // hop which handed us the request really was Cloudflare, and the peer this
  // process sees is Railway's proxy rather than Cloudflare's edge — so the check
  // cannot be written WITHOUT the trust-proxy change below. With a hop count set,
  // the RIGHTMOST X-Forwarded-For entry is the one the last trusted hop appended,
  // which is Cloudflare's edge address, and that is range-checkable. Until then
  // this narrows the spoofable surface from "any request" to "a request that skips
  // the front door"; it does not close it, and neither this comment nor
  // RAILWAY_SETUP.md claims it does.
  //
  // Narrowing `trust proxy` from `true` to a hop count is the deeper fix and is
  // not this function's to make: it also governs the rate limiters and the
  // abuse-facing client key, and getting the count wrong there breaks those.
  function clientIpForMeta(req) {
    const usable = (raw) => {
      const ip = String(raw || '')
        .trim()
        .slice(0, 45);
      const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      return isNonPublicIp(bare) ? '' : bare;
    };
    const cf = usable(req.get('cf-connecting-ip'));
    if (cf) return cf;
    if (req.get('x-forwarded-for')) return '';
    return usable(req.ip);
  }

  /**
   * Report one paid order to Meta's Conversions API.
   *
   * CALLED FROM THE PAYMENT ITSELF — the PeleCard callback and the free-coupon
   * path — not from the buyer's browser. That is the entire point of a server-side
   * report: a buyer who closes the tab before the confirmation page renders has
   * still bought the deck, and Meta has to be told. The confirmation page's
   * /api/track calls this too, as the fallback for an order paid by some other
   * route; db.claimMetaReport lets exactly one of them through.
   *
   * Fire-and-forget and fail-soft: a failure is logged and nothing else — an ad
   * platform that cannot be reached must never affect an order that already
   * happened.
   */
  function sendPurchaseToMeta(collectionId, ctx = null, { preclaimed = false } = {}) {
    const pixelId = settings.get('analytics', 'meta_pixel_id');
    const token = process.env.META_CAPI_TOKEN || '';
    if (!metaCapi.isArmed({ pixelId, token })) return;
    const c = db.getCollection(collectionId);
    if (!c || !c.order || !c.order.paid) return;
    // Once per paid order, whichever path gets here first. `preclaimed` is the
    // payment paths, where markPaid took the claim inside the write it was doing
    // anyway rather than adding a second one to the hot path of a charge.
    if (!preclaimed && !db.claimMetaReport(collectionId)) return;
    const orderNo = db.orderRef(c);
    // The amount is read from the order store, never from a caller.
    const value = c.order.charged_total != null ? c.order.charged_total : c.order.total;
    // What we captured at pay/init, refreshed by anything the caller can add.
    // Only a REAL value overrides: the confirmation page knows the click id but
    // not the cookies, the callback knows the cookies but not the click id, and an
    // empty string from either must not erase what the other one had.
    const a = { ...((c.order.pelecard && c.order.pelecard.meta_ctx) || {}) };
    for (const [k, v] of Object.entries(ctx || {})) if (v) a[k] = v;
    // Contact matching is the owner's call and ships OFF: it is the only part of
    // this payload that describes a person rather than a purchase.
    const contact = settings.get('analytics', 'meta_capi_contact')
      ? { email: c.owner_email, phone: c.owner_phone }
      : {};
    const event = metaCapi.purchaseEvent({
      orderNo,
      value,
      fbclid: a.fbclid || '',
      sourceUrl: a.source_url || paymentBaseUrl(),
      fbp: a.fbp || '',
      fbc: a.fbc || '',
      ip: a.ip || '',
      userAgent: a.ua || '',
      // Our own id for the sale, so user_data is never empty even for the buyer
      // whose browser gave Meta nothing — the buyer this whole feature is for.
      externalId: orderNo,
      clickAt: Number(a.seen_at) || 0,
      // WHEN THE SALE HAPPENED, not when we got round to telling Meta. A report
      // resurrected by the boot sweep can leave days after the payment, and
      // stamping it with the send would present a six-day-old sale as happening at
      // boot — which is also what makes the seven-day age limit in
      // db.staleMetaReports able to do its job: Meta rejects an event whose
      // event_time is outside its window, and event_time is this.
      at: Date.parse(c.order.paid_at) || Date.now(),
      contact,
    });
    // RETURNED, not fired and forgotten. Nothing on the payment path waits for
    // this — the whole point is that a charge never blocks on an ad platform — but
    // the sweep has to be able to pace itself, and it cannot pace what it cannot
    // await.
    return metaCapi
      .send({ pixelId, token, testCode: process.env.META_CAPI_TEST_CODE || '', event })
      .then((r) => {
        if (r.skipped) return;
        if (r.ok) return db.finishMetaReport(collectionId, { ok: true });
        console.error(
          '[meta-capi] ' + orderNo + ': ' + r.error + (r.code ? ' (code ' + r.code + ')' : '')
        );
        // A REFUSAL AND A FAILURE ARE DIFFERENT THINGS. A timeout, a dead network
        // or a 5xx is worth trying again. A 4xx is Meta telling us the request
        // itself is wrong — a revoked token, a pixel that no longer exists — and
        // retrying it on every confirmation-page load until someone notices just
        // burns a whole-store write per reload for an answer that cannot change.
        db.finishMetaReport(collectionId, { permanent: isPermanentMetaError(r), error: r.error });
      })
      .catch((e) => {
        console.error('[meta-capi] ' + orderNo + ': ' + ((e && e.message) || e));
        db.finishMetaReport(collectionId, { error: String((e && e.message) || e) });
      });
  }

  // Meta's error codes for failures that a later attempt CAN come out of.
  //
  // THE CLASSIFICATION IS MADE ON THE CODE, NOT ON THE HTTP STATUS. Meta's own
  // error reference is explicit about what to branch on — "Error handling should
  // be done using only the Error Codes" — and the Conversions API documents only
  // that an invalid payload comes back as "4xx HTTP", with no promise about WHICH
  // 4xx, so the status cannot separate a refusal from a "not right now". The two
  // things most likely to actually go wrong here are both in that ambiguous zone:
  //   • throttling. Meta's rate limits are identified by code, not by 429:
  //     4 (app level), 17 (user level) and 32 (page level) per the Graph API
  //     rate-limiting docs, 613 the ad-account limit, and 80000–80014 the
  //     business-use-case series (80004 is the ads one);
  //   • an access token that is expired, revoked or scoped wrong — 190, an
  //     OAuthException. That is the single most likely mistake the first time the
  //     owner arms the API, and writing it off as permanent would lose every sale
  //     made in that window even after she fixes the token.
  //   • 1, 2, 341 and 368 are Meta's own documented "temporary, wait and retry".
  // 429 and 408 stay transient too: nothing says Meta never sends them, and if it
  // does they mean exactly what they say.
  const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 190, 341, 368, 613]);

  // Will trying this again ever produce a different answer? Anything that is not a
  // 4xx — a timeout, a dead socket, a 5xx — is theirs and worth retrying, and so
  // is a 4xx whose code says "later" rather than "no".
  function isPermanentMetaError(r) {
    const s = Number(r && r.status);
    if (!(s >= 400 && s < 500)) return false;
    if (s === 429 || s === 408) return false;
    const code = Number(r && r.code);
    if (META_TRANSIENT_CODES.has(code)) return false;
    // Business-use-case rate limits: one code per API surface, 80000–80014.
    if (code >= 80000 && code <= 80014) return false;
    // Any auth failure at all is a credential that can be replaced, whatever code
    // Meta files it under.
    if (String((r && r.type) || '') === 'OAuthException') return false;
    return true;
  }

  // Reports that were claimed and never finished: the process died between taking
  // the claim and hearing back from Meta — a deploy inside the six-second timeout
  // is all it takes. Without this the order would sit there marked as claimed
  // forever, and for the buyer this feature exists for (the one who closed the tab
  // and never loads a confirmation page) NOTHING else would ever come back for it.
  //
  // Delayed and unref'd so it never delays a boot or holds the process open.
  const META_SWEEP_MAX = Number(process.env.META_CAPI_SWEEP_MAX || 100);
  const META_SWEEP_CONCURRENCY = Number(process.env.META_CAPI_SWEEP_CONCURRENCY || 4);

  // A FEW AT A TIME, NOT ALL OF THEM AT ONCE.
  //
  // Firing the whole batch in one synchronous loop is wrong twice over. Each
  // send's six-second abort timer is armed when send() is CALLED, before any of
  // them has a socket, so everything queued behind the connection pool can abort
  // as a self-inflicted timeout — a transient failure that burns a `tries`
  // increment and pushes a perfectly healthy order into backoff. And every
  // response that lands writes the whole store, so a big batch is that many
  // synchronous full-file writes back to back.
  //
  // Draining a few in flight at a time fixes both: nothing waits on the pool long
  // enough to time out on us, and the writes are spread across the drain instead
  // of arriving as one block. It does not make them fewer — that would mean
  // collecting outcomes and finishing them in one write, which means the send path
  // no longer recording its own result — so the batch is capped as well.
  function drainMetaReports(ids) {
    const queue = ids.slice();
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          await sendPurchaseToMeta(id, null, { preclaimed: true });
        } catch (e) {
          console.error('[meta-capi] sweep ' + id + ': ' + ((e && e.message) || e));
        }
      }
    };
    const lanes = Math.max(1, Math.min(META_SWEEP_CONCURRENCY, queue.length));
    return Promise.all(Array.from({ length: lanes }, worker));
  }

  function sweepUnfinishedMetaReports({ limit = 50 } = {}) {
    if (!metaCapiArmed()) return 0;
    // THE WHOLE BATCH IS CLAIMED UNDER ONE WRITE. Letting sendPurchaseToMeta take
    // its own claim per order would be one whole-store write per order — hundreds
    // of milliseconds each at real order counts — twenty seconds after boot, on a
    // box that is already answering requests. The cap is what bounds the rest: the
    // finishes cannot be batched the same way, so a pass is never allowed to be
    // enormous however many the caller asks for. Whatever is left comes back on
    // the next pass, and the retry route reports it as `remaining`.
    const ids = db.claimMetaReports(
      db.staleMetaReports({ limit: Math.min(limit, META_SWEEP_MAX) })
    );
    drainMetaReports(ids).catch((e) =>
      console.error('[meta-capi] sweep: ' + ((e && e.message) || e))
    );
    if (ids.length)
      console.log('[meta-capi] sweep: retrying ' + ids.length + ' unfinished report(s)');
    return ids.length;
  }

  // The buyer's device details, aged out. See db.sweepMetaCtx for why they need a
  // life independent of the report: the abandoned checkout that never produces one
  // at all, and the failed report that has aged past the retry window, are both
  // invisible to finishMetaReport and would otherwise be kept forever.
  //
  // Runs whether or not the API is armed — details captured while it WAS armed
  // must still age out after the token is taken away — and repeats, because a box
  // that stays up for weeks would otherwise sweep once and then never again.
  function sweepMetaCtx() {
    const n = db.sweepMetaCtx();
    if (n) console.log('[meta-capi] dropped stored device details for ' + n + ' order(s)');
    return n;
  }
  // WHAT ACTUALLY WAKES THESE UP.
  //
  // The report sweep needs a REPEATING trigger, not just a boot one. A failed
  // report now waits before its next try, and the longest wait is six hours — but
  // nothing was scheduled to come back when that wait expired. On a box that runs
  // untouched for days (deploys here are manual) the only re-claim triggers were
  // the next boot and a buyer reloading their own confirmation page, so a handful
  // of orders parked at a six-hour backoff would simply sit there until the
  // seven-day age gate dropped them for good. Hourly is well under that longest
  // wait, and a pass with nothing to do costs one filtered scan and no write.
  //
  // Every timer is unref'd, so none of them delays a boot or holds the process
  // open, and the intervals are what keep a long-lived box sweeping rather than
  // sweeping once and never again.
  function armMetaCapiTimers({ setTimeoutFn = setTimeout, setIntervalFn = setInterval } = {}) {
    const timers = [
      setTimeoutFn(sweepUnfinishedMetaReports, Number(process.env.META_CAPI_SWEEP_MS || 20000)),
      setIntervalFn(
        sweepUnfinishedMetaReports,
        Number(process.env.META_CAPI_SWEEP_EVERY_MS || 3600 * 1000)
      ),
      setTimeoutFn(sweepMetaCtx, Number(process.env.META_CTX_SWEEP_MS || 30000)),
      setIntervalFn(sweepMetaCtx, Number(process.env.META_CTX_SWEEP_EVERY_MS || 6 * 3600 * 1000)),
    ];
    for (const t of timers) if (t && typeof t.unref === 'function') t.unref();
    return timers;
  }
  if (process.env.NODE_ENV !== 'test') armMetaCapiTimers();
  // The seam the tests drive it through, since the boot timer is deliberately not
  // armed under NODE_ENV=test — a suite that booted the app should not start
  // firing at an ad platform.
  app.locals.metaCapiSweep = sweepUnfinishedMetaReports;
  app.locals.metaCtxSweep = sweepMetaCtx;
  app.locals.metaCapiArmTimers = armMetaCapiTimers;

  app.post('/api/track', (req, res) => {
    if (!trackRate.ok(clientKey(req))) return res.status(429).json({ error: 'too many attempts' });
    const body = req.body || {};
    const kind = String(body.kind || '');
    let value;
    let orderNo;
    // A purchase is the only kind that carries money, and the browser supplies
    // none of it. It names an order it can prove it owns (the same collection id +
    // owner token the confirmation page already holds for the summary), and the
    // amount, the order number and the fact of payment are read from the order
    // store. An unpaid or unprovable order records nothing at all.
    let order = null;
    if (kind === 'purchase') {
      const c = db.getCollection(String(body.collection || ''));
      if (!c || !c.order || !c.order.paid) return res.status(204).end();
      if (!body.k || body.k !== c.owner_token) return res.status(204).end();
      value = c.order.charged_total != null ? c.order.charged_total : c.order.total;
      orderNo = db.orderRef(c);
      order = c;
    }
    const landing = String(body.landing || '').slice(0, 2000);
    attribution.record({
      kind,
      landing,
      referrer: String(body.referrer || '').slice(0, 500),
      visitor: body.visitor,
      order_no: orderNo,
      value,
      // How the order was PLACED, when the wizard recorded it. The confirmation page
      // is often opened on another device, from one of our own emails, and that
      // browser's touch would credit the sale to the inbox instead of the ad.
      arrival: order ? order.arrival : undefined,
    });
    // Meta's copy of the same sale — the FALLBACK half. The report that matters
    // left from the payment itself (see sendPurchaseToMeta), because a buyer who
    // closed the tab before this page rendered has still bought the deck. This
    // path only catches an order that reached paid by some route the callback
    // never saw, and db.claimMetaReport makes sure only one of them sends.
    //
    // It is still worth having: when the confirmation page DOES load it carries
    // things the callback could not — the landing URL out of the buyer's own
    // storage, the _fbp of a browser that never sent us a cookie.
    //
    // Not awaited. The buyer is waiting for a 204 on their confirmation page, and
    // whether Meta accepted the event is no business of theirs.
    if (kind === 'purchase' && order) {
      const cookies = metaCapi.fbCookies(req.headers && req.headers.cookie);
      sendPurchaseToMeta(order.id, {
        // The click id on its own and the page URL without its query — the same
        // rule as the capture at pay/init, for the same reason: both of these
        // arrive here carrying the buyer's owner token.
        fbclid: metaCapi.fbclidFrom(landing),
        source_url: metaCapi.pageUrl(body.source_url || ''),
        fbp: String(body.fbp || cookies.fbp || '').slice(0, 255),
        fbc: String(cookies.fbc || '').slice(0, 255),
        ip: clientIpForMeta(req),
        ua: String(req.get('user-agent') || '').slice(0, 500),
      });
    }
    // 204 always, even for a refused event: this endpoint tells a caller nothing
    // about what it stored, and a measurement beacon has no use for an answer.
    res.status(204).end();
  });

  // Admin: the report — one row per campaign over the last N days, plus the feed
  // of the last events for the live view.
  // Admin: is the server-side reporting to Meta actually switched on? The token
  // is an environment secret and is never returned — only whether it is there, so
  // the admin page can say "armed" or "the token is missing" instead of leaving
  // the owner to guess why Ads Manager still under-reports.
  app.get('/api/admin/meta-capi/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const pixelId = settings.get('analytics', 'meta_pixel_id');
    res.json({
      armed: metaCapi.isArmed({ pixelId, token: process.env.META_CAPI_TOKEN || '' }),
      has_pixel: Boolean(pixelId),
      has_token: Boolean(process.env.META_CAPI_TOKEN),
      test_mode: Boolean(process.env.META_CAPI_TEST_CODE),
      contact_matching: Boolean(settings.get('analytics', 'meta_capi_contact')),
      graph_version: metaCapi.GRAPH_VERSION,
      // A failed report now WAITS before trying again, which means it can be
      // quietly failing for hours. Without these the scenario the retry logic was
      // built for — a token that is expired or scoped wrong — runs invisibly:
      // `failing` with a plausible `oldest_error` is the owner's signal to look at
      // the token, and `permanent` is the signal to call /retry after fixing it.
      reports: db.metaReportCounts(),
    });
  });

  // Which ad account to report on. Normally NEITHER of these is set: with one ad
  // account behind the token there is nothing to choose and it is discovered. The
  // saved admin setting wins over the environment, because it is the one the owner
  // can change without a redeploy; META_AD_ACCOUNT_ID exists so that an account
  // pinned on Railway alongside the token actually takes effect (it was documented
  // as a variable before anything read it).
  //
  // The two are reported to the page SEPARATELY as well as combined: emptying the
  // admin field does not mean "discover it again" when the environment still names
  // an account, and a page that said so would be telling the owner something she
  // can see with her own eyes is untrue.
  // `act_` comes off case-insensitively and however many times it was pasted:
  // Ads Manager shows `act_99887766`, and both a copied prefix and a shouted one
  // would otherwise build `act_act_99887766` / `act_ACT_99887766` into the Graph
  // path, which fails as a bad account rather than as a bad paste.
  const stripAct = (v) =>
    String(v || '')
      .trim()
      .replace(/^(act_)+/i, '');
  const metaAdAccountSaved = () => stripAct(settings.get('analytics', 'meta_ad_account_id'));
  const metaAdAccountEnv = () => stripAct(process.env.META_AD_ACCOUNT_ID);
  function metaAdAccountId() {
    return metaAdAccountSaved() || metaAdAccountEnv();
  }

  // Admin: Meta's own per-ad numbers — spend above all, since that is the half of
  // ROAS no first-party ledger can ever see. Same token as the Conversions API,
  // which needs ads_read on the account as well; a token without it comes back
  // with Meta's own message rather than a bare failure, because "(#200) Requires
  // ads_read permission" tells the owner exactly which token to make.
  app.get('/api/admin/ads/meta', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const days = Math.min(Math.max(1, Number(req.query.days) || 30), 400);
    const accountId = metaAdAccountId();
    const result = await metaInsights.cachedInsights({
      token: process.env.META_CAPI_TOKEN || '',
      accountId,
      days,
    });
    // A shallow copy: `result` may be the object sitting in the module's cache, and
    // the per-request numbers below must not be written into it.
    const out = {
      ...result,
      // What the admin field holds, and what the environment holds, as two separate
      // answers — the page has to be able to say which of them is in force.
      account_setting: metaAdAccountSaved(),
      account_env: metaAdAccountEnv(),
    };
    if (result.ok) {
      // OUR half of the blended line, cut at the SAME INSTANT Meta's window opens.
      // Meta counts whole calendar days in the ad account's timezone; report() is a
      // rolling now-minus-N-days cutoff. Left alone, ours runs ~9-24h longer than
      // Meta's and the division is of unlike windows. report()'s cutoff is
      // now - days*24h, so handing it a `now` of since_ms + the span puts the cut
      // exactly on Meta's opening instant; both sides then end at the present
      // moment, which is as far as either has data.
      const ours = attribution.report({
        days: result.days,
        now: result.since_ms + result.days * 24 * 60 * 60 * 1000,
      });
      // META's revenue over META's spend — not the whole site's. isPaid is handed
      // over rather than re-implemented so "cost money" keeps one definition.
      //
      // This is an ESTIMATE and it errs in both directions — see metaAttributed().
      // The part of it that came in on a deliberately tagged link is separated out,
      // because that half cannot be organic and is therefore the half the owner can
      // lean on. The page shows the split rather than calling the total a floor.
      const mine = metaInsights.metaAttributed(ours.rows, attribution.isPaid);
      out.ours = {
        revenue: mine.revenue,
        orders: mine.orders,
        rows: mine.matched,
        // Arrived on an ad's own link — it carried a campaign or an ad name. Near
        // certain, not certain: that address travels the moment somebody pastes it
        // on into a group chat, and brings its campaign with it.
        tagged: mine.tagged,
        // A Meta click id and nothing else. Facebook and Instagram put one on every
        // outbound link, so an organic post's clicks are in here too.
        untagged: mine.untagged,
        // Every source, for context only: the gap between the two is what says
        // how much of the shop's takings the ads are even being credited with.
        revenue_all: ours.totals.revenue,
        orders_all: ours.totals.orders,
      };
      out.roas =
        result.totals.spend > 0
          ? Math.round((mine.revenue / result.totals.spend) * 100) / 100
          : null;
    }
    res.json(out);
  });

  // Admin: hand the sales written off as "Meta will refuse this every time" back
  // for another try.
  //
  // The recovery path this exists for is the obvious one: the API is armed for the
  // first time with a token that is expired or scoped wrong, every sale in that
  // window is marked final, and fixing the token recovers nothing on its own —
  // claimMetaReport refuses, the boot sweep excludes them, and there is no other
  // door. (Error 190 is no longer classified as permanent, so that particular
  // mistake should not reach here any more; this is the escape hatch for the ones
  // that still do.) Clearing the mark makes them claimable again and runs the
  // sweep, which re-sends anything paid inside Meta's seven-day window. The device
  // details were dropped when the failure was recorded, so a recovered report
  // carries the order number and the money but weaker match keys.
  app.post('/api/admin/meta-capi/retry', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const cleared = db.clearPermanentMetaReports({ id: String((req.body || {}).collection || '') });
    // SWEEP AS MANY AS WE CLEARED. The default sweep cap is fifty and the clear cap
    // is five hundred, so taking the default here would hand back 450 sales that
    // are claimable but scheduled by nothing — they would trickle out fifty at a
    // time on later boots, and the response would not have said so. `remaining` is
    // what the cap did leave, so the owner knows to call again rather than guess.
    const swept = sweepUnfinishedMetaReports({ limit: Math.max(50, cleared.length) });
    res.json({
      cleared: cleared.length,
      ids: cleared,
      swept,
      remaining: db.staleMetaReports({ limit: Number.MAX_SAFE_INTEGER }).length,
    });
  });

  app.get('/api/admin/ads', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const days = Math.min(Math.max(1, Number(req.query.days) || 30), 400);
    res.json({
      ...attribution.report({ days }),
      // THE PUBLIC ADDRESS OF THE SITE, for the link builder on this page.
      //
      // It cannot use the address the admin is open at: the owner reaches the
      // admin through the Railway hostname as often as through the real domain,
      // and a link built there carried *.up.railway.app into her Instagram bio.
      // That link works, which is the worst part of it — nothing would have said
      // it was wrong. The server is the only party that knows which name the
      // public site answers to.
      base_url: paymentBaseUrl(),
    });
  });
  app.get('/api/admin/ads/live', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ events: attribution.recent(Number(req.query.limit) || 60) });
  });
  // Admin: hide, or stop hiding, ONE row of the report table, named by its four
  // fields [source, medium, campaign, content]. Display only — a hidden row still
  // counts in every total — and a paid row is refused (see attribution.setRowHidden).
  app.post('/api/admin/ads/hidden', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = req.body || {};
    const out = attribution.setRowHidden(body.row, body.hidden);
    if (out.error) {
      return res.status(out.error === 'could not save' ? 500 : 400).json({ error: out.error });
    }
    res.json(out);
  });

  // Save the ledger when the process is asked to stop. Events are queued in memory
  // for up to a second and a half so that a burst of ad traffic is not a burst of
  // whole-file writes — and Railway ends the old container with SIGTERM on every
  // single deploy. Node's default action for that signal is to die immediately,
  // running no exit handler, so without this the last events before every deploy
  // are simply gone, and a deploy is exactly when the owner is watching the page.
  //
  // flush() is synchronous from end to end, which is what makes it usable here:
  // there is no await to be cut short, and it cannot interleave with the queued
  // write it is racing (that one publishes synchronously too, and skips a snapshot
  // that has been overtaken). Handling the signal is also what now decides that
  // the process ends at all — nothing else in the app listens — hence the explicit
  // exit with the conventional code for each signal.
  let stopping = false;
  function stopWithSignal(code) {
    if (stopping) return;
    stopping = true;
    try {
      attribution.flush();
    } catch {
      /* a counting ledger is never a reason to hold up a shutdown */
    }
    process.exit(code);
  }
  process.once('SIGTERM', () => stopWithSignal(143));
  process.once('SIGINT', () => stopWithSignal(130));
  // Any other way out (an explicit exit elsewhere, a fatal error) still gets the
  // queue written. A second call with nothing new to say writes nothing.
  process.once('exit', () => {
    try {
      attribution.flush();
    } catch {
      /* nothing left to do about it at this point */
    }
  });

  // Admin: owner-editable message templates + settings. The email subject/body
  // templates, the editable label maps and the WhatsApp trigger catalog all live
  // in server/settings.js (a DATA_DIR store overlaying the registry defaults). The
  // GET returns defaults + overrides + effective values + the registry (tokens +
  // kind per key) so the admin page can render an editor; POST stores one override,
  // DELETE resets one key back to its default. All behind the admin key.
  app.get('/api/admin/settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(settings.all());
  });
  app.post('/api/admin/settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { section, key, value } = req.body || {};
    if (!settings.hasKey(section, key)) {
      return res.status(400).json({ error: 'unknown section/key' });
    }
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    // Reject a value whose SHAPE doesn't match the registry default (null/array/
    // string for an object key, a non-string subject/body, etc.) BEFORE it can
    // reach the store — a bad override would break live email rendering. The store
    // is left untouched on a rejected write.
    const shapeError = settings.validateValue(section, key, value);
    if (shapeError) return res.status(400).json({ error: shapeError });
    res.json({ effective: settings.set(section, key, value) });
  });
  app.delete('/api/admin/settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    // section/key come from the body, but fall back to the query string: many HTTP
    // clients/proxies drop a DELETE request body, which would otherwise make reset
    // silently 400 and leave a broken override un-clearable. NOTE: the `key` query
    // param is reserved for the admin secret (requireAdmin), so the settings key
    // uses `settingKey` to avoid a collision.
    const body = req.body || {};
    const section = body.section != null ? body.section : req.query.section;
    const key = body.key != null ? body.key : req.query.settingKey;
    if (!settings.hasKey(section, key)) {
      return res.status(400).json({ error: 'unknown section/key' });
    }
    res.json({ effective: settings.reset(section, key) });
  });

  // WhatsApp bot inbound webhook (Whapi Cloud). Point Whapi's webhook at
  // /api/whatsapp/webhook?secret=<WHAPI_WEBHOOK_SECRET>. DORMANT until armed:
  // verifies the shared secret (timing-safe) first — a missing/mismatched secret,
  // or a bot with no secret configured, is rejected 403 with no work; when the bot
  // isn't fully armed we accept but do nothing. Otherwise every parsed event is
  // handled fail-soft (a bad event or a Whapi send failure never throws out of the
  // route and never breaks the rest of the batch), and we ALWAYS answer 200 so
  // Whapi doesn't retry-storm.
  // Mirror (copy) an inbound WhatsApp webhook to ANOTHER environment's webhook, so a
  // group created there can also collect words — e.g. production forwards a copy to
  // staging. One Whapi channel delivers to ONE URL (production), but a group's
  // collection mapping lives only in the service that CREATED it; forwarding a copy
  // lets each environment act on its OWN groups (an unmapped group is already a
  // no-op, so a copy of prod's real traffic is silently ignored by staging and never
  // stored there). Fire-and-forget: never blocks or fails the webhook response. The
  // `mirror=1` marker on the forwarded URL stops the copy from being re-forwarded (no
  // ping-pong loops) — so set WHATSAPP_MIRROR_WEBHOOK_URL ONLY on the entry
  // environment (production), pointing at staging's webhook (with staging's secret).
  const WHATSAPP_MIRROR_WEBHOOK_URL = process.env.WHATSAPP_MIRROR_WEBHOOK_URL || '';
  function mirrorWebhook(req) {
    try {
      if (!WHATSAPP_MIRROR_WEBHOOK_URL) return;
      const q = req.query || {};
      if (q.mirror === '1' || q.mirror === 'true') return; // this IS a mirror — don't re-forward
      const sep = WHATSAPP_MIRROR_WEBHOOK_URL.includes('?') ? '&' : '?';
      const url = WHATSAPP_MIRROR_WEBHOOK_URL + sep + 'mirror=1';
      const fetchImpl = typeof fetch !== 'undefined' ? fetch : null;
      if (!fetchImpl) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: controller.signal,
      })
        .catch(() => {})
        .finally(() => clearTimeout(timer));
    } catch {
      /* a mirror failure must never break the webhook */
    }
  }

  // Should we log a 0-event webhook's shape? Scoped so routine traffic (status
  // receipts, our own from_me echoes, plain text) never spams — but a "member added"
  // is captured whether Whapi delivers it as a GROUP event OR as a system `messages`
  // action. True when the body has a group/participant key, OR carries an inbound
  // (not from_me) NON-text message that parseWebhook dropped (a system/action event).
  function isGroupWebhook(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (Object.keys(body).some((k) => /group|participant/i.test(k))) return true;
    if (Array.isArray(body.messages)) {
      return body.messages.some((m) => m && !m.from_me && m.type && m.type !== 'text');
    }
    return false;
  }

  // Structure-only fingerprint of a webhook body for diagnostics: top-level keys ->
  // (for an array of objects) the keys of the first element, else the value's type.
  // Emits field NAMES only — never message text, phone numbers or names — so an
  // unhandled inbound reveals its shape without leaking any content.
  function webhookShape(body) {
    if (!body || typeof body !== 'object') return typeof body;
    const out = {};
    for (const k of Object.keys(body)) {
      const v = body[k];
      if (Array.isArray(v)) {
        out[k] =
          v[0] && typeof v[0] === 'object' ? '[{' + Object.keys(v[0]).join(',') + '}]' : 'array';
      } else if (v && typeof v === 'object') {
        out[k] = '{' + Object.keys(v).join(',') + '}';
      } else {
        out[k] = typeof v;
      }
    }
    return out;
  }

  app.post('/api/whatsapp/webhook', async (req, res) => {
    if (!whatsapp.verifyWebhookSecret(req.query && req.query.secret)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // Mirror a COPY of this inbound to another environment's webhook (prod ->
    // staging), so a group created there can also collect its words. Fire-and-
    // forget; never blocks the response. A no-op unless WHATSAPP_MIRROR_WEBHOOK_URL
    // is set and this request isn't itself a mirror.
    mirrorWebhook(req);
    if (!whatsapp.isConfigured()) return res.status(200).json({ ok: true });
    const base = paymentBaseUrl();
    try {
      const { events } = whatsapp.parseWebhook(req.body);
      // Diagnostic: if we recognized NO events but this looks like an unhandled
      // group/participant inbound (a join can arrive as a `groups`/PATCH event OR as
      // a system `messages` action, neither of which parseWebhook matches yet), log
      // the body's STRUCTURE — field names only, never content — so the real shape is
      // visible and can be parsed. Scoped (isGroupWebhook) so routine status receipts
      // and our own echoes don't spam the log.
      if (events.length === 0 && isGroupWebhook(req.body)) {
        console.warn(
          '[whatsapp] unhandled group webhook shape:',
          JSON.stringify(webhookShape(req.body))
        );
      }
      for (const ev of events) {
        try {
          await handleWaEvent(ev, base);
        } catch (e) {
          console.warn('[whatsapp] event failed:', e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.warn('[whatsapp] webhook failed:', e && e.message ? e.message : e);
    }
    res.status(200).json({ ok: true });
  });

  // Admin: WhatsApp arming status — a non-secret readout so the owner can confirm
  // the bot is live after setting the Railway env, instead of reading logs. Returns
  // only PRESENCE booleans (never the token/secret VALUES): { enabled, tokenPresent,
  // webhookSecretPresent, baseUrl, configured, ready }. `configured` = can send/open
  // groups; `ready` = configured AND a webhook secret is set = the full round-trip
  // (send + receive). Admin-gated because the arming state, while not a secret, is
  // operational and shouldn't be public.
  app.get('/api/whatsapp/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(whatsapp.status());
  });

  // Admin: CLEAR the reachout circuit breaker (server/wa-guard.js). The breaker is
  // sticky by design — it survives restarts and never auto-resets, because the
  // last ban escalated precisely by retrying into an account restriction. Only a
  // human who has checked the number's standing in WhatsApp Business should
  // re-open the tap, which is what this route is. Also resets the day's reachout
  // count so a clear is a genuine reset rather than a resume into a spent budget.
  app.post('/api/admin/whatsapp/guard/clear', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const before = whatsapp.guard.snapshot();
    const after = whatsapp.guard.clear();
    if (before.tripped) {
      console.warn(
        '[wa-guard] breaker cleared by admin — reachout re-enabled. Previous reason: ' +
          before.reason
      );
    }
    res.json({ ok: true, guard: after });
  });

  // Live channel connection probe. Unlike /status (a pure env snapshot), this makes
  // a real Whapi call to check whether the linked phone is still paired — so the
  // admin banner can surface a dropped device ("QR"/disconnected) that otherwise
  // silently breaks group creation. Admin-gated, async, returns only the connection
  // tri-state + raw status text (never the token/secret). Fail-soft: never throws.
  app.get('/api/whatsapp/health', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json(await whatsapp.health());
    } catch (e) {
      res.json({ ok: false, connection: 'error', error: (e && e.message) || String(e) });
    }
  });

  // Admin: the catalog of previewable messages (email + WhatsApp triggers).
  app.get('/api/admin/message-preview', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ kinds: messagePreview.listKinds({ settings }) });
  });

  // Admin: render ONE message exactly as it would be sent. Renders against a
  // SAMPLE order by default so the preview works on a fresh install and never puts
  // a real customer's details into a screenshot; pass ?collection=<id> to render a
  // real order instead, which is what you want when checking that a specific
  // order's address / design / amount interpolates correctly.
  //
  // The hero product photo is resolved through the SAME resolveProductImageUrl the
  // real send path uses, so "does the photo actually appear" is a question the
  // preview can answer honestly.
  //
  // `draft`, when present, renders an UNSAVED edit instead of the stored template —
  // see the POST route below. The body is shared by both routes so a drafted
  // preview and a stored one can't diverge in how they resolve the order, the
  // product photo or the base URL. It answers the request itself, including its own
  // 404s, so each route just awaits it.
  async function respondWithMessagePreview(req, res, draft) {
    const base = paymentBaseUrl();
    let collection = null;
    if (req.query && req.query.collection) {
      collection = db.getCollection(String(req.query.collection));
      if (!collection) return res.status(404).json({ error: 'collection not found' });
      collection = { ...collection, count: db.countWords(collection.id) };
    }
    const target = collection || messagePreview.SAMPLE_COLLECTION;
    let productImageUrl = null;
    try {
      productImageUrl = await resolveProductImageUrl(target, base);
    } catch {
      productImageUrl = null;
    }
    const out = messagePreview.render(String(req.params.channel), String(req.params.id), {
      notify,
      whatsapp,
      settings,
      baseUrl: base,
      collection,
      productImageUrl,
      draft,
    });
    if (!out) return res.status(404).json({ error: 'unknown message id' });
    res.json({ ...out, sample: !collection, draft: !!draft });
  }

  app.get('/api/admin/message-preview/:channel/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await respondWithMessagePreview(req, res, null);
  });

  // Admin: render ONE message from an UNSAVED draft — the preview page's editor
  // POSTs the text as it is typed so the owner sees the real, rendered result
  // before committing it. Nothing is stored: the draft is overlaid on a throwaway
  // copy of the settings store for this one render, and saving still goes through
  // POST /api/admin/settings like every other edit.
  //
  // The draft is shape-validated with the SAME settings.validateValue a save uses,
  // so the preview can't accept (and appear to bless) a value that a save would
  // then reject.
  app.post('/api/admin/message-preview/:channel/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const draft = (req.body && req.body.draft) || null;
    if (draft) {
      const { section, key, value } = draft;
      if (!settings.hasKey(section, key)) {
        return res.status(400).json({ error: 'unknown section/key' });
      }
      if (value === undefined) return res.status(400).json({ error: 'value required' });
      const shapeError = settings.validateValue(section, key, value);
      if (shapeError) return res.status(400).json({ error: shapeError });
    }
    await respondWithMessagePreview(req, res, draft);
  });

  // Admin: which collections have a WhatsApp group. Pure local state (no Whapi
  // call), so it stays fast enough for the admin table's 15s refresh and still
  // answers while the channel is down. Keyed by collection id for a direct lookup
  // per row. Closed groups are INCLUDED (see wa-state.allGroups) — the owner may
  // still want to post in the group of a finished order. Returns ids only: no
  // buyer phone, no member list.
  app.get('/api/admin/whatsapp/groups', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const groups = {};
    for (const g of waState.allGroups()) {
      if (!g || !g.collection_id) continue;
      groups[g.collection_id] = { groupId: g.groupId, closed: !!g.closed };
    }
    res.json({ groups });
  });

  // Admin: open a word-collection group for a collection that has none — the
  // manual equivalent of the automatic order-created hook, for orders that were
  // placed while the bot was dormant or disconnected. Deliberately reuses
  // openWhatsappGroup so a manually opened group is IDENTICAL to an automatic one
  // (same subject, same buyer add, same pinned group_opened announcement, same
  // wa-state link) rather than a second, subtly different code path.
  //
  // openWhatsappGroup is fail-soft and returns nothing, so success is decided by
  // re-reading wa-state after it runs. On failure we probe the channel health to
  // tell the owner WHICH failure it is — a disconnected channel (re-scan the QR)
  // reads completely differently from a bad buyer phone, and without this the
  // button would just say "failed" for the one problem that actually recurs.
  app.post('/api/admin/whatsapp/groups/:cid/open', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const collection = db.getCollection(req.params.cid);
    if (!collection) return res.status(404).json({ error: 'collection not found' });
    if (waState.groupForCollection(collection.id)) {
      return res.status(409).json({ error: 'already has a group' });
    }
    if (!whatsapp.isConfigured()) {
      return res.status(400).json({ error: 'not configured', reason: 'bot_off' });
    }
    // A tripped breaker means WhatsApp has restricted this number from contacting
    // people. Refusing the click here (rather than letting it fall through to a
    // generic "could not create group") is the whole point of the guard: a manual
    // retry into a live restriction is exactly how the previous ban was escalated.
    const guardState = whatsapp.guard.snapshot();
    if (guardState.tripped && whatsapp.groupMode() === 'auto_add') {
      return res.status(409).json({
        error: 'reachout blocked',
        reason: 'guard_tripped',
        detail: guardState.reason,
        guard: guardState,
      });
    }
    // In auto_add mode the buyer's number is what the group is built around, so a
    // collection with no usable IL mobile can never get one and the owner should be
    // told that, not "try again". invite_link mode adds nobody, so it needs no
    // phone at all — the link reaches the buyer by email / their order page.
    if (whatsapp.groupMode() === 'auto_add' && !ilPhoneToWaId(collection.owner_phone)) {
      return res.status(400).json({ error: 'no usable buyer phone', reason: 'bad_phone' });
    }
    try {
      await openWhatsappGroup(collection, paymentBaseUrl());
    } catch (e) {
      console.warn('[whatsapp] admin open failed:', e && e.message ? e.message : e);
    }
    // groupForCollection returns the groupId STRING (by_collection maps
    // collection id -> groupId), not an entry object.
    const groupId = waState.groupForCollection(collection.id);
    if (groupId) return res.json({ ok: true, groupId });
    let connection = 'unknown';
    try {
      const h = await whatsapp.health();
      connection = (h && h.connection) || 'unknown';
    } catch {
      connection = 'error';
    }
    res.status(502).json({ error: 'could not create group', reason: 'whapi_failed', connection });
  });

  // Admin: a clickable link to an existing group. WhatsApp has no "open group by
  // id" URL, so the only way in is the group's invite link — which also works
  // when the owner's personal number isn't a member yet (the group is created by
  // the BOT number, so usually it isn't): the link offers to join, then opens it.
  // Live Whapi call, hence separate from the listing above rather than folded into
  // it — one call per click instead of one per row per refresh.
  app.get('/api/admin/whatsapp/groups/:cid/invite', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const groupId = waState.groupForCollection(req.params.cid);
    if (!groupId) return res.status(404).json({ error: 'no group for this collection' });
    try {
      const r = await whatsapp.getInviteLink(groupId);
      if (!r || !r.ok || !r.inviteLink) {
        return res.status(502).json({ error: 'could not fetch invite link' });
      }
      res.json({ ok: true, groupId, inviteLink: r.inviteLink });
    } catch (e) {
      res.status(502).json({ error: (e && e.message) || String(e) });
    }
  });

  // Public: the buyer-wizard feature flags. Unauthenticated on purpose — every
  // visitor's wizard must know which of the gated features to show. Returns ONLY a
  // flat projection of the features section's effective booleans (never other
  // settings sections or secrets). The keys are derived from the registry's
  // `features` section so a flag added there is projected automatically — while
  // the projection is scoped to that ONE section, so nothing else can ever leak.
  // Mirrors the public GET /api/content. All writes stay behind the admin key via
  // /api/admin/settings.
  app.get('/api/features', (req, res) => {
    // Deep-clones the whole settings tree — call it ONCE (this is an unauthenticated
    // hot path hit on every wizard load).
    const all = settings.all();
    const eff = (all.effective && all.effective.features) || {};
    const out = {};
    for (const k of Object.keys((all.registry && all.registry.features) || {})) {
      out[k] = !!eff[k];
    }
    res.json(out);
  });

  return { metaCapiArmed, metaAdContext, sendPurchaseToMeta, isGroupWebhook, webhookShape };
}

// The public FAQ projection.
function registerFaq(app, { settings, faq }) {
  // Public, UNAUTHENTICATED: the home-page FAQ the owner edits in admin-faq.html.
  // A WHITELISTED projection of only the `faq` settings section — the ENABLED
  // questions, in order, reduced to { id, q, a, link_text, link_url }. A disabled
  // question is the owner hiding it from visitors, so it must not travel here even
  // though the admin page still shows it. faq.publicFaq falls back to the shipped
  // defaults if the stored value is somehow malformed, so this endpoint answers
  // with real content or nothing surprising — never a 500 the home page has to
  // handle. Writes stay behind the admin key via /api/admin/settings.
  app.get('/api/faq', (req, res) => {
    res.json({ items: faq.publicFaq(settings.get('faq', 'list')) });
  });
}

module.exports = {
  registerPlaybook,
  registerUnsubscribeSmsContent,
  registerContentUploads,
  registerStagingImports,
  registerAdsSettingsWhatsapp,
  registerFaq,
};
