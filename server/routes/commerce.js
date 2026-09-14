// Agent A (Commerce): the HTTP routes, moved out of server/index.js.
//
// Slice 3 of splitting the monolith (see docs/agent-partition.md, "Splitting the
// monolith"). Every block below is a VERBATIM move; only the glue is new.
//
// Wired exactly like server/routes/platform.js and server/routes/catalog.js:
//   - Each function registers ONE contiguous block that used to sit inline in
//     index.js, and index.js calls it at exactly the spot the block occupied.
//     Express matches in registration order, so a block mounted anywhere else could
//     change which handler answers. tests/unit/route-order.test.js pins the order.
//   - Everything a block uses from index.js is passed in explicitly. This module
//     never requires index.js (a cycle) and requires NOTHING at the top level,
//     because the unit tests reload the app by purging require.cache for server/*.js.
//   - Whatever index.js still calls from a block comes back as the return value.

// The self-collection sticker sheet (/api/admin/stickers, /api/admin/pickup-stickers)
// and the physical stock (/api/admin/stock).
function registerStickersAndStock(
  app,
  {
    requireAdmin,
    express,
    path,
    fs,
    os,
    db,
    templates,
    hfd,
    TEMPLATE_ROOT,
    PICKUP_STICKERS_SCRIPT,
    PREVIEW_TIMEOUT_MS,
    spawnGenerator,
    killGenerator,
  }
) {
  // --- self-collection stickers -------------------------------------------------
  // Every printed game the customer collects herself gets a label on its box, and
  // the owner has been typing that sheet by hand every night: open a document,
  // type eleven names, print. This is that sheet, from the orders.

  // The design's Hebrew name — what goes on the label, because "which of these two
  // boxes is the Paris one" is a question about a picture and not about a theme
  // key. Falls back to the key rather than to nothing: a label with no design is
  // worse than a label with an odd-looking one.
  function designNameFor(theme) {
    const key = String(theme || '');
    if (!key) return '';
    try {
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
      const entry = themes[key];
      return (entry && String(entry.display_he || '').trim()) || key;
    } catch {
      return key;
    }
  }

  // The orders a sticker is printed for TONIGHT: exactly the owner's
  // "הופקו — לשליחה לדפוס" pile, narrowed to self-collection.
  //
  // ONE STAGE, NOT A RANGE. The sheet is printed with the batch that is about to
  // leave for Galor, so it is the same set as that chip and no wider. Each clause
  // earns its place —
  //   • pickup             — a delivery order is posted, and its label is the
  //                          courier's (server/hfd.js), not this one;
  //   • paid               — an unpaid order is not being made;
  //   • produced           — there is no box to label until the deck is built;
  //   • NOT sent to print  — once the batch has gone, its stickers went with it;
  //                          reprinting them the next night is a duplicate sheet
  //                          for boxes that already carry one;
  //   • not ready          — marked ready means labelled and handed over;
  //   • not cancelled.
  //
  // This USED to also take orders resting in בדפוס (stamped, not yet ready), on
  // the reasoning that the stamp and the ready mark are pressed together so
  // nothing ever rests there. Orders do rest there — eight of them the day this
  // changed — and every one had already had its sticker printed. Zero on a night
  // with nothing newly produced is the correct answer, not a sign the sheet is
  // broken.
  //
  // Oldest first, so the sheet comes out in the order the orders table shows and a
  // sticker can be found in it.
  function orderProduced(c) {
    const p = (c.order && c.order.production) || c.production || null;
    // RELEASED, not merely generated. This sheet says of itself that it is
    // "exactly the owner's הופקו — לשליחה לדפוס pile" and ONE STAGE, NOT A RANGE;
    // once a buyer's סיום could build a deck without the order entering that pile
    // (see db.setProductionReleased), reading `generated` here would have printed
    // stickers for boxes that are not in tonight's batch.
    return !!(p && p.state === 'generated' && p.released_at);
  }
  // EVERY box in tonight's pile, in the order the orders table shows them, each
  // with the label it needs. Two kinds, because we sell two ways of getting the
  // box to the customer:
  //
  //   pickup   — she collects it. The label is OURS: the one below, printed here.
  //   delivery — HFD carries it. The label is THEIRS: a barcode the driver scans,
  //              which we cannot draw and have to fetch per shipment.
  //
  // A digital order has no box and no label at all.
  //
  // A delivery order with no HFD shipment booked (or one that was cancelled) has
  // nothing to fetch — `shipment_number` is null and the caller leaves it out of
  // the PDF and says which ones it left out. Booking is a real van and a real
  // charge, so it stays a button the owner presses, never a side effect of asking
  // for the stickers.
  function stickerBatch() {
    return db
      .listAllCollections()
      .filter((c) => {
        const o = c.order;
        if (!o || c.cancelled) return false;
        if (!o.paid) return false;
        // A PDF-only order is a file in an inbox; there is nothing to stick a
        // label on.
        if (o.version !== 'pickup' && o.version !== 'delivery') return false;
        if (o.ready_at || o.sent_to_print_at) return false;
        return orderProduced(c);
      })
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .map((c) => {
        const rec = (c.order && c.order.hfd) || null;
        const live = rec && rec.shipment_number && !rec.cancelled_at;
        return {
          id: c.id,
          kind: c.order.version === 'delivery' ? 'delivery' : 'pickup',
          // The courier's shipment, when there is one to fetch a label for.
          shipment_number: live ? String(rec.shipment_number) : null,
          // What OUR label says. Built for every entry, not just the pickups: it
          // is also how a skipped delivery order is named back to the owner.
          label: {
            order_no: db.orderRef(c),
            // What the deck is CALLED — her own title when she wrote one, else the
            // honoree's name, which is the same thing the cards print.
            title: (c.custom_title || c.honoree_name || '').trim(),
            // The person COLLECTING, who is the buyer and not the honoree. Blank
            // when the order never captured one: an empty line is honest, and the
            // phone underneath still identifies them.
            buyer_name: (c.buyer_name || '').trim(),
            design: designNameFor(c.theme),
            phone: (c.owner_phone || '').trim(),
          },
        };
      });
  }

  // The self-collection half of that pile — the labels this server draws itself.
  // Derived from stickerBatch rather than re-filtered, so the two cannot drift
  // into disagreeing about what tonight's pile is.
  function pickupStickerOrders() {
    return stickerBatch()
      .filter((e) => e.kind === 'pickup')
      .map((e) => e.label);
  }

  // Spawn ONE pickup_stickers.py run over `entries` — our labels and the courier's
  // already-downloaded PDFs, in the order they should print — and resolve the
  // finished PDF's path. `outDir` belongs to the CALLER, which fetched the courier
  // labels into it and removes it afterwards.
  //
  // One Chrome print for all of ours, the same path the deck uses, so it goes
  // through spawnGenerator and inherits its concurrency slot and its kill.
  function runStickerBatch(entries, outDir) {
    return new Promise((resolve, reject) => {
      const jsonPath = path.join(outDir, 'stickers.json');
      const outPdf = path.join(outDir, 'pickup-stickers.pdf');
      try {
        fs.writeFileSync(jsonPath, JSON.stringify(entries), 'utf8');
      } catch (e) {
        return reject(e);
      }
      const child = spawnGenerator([PICKUP_STICKERS_SCRIPT, jsonPath, outPdf]);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGenerator(child);
      }, PREVIEW_TIMEOUT_MS);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('sticker render timed out'));
        if (code !== 0 || !fs.existsSync(outPdf)) {
          return reject(new Error((stderr || stdout || 'exit ' + code).trim().slice(0, 800)));
        }
        resolve(outPdf);
      });
    });
  }

  // How many courier labels are pulled from HFD at once. A batch is ten or twenty
  // parcels and each label is one small request; four at a time empties the queue
  // in about as long as one round trip without opening twenty sockets to a
  // courier that has no idea we are batching.
  const HFD_LABEL_CONCURRENCY = 4;

  // Download the courier's label for every delivery entry that has a shipment,
  // into `outDir`. Resolves { files, failed } — a Map from entry id to the file on
  // disk, and the ones HFD would not give us, each with the reason.
  //
  // A label that does not come down is NOT fatal: the rest of the pile still
  // prints, and the owner is told which parcels to fetch by hand. Losing twenty
  // labels because HFD hiccuped on one is the failure worth avoiding here.
  async function fetchCourierLabels(entries, outDir) {
    const wanted = entries.filter((e) => e.kind === 'delivery' && e.shipment_number);
    const files = new Map();
    const failed = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= wanted.length) return;
        const e = wanted[i];
        let r;
        try {
          r = await hfd.fetchLabel(e.shipment_number);
        } catch (err) {
          r = { ok: false, error: (err && err.message) || String(err) };
        }
        if (!r.ok) {
          console.error('hfd label failed for', e.shipment_number, '-', r.error);
          failed.push({
            order_no: e.label.order_no,
            shipment_number: e.shipment_number,
            message: r.error,
          });
          continue;
        }
        const file = path.join(outDir, 'hfd-' + e.shipment_number + '.pdf');
        try {
          fs.writeFileSync(file, r.pdf);
          files.set(e.id, file);
        } catch (err) {
          failed.push({
            order_no: e.label.order_no,
            shipment_number: e.shipment_number,
            message: (err && err.message) || String(err),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(HFD_LABEL_CONCURRENCY, wanted.length) }, worker)
    );
    return { files, failed };
  }

  // The batch as the generator wants it: our labels as their own fields, the
  // courier's as the file already fetched to disk, both in the order they should
  // print. A delivery whose label did not come down drops out here — the caller
  // counts what is missing and the page names it.
  function stickerEntries(printable, files) {
    return printable
      .map((e) => {
        if (e.kind === 'pickup') return e.label;
        const file = files.get(e.id);
        return file ? { pdf: file } : null;
      })
      .filter(Boolean);
  }

  // Admin: tonight's stickers, as ONE PDF to print.
  //
  // The pile is mixed — boxes the customer collects and boxes HFD carries — and it
  // used to take two places to get its labels: this button for the self-collection
  // ones and HFD's own website for the rest. So this is the whole pile in one
  // download, in the order the orders table shows it: our own label (105x74 mm,
  // one to a page, straight onto the label stock) for a collection, and HFD's own
  // sticker, fetched per shipment, for a delivery.
  //
  // A delivery order with no shipment booked is LEFT OUT and named in the response
  // header rather than booked on the spot: a shipment is a real van and a real
  // charge, and pressing "print my stickers" is not consent to order one.
  //
  // A GET so the button can be a plain link and the browser's own download does
  // the work — there is nothing to post, and the batch is derived entirely from
  // orders that already exist.
  async function sendStickerBatch(req, res) {
    if (!requireAdmin(req, res)) return;
    const batch = stickerBatch();
    // What we can actually print: every collection label, and every delivery that
    // has a shipment to fetch a label for.
    const printable = batch.filter((e) => e.kind === 'pickup' || e.shipment_number);
    const unbooked = batch.filter((e) => e.kind === 'delivery' && !e.shipment_number);
    if (!printable.length) {
      // Not an error page: "there are none tonight" is a normal night, and it
      // should read as one rather than as something that failed. An evening whose
      // only orders are deliveries waiting to be booked says THAT instead.
      return res.status(409).json({
        error: 'none',
        message: unbooked.length
          ? 'כל ההזמנות שממתינות לדפוס הן משלוחים שעוד לא נפתח להם משלוח ב-HFD.'
          : 'אין כרגע הזמנות שהופקו וממתינות לשליחה לדפוס.',
        unbooked: unbooked.map((e) => e.label.order_no),
      });
    }

    let outDir;
    try {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-stickers-'));
    } catch (e) {
      console.error('stickers: no temp dir:', (e && e.message) || e);
      return res.status(500).json({ error: 'render failed' });
    }
    const cleanup = () => {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    };

    let out;
    let failed = [];
    try {
      const labels = await fetchCourierLabels(printable, outDir);
      failed = labels.failed;
      const entries = stickerEntries(printable, labels.files);
      if (!entries.length) {
        cleanup();
        return res.status(502).json({
          error: 'no labels',
          message: 'HFD לא החזירה אף מדבקה: ' + ((failed[0] && failed[0].message) || 'שגיאה'),
        });
      }
      out = await runStickerBatch(entries, outDir);
    } catch (e) {
      cleanup();
      console.error('stickers failed:', (e && e.message) || e);
      return res.status(502).json({ error: 'render failed' });
    }

    const name = 'מדבקות ' + new Date().toISOString().slice(0, 10) + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    // Counts, not names: a header is latin-1 and an order title is not. The page
    // shows the owner WHICH orders are missing a shipment; these are here so a
    // download that came out short can be explained from the response alone.
    res.setHeader('X-Stickers-Unbooked', String(unbooked.length));
    res.setHeader('X-Stickers-Failed', String(failed.length));
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="stickers.pdf"; filename*=UTF-8\'\'' + encodeURIComponent(name)
    );
    res.sendFile(out, (err) => {
      cleanup();
      if (err) console.error('stickers send failed:', (err && err.message) || err);
    });
  }

  app.get('/api/admin/stickers', sendStickerBatch);
  // The name it shipped under, kept working: it is in the staff allowlist, in the
  // owner's browser history, and on a button that may be open in a tab right now.
  app.get('/api/admin/pickup-stickers', sendStickerBatch);

  // --- physical stock -----------------------------------------------------------
  // Boards, boxes, thank-you notes, stickers. See the block above db.stockSnapshot
  // for what counts as using one and why the counts may go negative.

  // Every design that exists RIGHT NOW, as { theme, name }. Read from themes.json
  // (the volume's copy in production, so a template the owner uploaded is in here
  // too) and deliberately NOT filtered to public designs: a private template's
  // boards are on the same shelf as everyone else's.
  function stockDesigns() {
    try {
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
      return Object.entries(themes)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([theme, v]) => ({ theme, name: (v.display_he || '').trim() || theme }));
    } catch {
      // No theme list is not an error here — the stored counts are still the truth,
      // and stockSnapshot answers with them (as orphans) rather than nothing.
      return [];
    }
  }

  app.get('/api/admin/stock', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(db.stockSnapshot(stockDesigns()));
  });

  // Admin: correct a count, restock a shelf, or change how many of a supply an
  // order uses. One route for both kinds of row, because they are one screen.
  app.put('/api/admin/stock', express.json({ limit: '8kb' }), (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const designs = stockDesigns();
    if (b.kind === 'board') {
      const stored = db.setBoardStock(b.theme, b.count, designs);
      if (stored == null) return res.status(404).json({ error: 'unknown design' });
    } else if (b.kind === 'supply') {
      const stored = db.setSupplyStock(b.key, { count: b.count, per_order: b.per_order });
      if (stored == null) return res.status(404).json({ error: 'unknown supply' });
    } else {
      return res.status(400).json({ error: 'expected kind board|supply' });
    }
    // The whole shelf back, so the page redraws from the store rather than from
    // what it hoped the store did.
    res.json(db.stockSnapshot(designs));
  });

  return { stickerBatch, pickupStickerOrders, stickerEntries, stockDesigns };
}

