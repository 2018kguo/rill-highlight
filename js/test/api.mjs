// API test: the highlighter behaves as Shiki 4.5.0's (on its JavaScript regex
// engine) beyond the corpus: loading order, errors, grammar states, custom
// themes, cross-language injections and embeds, the shorthands, and the options
// rill-highlight rejects.   node test/api.mjs
import assert from 'node:assert/strict';
import { createBundledHighlighter, createCssVariablesTheme, createSingletonShorthands, createJavaScriptRegexEngine, bundledLanguages, bundledThemes, guessEmbeddedLanguages as shikiGuess } from 'shiki';
import * as rill from '../src/index.js';

const engine = () => createJavaScriptRegexEngine({ forgiving: true });
const shikiCreate = createBundledHighlighter({ langs: bundledLanguages, themes: bundledThemes, engine });
const shikiShorthands = createSingletonShorthands(shikiCreate, { guessEmbeddedLanguages: shikiGuess });

const cases = [];
const test = (name, run) => cases.push({ name, run });

/** Runs `run(highlighter)` on both and compares what it returns (or throws). */
async function same(options, run) {
  const outcome = async (create) => {
    try {
      const highlighter = await create(options);
      return { value: await run(highlighter) };
    } catch (error) {
      return { error: error.message };
    }
  };
  const [want, got] = [await outcome((options) => shikiCreate({ ...options, warnings: false })), await outcome(rill.createHighlighter)];
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(want)));
  return got;
}

const ts = 'const a = css`color: red`;\nfunction f<T>(x: T) { return `${x}`; }\n';
const markdown = '# Title\n\n```python\ndef f(x):\n    return x  # c\n```\n\n```html\n<b>&amp;</b>\n```\n';

test('loaded languages and themes, in order', () =>
  same({ themes: ['github-dark', 'nord'], langs: ['html', 'markdown'] }, async (h) => {
    const first = [h.getLoadedLanguages(), h.getLoadedThemes()];
    await h.loadLanguage('vue', 'python');
    await h.loadTheme('monokai');
    return [first, h.getLoadedLanguages(), h.getLoadedThemes()];
  }));

test('langAlias', () =>
  same({ themes: ['nord'], langs: ['javascript'], langAlias: { mylang: 'javascript' } }, (h) => [h.getLoadedLanguages(), h.codeToHtml('let x', { lang: 'mylang', theme: 'nord' })]));

test('errors: not in the bundle, not loaded, empty themes, defaultColor', async () => {
  await same({ themes: ['nord'], langs: ['nope'] }, () => 1);
  await same({ themes: ['nope'], langs: [] }, () => 1);
  await same({ themes: ['nord'], langs: ['python'] }, (h) => h.codeToHtml('x', { lang: 'rust', theme: 'nord' }));
  await same({ themes: ['nord'], langs: ['python'] }, (h) => h.codeToHtml('x', { lang: 'python', theme: 'monokai' }));
  await same({ themes: ['nord'], langs: ['python'] }, (h) => h.codeToHtml('x', { lang: 'python', themes: {} }));
  await same({ themes: ['nord'], langs: ['python'] }, (h) => h.codeToHtml('x', { lang: 'python', themes: { dark: 'nord' } }));
  await same({ themes: ['nord'], langs: ['python'] }, (h) => h.codeToHtml('x', { lang: 'python' }));
  await same({ themes: ['nord'], langs: ['python'] }, (h) => {
    h.dispose();
    return h.codeToHtml('x', { lang: 'python', theme: 'nord' });
  });
});

test('plain text, "none" theme and empty code', () =>
  same({ themes: ['nord', 'github-light'], langs: ['python'] }, (h) => [
    h.codeToHtml('a <b> & c\r\nd', { lang: 'text', theme: 'nord' }),
    h.codeToHtml('a\nb', { lang: 'txt', themes: { light: 'github-light', dark: 'nord' } }),
    h.codeToTokens('a\nb', { lang: 'plaintext', themes: { light: 'github-light', dark: 'nord' } }),
    h.codeToHtml('x = 1', { lang: 'python', theme: 'none' }),
    h.codeToHtml('', { lang: 'python', theme: 'nord' }),
    h.codeToTokens('\n\n', { lang: 'python', theme: 'nord' }).tokens,
    h.codeToTokensBase('x = "y"', { lang: 'python' }),
    h.codeToTokensWithThemes('x = "y"', { lang: 'python', themes: { light: 'github-light', dark: 'nord' } }),
  ]));

test('grammar states continue the code and carry scopes', () =>
  same({ themes: ['github-light', 'github-dark'], langs: ['typescript'] }, (h) => {
    const themes = { light: 'github-light', dark: 'github-dark' };
    const first = h.codeToTokens('const s = `a\n', { lang: 'typescript', themes });
    const second = h.codeToTokens('b ${x}` + 1', { lang: 'typescript', themes, grammarState: first.grammarState });
    const state = h.getLastGrammarState('/* open', { lang: 'typescript', theme: 'github-dark' });
    return [first.grammarState.getScopes(), second.tokens, state.toJSON(), h.getLastGrammarState(first.tokens).toJSON()];
  }));

