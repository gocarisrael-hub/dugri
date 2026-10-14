# Storage plan: getting off the single JSON file

Status: PROPOSAL for the owner to decide. No code has changed. Written 2026-10-14 by Agent D.

## The problem, measured

All orders, words, coupons, stock and reminder state live in one file, `/data/dugri-data.json`.
`saveDb()` (`server/db.js`) rewrites the whole file on every change, synchronously, so the whole
server (pages, API, payments) is frozen while it writes. Since #655 the file is compact JSON.

Measured locally (Apple M4, median of 7). The synthetic store is built from a real collection made
through `db.js` (delivery order, paid), cloned N times with 100 words each. Railway will be slower
in absolute terms; the ratios carry over.

| orders | whole file | of which NOT words | one save today | one save, words moved out |
| -----: | ---------: | -----------------: | -------------: | ------------------------: |
|  1,000 |    27.7 MB |             1.2 MB |          80 ms |                    3.8 ms |
|  3,000 |    83.5 MB |             3.6 MB |         274 ms |                     11 ms |
| 10,000 |   278.7 MB |            12.1 MB |         821 ms |                     37 ms |

**Words are 96% of the file.** Almost all of the freeze is rewriting other people's words to save
one change. Writing one collection's 100 words as a file of its own takes 0.2 ms.

Facts the options below depend on:

- **72 `saveDb()` call sites**, not 47: 46 in `server/db.js`, 17 in `server/stores/commerce.js`,
  5 in `server/stores/platform.js` and 4 in `server/stores/catalog.js`. The 47 counted `db.js` alone
  before the store split.
- **13 store methods touch words** (`_db.words` / `_db.held_words`): `addWords`, `deleteWord`,
  `editWord`, `listWords`, `countWords`, `listHeldWords`, `countHeldWords`, `releaseHeld`,
  `listAllCollections`, `deleteCollection` in `db.js`; `lastActivityMs`, `markOrderNotified` in
  `stores/platform.js`. Of these, four save: `addWords`, `deleteWord`, `editWord`,
  `deleteCollection`. Nothing outside the store reads words directly.
- **254 `db.*()` calls** outside the store (`index.js` 142, `routes/commerce.js` 53,
  `platform-hooks.js` 34, `routes/platform.js` 17, `routes/catalog.js` 6, two more), and 98 unit
  test files. Every one is synchronous today.
- **Production runs `node:20-alpine`** (`Dockerfile`). Node 20 has no built-in SQLite.
- **The orders file has no backup in code.** `store-backup.js` covers settings, the playbook,
  gallery and photo-fallback stores. It does not cover `dugri-data.json`. Whether Railway volume
  backups are switched on for production is unknown (see Phase 0).
- **Payments self-heal; words do not.** A Tranzila payment lost from the file is re-read from
  Tranzila by the sweep. A buyer's words exist only in this file.

## The options

### (a) Move words out of the single file

Words stay in memory exactly as today. They are persisted per collection, as
`/data/words/<collection id>.json` (temp file + rename, the same as the main file). The main file
no longer carries `words` / `held_words`.

- **Freeze per save:** a change to an order rewrites only the 1.2 / 3.6 / 12.1 MB main file
  (3.8 / 11 / 37 ms). A word change rewrites only that collection's words file (0.2 ms).
- **Save sites that change:** 4 of 72 (the word-saving methods above), plus the 9 word readers,
  all inside `db.js` / `stores/platform.js`. None of the 254 callers changes. The other 68 save
  sites, including `markPaid`, `setOrder`, `createCollection` and every commerce store write, keep
  exactly today's path.
- **Migration from the live file:** on boot, if the main file still has `words`: back up the main
  file (`backupFile`), write every collection's words file, read them all back and compare counts,
  and only then save the main file without words. This is idempotent: a crash midway re-runs it.
- **Atomicity:** two files are no longer written in one step. Order the writes so that a crash
  between them leaves, at worst, an orphan words file for a deleted collection (pruned at boot) or
  a word saved without its collection's activity timestamp. Payment state lives only in the main
  file, so it is never split.
- **Rollback hazard:** an older image reads a main file with no `words` and shows every collection
  as empty. The words are not lost on disk, but the old code cannot see them. That is why the
  phased order below ships the reader first.
- **Backup/restore:** a directory instead of one file. The Railway volume backup covers both.
- **Cost:** nothing new. Disk is unchanged (~28 MB at 1,000 orders).
- **Risk to payments:** lowest. The payment write path is byte-for-byte today's, only on a smaller
  file.

### (b) SQLite on the Railway volume

One `/data/dugri.db` file: a `words` table (one row per word) and a `collections` table (one JSON
document per row), in WAL mode. To avoid touching all 72 save sites, `saveDb()` keeps its
signature: word methods write their rows directly, and `saveDb()` writes only the collection rows
whose JSON changed since the last save (hash per row).

- **Freeze per save:** one word insert measured 0.01 ms (`synchronous=NORMAL`) to 0.05 ms
  (`FULL`). The collections diff still stringifies every collection: about the "not words" column
  above (3.8 / 11 / 37 ms), until collections also get per-row writes.
- **Save sites that change:** the same 4 word sites plus the `saveDb()` internals. Going further
  (per-row writes for every mutator, so no diff at all) means all 72.
- **New dependency:** Node 20 has no SQLite. Either upgrade the image to Node 22 or later and use
  `node:sqlite` (flagged as still in development in Node 22), or add `better-sqlite3`, a native
  module that must build or ship a prebuilt binary for Alpine (musl). Either way this is a
  platform change on top of the storage change.
