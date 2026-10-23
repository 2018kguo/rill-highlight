// Doubling test for streaming: while a code block streams line by line through the
// Streamdown plugin, the code tokenized per update must not grow with the block
// (finished lines continue from the grammar state). Counts the UTF-16 units handed
// to the wasm tokenizer and the rows the plugin appends, not time.
//   node test/doubling.mjs
import assert from 'node:assert/strict';
import { getDefaultCore } from '#default-core';
import { createCodePlugin } from '../src/streamdown.js';

const core = await getDefaultCore();
let units = 0;
const tokenize = core.binding.tokenize;
core.binding.tokenize = (highlighter, string, ...rest) => {
  units += string.length;
  return tokenize(highlighter, string, ...rest);
};
const plugin = createCodePlugin({ core });
const themes = ['github-light', 'github-dark'];
const LINE = '  const value = compute(items[i], { key: "a", n: 0x1F }); // note';
const TIMED = 50;

/** Units tokenized by the last `TIMED` updates of a block streamed to `lines` lines. */
async function lastUpdates(lines, language) {
  const options = { language, themes, isIncomplete: true };
  await new Promise((resolve) => plugin.highlight({ ...options, code: 'x' }, resolve) ?? null);
  let code = '';
  let counted = 0;
  for (let line = 0; line < lines; line++) {
    // Each update ends mid-line, as a streamed block does.
    for (const end of [LINE.length >> 1, LINE.length]) {
      const before = units;
      const result = plugin.highlightSync({ ...options, code: code + LINE.slice(0, end) + `${line}` });
      assert.ok(result, 'loaded');
      if (line >= lines - TIMED) counted += units - before;
    }
    code += `${LINE}${line}\n`;
  }
  return counted;
}

for (const language of ['typescript', 'python', 'markdown']) {
  const sizes = [250, 500, 1000, 2000];
  const counts = [];
  for (const size of sizes) counts.push(await lastUpdates(size, language));
  const report = sizes.map((size, index) => `${size}: ${counts[index]}`).join(', ');
  for (let index = 1; index < sizes.length; index++) {
    assert.ok(counts[index] <= 1.2 * counts[index - 1], `${language}: per-update tokenizing grows with the block (${report})`);
  }
  console.log(`ok  ${language}: units tokenized by the last ${TIMED} updates: ${report}`);
}