test('grammarContextCode', () =>
  same({ themes: ['github-dark'], langs: ['vue'] }, (h) => h.codeToHtml('const x = 1 < 2', { lang: 'vue', theme: 'github-dark', grammarContextCode: '<script setup lang="ts">\n' })));

test('grammar state checks', async () => {
  await same({ themes: ['nord'], langs: ['python', 'rust'] }, (h) => {
    const { grammarState } = h.codeToTokens('x', { lang: 'python', theme: 'nord' });
    return h.codeToTokens('x', { lang: 'rust', theme: 'nord', grammarState });
  });
});

test('custom themes: CSS variables, color replacements, theme objects', () =>
  same({ themes: [createCssVariablesTheme({ name: 'vars', variableDefaults: { 'token-keyword': '#f00' } }), 'github-dark'], langs: ['typescript'] }, (h) => [
    h.codeToHtml(ts, { lang: 'typescript', theme: 'vars' }),
    h.codeToHtml(ts, { lang: 'typescript', themes: { light: 'vars', dark: 'github-dark' } }),
    h.codeToHtml(ts, { lang: 'typescript', theme: 'github-dark', colorReplacements: { '#f97583': 'red', 'github-dark': { '#e1e4e8': 'var(--fg)' } } }),
    h.codeToHtml(ts, { lang: 'typescript', theme: { name: 'inline', type: 'light', fg: '#123456', bg: '#fedcba', settings: [{ scope: 'keyword', settings: { foreground: '#ff00ff', fontStyle: 'italic underline' } }] } }),
    h.getLoadedThemes(),
  ]));

test('injections and lazy embeds see every loaded language', async () => {
  const injected = await same({ themes: ['github-dark'], langs: ['typescript', 'ts-tags'] }, (h) => h.codeToHtml(ts, { lang: 'typescript', theme: 'github-dark' }));
  const plain = await same({ themes: ['github-dark'], langs: ['typescript'] }, (h) => h.codeToHtml(ts, { lang: 'typescript', theme: 'github-dark' }));
  assert.notEqual(injected.value, plain.value, 'ts-tags highlights the css`` template');
  const embedded = await same({ themes: ['github-dark'], langs: ['markdown'] }, async (h) => {
    const before = h.codeToHtml(markdown, { lang: 'markdown', theme: 'github-dark' });
    await h.loadLanguage('python');
    return [before, h.codeToHtml(markdown, { lang: 'markdown', theme: 'github-dark' })];
  });
  assert.notEqual(embedded.value[0], embedded.value[1], 'loading python highlights the fence');
});

test('shorthands load embedded languages', async () => {
  for (const options of [{ lang: 'markdown', theme: 'github-dark' }, { lang: 'md', themes: { light: 'github-light', dark: 'github-dark' } }]) {
    assert.equal(await rill.codeToHtml(markdown, options), await shikiShorthands.codeToHtml(markdown, options));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await rill.codeToTokens(ts, { lang: 'ts', theme: 'nord' }))), JSON.parse(JSON.stringify(await shikiShorthands.codeToTokens(ts, { lang: 'ts', theme: 'nord' }))));
});

test('unsupported options throw', async () => {
  const h = await rill.createHighlighter({ themes: ['nord'], langs: ['python'] });
  const options = { lang: 'python', theme: 'nord' };
  for (const extra of [{ transformers: [{}] }, { decorations: [{ start: 0, end: 1 }] }, { includeExplanation: true }, { tokenizeTimeLimit: 100 }, { meta: { title: 'x' } }]) {
    assert.throws(() => h.codeToHtml('x', { ...options, ...extra }), /is not supported/, JSON.stringify(extra));
  }
  assert.throws(() => h.codeToHtml('x', { ...options, lang: 'ansi' }), /is not supported/);
  await assert.rejects(rill.createHighlighter({ engine: {} }), /is not supported/);
  await assert.rejects(h.loadLanguage({ name: 'custom', scopeName: 'source.custom', patterns: [] }), /is not supported/);
  // Accepted because they change nothing: empty lists and `_` meta keys.
  assert.equal(h.codeToHtml('x', { ...options, transformers: [], decorations: [], meta: { _private: 1 } }), h.codeToHtml('x', options));
  const states = await rill.createHighlighter({ themes: ['nord', 'monokai'], langs: ['python'] });
  const { grammarState } = states.codeToTokens('x', { lang: 'python', themes: { a: 'nord', b: 'monokai' }, defaultColor: false });
  assert.throws(() => states.codeToTokens('y', { lang: 'python', theme: 'nord', grammarState }), /is not supported/);
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}
process.exit(failed ? 1 : 0);
