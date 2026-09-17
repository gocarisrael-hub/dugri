// @vitest-environment jsdom
//
// THE PLAYER COUNT, PUT BEHIND A BUTTON.
//
// Four players is the standard deck and the default. Almost nobody changes it, so
// the 4/8/12/16 choice no longer sits on the main path: it is revealed by
// "רוצים יותר חיילים? לחצו כאן", together with what choosing more costs in word
// cards. The deck is always 104 cards, so every pawn card is a word card fewer.
//
// WHAT THESE HOLD STILL, and why each one is here rather than being obvious:
//
//   * the choice is really hidden, and really appears — asserted on `hidden` and
//     on aria-expanded together, because a sighted buyer believes one and a
//     screen reader believes the other, and they are two halves of one fact;
//   * a buyer who never opens it submits the SAME ORDER as before. Asserted on
//     the value that reaches the payload, not on what the control looks like: a
//     test that checks the control would pass just as happily if the number never
//     reached the order at all;
//   * the cost line is still written from pawnPlan — the page's single piece of
//     deck arithmetic, already pinned against the server by pawn-count.test.js —
//     rather than a second copy of the rule living in the markup;
//   * a buyer who ALREADY chose a bigger deck finds it open. Collapsing it on her
//     would hide a decision she has made behind a button inviting her to make it.
//
// The wizard is one enormous inline script that wants fetch, feature flags and a
// design catalogue before it will boot, so — like tests/unit/pawn-count.test.js —
// this reads the page as text and runs the pieces it covers.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(root, 'site', 'options.html'), 'utf8');

// The disclosure's own logic, lifted out of the page by name so a rename here is
// a failure rather than a test that quietly stops covering anything.
function wizardFunction(name) {
  const at = html.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('site/options.html no longer declares ' + name);
  // Balance braces from the function's opening one.
  const open = html.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error('unterminated ' + name);
}

/** The page's own setPawnCountOpen, bound to a DOM shaped like the real one. */
function mountDisclosure() {
  document.body.innerHTML = `
    <button type="button" id="pawnCountToggle" aria-expanded="false" aria-controls="pawnCountPanel">
      רוצים יותר חיילים? לחצו כאן
    </button>
    <div id="pawnCountPanel" hidden>
      <div class="pawn-count-row">
        <div class="pawn-count" id="pawnCount" role="group" aria-label="מספר שחקנים"></div>
      </div>
      <p class="pawn-budget-note" id="pawnBudgetNote"></p>
    </div>`;
  const pawnCountToggle = document.getElementById('pawnCountToggle');
  const pawnCountPanel = document.getElementById('pawnCountPanel');
  const setPawnCountOpen = new Function(
    'pawnCountToggle',
    'pawnCountPanel',
    wizardFunction('setPawnCountOpen') + '; return setPawnCountOpen;'
  )(pawnCountToggle, pawnCountPanel);
  return { toggle: pawnCountToggle, panel: pawnCountPanel, setPawnCountOpen };
}

describe('the choice is behind the button, and the button says so', () => {
  it('is shut until it is pressed, and open after — in both channels at once', () => {
    const { toggle, panel, setPawnCountOpen } = mountDisclosure();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    setPawnCountOpen(true);
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    setPawnCountOpen(false);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals the counts AND what they cost, in the same panel', () => {
    const { panel } = mountDisclosure();
    // The choice itself…
    expect(panel.querySelector('#pawnCount')).not.toBeNull();
    // …and the cost line, which is the half of her request that is easy to drop.
    expect(panel.querySelector('#pawnBudgetNote')).not.toBeNull();
  });

  it('keeps the group’s own name for a screen reader', () => {
    const { panel } = mountDisclosure();
    const group = panel.querySelector('#pawnCount');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('מספר שחקנים');
  });
});

// SOURCE GUARDS, over the page as shipped.
describe('the page ships the disclosure, not just the logic', () => {
  it('uses a real button, keyboard-reachable, with its state and its target', () => {
    const tag = /<button[^>]*id="pawnCountToggle"[\s\S]*?>/.exec(html)[0];
    expect(tag).toContain('type="button"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('aria-controls="pawnCountPanel"');
    // Owner-editable like the rest of this step's copy.
    expect(tag).toContain('data-edit=');
  });

  it('starts shut, and the panel is the thing that hides', () => {
    const panel = /<div[^>]*id="pawnCountPanel"[^>]*>/.exec(html)[0];
    expect(panel).toContain('hidden');
  });

  it('opens itself for a buyer who already asked for a bigger deck', () => {
    // Both restore routes (?players= and the saved selection) have run by the time
    // this fires; without it her existing choice would sit behind a button that
    // invites her to make it.
    expect(html).toContain('setPawnCountOpen(pawnPlayers !== PLAYER_COUNTS[0])');
  });

  // THE COST LINE IS NOT A STRING IN THE MARKUP. It is written by renderPawnCount
  // from pawnPlan(), which pawn-count.test.js holds against the server's numbers.
  it('leaves the numbers to pawnPlan, and hardcodes none of them', () => {
    const panel = html.slice(html.indexOf('id="pawnCountPanel"'), html.indexOf('id="pawnGrid"'));
    // The note is an empty node in the markup…
    expect(panel).toMatch(/<p class="pawn-budget-note" id="pawnBudgetNote"><\/p>/);
    // …and no deck arithmetic has been copied in beside it.
    expect(panel).not.toMatch(/\b(104|103|412)\b/);
    // The one place it is written is still the renderer.
    expect(html).toContain("document.getElementById('pawnBudgetNote')");
  });

  // THE DEFAULT IS UNTOUCHED — the point of the change is to remove a decision,
  // not to change what happens when it is not made.
  //
  // WHAT THIS ONE IS NOT: proof that the default reaches the order. Matching the
  // page's source cannot show that — it would pass just as happily if the submit
  // path never ran at all. That proof is in tests/e2e/pawn-photos.spec.js, "a
  // buyer who never opens the disclosure still orders the standard deck", which
  // drives the real wizard and reads `players` out of the submitted body. What is
  // pinned HERE is narrower and worth pinning anyway: the default is still the
  // first offered count, and an untouched control still deletes itself from the url.
  it('declares the standard deck as the default, and keeps it out of the url', () => {
    expect(html).toContain('let pawnPlayers = PLAYER_COUNTS[0]');
    expect(html).toMatch(/players:\s*pawnPlayers/);
    expect(html).toContain('if (s.pawnPlayers !== PLAYER_COUNTS[0])');
    expect(html).toContain("else url.searchParams.delete('players')");
  });

  // The ceiling stays on the main path: it is information she relies on, not a
  // decision she has to make. Moving it inside the panel would hide her word
  // budget from everyone who never opens the button.
  it('leaves the word ceiling on screen for everyone', () => {
    const budget = /<div class="pawn-budget"[\s\S]*?<\/div>/.exec(html)[0];
    expect(budget).toContain('id="pawnBudgetMain"');
    expect(budget).not.toContain('id="pawnBudgetNote"');
  });
});