- **Migration:** on boot, import the JSON file into the database in one transaction, verify row
  counts, then rename the JSON file to `dugri-data.json.migrated`. Rollback = redeploy the old
  image and rename the file back. Writes made after the migration exist only in SQLite, so they
  need an export step.
- **Atomicity:** better than today. A word and its collection change commit together in one
  transaction.
- **Backup/restore:** a single file, consistently copyable with SQLite's backup API. Volume backups
  cover it.
- **Cost:** nothing new; the file is about 1.8 times the JSON size (50 MB at 1,000 orders).
- **Risk to payments:** medium. Every write, including `markPaid`, goes through a new engine and a
  new native or experimental dependency.

### (c) Railway Postgres

A separate Railway Postgres service, reached over the private network.

- **Freeze per save:** none in-process. A write is a network round trip, but not a freeze. Not
  measured here: there is no Postgres to measure against.
- **Save sites that change:** all 72, and all 254 callers plus the 98 test files, because every
  Postgres client in Node is asynchronous. `db.markPaid(...)` becomes `await db.markPaid(...)`
  through every route in all four domains. The alternative of keeping memory as the truth and
  writing behind to Postgres breaks "on disk before the response", so it is not an option.
- **Migration:** a one-off import script and a cutover window with writes stopped. Rollback means
  exporting Postgres back to the JSON shape.
- **Backup/restore:** Postgres dumps, and the Railway volume backups of the database service. The
  only option whose data does not sit on the same volume as the app.
- **Cost:** a small always-on database. At Railway's rates ($10/GB-month RAM, $20/vCPU-month,
  $0.15/GB-month disk), roughly 100–250 MB RAM is $1–2.5 a month, plus a little CPU and disk.
  Estimated $2–5 a month on top of dugri's ~$5.4. Not measured.
- **Risk to payments:** highest. Every payment path is rewritten to be asynchronous at once.
- **What only (c) buys:** more than one app replica (Hobby allows 6). Nothing else here allows it,
  and the in-memory store would also have to go. At 10,000 orders, (a) or (b) keeps the freeze at
  tens of milliseconds, so replicas are not what the order count calls for.

### Side by side

|                            | (a) words out             | (b) SQLite                          | (c) Postgres                    |
| -------------------------- | ------------------------- | ----------------------------------- | ------------------------------- |
| freeze at 1k / 3k / 10k    | 4 / 11 / 37 ms            | 4 / 11 / 37 ms (diffed)             | none in-process (network write) |
| save sites changed (of 72) | 4                         | 4 + saveDb internals                | 72, plus 254 callers            |
| new dependency             | none                      | Node 22+ or native module           | a database service + client     |
| migration                  | split on boot, idempotent | import on boot, one transaction     | import script + cutover         |
| rollback                   | needs reader-first phase  | rename file back, export new writes | export to JSON                  |
| extra monthly cost         | $0                        | $0                                  | ~$2–5 (estimate)                |
| risk to payments           | lowest                    | medium                              | highest                         |

## fsync

**Today there is none.** `saveDb()` writes a temp file and renames it, without `fsync`. A crashed or
redeployed process loses nothing: the kernel already holds the data. A lost machine (host crash,
power loss) can lose the last few seconds of writes. Depending on the filesystem it could also
leave the old file. The volume's filesystem has not been checked.

**What it costs:** measured locally, +3 ms on the 28 MB file and +4 ms on a small file. That is a
FLOOR. On macOS `fsync` does not flush the drive cache, and a Railway volume is network or virtual
storage whose flush latency is unmeasured (production reads are blocked in the agent's session).

**Recommendation:** add it after phase 1, not before. Today every save would pay it on a 28 MB
file. After (a), saves are small and the cost is a few milliseconds. Add `fsync` on the temp file,
plus an `fsync` of the directory after the rename (without it the rename itself is not durable).
Measure on the staging volume first: a one-line timing of 100 fsynced writes via `railway ssh` on
staging. Payments are covered either way by the Tranzila sweep; words are what fsync protects.

## Recommendation and phased order

**Recommend (a), words out of the single file, then fsync. Hold (b) and (c) until there is a
reason only they meet.** (a) removes 96% of the freeze and changes 4 of 72 save sites. It adds no
dependency and leaves the payment write path untouched. (b) gives the same freeze for a platform
change. (c) is a rewrite of every route in every domain, for replicas the order count does not need.

0. **Now, no code (owner, in the Railway dashboard):** switch on volume backups for the production
   volume (daily and weekly), and do one restore drill on staging. The orders file has no other
   backup. Also report the real file size and order count; agents cannot read production.
1. **1a, reader only:** the store reads words from `/data/words/*.json` when present, and from the
   main file otherwise. It still writes the main file with words. Ships and deploys first, so
   rolling back from 1b lands on a build that understands both layouts.
2. **1b, writer and migration:** the boot split (backup, write, read-back count check, then drop
   words from the main file), and the four word-saving methods write per-collection files. Tests:
   split round-trip, crash at each step of the split, counts preserved, payment writes unchanged,
   and a 1a image reading a 1b volume.
3. **fsync:** measure on staging, then add file and directory fsync to every save.
4. **Revisit (b) or (c)** only if one of these happens: the main file alone passes about 50 ms per
   save (around 15,000 orders by the table), the owner needs more than one replica, or reporting
   needs queries the in-memory store cannot answer.

Rollback at every phase: redeploy the previous image. Phase 1b's rollback is safe because 1a reads
both layouts. Before 1a is on production, there is no layout change to roll back.
