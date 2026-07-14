import { describe, it, expect } from 'vitest';
import {
  normalizeWord,
  dedupeWords,
  parseWordText,
  buildBulkCsv,
  newestFirst,
} from '../../site/js/collect.js';
import { fillName, nextPrompt, PROMPTS } from '../../site/js/word-prompts.js';

describe('normalizeWord', () => {
  it('trims, collapses whitespace, lowercases', () => {
    expect(normalizeWord('  Hello   World ')).toBe('hello world');
  });
  it('handles null/undefined', () => {
    expect(normalizeWord(null)).toBe('');
    expect(normalizeWord(undefined)).toBe('');
  });
});

describe('dedupeWords', () => {
  it('removes case/space-insensitive dups, preserves first-seen order, drops empties', () => {
    expect(dedupeWords(['a', 'A', ' a ', 'b', '', '  '])).toEqual(['a', 'b']);
  });
  it('keeps the original (trimmed) text of the first occurrence', () => {
    expect(dedupeWords(['  Shira ', 'shira'])).toEqual(['Shira']);
  });
});

describe('parseWordText', () => {
  it('splits on newlines and commas, trims, drops empties', () => {
    expect(parseWordText('one\ntwo, three\n\nfour')).toEqual(['one', 'two', 'three', 'four']);
  });
  it('handles CRLF and stray commas', () => {
    expect(parseWordText('a,,b\r\nc,')).toEqual(['a', 'b', 'c']);
  });
});

describe('buildBulkCsv', () => {
  it('has a 32-column c1w1..c8w4 header', () => {
    const header = buildBulkCsv(['x']).split('\n')[0].split(',');
    expect(header).toHaveLength(32);
    expect(header[0]).toBe('c1w1');
    expect(header[31]).toBe('c8w4');
  });
  it('pads a short page to 32 cells and makes one data row', () => {
    const lines = buildBulkCsv(['a', 'b', 'c']).split('\n');
    expect(lines).toHaveLength(2); // header + 1 page
    expect(lines[1].split(',')).toHaveLength(32);
  });
  it('makes a second page past 32 words', () => {
    const words = Array.from({ length: 33 }, (_, i) => 'w' + i);
    expect(buildBulkCsv(words).split('\n')).toHaveLength(3); // header + 2 pages
  });
  it('dedupes before building', () => {
    const lines = buildBulkCsv(['dup', 'dup', 'x']).split('\n');
    expect(lines).toHaveLength(2);
  });
  it('csv-escapes cells with commas', () => {
    expect(buildBulkCsv(['a,b']).split('\n')[1]).toContain('"a,b"');
  });
  it('neutralizes spreadsheet formula-injection cells', () => {
    expect(buildBulkCsv(['=1+1']).split('\n')[1]).toContain("'=1+1");
  });
});

describe('newestFirst', () => {
  it('returns words newest-first (reversed) without mutating the source', () => {
    const src = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(newestFirst(src).map((w) => w.id)).toEqual([3, 2, 1]);
    // The source array is untouched, so delete/edit keep targeting words by id.
    expect(src.map((w) => w.id)).toEqual([1, 2, 3]);
  });
  it('handles empty and non-array input', () => {
    expect(newestFirst([])).toEqual([]);
    expect(newestFirst(null)).toEqual([]);
    expect(newestFirst(undefined)).toEqual([]);
  });
});

describe('word prompts', () => {
  it('fillName interpolates the honoree name', () => {
    expect(fillName('איך קוראים ל{name}?', 'שירה')).toBe('איך קוראים לשירה?');
  });
  it('fillName falls back when name is empty', () => {
    expect(fillName('הרגל של {name}', '')).toContain('בעלת השמחה');
  });
  it('nextPrompt returns a prompt from the bank', () => {
    const p = nextPrompt([], () => 0);
    expect(p).toBe(PROMPTS[0]);
  });
  it('nextPrompt avoids ids already seen', () => {
    const seen = PROMPTS.slice(1).map((p) => p.id); // everything except the first
    const p = nextPrompt(seen, () => 0.999);
    expect(p.id).toBe(PROMPTS[0].id);
  });
});
