<h1 align="center">rill-highlight</h1>
<p align="center">Shiki-compatible syntax highlighting in Rust and WebAssembly.</p>
<p align="center">
  <a href="#install">Install</a> ·
  <a href="#use">API</a> ·
  <a href="#performance">Benchmarks</a> ·
  <a href="#limits">Limits</a>
</p>

Highlight growing code blocks without changing their appearance.
rill-highlight implements Shiki's TextMate tokenizer in Rust and exposes
familiar JavaScript APIs through WebAssembly. It also supplies a Streamdown
code plugin and the highlighter used by [rill](https://github.com/2018kguo/rill).

The comparison below uses Shiki's JavaScript regex engine. Its default
Oniguruma engine has some different results; see [limits](#limits) before
replacing it. Supported dependency pins are in [js/package.json](js/package.json).

```js
import { codeToHtml } from '@2018kguo/rill-highlight';

const html = await codeToHtml('const answer = 42', { lang: 'ts', theme: 'github-dark' });
```

## Why

- **Identical output.** On a corpus of 121 files in 31 languages (42,379
  lines of real code plus edge cases), every token, offset and style matches
  Shiki's, and all 746 `codeToHtml` calls are byte-identical: one theme and
  two themes on every file, and on files up to 400 lines also CSS variables
  only, three themes, `light-dark()`, the whitespace and merge options,
  `structure: 'inline'` and `tokenizeMaxLineLength`. Streaming the first 150
  lines of each file through the Streamdown plugin, 32,320 calls, matches
  `@streamdown/code`, and all 242 bundled languages match on a mixed
  sample. (The tests run Shiki without its per-line time limit, see
  [Limits](#limits).)
- **Faster.** In Node, 4.6x faster than Shiki at `codeToTokens`, 4.9x at
  `codeToHtml` and 5.5x to the first result, and in Chromium 5x to 6x on
  streamed and freshly loaded answers (numbers under
  [Performance](#performance)). Tokenizing two themes takes one pass, where
  Shiki tokenizes once per theme.
- **Small.** The wasm module is 335 KB (135 KB gzipped). Grammars and themes
  are separate modules loaded when a language or theme is first used, as
  Shiki loads its own.

The caveats: no transformers, decorations or explanations, no custom
grammars at runtime (grammars are precompiled by a build step), no `ansi`
language, and no 500 ms per-line time limit. Options it does not implement
throw instead of being ignored.

## Install

```sh
npm install @2018kguo/rill-highlight
```

It has no dependencies. Node 20 or later, or any browser with WebAssembly.
The package is 2.7 MB (19.8 MB unpacked, nearly all of it grammars); a page
fetches only the wasm module and the grammars and themes it uses.

## Use

The API is Shiki's. Load themes and languages once, then highlight
synchronously:

```js
import { createHighlighter } from '@2018kguo/rill-highlight';

const highlighter = await createHighlighter({
  themes: ['github-light', 'github-dark'],
  langs: ['typescript', 'python'],
});

highlighter.codeToHtml(code, { lang: 'ts', theme: 'github-dark' });
highlighter.codeToHtml(code, {
  lang: 'python',
  themes: { light: 'github-light', dark: 'github-dark' },
  defaultColor: false,          // CSS variables only
  cssVariablePrefix: '--code-',
});
const { tokens, fg, bg, grammarState } = highlighter.codeToTokens(code, { lang: 'ts', theme: 'github-dark' });
await highlighter.loadLanguage('rust');
highlighter.dispose();
```

The shorthands `codeToHtml`, `codeToTokens`, `codeToTokensBase`,
`codeToTokensWithThemes` and `getSingletonHighlighter` share one highlighter
and load what each call needs, including the languages embedded in the code
(fenced blocks in Markdown, `<script lang>`), as Shiki's do.

All 242 of Shiki's bundled languages (346 ids with aliases) and 65 themes
are included. Themes can also be objects, as in Shiki.

### Node

Nothing to configure: the wasm module and data files are read from the
package directory.

### Browsers

With a bundler, the default import works as it is. Each grammar and theme is
a JavaScript module the package imports with a dynamic `import()` when it is
first used, so every bundler puts it in a chunk of its own; the wasm module is
fetched from `new URL('../dist/rill_highlight.wasm', import.meta.url)`, which
Vite, webpack and Rollup with an asset plugin turn into an asset. Bundlers
that leave such URLs alone (bun) need the wasm module served and passed in,
with the package's data:

```js
import { createHighlightCore } from '@2018kguo/rill-highlight/core';
import { data } from '@2018kguo/rill-highlight/data';
import { createCodePlugin } from '@2018kguo/rill-highlight/streamdown';

// rill_highlight.wasm copied from node_modules/@2018kguo/rill-highlight/dist/
const core = createHighlightCore({ wasm: new URL('./rill_highlight.wasm', import.meta.url), data });
const highlighter = await (await core).createHighlighter({ themes: ['github-dark'], langs: ['ts'] });
const code = createCodePlugin({ core });
```

`test/bundle.mjs` builds a page that highlights on the main thread and in a
Web Worker with Vite and with bun, from the packed tarball, and checks it in
Chromium. Without a bundler, serve the package's `dist/` directory (or use a
CDN copy) and point a core at it; `/core` has no bare imports, so it also loads
straight from a CDN. For a local copy, serve `dist/` at `/vendor/rill-highlight/`:

```js
import { createHighlightCore } from '@2018kguo/rill-highlight/core';

const core = await createHighlightCore({
  baseUrl: new URL('/vendor/rill-highlight/', location.href).href,
});
const highlighter = await core.createHighlighter({ themes: ['github-dark'], langs: ['ts'] });
```

`createHighlightCore({ wasm, data })` takes the wasm module (bytes, a
`Response`, a `WebAssembly.Module` or a URL) and a `data` object with
`grammar(name)` and `theme(name)` functions returning JSON text, for any
other way of loading them; `@2018kguo/rill-highlight/data` exports the
package's own.

### Streamdown

`@2018kguo/rill-highlight/streamdown` exports `code` and `createCodePlugin`,
the same as `@streamdown/code`:

```jsx
import { Streamdown } from 'streamdown';
import { code } from '@2018kguo/rill-highlight/streamdown';

<Streamdown plugins={{ code }}>{markdown}</Streamdown>;
```

`createCodePlugin({ themes, core })` takes the same `themes` as
`@streamdown/code`, and a core from `createHighlightCore` to load the files
from elsewhere. The plugin also has `highlightSync(options)`, which returns
the result right away when the language is loaded (null otherwise), without
the callback round trip, and `load({ language, themes })`, which loads it and
rejects when it cannot (a theme that is not bundled, a grammar that does not
compile) where `highlight` only logs the error.

### Rust

The crate is the tokenizer without the JavaScript layer. It reads the grammar
files the data build writes (`js/dist/grammars/*.json`, built by
`js/scripts/build-grammars.mjs`) and returns tokens with style ids:

```rust
let grammar = std::fs::read_to_string("dist/grammars/rust.json")?;
let theme = std::fs::read_to_string("dist/themes/github-dark.json")?;
let mut highlighter = rill_highlight::Highlighter::from_json(&[&grammar], "rust", &[&theme])?;
let code: Vec<u16> = "fn main() {}".encode_utf16().collect();
let tokenized = highlighter.tokenize(&code, None, 0)?;
for token in &tokenized.lines[0] {
    let style = &highlighter.styles()[token.style as usize][0];
    println!("{}..{} {:?} {}", token.offset, token.offset + token.length, style.color, style.font_style);
}
```

Offsets are in UTF-16 code units, as in JavaScript. `Registry` holds the
grammars of several languages for injections and embedded languages, and
`regex::JsRegExp` is the ECMAScript regex engine on its own.

## What is supported

| Option | Status |
| --- | --- |
| `lang`, `theme`, `themes` (one to four), `defaultColor` (including `false` and `'light-dark()'`), `cssVariablePrefix`, `colorsRendering`, `colorReplacements` | Supported |
| `grammarState`, `grammarContextCode`, `getLastGrammarState` | Supported; a grammar state works with calls using the same themes |
| `tokenizeMaxLineLength`, `mergeWhitespaces`, `mergeSameStyleTokens`, `structure`, `tabindex`, `rootStyle` | Supported |
| `createHighlighter({ themes, langs, langAlias })`, `loadLanguage`, `loadTheme`, `getLoadedLanguages`, `getLoadedThemes`, `getTheme`, `dispose` | Supported, including load order, injections (`ts-tags`, `vue`) and lazily embedded languages |
| Theme objects, `'none'` theme, plain-text languages | Supported |
| `transformers`, `decorations`, `meta`, `includeExplanation`, `tokenizeTimeLimit`, `engine` | Throws |
| Language objects (custom grammars), `lang: 'ansi'`, the `'none'` theme next to other themes | Throws |
| `codeToHast`, `loadLanguageSync`, `setTheme`, `getLanguage` | Not provided |

## Limits

- **Regex translation.** Shiki's JavaScript engine translates each Oniguruma
  pattern with oniguruma-to-es and runs it with the host's `RegExp`.
  rill-highlight translates every pattern ahead of time for the ES2025 target,
  which Shiki picks where the runtime supports regex modifiers (Node 23 and
  Chrome 125 onward), and runs it on its own engine. On older runtimes
  Shiki uses a different target and its output can differ from rill's. The
  comparisons here are against Shiki on its JavaScript engine with
  `forgiving: true`, as `@streamdown/code` configures it. Shiki's default
  engine is Oniguruma (wasm): against it, 737 of the 746 `codeToHtml` calls
  are identical, and the rest (Python files with non-ASCII identifiers, one
  shell script) differ where Oniguruma and JavaScript regexes do
  (`ENGINE=oniguruma node test/html.mjs`).
- **Patterns that do not compile.** Every one of the 24,300 bundled patterns
  compiles (a test checks), but if a pattern failed to compile, tokenizing
  code that reaches it would throw rather than skip it. For such a language,
  use Shiki. One `ahk2` pattern is skipped, as Shiki's forgiving engine skips
  it.
- **No time limit.** Shiki stops tokenizing a line after 500 ms by default
  (`tokenizeTimeLimit`) and leaves the rest unstyled; rill-highlight always
  tokenizes the whole line, so a pathological line can take long where Shiki
  would give up. `tokenizeMaxLineLength` bounds that. A cold grammar's first
  lines can pass the limit in Shiki on a slow or busy machine, so Shiki's
  tokens there vary by machine; the tests run Shiki without the limit. Some grammars' patterns
  backtrack quadratically on adversarial lines (a 4,000-character run of
  spaces in TypeScript, of `(` in fish) in V8 and here alike; rill-highlight is
  several times faster on them, but they grow the same way (tests/doubling.rs
  lists them, and checks everything else grows linearly).
- **Grammar states** come from the highlighter and the themes that produced
  them; passing one to a call with other themes throws.
- **Loading after use.** Like Shiki, loading a language reloads the
  languages that embed it lazily (Markdown's fenced blocks). A grammar that
  includes a language without declaring it, loaded after the first
  highlight, may see that language later than Shiki would.

## Performance

Measured with `npm run bench` in `js/` on an Apple M5 Pro (18 cores, macOS)
with Node, on the corpus (the files of each of the 31 languages
concatenated, 1.4 MB in all), Shiki on its JavaScript regex engine, both with
two themes (github-light and github-dark) as Streamdown uses them. Warm is
the fastest of nine runs on a loaded highlighter, summed over the languages;
first result is a fresh process creating the highlighter for one language and
highlighting once, summed. The machine was shared with other work, so single
languages vary by up to about 20% between runs.

| | Shiki | rill-highlight (wasm) | |
| --- | --- | --- | --- |
| `codeToTokens`, warm | 1,730 ms | 378 ms | 4.6x |
| `codeToHtml`, warm | 1,878 ms | 386 ms | 4.9x |
| First result | 5,810 ms | 1,057 ms | 5.5x |

rill-highlight also spends about 20 ms once per process instantiating the
wasm module, not counted above. Per language, the warm `codeToTokens`
speedup runs from 0.8x (diff, 0.2 ms either way) and 1.3x (YAML) to 12.8x
(TypeScript). Natively, without wasm, the tokenizer is 6.8x faster than
Shiki warm (1,703 ms against 252 ms) and 13.3x to the first result.

A single 18,000-character line of TypeScript takes Shiki 15 ms and
rill-highlight 7 ms (wasm) or 4.7 ms (native).

In Chromium, `npm run bench:browser` (it needs bun and Playwright's
Chromium) highlights 16 AI-answer-sized code
blocks (60 lines each, 16 languages) through both Streamdown plugins with 4x
CPU throttling: from a cold page 3,058 ms against 484 ms (6.3x), streaming
each block in 12-character chunks 3,434 ms against 671 ms (5.1x), and the
same blocks again once loaded 122 ms against 43 ms (2.8x).

## How it works

- `js/scripts/build-grammars.mjs` takes Shiki's bundled grammars and
  translates every pattern they contain (and the anchor and back-reference
  variants the tokenizer can produce) with oniguruma-to-es, as Shiki's engine
  would at runtime, into `dist/grammars/<name>.json` (for the Rust crate)
  and the same text as modules in `dist/data/` (what the package ships).
- `src/regex/` is an ECMAScript regex engine (`u` and `v` modes, lookbehind,
  modifiers, Unicode properties from V8's tables) with oniguruma-to-es's
  `EmulatedRegExp` extensions. It reproduces V8's results, including a V8
  quirk with case-insensitive modifier groups.
- `src/textmate/` ports `@shikijs/vscode-textmate`: rules, the scanner with
  Shiki's search cache, injections, theme matching. It styles every theme in
  one pass, because the matched rules do not depend on the theme.
- `js/src/` is Shiki's `codeToTokens` / `codeToHtml` logic around the wasm
  module, written to produce the same objects and markup.

## Testing

In `js/`, after `npm install`, `npm run corpus` (fetches the corpus at pinned
commits) and `npm run build`:

```sh
npm test                    # API, tokens, HTML and streaming vs Shiki
npm run test:all-languages  # every bundled language on a mixed sample
npm run test:pack           # pack, install the tarball, highlight from it
npm run test:bundle         # the tarball bundled by Vite and bun, in Chromium
cargo test --release --features op-counts --test doubling  # linear work
cargo test                  # in the repository root: regex semantics, units, every pattern compiles
```

CI runs the Rust tests and clippy, and the JavaScript tests on the checked-in
edge-case corpus (`npm run test:ci`).

## License

MIT. The bundled grammars and themes keep their own licenses (MIT, Apache-2.0,
BSD, ISC, MPL-2.0 and GPL-3.0 among them), listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with the licenses of Shiki,
vscode-textmate, oniguruma-to-es and `@streamdown/code`, whose code is ported
here.
