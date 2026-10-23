// Builds the grammar and theme data rill-highlight loads, from Shiki's bundle:
//
//   dist/manifest.js           languages, grammar metadata and theme names (below)
//   dist/languages.json        language ids, aliases, and the grammars each one loads
//   dist/grammars/<name>.json  { grammar, regexes } per grammar
//   dist/themes/<name>.json    each bundled theme as Shiki ships it
//   dist/data/                 the same grammars and themes as JavaScript modules
//                              (`export default "<json>"`) and index.js, a table
//                              that imports each on demand: what the package
//                              ships, so any bundler splits them into chunks
//
// A grammar keeps only the keys the tokenizer reads (vscode-textmate's rule
// fields), so comments and editor metadata are left out.
// `regexes` maps every Oniguruma source the tokenizer can hand to the regex engine
// (after vscode-textmate's `\z` rewrite and `\A`/`\G` anchor variants) to its
// oniguruma-to-es translation `[pattern, flags, options]`, or to null when the
// JavaScript engine skips it (`forgiving`). The common translations are written
// short: the pattern alone when the flags are `dgv` and there are no options, and
// `0` when that pattern is the source itself. End/while sources with back-references
// are stored as templates: each `\N` becomes the placeholder U+E000+N, which the
// Rust engine replaces with the captured text.
import { mkdirSync, writeFileSync } from 'node:fs';
import { bundledLanguages, bundledLanguagesInfo, bundledThemes } from 'shiki';
import { toRegExpDetails } from 'oniguruma-to-es';
import { createRequire } from 'node:module';

const shikiVersion = createRequire(import.meta.url)('shiki/package.json').version;

const out = new URL('../dist/', import.meta.url).pathname;
for (const directory of ['grammars', 'themes', 'data/grammars', 'data/themes']) mkdirSync(out + directory, { recursive: true });

// Shiki's defaultJavaScriptRegexConstructor options, with the target that
// `target: 'auto'` picks in engines with ES2025 flag groups.
const translateOptions = {
  global: true,
  hasIndices: true,
  lazyCompileLength: 3000,
  target: 'ES2025',
  rules: { allowOrphanBackrefs: true, asciiWordBoundaries: true, captureGroup: true, recursionLimit: 5, singleline: true },
};

// vscode-textmate RegExpSource constructor: rewrites `\z` and detects anchors.
function regExpSource(source) {
  let hasAnchor = false;
  let output = '';
  let last = 0;
  for (let pos = 0; pos < source.length; pos++) {
    if (source[pos] === '\\' && pos + 1 < source.length) {
      const next = source[pos + 1];
      if (next === 'z') {
        output += source.substring(last, pos) + '$(?!\\n)(?<!\\n)';
        last = pos + 2;
      } else if (next === 'A' || next === 'G') {
        hasAnchor = true;
      }
      pos++;
    }
  }
  return { source: last === 0 ? source : output + source.substring(last), hasAnchor };
}

// vscode-textmate RegExpSource._buildAnchorCache.
function anchorVariants(source) {
  const variants = [[], [], [], []]; // A0_G0, A0_G1, A1_G0, A1_G1
  for (let pos = 0; pos < source.length; pos++) {
    const ch = source[pos];
    for (const v of variants) v.push(ch);
    if (ch === '\\' && pos + 1 < source.length) {
      const next = source[pos + 1];
      const pick = next === 'A' ? ['￿', '￿', 'A', 'A'] : next === 'G' ? ['￿', 'G', '￿', 'G'] : [next, next, next, next];
      variants.forEach((v, i) => v.push(pick[i]));
      pos++;
    }
  }
  return variants.map((v) => v.join(''));
}

const PLACEHOLDER = 0xe000;
const backReferenceTemplate = (source) => source.replace(/\\(\d+)/g, (_, n) => String.fromCharCode(PLACEHOLDER + Math.min(+n, 0x8ff)));

// Lone surrogates do not survive JSON for Rust; escape them in JS patterns.
const escapeLoneSurrogates = (pattern) => pattern.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
const hasLoneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

function translate(source) {
  try {
    const details = toRegExpDetails(source, translateOptions);
    new RegExp(details.pattern, details.flags); // the engine skips what V8 rejects
    return [escapeLoneSurrogates(details.pattern), details.flags, details.options ?? null];
  } catch {
    return null;
  }
}

function collectRegexes(grammar) {
  const regexes = {};
  const add = (source) => {
    if (!(source in regexes)) regexes[source] = translate(source);
  };
  const addWithAnchors = (source, hasAnchor) => {
    if (hasAnchor) anchorVariants(source).forEach(add);
    else add(source);
  };
  add('￿');
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const key of ['match', 'begin', 'end', 'while']) {
      const raw = node[key];
      if (typeof raw !== 'string' || raw === '') continue;
      const { source, hasAnchor } = regExpSource(raw);
      addWithAnchors(source, hasAnchor);
      if ((key === 'end' || key === 'while') && /\\(\d+)/.test(source)) {
        addWithAnchors(backReferenceTemplate(source), hasAnchor);
      }
    }
    for (const value of Object.values(node)) if (typeof value === 'object') visit(value);
  };
  visit(grammar);
  add('');
  return regexes;
}

