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
//
// The PAYMENT block is deliberately NOT here — it stays in index.js as slice 3b.
// The boundary would have cut through settleVerifiedPayment, which the PeleCard
// callback (moving) and decideTranzilaRow (staying) both call.

// The self-collection sticker sheet (/api/admin/stickers, /api/admin/pickup-stickers)
// and the physical stock (/api/admin/stock).
// WHICH GAME IS IN THIS BOX — the one answer BOTH labels print, ours and the
// courier's.
//
// There were two of these: one inside registerStickersAndStock for the
// self-collection sticker, one inside registerReadyBatchAndHfd for HFD's. Same
// question, two implementations, nothing binding them — so they disagreed exactly
// when the themes file does not name the theme: the courier label fell through to
// `c.design` (the name STAMPED at order time) while the sticker dropped straight
// to the raw key. Theme keys are Latin slugs (`bachelorette`, `trip comeback`), so
// that box went out with סיישל on one label and `trip comeback` on the other.
//
// It lives at MODULE scope rather than being injected: both registers are
// Commerce's own and both already hold `templates` + `TEMPLATE_ROOT`, so there is
// nothing to plumb. (Contrast `orderReadySmsWillSend`, which is injected because
// it crosses a domain boundary — D's gate into A's dialog.)
//
// Three steps, in this order, through the shared helper /api/design-names and the
// storefront already use:
//   1. the themes file's current `display_he` — a rename propagates here;
//   2. else the name stamped on the order — stale, but a human wrote it;
//   3. else the theme key — an odd-looking label beats a blank one.
//
// Takes the COLLECTION, not a theme key, because step 2 needs `c.design`.
// Delegating also inherits ownTheme's guard, so a theme called `__proto__` or
// `constructor` resolves to nothing rather than to Object's own properties, which
// the hand-rolled `themes[key]` lookups did not.
function designNameForCollection(templates, TEMPLATE_ROOT, c) {
  if (!c) return '';
  const theme = c.theme || null;
  try {
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
    return templates.displayNameForDesign(themes, { theme, name: c.design, id: theme });
  } catch {
    // No themes file at all: the stamped name still ships, then the key.
    return String((c && c.design) || theme || '');
  }
}

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

  // Bound to this register's injected templates/TEMPLATE_ROOT. The rule itself is
  // at module scope so the courier label calls the SAME one.
  const designNameFor = (c) => designNameForCollection(templates, TEMPLATE_ROOT, c);

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
        // How many boxes this order goes out in (db.orderBoxes): one label per
        // box. 1 for a single copy or for all copies in one box; an order placed
        // before the box choice existed is a box per copy.
        const boxes = Math.max(1, db.orderBoxes(c.order));
        // The courier's shipments still standing, one per box — a box's label is
        // fetched by its own shipment number. A cancelled one has no label.
        const shipments = db
          .hfdShipments(c.order)
          .filter((r) => r && r.shipment_number && !r.cancelled_at)
          .map((r) => ({ box: r.box || 1, shipment_number: String(r.shipment_number) }));
        return {
          id: c.id,
          kind: c.order.version === 'delivery' ? 'delivery' : 'pickup',
          // The first courier shipment, when there is one to fetch a label for
          // (the whole list is `shipments`).
          shipment_number: shipments.length ? shipments[0].shipment_number : null,
          shipments,
          // Boxes of a delivery with no shipment booked yet — named back to the
          // owner with the unbooked ones, since their labels cannot print.
          missing_boxes: c.order.version === 'delivery' ? Math.max(0, boxes - shipments.length) : 0,
          boxes,
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
            design: designNameFor(c),
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
  // The map is keyed by SHIPMENT NUMBER, not by order: an order whose copies
  // went out in separate boxes has a shipment — and a label — per box.
  async function fetchCourierLabels(entries, outDir) {
    const wanted = entries
      .filter((e) => e.kind === 'delivery')
      .flatMap((e) => courierShipments(e).map((s) => ({ e, number: s.shipment_number })));
    const files = new Map();
    const failed = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= wanted.length) return;
        const { e, number } = wanted[i];
        let r;
        try {
          r = await hfd.fetchLabel(number);
        } catch (err) {
          r = { ok: false, error: (err && err.message) || String(err) };
        }
        if (!r.ok) {
          console.error('hfd label failed for', number, '-', r.error);
          failed.push({
            order_no: e.label.order_no,
            shipment_number: number,
            message: r.error,
          });
          continue;
        }
        const file = path.join(outDir, 'hfd-' + number + '.pdf');
        try {
          fs.writeFileSync(file, r.pdf);
          files.set(number, file);
        } catch (err) {
          failed.push({
            order_no: e.label.order_no,
            shipment_number: number,
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
  //
  // ONE LABEL PER BOX. A self-collection order whose copies go out in separate
  // boxes gets a label for each, marked `1/3`, `2/3`, `3/3`, so the boxes of one
  // order can be matched up on the shelf and none is handed over short. One box
  // gets one label with no mark, exactly as before. A delivery in separate boxes
  // is a separate HFD booking per box, so it is one courier label per shipment,
  // in box order (`files` is keyed by shipment number).
  function stickerEntries(printable, files) {
    return printable.flatMap((e) => {
      if (e.kind === 'pickup') {
        const n = Math.max(1, Number(e.boxes) || 1);
        if (n === 1) return [e.label];
        return Array.from({ length: n }, (_, i) => ({ ...e.label, box: i + 1 + '/' + n }));
      }
      return courierShipments(e)
        .map((sh) => files.get(sh.shipment_number))
        .filter(Boolean)
        .map((file) => ({ pdf: file }));
    });
  }

  // A delivery entry's live shipments. An entry built without the list (one
  // shipment, the shape before boxes) is read as its single number.
  function courierShipments(e) {
    if (Array.isArray(e.shipments)) return e.shipments;
    return e.shipment_number ? [{ box: 1, shipment_number: String(e.shipment_number) }] : [];
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
    // A delivery with ANY box not yet booked is named here: its booked boxes'
    // labels still print, the rest need one more press of שלח ל-HFD.
    const unbooked = batch.filter(
      (e) => e.kind === 'delivery' && (!e.shipment_number || e.missing_boxes > 0)
    );
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

  return {
    stickerBatch,
    pickupStickerOrders,
    stickerEntries,
    stockDesigns,
    designNameForCollection: designNameFor,
  };
}

// The ready-batch press and the HFD courier routes.
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
    // The per-order answer from index.js, NOT re-derived here. queueReadySms
    // gates on this same function at send time, so the dialog and the sender
    // cannot drift apart — which is the whole point: a second copy of the rule
    // is what would put them back out of step the next time a condition is added.
    orderReadySmsWillSend,
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
      // WILL A TEXT BE ATTEMPTED FOR THIS ONE. Answered by the sender's own
      // gate, so it accounts for every condition at once — self-pickup, the
      // template being armed, and a mobile the gateway accepts. Reporting the
      // ingredients separately (has_phone + sms_enabled) left the owner to
      // multiply them in her head, and after the order-ready text was narrowed
      // to self-pickup that arithmetic silently stopped being right: a delivery
      // buyer with a perfectly good mobile is not listed under no_phone and gets
      // nothing. ATTEMPTED, not delivered — a queued message can still fail, and
      // a failed one can still have reached her.
      will_sms: Boolean(orderReadySmsWillSend(c)),
    };
  }

  // The preview. Read-only and separate from the press on purpose: a button that
  // blasts messages on its first click is a button that gets clicked by accident.
  app.get('/api/admin/orders/ready-batch', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = batchReadyCandidates().map(batchReadyRow);
    const smsArmed = orderReadySmsArmed();
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
      // How many texts this press will ATTEMPT. The one number the dialog was
      // missing: `sms_enabled` says the template is on, `no_phone` says who has
      // no mobile, and neither says how many people actually get a message.
      will_sms: rows.filter((r) => r.will_sms).length,
      // …and WHO does not, despite our holding a mobile for them — the delivery,
      // digital and custom orders the order-ready text is not for. Named rather
      // than counted, for the same reason no_phone is: the owner may want to tell
      // these people some other way, and a number sends her hunting.
      // Empty when the text is switched off entirely: then nothing was going to
      // be attempted for ANYONE, and naming every row would be noise rather than
      // the call-by-hand list this exists to produce. Exactly the rule
      // `not_emailed` follows below, for the same reason.
      no_sms_with_phone: smsArmed
        ? rows.filter((r) => r.has_phone && !r.will_sms).map((r) => r.order_no)
        : [],
      // What will ACTUALLY be sent. The dialog is the last thing she reads before
      // an action that cannot be taken back, so both answers come from the same
      // gates the senders themselves use — a switched-off template must not be
      // described as "everyone gets a mail".
      sms_enabled: smsArmed,
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

  // The courier sticker's design name is the SAME question the self-collection
  // sticker asks, so it is the same function: see designNameForCollection above.
  // It used to be a second implementation here, and the two disagreed for any
  // theme the themes file does not name.
  //
  // Note on what was dropped: this read `(c.order && c.order.theme) || c.theme`.
  // Nothing in the repo ever assigns `order.theme` (`git grep 'order\.theme\s*='`
  // is empty) and no stored order carries it — 0 of 330 checked read-only in
  // production — so that branch was vestigial and is gone rather than carried
  // forward into the shared resolver. `site/admin.html` still reads it the same
  // defensive way; harmless, and not this PR's business.

  // Admin: is the courier integration armed? The admin page asks once at load and
  // hides the whole control when it isn't, rather than offering a button that can
  // only fail.
  app.get('/api/admin/hfd/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(hfd.status());
  });

  // Is this shipment record a van that is still coming?
  const liveShipment = (r) => !!(r && r.shipment_number && !r.cancelled_at);

  // What every HFD route answers with: box 1's record as `hfd` (the shape the
  // page and every caller read before shipments were per box), and the whole
  // list, one record per box, as `shipments`, with how many boxes there are.
  function hfdState(id) {
    const c = db.getCollection(id);
    const order = (c && c.order) || null;
    return {
      hfd: (order && order.hfd) || null,
      shipments: db.hfdShipments(order),
      boxes: Math.max(1, db.orderBoxes(order)),
    };
  }

  // One booking at a time per order. The page keeps its button dead while a
  // press is in flight, but two tabs are two buttons; a second van for the same
  // box is a real charge, so the server refuses the overlap itself.
  const hfdBooking = new Set();

  // Admin: book this delivery order's parcels. Deliberately manual — a shipment
  // is a van and a charge, so it happens when the owner presses, never on a state
  // change.
  //
  // ONE BOOKING PER BOX. Copies packed separately (db.orderBoxes — a box per copy
  // unless the buyer chose one box, and for every order from before that choice)
  // are separate HFD deliveries, each with its own number, label and tracking.
  // The press books exactly the boxes that have NO live shipment: a retry after a
  // refusal half-way, or after one box was cancelled, books only what is missing
  // and never a second van for a box that already has one.
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
    const boxes = Math.max(1, db.orderBoxes(c.order));
    const list = db.hfdShipments(c.order);
    const missing = [];
    for (let k = 1; k <= boxes; k += 1) {
      if (!list.some((r) => (r.box || 1) === k && liveShipment(r))) missing.push(k);
    }
    // A second press must not book a second van. The already-booked shipments
    // are returned with the refusal so the page can just show them.
    if (!missing.length) {
      const numbers = list.filter(liveShipment).map((r) => r.shipment_number);
      return res.status(409).json({
        error: 'already booked',
        message: 'כבר נוצר משלוח להזמנה הזו (' + numbers.join(', ') + ').',
        ...hfdState(c.id),
      });
    }
    if (hfdBooking.has(c.id)) {
      return res.status(409).json({
        error: 'busy',
        message: 'המשלוח להזמנה הזו כבר נשלח ל-HFD, רגע…',
        ...hfdState(c.id),
      });
    }
    hfdBooking.add(c.id);
    try {
      const designName = designNameForCollection(templates, TEMPLATE_ROOT, c);
      const booked = [];
      for (const box of missing) {
        const r = await hfd.createShipment(c, { designName, box, boxes });
        if (!r.ok) {
          // Our own data is wrong (not a delivery, no address): nothing went to
          // HFD for this box, and the same is true of every other box.
          if (HFD_LOCAL_ERRORS[r.error]) {
            return res.status(400).json({
              error: r.error,
              message: HFD_LOCAL_ERRORS[r.error],
              ...hfdState(c.id),
            });
          }
          // HFD refused. Remember why, on THAT box: the owner comes back to this
          // row later, and "it didn't work" with no reason is what sends her to
          // the phone. Stop here rather than hammer the courier with the same
          // request for the next box; the next press books what is still missing.
          console.error('hfd create refused for', c.id, 'box', box + '/' + boxes, '-', r.error);
          db.setHfdShipment(c.id, { error: r.error, error_at: new Date().toISOString() }, box);
          const message =
            boxes > 1 && booked.length
              ? r.error + ' (נפתחו ' + booked.length + ' מתוך ' + boxes + ' משלוחים)'
              : r.error;
          return res.status(502).json({
            error: 'hfd refused',
            message,
            booked,
            ...hfdState(c.id),
          });
        }
        db.setHfdShipment(
          c.id,
          {
            shipment_number: r.shipmentNumber,
            rand_number: r.randNumber,
            tracking_url: hfd.trackingUrl(r.randNumber),
            sent_at: new Date().toISOString(),
            cancelled_at: null,
            error: null,
            error_at: null,
          },
          box
        );
        booked.push(box);
      }
      res.json({ ok: true, booked, ...hfdState(c.id) });
    } finally {
      hfdBooking.delete(c.id);
    }
  });

  // The record a label or cancel request means: `?box=k` names one box; without
  // it, the first live shipment (or, for history, the first record at all).
  function pickShipment(order, boxParam) {
    const list = db.hfdShipments(order);
    if (boxParam != null && boxParam !== '') {
      const k = Number(boxParam);
      return list.find((r) => (r.box || 1) === k) || null;
    }
    return list.find(liveShipment) || list[0] || null;
  }

  // Admin: a parcel's sticker, proxied so the token never reaches the browser.
  // Inline, because the owner prints it straight from the tab. `?box=k` for one
  // box of an order sent as several.
  app.get('/api/admin/collections/:id/hfd/label', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const c = db.getCollection(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const rec = pickShipment(c.order, req.query.box);
    const number = rec && rec.shipment_number;
    if (!number) return res.status(404).json({ error: 'no shipment' });
    const r = await hfd.fetchLabel(number);
    if (!r.ok) return res.status(502).json({ error: 'hfd label failed', message: r.error });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="hfd-' + number + '.pdf"');
    res.send(r.pdf);
  });

  // Admin: cancel the booked parcels — every live one, or `?box=k` for one. The
  // numbers are KEPT (marked cancelled) — an order's shipping history is
  // evidence, and a cleared field cannot say that a van was once ordered and
  // stood down.
  app.delete('/api/admin/collections/:id/hfd', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const c = db.getCollection(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const list = db.hfdShipments(c.order);
    let targets;
    if (req.query.box != null && req.query.box !== '') {
      const one = pickShipment(c.order, req.query.box);
      targets = one ? [one] : [];
    } else {
      targets = list.filter(liveShipment);
      // Nothing live: answer with the history, as a single cancelled one did.
      if (!targets.length && list.some((r) => r.shipment_number)) {
        return res.json({ ok: true, ...hfdState(c.id) });
      }
    }
    if (!targets.length || !targets.some((r) => r.shipment_number)) {
      return res.status(404).json({ error: 'no shipment' });
    }
    for (const rec of targets) {
      if (!rec.shipment_number || rec.cancelled_at) continue;
      const r = await hfd.cancelShipment(rec.shipment_number);
      if (!r.ok) {
        // LOGGED, not only returned. A refusal the owner reports as "it says it
        // failed" is unanswerable without HFD's own words for it, and this is the
        // only place they exist. Boxes cancelled before it stay cancelled.
        console.error('hfd cancel refused for', rec.shipment_number, '-', r.error);
        return res.status(502).json({ error: 'hfd refused', message: r.error, ...hfdState(c.id) });
      }
      db.setHfdShipment(c.id, { cancelled_at: new Date().toISOString() }, rec.box || 1);
    }
    res.json({ ok: true, ...hfdState(c.id) });
  });
}

// The admin coupon routes and the partner report.
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

// The checkout's coupon preview.
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

// Setting the order (version + price + optional delivery address).
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
      // One box for every copy, or a box each — decides the delivery fee.
      one_box: b.one_box,
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
      one_box: typeof r.one_box === 'boolean' ? r.one_box : null,
      boxes: db.orderBoxes(r),
    });
  });
}

// The public celebrations counter.
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

// The public pricing reads.
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
  registerStatsOrders,
  registerPricing,
};
