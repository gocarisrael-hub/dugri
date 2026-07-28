// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server/** went unlinted for the whole life of the backend: eslint.config.js had
// blocks for site/js/**, tests/** and the root config files, and nothing matched
// server/. A duplicate object key reached main that way — two `board_file` keys
// in one setProduction literal, the second silently winning, so production
// recorded null and boards were never delivered. `eslint .` stayed green.
//
// These tests pin the coverage itself, not a specific rule list: a future edit
// that reorders or narrows the config and drops the backend again fails here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const lint = (code, file) =>
  new ESLint({ cwd: repoRoot }).lintText(code, { filePath: path.join(repoRoot, file) });

describe('eslint covers the backend', () => {
  it('flags a duplicate object key in server/** — the defect that reached main', async () => {
    const [result] = await lint(
      'const o = { a: 1, b: 2, a: 3 };\nmodule.exports = o;\n',
      'server/x.js'
    );
    const rules = result.messages.map((m) => m.ruleId);
    expect(rules).toContain('no-dupe-keys');
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('applies SOME config to server/** at all (an unmatched file gets zero rules)', async () => {
    // `notDefinedAnywhere` is an error only if a config block matched this path.
    const [result] = await lint('notDefinedAnywhere();\n', 'server/y.js');
    expect(result.messages.map((m) => m.ruleId)).toContain('no-undef');
  });

  it('understands CommonJS in server/** (require/module are not undefined)', async () => {
    const [result] = await lint("const fs = require('fs');\nmodule.exports = fs;\n", 'server/z.js');
    expect(result.messages.filter((m) => m.ruleId === 'no-undef')).toHaveLength(0);
  });
});