const grammars = new Map();
const languages = {};
// Per grammar, what Shiki's registry reads from the language registration.
const grammarInfo = {};
for (const id of Object.keys(bundledLanguages)) {
  const loaded = [...new Set((await bundledLanguages[id]()).default)];
  for (const grammar of loaded) {
    if (grammar.balancedBracketSelectors || grammar.unbalancedBracketSelectors) {
      throw new Error(`${grammar.name}: bracket selectors are not supported`);
    }
    if (!grammars.has(grammar.name)) {
      grammars.set(grammar.name, grammar);
      const info = {};
      for (const key of ['aliases', 'embeddedLangs', 'embeddedLangsLazy']) if (grammar[key]?.length) info[key] = grammar[key];
      grammarInfo[grammar.name] = info;
    }
    else if (grammars.get(grammar.name) !== grammar) throw new Error(`two grammars named ${grammar.name}`);
  }
  const info = bundledLanguagesInfo.find((i) => i.id === id);
  languages[id] = { name: loaded.at(-1).name, aliases: info?.aliases ?? [], grammars: loaded.map((g) => g.name) };
}

// The keys vscode-textmate reads: of a grammar, of a rule, and the rule maps.
const GRAMMAR_KEYS = new Set(['name', 'scopeName', 'injectionSelector', 'injectTo', 'injections']);
const RULE_KEYS = new Set(['name', 'contentName', 'match', 'begin', 'end', 'while', 'include', 'applyEndPatternLast', 'patterns']);
const RULE_MAPS = new Set(['repository', 'captures', 'beginCaptures', 'endCaptures', 'whileCaptures']);
const ruleOf = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rule = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === 'patterns') rule.patterns = Array.isArray(field) ? field.map(ruleOf) : field;
    else if (RULE_MAPS.has(key)) rule[key] = mapOf(field);
    else if (RULE_KEYS.has(key)) rule[key] = field;
  }
  return rule;
};
const mapOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, rule]) => [key, ruleOf(rule)])) : value);
const grammarOf = (grammar) => {
  const out = ruleOf(grammar);
  for (const key of GRAMMAR_KEYS) if (key in grammar) out[key] = key === 'injections' ? mapOf(grammar[key]) : grammar[key];
  return out;
};
const compact = (source, translation) =>
  translation && translation[1] === 'dgv' && translation[2] === null ? (translation[0] === source ? 0 : translation[0]) : translation;
const writeModule = (path, text) => writeFileSync(path, `export default ${JSON.stringify(text)};\n`);

let regexCount = 0, skipped = 0, bytes = 0;
for (const [name, raw] of grammars) {
  const grammar = grammarOf(raw);
  const json = JSON.stringify(grammar);
  if (hasLoneSurrogate(json) || /[\ue000-\ue8ff]/.test(json)) throw new Error(`${name}: unsupported characters in grammar`);
  const regexes = collectRegexes(grammar);
  regexCount += Object.keys(regexes).length;
  skipped += Object.values(regexes).filter((r) => r === null).length;
  for (const source of Object.keys(regexes)) regexes[source] = compact(source, regexes[source]);
  const text = JSON.stringify({ grammar, regexes });
  bytes += text.length;
  writeFileSync(`${out}grammars/${name}.json`, text);
  writeModule(`${out}data/grammars/${name}.js`, text);
}
writeFileSync(out + 'languages.json', JSON.stringify(languages));
for (const name of Object.keys(bundledThemes)) {
  const text = JSON.stringify((await bundledThemes[name]()).default);
  writeFileSync(`${out}themes/${name}.json`, text);
  writeModule(`${out}data/themes/${name}.js`, text);
}
const table = (directory, names) => `{\n${names.map((name) => `  ${JSON.stringify(name)}: () => import(${JSON.stringify(`./${directory}/${name}.js`)}),`).join('\n')}\n}`;
writeFileSync(
  out + 'data/index.js',
  `// Generated by scripts/build-grammars.mjs from shiki ${shikiVersion}.
// Each bundled grammar and theme as a module of its own, imported on demand: a
// bundler makes each a chunk that loads when a highlighter first needs it.
const grammars = ${table('grammars', [...grammars.keys()])};
const themes = ${table('themes', Object.keys(bundledThemes))};
const text = (table, name) => (Object.hasOwn(table, name) ? table[name]().then((module) => module.default) : Promise.reject(new Error(\`[rill-highlight] no bundled data for \${name}\`)));

/** createHighlightCore's \`data\`: the JSON text of each bundled grammar and theme. */
export const data = { grammar: (name) => text(grammars, name), theme: (name) => text(themes, name) };
`,
);
const manifest = { languages, grammars: grammarInfo, themes: Object.keys(bundledThemes) };
writeFileSync(out + 'manifest.js', `// Generated by scripts/build-grammars.mjs from shiki ${shikiVersion}.\nexport default ${JSON.stringify(manifest)};\n`);
console.log(`${grammars.size} grammars, ${Object.keys(languages).length} language ids, ${regexCount} regex sources (${skipped} skipped), ${(bytes / 1e6).toFixed(1)} MB`);