// The whole בדפוס pile in one press (/api/admin/orders/ready-batch) and the HFD
// courier (/api/admin/hfd/status, /api/admin/collections/:id/hfd*).
function registerReadyBatchAndHfd(
  app,
  {
    requireAdmin,
    db,
    sms,
    hfd,
    templates,
    TEMPLATE_ROOT,
    applyOrderReady,
    orderReadyEmailArmed,
    orderReadySmsArmed,
  }
) {
  // --- the whole בדפוס pile, in one press ---------------------------------------
  //
  // The batch the owner actually works in: a run comes back from Galor and every
  // box in it becomes ready within the same minute. Pressing eleven rows one at a
  // time is eleven chances to miss one — and a missed row is a customer who never
  // hears that her game is waiting.
  //
  // WHAT IT TAKES: exactly what the בדפוס chip shows — paid, not cancelled, sent
  // to print, not yet ready. Both kinds, deliberately: a delivery order becomes
  // ready at the same moment as a pickup one, and leaving it behind would only
  // mean pressing it by hand afterwards. Each one goes through the SAME step a
  // single row does (applyOrderReady), so the email, the SMS and the stock all
  // behave exactly as they do today.
  //
  // WHAT IT DOES NOT DO: book a courier. That is a real van and a real charge, and
  // it stays a button pressed per order — the same rule the sticker sheet follows.
  function batchReadyCandidates() {
    return db
      .listAllCollections()
      .filter((c) => {
        const o = c.order;
        if (!o || c.cancelled) return false;
        if (!o.paid) return false;
        return !!o.sent_to_print_at && !o.ready_at;
      })
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }

  // One candidate, described for the confirmation dialog. The owner is about to
  // text real people; she is shown who, and — just as importantly — who will get
  // nothing because we hold no mobile for them.
  function batchReadyRow(c) {
    const version = String((c.order && c.order.version) || '');
    return {
      id: c.id,
      order_no: db.orderRef(c),
      honoree: c.honoree_name || '',
      // The order's REAL version, not "delivery or else pickup". A pdf and a
      // custom order travel this same pipeline — db.applyOrderStock says so in
      // as many words — and calling a digital sale self-pickup tells the owner
      // she is sending two people to גלאור when one of them is waiting on a file.
      kind: ['delivery', 'pickup', 'pdf', 'custom'].includes(version) ? version : 'other',
      // The number as the GATEWAY will read it, not merely "something was typed
      // in the phone field". sms.enqueue puts every number through ilMobile(),
      // which soft-fails anything that is not an Israeli mobile — so a landline
      // counted as "will get a text" would be left off the call-by-hand list,
      // which is the one list this dialog exists to produce.
      has_phone: Boolean(sms.ilMobile(c && c.owner_phone)),
    };
  }

  // The preview. Read-only and separate from the press on purpose: a button that
  // blasts messages on its first click is a button that gets clicked by accident.
  app.get('/api/admin/orders/ready-batch', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = batchReadyCandidates().map(batchReadyRow);
    const kinds = { pickup: 0, delivery: 0, pdf: 0, custom: 0, other: 0 };
    for (const r of rows) kinds[r.kind] += 1;
    res.json({
      orders: rows,
      count: rows.length,
      pickup: kinds.pickup,
      delivery: kinds.delivery,
      // Every kind in the pile, so the dialog can say "2 self-pickup · 1 digital"
      // rather than filing the file under the boxes.
      kinds,
      // Named rather than counted: "3 without a phone" sends her hunting; three
      // order numbers tell her which three to call.
      no_phone: rows.filter((r) => !r.has_phone).map((r) => r.order_no),
      // What will ACTUALLY be sent. The dialog is the last thing she reads before
      // an action that cannot be taken back, so both answers come from the same
      // gates the senders themselves use — a switched-off template must not be
      // described as "everyone gets a mail".
      sms_enabled: orderReadySmsArmed(),
      email_enabled: orderReadyEmailArmed(),
    });
  });

  app.post('/api/admin/orders/ready-batch', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const done = [];
    const failed = [];
    const emailArmed = orderReadyEmailArmed();
    // ONE AT A TIME, and each send awaited — the pattern every other bulk sender
    // here follows (the reminder scans). Eleven mails fired at once is eleven
    // chances to trip Resend's rate limit, and a swallowed rejection would leave
    // the owner reading "11 marked ready" while a customer sits waiting.
    for (const c of batchReadyCandidates()) {
      const row = batchReadyRow(c);
      // Each order is marked through the store's own gate, so the batch cannot do
      // anything a single press could not — and one order that refuses (a race
      // with another tab, a row cancelled a second ago) never stops the rest.
      let r = null;
      try {
        r = db.setOrderReady(c.id, true);
      } catch (e) {
        r = { error: String((e && e.message) || e) };
      }
      if (!r || r.error || !r.changed) {
        failed.push({ ...row, error: (r && r.error) || 'unchanged' });
        continue;
      }
      const applied = await applyOrderReady(c.id, true, true);
      done.push({ ...row, sms_queued: Boolean(applied.sms), emailed: Boolean(applied.emailed) });
    }
    res.json({
      ok: true,
      marked: done.length,
      sms_queued: done.filter((d) => d.sms_queued).length,
      emailed: done.filter((d) => d.emailed).length,
      // The orders that were marked ready and whose mail did NOT go — the ones
      // she has to tell by hand. Empty when mail is switched off entirely: then
      // nothing was attempted, and naming every row would be noise, not news.
      not_emailed: emailArmed ? done.filter((d) => !d.emailed).map((d) => d.order_no) : [],
      email_enabled: emailArmed,
      sms_enabled: orderReadySmsArmed(),
      orders: done,
      failed,
      sent_to_print_count: db.countSentToPrintOrders(),
      ready_count: db.countReadyOrders(),
    });
  });

  // --- HFD shipments -----------------------------------------------------------
  // Booking a delivery order's parcel with the courier from our own admin instead
  // of retyping the address into HFD's site. See server/hfd.js for the API; every
  // route here is a no-op while the credentials are unset.

  // The three refusals that are OUR data being wrong, not HFD saying no. They are
  // 400s with a fix the owner can act on, and nothing is sent to the courier.
  const HFD_LOCAL_ERRORS = {
    'no order': 'אין הזמנה על הרשומה הזו.',
    'not a delivery order': 'זו לא הזמנת משלוח — אין מה לשלוח לשליח.',
    'address required': 'להזמנה חסרה כתובת מלאה (רחוב, עיר).',
  };

  // The design's CURRENT public name, for the sticker — the same string
  // /api/design-names serves and the storefront shows (themes.json `display_he`),
  // resolved from the order's generator theme. NOT `c.design`, which is the name
  // stamped on the order when it was placed: a template rename leaves every older
  // order carrying a label the shop no longer uses. Falls back to the stamped name
  // if themes.json can't be read at all.
  function hfdDesignName(c) {
    try {
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
      const theme = (c.order && c.order.theme) || c.theme || null;
      return templates.displayNameForDesign(themes, { theme, name: c.design, id: theme });
    } catch {
      return (c && c.design) || '';
    }
  }

  // Admin: is the courier integration armed? The admin page asks once at load and
  // hides the whole control when it isn't, rather than offering a button that can
  // only fail.
  app.get('/api/admin/hfd/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(hfd.status());
  });

  // Admin: book this delivery order's parcel. Deliberately manual — a shipment is
  // a van and a charge, so it happens when the owner presses, never on a state
  // change.
  app.post('/api/admin/collections/:id/hfd', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const c = db.getCollection(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    if (!hfd.isConfigured()) {
      return res.status(503).json({
        error: 'hfd not configured',
        message: 'HFD לא מוגדרת — חסרים HFD_TOKEN / HFD_CLIENT_NUMBER.',
      });
    }
    // A second press must not book a second van. The already-booked shipment is
    // returned with the refusal so the page can just show it.
    const existing = c.order && c.order.hfd;
    if (existing && existing.shipment_number && !existing.cancelled_at) {
      return res.status(409).json({
        error: 'already booked',
        message: 'כבר נוצר משלוח להזמנה הזו (' + existing.shipment_number + ').',
        hfd: existing,
      });
    }

    const r = await hfd.createShipment(c, { designName: hfdDesignName(c) });
    if (!r.ok) {
      if (HFD_LOCAL_ERRORS[r.error]) {
        return res.status(400).json({ error: r.error, message: HFD_LOCAL_ERRORS[r.error] });
      }
      // HFD refused. Remember why: the owner comes back to this row later, and
      // "it didn't work" with no reason is what sends her to the phone.
      console.error('hfd create refused for', c.id, '-', r.error);
      const record = db.setHfdShipment(c.id, {
        error: r.error,
        error_at: new Date().toISOString(),
      });
      return res.status(502).json({ error: 'hfd refused', message: r.error, hfd: record });
    }

    const record = db.setHfdShipment(c.id, {
      shipment_number: r.shipmentNumber,
      rand_number: r.randNumber,
      tracking_url: hfd.trackingUrl(r.randNumber),
      sent_at: new Date().toISOString(),
      cancelled_at: null,
      error: null,
      error_at: null,
    });
    res.json({ ok: true, hfd: record });
  });

  // Admin: the parcel's sticker, proxied so the token never reaches the browser.
  // Inline, because the owner prints it straight from the tab.
  app.get('/api/admin/collections/:id/hfd/label', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const c = db.getCollection(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const number = c.order && c.order.hfd && c.order.hfd.shipment_number;
    if (!number) return res.status(404).json({ error: 'no shipment' });
    const r = await hfd.fetchLabel(number);
    if (!r.ok) return res.status(502).json({ error: 'hfd label failed', message: r.error });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="hfd-' + number + '.pdf"');
    res.send(r.pdf);
  });

  // Admin: cancel the booked parcel. The number is KEPT (marked cancelled) — an
  // order's shipping history is evidence, and a cleared field cannot say that a
  // van was once ordered and stood down.
  app.delete('/api/admin/collections/:id/hfd', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const c = db.getCollection(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const record = c.order && c.order.hfd;
    if (!record || !record.shipment_number) return res.status(404).json({ error: 'no shipment' });
    if (record.cancelled_at) return res.json({ ok: true, hfd: record });
    const r = await hfd.cancelShipment(record.shipment_number);
    if (!r.ok) {
      // LOGGED, not only returned. A refusal the owner reports as "it says it
      // failed" is unanswerable without HFD's own words for it, and this is the
      // only place they exist.
      console.error('hfd cancel refused for', record.shipment_number, '-', r.error);
      return res.status(502).json({ error: 'hfd refused', message: r.error, hfd: record });
    }
    const next = db.setHfdShipment(c.id, { cancelled_at: new Date().toISOString() });
    res.json({ ok: true, hfd: next });
  });
}

