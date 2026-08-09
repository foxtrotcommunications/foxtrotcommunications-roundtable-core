// tests/a2a/dedupeMetadataComments.test.ts — round-accumulated duplicate
// directive blocks.
//
// fullText accumulates across model rounds, so a short first-round answer
// carrying confirm_action/follow_ups blocks can be concatenated with a fuller
// recomposition ending in the same blocks. Observed 2026-08-09 and published
// in the Pendragon head-to-head study (Q7): both blocks appeared twice in one
// response artifact. The dedupe keeps the LAST occurrence of an exact
// duplicate and touches nothing else.

const { dedupeMetadataComments } = require('../../server/a2a/textShaping');

const CONFIRM = '<!-- confirm_action: {"label":"Watch my paychecks","reply":"Yes — create a missed-paycheck watch with a 3-day grace period."} -->';
const FOLLOW_A = '<!-- follow_ups: ["Which paychecks will you monitor?", "When would you alert me?"] -->';
const FOLLOW_B = '<!-- follow_ups: ["Which paychecks will you monitor?", "Can I change the grace period?"] -->';

describe('dedupeMetadataComments', () => {
  it('keeps only the last occurrence of an exact duplicate block (the Q7 shape)', () => {
    const text =
      `Short first-round answer.\n\n${CONFIRM}\n${FOLLOW_A}No chart is needed here.\n\n` +
      `Fuller recomposition of the answer.\n\n${CONFIRM}\n${FOLLOW_A}`;
    const out = dedupeMetadataComments(text);
    expect(out.match(/confirm_action/g)).toHaveLength(1);
    expect((out.match(/follow_ups/g) || [])).toHaveLength(1);
    // The survivors are the final ones — after the recomposition.
    expect(out.indexOf(CONFIRM)).toBeGreaterThan(out.indexOf('Fuller recomposition'));
    // Prose on both sides survives, including the stray sentence that was
    // glued to the duplicate block.
    expect(out).toContain('Short first-round answer.');
    expect(out).toContain('No chart is needed here.');
    expect(out).toContain('Fuller recomposition of the answer.');
  });

  it('leaves distinct blocks of the same kind alone', () => {
    const text = `Answer.\n${FOLLOW_A}\nMore.\n${FOLLOW_B}`;
    expect(dedupeMetadataComments(text)).toBe(text);
  });

  it('is a no-op without duplicates', () => {
    const text = `Answer.\n\n${CONFIRM}\n${FOLLOW_B}`;
    expect(dedupeMetadataComments(text)).toBe(text);
  });

  it('never touches non-directive comments', () => {
    const text = '<!-- note --> a <!-- note --> b';
    expect(dedupeMetadataComments(text)).toBe(text);
  });
});
