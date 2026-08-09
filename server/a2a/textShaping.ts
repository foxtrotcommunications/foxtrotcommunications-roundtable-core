// server/a2a/textShaping.ts — pure text-shaping helpers for A2A responses.
// Kept dependency-free so tests can import them without bootstrapping the
// server graph (config, tracing, aiProvider).

/** Remove earlier EXACT duplicates of metadata comment blocks, keeping the
 *  last occurrence. Directive comments (confirm_action, follow_ups) describe
 *  the composition they follow; fullText accumulates across model rounds, so
 *  a short first-round answer that already carried its directive blocks can
 *  be concatenated with a fuller recomposition ending in the same blocks —
 *  observed 2026-08-09 (published in the Pendragon head-to-head study, Q7):
 *  both blocks appeared twice in one response artifact. Only EXACT duplicates
 *  are touched — distinct blocks of the same kind pass through. */
function dedupeMetadataComments(text: string): string {
  const COMMENT_RE = /<!--\s*(?:confirm_action|follow_ups):[\s\S]*?-->/g;
  const all = [...text.matchAll(COMMENT_RE)];
  const lastIndexByBlock = new Map<string, number>();
  for (const m of all) lastIndexByBlock.set(m[0], m.index!);
  let out = '';
  let cursor = 0;
  for (const m of all) {
    if (m.index! !== lastIndexByBlock.get(m[0])) {
      out += text.slice(cursor, m.index!);
      cursor = m.index! + m[0].length;
      // A duplicate often sits flush against the next sentence ("-->No chart
      // …"); leave surrounding text untouched beyond removing the block.
    }
  }
  out += text.slice(cursor);
  return out;
}

module.exports = { dedupeMetadataComments };
