// Per-collection word files: the layout the store is moving to (docs/storage-plan.md).
//
// Words are 96% of dugri-data.json, and the whole file is rewritten on every save,
// so one word costs a rewrite of every other buyer's words. The plan moves them
// into one file per collection under DATA_DIR/words/, in two steps:
//
//   1a (this module, read side only): the store can READ this layout. It still
//      writes the single file with words in it, so nothing on disk changes yet.
//   1b: the boot split and the word writes. The main file then drops `words` /
//      `held_words` and carries WORDS_LAYOUT_KEY = 'files' instead.
//
// 1a ships and sits on production first so that redeploying the previous image
// after 1b lands on a build that can read what 1b wrote.
//
// WHICH SOURCE WINS (pickWordSource):
//   - `words` and no marker → the main file. That is the old layout, and also
//     what a 1a build writes after reading the files: it saves its words back
//     into the main file and drops the marker, so after a rollback to 1a the main
//     file is newer than the word files, which are left behind untouched and
//     stale. 1b's split must therefore treat such a main file as the truth and
//     overwrite (and prune) the word files from it.
//   - The marker and no `words` → the word files. A missing directory or an
//     unreadable file THROWS. Booting with those collections empty would look
//     like a buyer's words were deleted, and the first save would write that
//     emptiness into the main file, where it would win from then on.
//   - The marker AND `words` → BOTH, merged. Only a build from before 1a writes
//     this: it does not know the marker, keeps it as an unknown key, and saves
//     the words it had (none, from a split volume) plus any added since. Taking
//     the main file alone would hide every word in the files. Merged by word id,
//     the main file's copy winning (it is the newer); a word deleted under that
//     old build comes back, which is the price of losing none.
//   - Neither → no words (an empty or pre-words file), exactly as before.
const fs = require('fs');
const path = require('path');

const WORDS_DIR_NAME = 'words';
const WORDS_LAYOUT_KEY = 'words_layout';
const FORMAT = 1;

const wordsDir = (dataDir) => path.join(dataDir, WORDS_DIR_NAME);

// One collection's file. `collection_id` is repeated inside so a file renamed or
// copied to the wrong name is caught on read rather than merged into the wrong
// order.
function encode(collectionId, words, heldWords) {
  return JSON.stringify({
    format: FORMAT,
    collection_id: collectionId,
    words: words || [],
    held_words: heldWords || [],
  });
}

function decode(fileName, raw) {
  const id = fileName.slice(0, -'.json'.length);
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`word file ${fileName} is not valid JSON: ${e.message}`);
  }
  if (!doc || doc.format !== FORMAT) {
    throw new Error(`word file ${fileName} has format ${doc && doc.format}, expected ${FORMAT}`);
  }
  if (doc.collection_id !== id) {
    throw new Error(`word file ${fileName} belongs to collection ${doc.collection_id}`);
  }
  for (const key of ['words', 'held_words']) {
    if (!Array.isArray(doc[key])) throw new Error(`word file ${fileName}: ${key} is not a list`);
    const stray = doc[key].find((w) => !w || w.collection_id !== id);
    if (stray) throw new Error(`word file ${fileName}: a ${key} entry belongs elsewhere`);
  }
  return doc;
}

// Every collection's words, concatenated. Only `<id>.json` is read: a `.tmp` left
// by a write cut short is not a file the writer finished, and its finished
// predecessor is still in place beside it. Sorted by name so a boot is
// deterministic; nothing depends on the order ACROSS collections (every reader
// filters by collection, and listWords sorts by created_at).
function readWordsDir(dataDir) {
  const dir = wordsDir(dataDir);
  if (!fs.existsSync(dir)) {
    throw new Error(`${dir} is missing, but the data file says words are stored there`);
  }
  const words = [];
  const heldWords = [];
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort();
  for (const name of names) {
    const doc = decode(name, fs.readFileSync(path.join(dir, name), 'utf8'));
    words.push(...doc.words);
    heldWords.push(...doc.held_words);
  }
  return { words, held_words: heldWords };
}

// Applies the rule above to a parsed main file, in place, and returns it. The
// marker is removed once the words are in memory: this build writes them back
// into the main file, and a main file carrying both would be ambiguous.
function pickWordSource(parsed, dataDir) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed[WORDS_LAYOUT_KEY] === undefined) return parsed;
  if (parsed[WORDS_LAYOUT_KEY] !== 'files') {
    throw new Error(`unknown ${WORDS_LAYOUT_KEY} "${parsed[WORDS_LAYOUT_KEY]}" in the data file`);
  }
  const files = readWordsDir(dataDir);
  delete parsed[WORDS_LAYOUT_KEY];
  parsed.words = mergeById(files.words, parsed.words);
  parsed.held_words = mergeById(files.held_words, parsed.held_words);
  return parsed;
}

// The word files' list with the main file's copies laid over it by id, in the
// files' order, then any word only the main file has.
function mergeById(fromFiles, fromMain) {
  if (!Array.isArray(fromMain) || !fromMain.length) return fromFiles;
  const main = new Map(fromMain.map((w) => [w.id, w]));
  const out = fromFiles.map((w) => {
    const newer = main.get(w.id);
    main.delete(w.id);
    return newer || w;
  });
  return out.concat([...main.values()]);
}

module.exports = {
  WORDS_DIR_NAME,
  WORDS_LAYOUT_KEY,
  FORMAT,
  wordsDir,
  encode,
  decode,
  readWordsDir,
  pickWordSource,
};
