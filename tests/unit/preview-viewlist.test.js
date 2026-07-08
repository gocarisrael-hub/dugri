import { describe, it, expect } from 'vitest';
import { previewViewList } from '../../site/js/configurator.js';

// previewViewList backs BOTH the inline name-preview swipe carousel and the
// fullscreen zoom, so they must always walk the same card → back → board order
// and include only the views the server actually returned.
describe('previewViewList', () => {
  it('always includes the card, first', () => {
    expect(previewViewList()).toEqual(['card']);
    expect(previewViewList({})[0]).toBe('card');
  });

  it('adds back and board in order when present', () => {
    expect(previewViewList({ hasBack: true, hasBoard: true })).toEqual(['card', 'back', 'board']);
  });

  it('omits an absent back but keeps the board', () => {
    expect(previewViewList({ hasBack: false, hasBoard: true })).toEqual(['card', 'board']);
  });

  it('omits an absent board but keeps the back', () => {
    expect(previewViewList({ hasBack: true, hasBoard: false })).toEqual(['card', 'back']);
  });

  it('is card-only when neither back nor board rendered', () => {
    expect(previewViewList({ hasBack: false, hasBoard: false })).toEqual(['card']);
  });
});