// The admin coupon routes (/api/admin/coupons*) and the partner's own report
// (/api/partner/:token).
function registerCoupons(app, { requireAdmin, db }) {
  // Admin: list all discount coupons.
  app.get('/api/admin/coupons', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ coupons: db.listCoupons() });
  });

  // Admin: create a coupon. 400 on invalid input or a duplicate code.
  // Optionally a PARTNER coupon — a blogger's code that earns her money — by
  // carrying partner_name + commission_type + commission_value.
  app.post('/api/admin/coupons', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const coupon = db.createCoupon({
      code: b.code,
      discount_pct: b.discount_pct,
      valid_until: b.valid_until,
      max_uses: b.max_uses,
      partner_name: b.partner_name,
      commission_type: b.commission_type,
      commission_value: b.commission_value,
    });
    if (coupon && coupon.error) return res.status(400).json({ error: coupon.error });
    res.status(201).json({ coupon });
  });

  // Admin: change or lift a coupon's redemption cap. Body: { max_uses } — a whole
  // number of uses, or null/'' for no limit. 404 unknown id, 400 a bad cap.
  app.post('/api/admin/coupons/:id/max-uses', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const coupon = db.setCouponMaxUses(req.params.id, (req.body || {}).max_uses);
    if (!coupon) return res.status(404).json({ error: 'not found' });
    if (coupon.error) return res.status(400).json({ error: coupon.error });
    res.json({ coupon });
  });

  // Admin: edit a coupon's PARTNER terms (name + what she earns). The code and the
  // discount are not editable — both are already printed in the blogger's post.
  app.post('/api/admin/coupons/:id/partner', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const coupon = db.updateCouponPartner(req.params.id, {
      partner_name: b.partner_name,
      commission_type: b.commission_type,
      commission_value: b.commission_value,
    });
    if (!coupon) return res.status(404).json({ error: 'not found' });
    if (coupon.error) return res.status(400).json({ error: coupon.error });
    res.json({ coupon });
  });

  // Admin: one partner's full report — the same numbers her own page shows, so
  // the two can never disagree about what is owed.
  app.get('/api/admin/coupons/:id/report', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const report = db.partnerReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'not found' });
    res.json(report);
  });

  // Admin: record money actually handed to the blogger.
  app.post('/api/admin/coupons/:id/payouts', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const payout = db.addCouponPayout(req.params.id, {
      amount: b.amount,
      date: b.date,
      note: b.note,
    });
    if (!payout) return res.status(404).json({ error: 'not found' });
    if (payout.error) return res.status(400).json({ error: payout.error });
    res.status(201).json({ payout });
  });

  // Admin: undo a payout entry — for correcting a mistake, not for hiding one.
  app.delete('/api/admin/coupons/:id/payouts/:payoutId', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db.deleteCouponPayout(req.params.id, req.params.payoutId)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  // Admin: issue a NEW report link, retiring the old one. For a link that leaked
  // or a partnership that ended; there is no way back to the previous token.
  app.post('/api/admin/coupons/:id/rotate-token', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const coupon = db.rotateCouponToken(req.params.id);
    if (!coupon) return res.status(404).json({ error: 'not found' });
    res.json({ coupon });
  });

  // THE BLOGGER'S OWN REPORT. No admin key and no login — the long random token in
  // the URL is the credential, which is the whole reason there is nothing here
  // worth stealing beyond her own numbers.
  //
  // It carries NO CUSTOMER DATA. Not a name, not an email, not a phone, not what
  // anyone ordered — those belong to the shop's buyers, who never agreed to be
  // listed on a partner's dashboard. An order number, a date and a sum are enough
  // for her to check every figure against what she is paid.
  app.get('/api/partner/:token', (req, res) => {
    const coupon = db.getCouponByToken(req.params.token);
    // Same answer for a malformed token, an unknown one and a coupon that is no
    // longer a partner's: a 404 that distinguishes them is a way to hunt for real
    // tokens.
    if (!coupon) return res.status(404).json({ error: 'not found' });
    const report = db.partnerReport(coupon.id);
    if (!report) return res.status(404).json({ error: 'not found' });
    res.json(report);
  });

  // Admin: toggle a coupon's active flag. 404 when the id is unknown.
  app.post('/api/admin/coupons/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const active = !!(req.body && req.body.active);
    const coupon = db.setCouponActive(req.params.id, active);
    if (!coupon) return res.status(404).json({ error: 'not found' });
    res.json({ coupon });
  });

  // Admin: delete a coupon. 404 when the id is unknown.
  app.delete('/api/admin/coupons/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db.deleteCoupon(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
}

