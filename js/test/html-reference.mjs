// Reference HTML: Shiki 4.5.0's codeToHtml on its JavaScript regex engine
// (forgiving, as @streamdown/code configures it), or with ENGINE=oniguruma on
// Shiki's default Oniguruma engine. Prints a JSON array, one HTML string (or
// { error }) per mode of test/html-modes.mjs.
//   node test/html-reference.mjs LANG FILE
import { readFileSync } from 'node:fs';
import { createHighlighter, createJavaScriptRegexEngine } from 'shiki';
import { EXTRA_MAX_LINES, modes, themesOf } from './html-modes.mjs';

const [lang, file] = process.argv.slice(2);
const code = readFileSync(file, 'utf8');
const list = modes(lang).slice(0, code.split('\n').length <= EXTRA_MAX_LINES ? undefined : 2);
const engine = process.env.ENGINE === 'oniguruma' ? undefined : createJavaScriptRegexEngine({ forgiving: true });
const highlighter = await createHighlighter({ themes: themesOf(list), langs: [lang], ...(engine && { engine }) });
console.log(JSON.stringify(list.map((options) => {
  try {
    return highlighter.codeToHtml(code, options);
  } catch (error) {
    return { error: String(error) };
  }
})));