// The checkout's coupon preview (/api/collections/:id/coupon/validate).
function registerCouponValidate(app, { db, couponRateOk, clientKey }) {
  // OWNER-SCOPED coupon validation so checkout can preview the discount. Requires
  // the collection id + owner_token (so it is NOT a fully-open enumeration oracle)
  // and is rate-limited per collection. Only the discount percentage is ever
  // leaked — never the coupon list or other fields.
  app.post('/api/collections/:id/coupon/validate', (req, res) => {
    const c = db.getCollection(req.params.id);
    const token = req.body && req.body.owner_token;
    if (!c || c.owner_token !== token) return res.status(403).json({ error: 'forbidden' });
    // Rate-limit by CLIENT IP (not collection — fresh collections are free to make)
    // to blunt code enumeration. This is the tight oracle budget; pay/init has its
    // own separate path so an owner's previews can't block their real payment.
    if (!couponRateOk('validate:' + clientKey(req))) {
      return res.status(429).json({ error: 'too many attempts' });
    }
    const r = db.validateCoupon(req.body && req.body.code);
    if (!r.valid) return res.json({ valid: false, reason: r.reason });
    res.json({ valid: true, discount_pct: r.coupon.discount_pct });
  });
}

// Setting the order (/api/collections/:id/order).
function registerOrder(app, { db, onOrderCreated, paymentBaseUrl }) {
  // Owner-only: set the order (version + price + optional delivery address).
  app.post('/api/collections/:id/order', (req, res) => {
    const b = req.body || {};
    const r = db.setOrder(req.params.id, b.owner_token, {
      version: b.version,
      address: b.address,
      // Copies of the same deck. setOrder sanitises it and recomputes the total —
      // the client's number never reaches the charge unmultiplied by our own price.
      quantity: b.quantity,
    });
    if (r && r.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    if (r && r.error) return res.status(400).json({ error: r.error });
    // Order created -> fire the one-time owner/buyer emails + WhatsApp group.
    onOrderCreated(req.params.id, paymentBaseUrl());
    res.json({
      version: r.version,
      total: r.total,
      quantity: r.quantity,
      unit_price: r.unit_price,
      delivery_fee: r.delivery_fee,
    });
  });
}

// The card payment: pay/cancel, pay/init, the shipping upgrade's shipping/init and
// the PeleCard callback (/api/payment/callback). newPayToken sat further up in
// index.js; only these two init routes used it, so it moved in with them.
function registerPayment(
  app,
  {
    pelecard,
    crypto,
    db,
    paymentBaseUrl,
    onOrderCreated,
    onOrderPaid,
    onShippingAdded,
    metaAdContext,
    metaCapiArmed,
    sendPurchaseToMeta,
  }
) {
  // A short per-payment ParamX token: <=19 chars, digits + lowercase letters
  // (PeleCard's ParamX limit). PeleCard echoes it back as AdditionalDetailsParamX.
  function newPayToken() {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 18);
  }

  // Owner-only: the buyer CLOSED the payment window. Marks every in-flight pay
  // session abandoned so it stops counting as "a payment is open".
  //
  // Without this the checkout deadlocks: pay/init records a real session, the
  // buyer closes the modal (which the server never hears about), and for the next
  // 20 minutes the free/coupon path answers 409 "close the payment window before
  // applying a coupon" — a window that is already closed, with no way to clear it.
  // That is the "pay button does nothing" report.
  //
  // Deliberately forgiving: any outcome that isn't outright forbidden answers 200,
  // because this is a fire-and-forget beacon sent while a modal closes. A buyer
  // must never be blocked by the failure of a cleanup call they cannot see.
  app.post('/api/collections/:id/pay/cancel', (req, res) => {
    const token = req.body && req.body.owner_token;
    const n = db.abandonPaySessions(req.params.id, token);
    if (n === null) return res.status(403).json({ error: 'forbidden' });
    res.json({ cancelled: n });
  });

  // Owner-only: start a PeleCard card payment for this collection's order.
  // Persists/refreshes the order first (same validation as /order), then asks
  // PeleCard for an iframe URL. Returns { url } for the browser to load in an
  // <iframe>. The ParamX token stored here lets the later callback find the order.
  app.post('/api/collections/:id/pay/init', async (req, res) => {
    if (!pelecard.isConfigured()) {
      return res.status(503).json({ error: 'card payment not configured' });
    }
    const base = paymentBaseUrl();
    if (!base) return res.status(503).json({ error: 'payment base url not configured' });

    const b = req.body || {};
    const c = db.getCollection(req.params.id);
    if (!c || c.owner_token !== b.owner_token) return res.status(403).json({ error: 'forbidden' });
    // Never re-open payment on an order that is already paid (re-clicking the card
    // button must not rebuild the order and discard the recorded payment).
    if (c.order && c.order.paid) return res.status(409).json({ error: 'already paid' });

    // (Re)set the order for this payment. setOrder preserves the pending PeleCard
    // handshake on an unpaid order, so in-flight ParamX tokens from an earlier
    // still-open pay modal survive (any version, incl. delivery).
    const order = db.setOrder(req.params.id, b.owner_token, {
      version: b.version,
      address: b.address,
      quantity: b.quantity,
    });
    if (order && order.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    if (order && order.error) return res.status(400).json({ error: order.error });
    // Order created (checkout started) -> fire the one-time owner/buyer emails +
    // WhatsApp group NOW, before the card payment. Idempotent, so re-opening the pay
    // modal (or applying a coupon on a retry) never re-notifies.
    onOrderCreated(req.params.id, base);

    // Optional discount coupon. Re-validate SERVER-SIDE (never trust a client
    // price). The effective charge is what we bill AND what the callback verifies.
    let discountPct = 0;
    let couponCode = null;
    if (b.coupon) {
      // NOT rate-limited here: pay/init is owner_token-gated and performs a real
      // charge, so it must never be blocked by the preview endpoint's oracle budget
      // (an owner previewing a code repeatedly must still be able to pay).
      const v = db.validateCoupon(b.coupon);
      // The reason travels with the refusal: between the preview and this click
      // someone else can have spent the code's last use, and "the coupon ran out"
      // is a very different thing to read than "we could not open the payment".
      if (!v.valid) return res.status(400).json({ error: 'invalid coupon', reason: v.reason });
      discountPct = v.coupon.discount_pct;
      couponCode = v.coupon.code;
    }
    // charged_total is ALWAYS a real number — the full total when no coupon.
    //
    // A COUPON BUYS A GAME, NOT POSTAGE. The percentage comes off the game money
    // only — unit price × copies — and the delivery fee is added back whole. It
    // used to come off `order.total`, which already includes the fee, so a 50%
    // code halved the courier's charge too and a 100% code shipped a parcel for
    // nothing. commissionFor (server/db.js) has always stated this rule and
    // computes its percent on the same base; the discount now agrees with it.
    //
    // A consequence worth naming: a 100% code on a DELIVERY order is no longer a
    // free order. The game is free, the shipping is not, so it goes through the
    // card for the fee alone — the free path below only sees a real zero.
    // The checkout screen (site/collect.html renderTotal) mirrors this exactly;
    // a change to either belongs in both.
    const fee =
      Number.isInteger(order.delivery_fee) && order.delivery_fee > 0 ? order.delivery_fee : 0;
    const gameMoney = Math.max(0, order.total - fee);
    const charged = Math.round(gameMoney * (1 - discountPct / 100)) + fee;

    // A base order total can never be 0 (version prices validate as >= 1 and the
    // charge falls back to a positive default), so charged<=0 is ONLY reachable via
    // a coupon that discounts to zero. Guard defensively: if the charge rounds to 0
    // with NO coupon, something is wrong — refuse rather than mark a paid-at-₪0
    // order. Only a real coupon may take the free/skip-PeleCard path.
    if (charged <= 0 && !couponCode) {
      return res.status(400).json({ error: 'invalid order total' });
    }

    // The buyer's own request, captured HERE because it is the last one they make
    // before the money moves: their IP, their browser, Meta's first-party cookies
    // and the ad they landed on. The sale is reported to Meta from the PeleCard
    // callback, which is a request from PeleCard's server — none of this exists
    // there. Null when the Conversions API is not armed.
    const adCtx = metaAdContext(req, b);

    // Free order (a coupon discounts it to <= 0): skip PeleCard entirely, mark it
    // paid now, count the coupon use, and tell the client it's paid. BUT NOT while a
    // real (non-free) card session is still in flight — otherwise the customer could
    // complete that charge and be billed for a "free" order.
    if (charged <= 0) {
      if (db.hasInFlightRealSession(order)) {
        return res
          .status(409)
          .json({ error: 'יש תשלום פתוח — סגרו את חלון התשלום לפני החלת קופון' });
      }
      db.markPaid(req.params.id, {
        method: 'coupon',
        charged_total: 0,
        coupon: couponCode,
        discount_pct: couponCode ? discountPct : null,
        // No PeleCard handshake on this path, so the buyer's details and the Meta
        // claim ride in on markPaid's own write — one write, not three.
        metaCtx: adCtx,
        metaClaim: Boolean(adCtx),
      });
      if (couponCode) db.incrementCouponUses(couponCode);
      // A free order is a conversion too, and this is the request the buyer made
      // themselves — so Meta is told here and now, with their own browser's
      // details, rather than waiting for a confirmation page that may never load.
      // Guarded: this handler is `async`, and Express 4 does not route a rejected
      // one to error middleware — an unanswered request and a dead process is not
      // a price a measurement side-effect may charge.
      try {
        if (adCtx) sendPurchaseToMeta(req.params.id, adCtx, { preclaimed: true });
      } catch (e) {
        console.error('[meta-capi] ' + req.params.id + ': ' + ((e && e.message) || e));
      }
      // A free (100%-coupon) order is now paid — fire the same payment receipts as
      // the PeleCard callback, showing the real charged amount (0, which the emails
      // render as "free — 100% coupon" rather than a bare price).
      onOrderPaid(req.params.id, base, 0);
      return res.json({ free: true, paid: true, total: 0 });
    }

    const paramToken = newPayToken();
    try {
      const { url, transactionId } = await pelecard.init({
        amountNis: charged,
        paramToken,
        urls: {
          goodUrl: base + '/pay-done.html',
          errorUrl: base + '/pay-done.html?error=1',
          serverGoodUrl: base + '/api/payment/callback',
          serverErrorUrl: base + '/api/payment/callback?error=1',
        },
      });
      // Record THIS session's own charged amount + coupon so the callback for it
      // verifies against the right price (sessions with different coupons stay
      // independent).
      db.recordPaymentInit(req.params.id, {
        paramToken,
        transactionId,
        charged_total: charged,
        coupon: couponCode,
        discount_pct: couponCode ? discountPct : null,
        metaCtx: adCtx,
      });
      res.json({ url, total: order.total, charged });
    } catch (e) {
      res.status(502).json({ error: 'payment init failed' });
    }
  });

  // Owner-only: buy DELIVERY for an order that is already paid.
  //
  // She picked pickup, the party moved, and now she wants it sent. The paid order
  // is immutable to public callers on purpose (setOrder refuses outright — it is
  // the only thing between a paid order and a client re-posting a cheaper
  // version), so this is its own small purchase: the shipping fee, charged once,
  // on its own PeleCard session. db.markShippingPaid then converges the order onto
  // version 'delivery' with the address, which is what makes every reader
  // downstream — the orders table, the emails, the press run — need to know
  // nothing about upgrades.
  //
  // NO COUPONS here, deliberately: a discount code buys a game, not postage.
  //
  // Refused once the collection is CLOSED (db.shippingUpgrade), which is the
  // owner's rule and the honest one — by then the deck is at the printer and where
  // it goes has already been decided.
  app.post('/api/collections/:id/shipping/init', async (req, res) => {
    if (!pelecard.isConfigured()) {
      return res.status(503).json({ error: 'card payment not configured' });
    }
    const base = paymentBaseUrl();
    if (!base) return res.status(503).json({ error: 'payment base url not configured' });

    const b = req.body || {};
    const c = db.getCollection(req.params.id);
    if (!c || c.owner_token !== b.owner_token) return res.status(403).json({ error: 'forbidden' });

    // Stage it (address sanitized, fee re-read from settings, availability
    // re-checked — the collection can close between rendering the offer and
    // pressing the button).
    const shipping = db.startShippingUpgrade(req.params.id, b.owner_token, { address: b.address });
    if (shipping.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    if (shipping.error === 'already paid') return res.status(409).json({ error: 'already paid' });
    if (shipping.error === 'closed') {
      return res.status(409).json({ error: 'closed', message: 'האיסוף נסגר והמשחק בהפקה' });
    }
    if (shipping.error) return res.status(400).json({ error: shipping.error });

    const charged = shipping.fee;
    // The fee is validated as a positive integer before the upgrade is ever
    // offered, so this is unreachable — and it is here because a 0-charge PeleCard
    // init is the one failure mode that would look like a free upgrade.
    if (!(charged > 0)) return res.status(400).json({ error: 'invalid order total' });

    const paramToken = newPayToken();
    try {
      const { url, transactionId } = await pelecard.init({
        amountNis: charged,
        paramToken,
        urls: {
          goodUrl: base + '/pay-done.html',
          errorUrl: base + '/pay-done.html?error=1',
          serverGoodUrl: base + '/api/payment/callback',
          serverErrorUrl: base + '/api/payment/callback?error=1',
        },
      });
      db.recordShippingInit(req.params.id, {
        paramToken,
        transactionId,
        charged_total: charged,
      });
      res.json({ url, charged });
    } catch {
      res.status(502).json({ error: 'payment init failed' });
    }
  });

  // PeleCard server-side callback (ServerSideGoodFeedbackURL). The body is
  // UNTRUSTED — we take only the TransactionId from it, then re-fetch the
  // transaction from PeleCard with our secret credentials (getTransaction) and
  // decide off that. A forged callback cannot survive: an unknown/foreign
  // TransactionId either fails the lookup or maps to a different order's token.
  app.post('/api/payment/callback', async (req, res) => {
    const parsed = pelecard.parseCallback(req.body || {});
    // We need a TransactionId to re-fetch the transaction. Prefer the one in the
    // callback; if it's absent, fall back to the id we stored at init (located via
    // the echoed ParamX token).
    let transactionId = parsed.transactionId;
    if (!transactionId && parsed.paramX) {
      // Fall back to the id we stored for that session (located via the echoed
      // ParamX token), then the per-order last_transaction_id as a last resort.
      const match = db.findPaySession(parsed.paramX);
      const holder =
        match &&
        (match.kind === 'shipping'
          ? match.collection.order.shipping.pelecard
          : match.collection.order.pelecard);
      transactionId =
        (match && match.session && match.session.transaction_id) ||
        (holder && holder.last_transaction_id) ||
        null;
    }
    if (!transactionId) return res.json({ ok: true });

    let tx;
    try {
      tx = await pelecard.getTransaction(transactionId);
    } catch (e) {
      // Transient error verifying with PeleCard: return non-200 so PeleCard
      // retries the callback once (markPaid is idempotent).
      return res.status(502).json({ error: 'verification failed' });
    }

    // Locate the specific pay SESSION by the AUTHORITATIVE token PeleCard returned.
    // Verify tx against THAT session's own charged_total (sessions opened with
    // different coupons must each verify against their own price) — never a shared
    // order-level amount. On success mark paid + credit THAT session's coupon.
    //
    // Two kinds of purchase arrive here now: the ORDER, and a SHIPPING upgrade
    // bought on top of an already-paid one. PeleCard has one callback URL and one
    // token space, so the token is what tells them apart — and it must, because the
    // "is it already paid?" guard is a different flag for each and the shipping
    // charge is a different (smaller) amount than the order's.
    const match = db.findPaySession(tx.paramX);
    const c = match && match.collection;
    const session = match && match.session;
    if (
      c &&
      session &&
      match.kind === 'shipping' &&
      !c.order.shipping.paid &&
      pelecard.verifyTransaction(tx, { amountNis: session.charged_total })
    ) {
      db.markShippingPaid(c.id, {
        method: 'pelecard',
        transactionId: tx.transactionId,
        approvalNo: tx.approvalNo,
        token: session.token,
        charged_total: session.charged_total,
      });
      // The order is a DELIVERY order from this moment (db.markShippingPaid), so
      // the owner is told the same way she is told about any other change of
      // fulfilment — she has a parcel to send that she did not have this morning.
      onShippingAdded(c.id, paymentBaseUrl(), session.charged_total);
      return res.json({ ok: true });
    }
    if (
      c &&
      session &&
      match.kind === 'order' &&
      !c.order.paid &&
      pelecard.verifyTransaction(tx, { amountNis: session.charged_total })
    ) {
      // metaClaim: the Meta report is claimed inside THIS write. The alternative
      // was a second synchronous whole-store write on the hot path of a charge
      // that has just cleared, for a measurement side-effect.
      const metaArmed = metaCapiArmed();
      db.markPaid(c.id, {
        method: 'pelecard',
        transactionId: tx.transactionId,
        approvalNo: tx.approvalNo,
        token: session.token,
        charged_total: session.charged_total,
        coupon: session.coupon,
        discount_pct: session.discount_pct,
        metaClaim: metaArmed,
      });
      // Count the coupon use once, on the real unpaid->paid transition.
      if (session.coupon) db.incrementCouponUses(session.coupon);
      // Fire the owner + buyer payment receipts, showing the amount ACTUALLY
      // charged for THIS session (never the pre-coupon order.total). Gated on
      // email being configured inside onOrderPaid, and fire-and-forget — a failed
      // send must never turn a successful charge into a failed callback.
      onOrderPaid(c.id, paymentBaseUrl(), session.charged_total);
      // Meta's copy of the sale, sent from HERE — the moment the money actually
      // landed, in a request made by PeleCard's server. Nothing about the buyer's
      // browser can suppress it: a closed tab, a blocked pixel and an in-app
      // browser that drops third-party scripts all still produce this call. The
      // buyer's own details ride along from the pay/init handshake (meta_ctx).
      // Guarded: an `async` handler in Express 4 does not route a rejection to
      // error middleware, and a payment callback must answer PeleCard whatever an
      // ad platform is doing.
      try {
        if (metaArmed) sendPurchaseToMeta(c.id, null, { preclaimed: true });
      } catch (e) {
        console.error('[meta-capi] ' + c.id + ': ' + ((e && e.message) || e));
      }
    }
    res.json({ ok: true });
  });
}

// The public celebrations counter (/api/stats/orders).
function registerStatsOrders(app, { db }) {
  // Public social-proof "celebrations" counter for the homepage. Returns ONLY an
  // aggregate number: a fixed base plus the count of paid orders — never any order
  // detail. Unauthenticated on purpose (every visitor renders it). The base is a
  // named constant (overridable via env) so it's easy to bump later.
  // Base offset for the public celebrations counter. Guard against a non-numeric
  // env value (Number("twenty") → NaN would make the count serialize to null).
  const ORDERS_COUNT_BASE = (() => {
    const n = Number(process.env.ORDERS_COUNT_BASE);
    return Number.isFinite(n) ? n : 23;
  })();
  app.get('/api/stats/orders', (req, res) => {
    res.json({ count: ORDERS_COUNT_BASE + db.countPaidOrders() });
  });
}

// The public pricing reads (/api/pricing, /api/delivery-exceptions).
function registerPricing(app, { db }) {
  // Public, UNAUTHENTICATED: the effective pricing the storefront + checkout read
  // (the owner edits it from admin-pricing.html, no deploy). A WHITELISTED
  // projection of only the `pricing` settings section — the store display price and
  // each checkout version's { enabled, price }. No other settings section leaks
  // here. Mirrors GET /api/content (public overrides projection).
  app.get('/api/pricing', (req, res) => {
    // db.effectivePricing() is the SINGLE source shared with the charge path (it
    // reads the same versionEnabled/versionPrice/storeValue helpers), so the price
    // a buyer is shown can never disagree with the price the server charges — and a
    // corrupt override falls back to the same built-in default the charge uses (not
    // a misleading 0). Only the whitelisted { store, versions } is exposed here.
    res.json(db.effectivePricing());
  });

  // Public, UNAUTHENTICATED: the localities where delivery takes longer, and how
  // long. Its own endpoint rather than a field on /api/pricing, because the two
  // have completely different audiences: every storefront page fetches pricing for
  // its numbers, while this list — thousands of names on a real courier's
  // exceptions list — is printed by exactly one surface, the checkout's delivery
  // note. Riding along on pricing would put the whole list on the home page, the
  // shop and every product page, none of which will ever show a word of it.
  // A WHITELISTED projection like /api/faq: the parsed { towns, eta_days }, never
  // the raw multi-line settings string.
  app.get('/api/delivery-exceptions', (req, res) => {
    res.json(db.deliveryExceptions());
  });
}

module.exports = {
  registerStickersAndStock,
  registerReadyBatchAndHfd,
  registerCoupons,
  registerCouponValidate,
  registerOrder,
  registerPayment,
  registerStatsOrders,
  registerPricing,
};
