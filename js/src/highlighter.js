// Shiki 4.5.0's highlighter API (`createHighlighter` from 'shiki') on the
// rill-highlight core. Code paths and error messages follow @shikijs/core and
// @shikijs/primitive; the tokenizing runs in wasm, once for all themes.
import { tokensToHtml } from './html.js';

export class ShikiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShikiError';
  }
}

/** An option Shiki has that rill-highlight does not implement. */
function unsupported(option, detail) {
  return new ShikiError(`[rill-highlight] \`${option}\` is not supported${detail ? `: ${detail}` : ''}. Use Shiki for this call.`);
}

const isPlainLang = (lang) => !lang || ['plaintext', 'txt', 'text', 'plain'].includes(lang);
const isSpecialLang = (lang) => lang === 'ansi' || isPlainLang(lang);
const isNoneTheme = (theme) => theme === 'none';
const NONE_THEME = Object.freeze({ name: 'none', type: 'dark', fg: '', bg: '', colorReplacements: {} });

// Token object shapes buildTokens makes.
const SHAPE_THEMES = 0; // codeToTokens with `themes`: htmlStyle
const SHAPE_THEME = 1; // codeToTokens with `theme`: color, fontStyle
const SHAPE_HTML = 2; // codeToHtml: the stringified style (and fontStyle)
const SHAPE_VARIANTS = 3; // codeToTokensWithThemes: variants

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;
const FONT_STRIKETHROUGH = 8;

/** Shiki `splitLines`: [line, offset] pairs split at `\r?\n`. */
export function splitLines(code, preserveEnding = false) {
  if (code.length === 0) return [['', 0]];
  const parts = code.split(/(\r?\n)/g);
  let index = 0;
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = preserveEnding ? parts[i] + (parts[i + 1] || '') : parts[i];
    lines.push([line, index]);
    index += parts[i].length;
    index += parts[i + 1]?.length || 0;
  }
  return lines;
}

function resolveColorReplacements(theme, options) {
  const replacements = typeof theme === 'string' ? {} : { ...theme.colorReplacements };
  const themeName = typeof theme === 'string' ? theme : theme.name;
  for (const [key, value] of Object.entries(options?.colorReplacements || {})) {
    if (typeof value === 'string') replacements[key] = value;
    else if (key === themeName) Object.assign(replacements, value);
  }
  return replacements;
}

function applyColorReplacements(color, replacements) {
  if (!color) return color;
  return replacements?.[color?.toLowerCase()] || color;
}

export function getTokenStyleObject(token) {
  const styles = {};
  if (token.color) styles.color = token.color;
  if (token.bgColor) styles['background-color'] = token.bgColor;
  if (token.fontStyle) {
    if (token.fontStyle & FONT_ITALIC) styles['font-style'] = 'italic';
    if (token.fontStyle & FONT_BOLD) styles['font-weight'] = 'bold';
    const decorations = [];
    if (token.fontStyle & FONT_UNDERLINE) decorations.push('underline');
    if (token.fontStyle & FONT_STRIKETHROUGH) decorations.push('line-through');
    if (decorations.length) styles['text-decoration'] = decorations.join(' ');
  }
  return styles;
}

export function stringifyTokenStyle(token) {
  if (typeof token === 'string') return token;
  return Object.entries(token)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

const COLOR_KEYS = ['color', 'background-color'];

/** Shiki `flatTokenVariants`, returning the `htmlStyle` of variant styles. */
function flatVariantsStyle(variants, variantsOrder, cssVariablePrefix, defaultColor, colorsRendering) {
  const styles = variantsOrder.map((name) => getTokenStyleObject(variants[name]));
  const styleKeys = new Set(styles.flatMap((style) => Object.keys(style)));
  const merged = {};
  const variableKey = (index, key) => {
    const keyName = key === 'color' ? '' : key === 'background-color' ? '-bg' : `-${key}`;
    return cssVariablePrefix + variantsOrder[index] + (key === 'color' ? '' : keyName);
  };
  styles.forEach((current, index) => {
    for (const key of styleKeys) {
      const value = current[key] || 'inherit';
      if (index === 0 && defaultColor && COLOR_KEYS.includes(key)) {
        if (defaultColor === 'light-dark()' && styles.length > 1) {
          const lightIndex = variantsOrder.findIndex((name) => name === 'light');
          const darkIndex = variantsOrder.findIndex((name) => name === 'dark');
          if (lightIndex === -1 || darkIndex === -1) throw new ShikiError('When using `defaultColor: "light-dark()"`, you must provide both `light` and `dark` themes');
          merged[key] = `light-dark(${styles[lightIndex][key] || 'inherit'}, ${styles[darkIndex][key] || 'inherit'})`;
          if (colorsRendering === 'css-vars') merged[variableKey(index, key)] = value;
        } else merged[key] = value;
      } else if (colorsRendering === 'css-vars') merged[variableKey(index, key)] = value;
    }
  });
  return merged;
}

/** Shiki `mapThemeColors` (the fg/bg of a multi-theme result). */
function mapThemeColors(themes, themeRegs, themeColorReplacements, cssVariablePrefix, defaultColor, property, colorsRendering) {
  return themes
    .map((t, index) => {
      const value = applyColorReplacements(themeRegs[index][property], themeColorReplacements[index]) || 'inherit';
      const cssVariable = `${cssVariablePrefix + t.color}${property === 'bg' ? '-bg' : ''}:${value}`;
      if (index === 0 && defaultColor) {
        if (defaultColor === 'light-dark()' && themes.length > 1) {
          const lightIndex = themes.findIndex((theme) => theme.color === 'light');
          const darkIndex = themes.findIndex((theme) => theme.color === 'dark');
          if (lightIndex === -1 || darkIndex === -1) throw new ShikiError('When using `defaultColor: "light-dark()"`, you must provide both `light` and `dark` themes');
          const light = applyColorReplacements(themeRegs[lightIndex][property], themeColorReplacements[lightIndex]) || 'inherit';
          const dark = applyColorReplacements(themeRegs[darkIndex][property], themeColorReplacements[darkIndex]) || 'inherit';
          return `light-dark(${light}, ${dark});${cssVariable}`;
        }
        return value;
      }
      if (colorsRendering === 'css-vars') return cssVariable;
      return null;
    })
    .filter((item) => !!item)
    .join(';');
}

/** Rejects the options rill-highlight would otherwise silently ignore. */
function checkOptions(options) {
  if (options.transformers?.length) throw unsupported('transformers');
  if (options.decorations?.length) throw unsupported('decorations');
  if (options.includeExplanation) throw unsupported('includeExplanation');
  if (options.tokenizeTimeLimit !== undefined) throw unsupported('tokenizeTimeLimit', 'lines are always tokenized to the end');
  if (options.meta && Object.keys(options.meta).some((key) => !key.startsWith('_'))) throw unsupported('meta');
}

const grammarStates = new WeakMap();
const releaseState = typeof FinalizationRegistry === 'undefined' ? null : new FinalizationRegistry(({ binding, handle }) => binding.freeState(handle));

/** Shiki's `GrammarState`: the tokenizer state after some code. */
export class GrammarState {
  #binding;
  constructor(binding, highlighterKey, handle, lang, themes) {
    this.#binding = binding;
    this.lang = lang;
    this.themes = themes;
    Object.defineProperty(this, '_highlighterKey', { value: highlighterKey });
    Object.defineProperty(this, '_handle', { value: handle });
    if (handle && releaseState) releaseState.register(this, { binding, handle });
  }
  get theme() {
    return this.themes[0];
  }
  getScopes() {
    return this._handle ? this.#binding.stateScopes(this._handle) : [];
  }
  toJSON() {
    return { lang: this.lang, theme: this.theme, themes: this.themes, scopes: this.getScopes() };
  }
}

export async function createHighlighterWithCore(core, options = {}) {
  if (options.engine !== undefined) throw unsupported('engine', 'rill-highlight always runs its own JavaScript-compatible regex engine');
  const { manifest, binding } = core;
  const alias = { ...options.langAlias };
  const registry = binding.newRegistry();
  let disposed = false;

  const themes = new Map(); // name -> theme record
  const themeObjects = new WeakMap(); // theme registration object -> record
  const themeHandles = [];
  const loadedGrammars = new Map(); // grammar name -> true, in Shiki's load order
  const graph = new Map(); // Shiki registry `_langGraph`: name -> registered
  const known = new Set(); // Shiki registry `_langMap` keys
  const highlighters = new Map(); // `${grammar}\0${theme handles}` -> entry

  const ensureNotDisposed = () => {
    if (disposed) throw new ShikiError('Shiki instance has been disposed');
  };

  const resolveLangAlias = (name) => {
    if (alias[name]) {
      const resolved = new Set([name]);
      while (alias[name]) {
        name = alias[name];
        if (resolved.has(name)) throw new ShikiError(`Circular alias \`${[...resolved].join(' -> ')} -> ${name}\``);
        resolved.add(name);
      }
    }
    return name;
  };

  // Themes.
  const registerTheme = (json, bundled) => {
    const [handle, [name, type, fg, bg, colorReplacements]] = binding.newTheme(json);
    themeHandles.push(handle);
    const record = { name, type, fg, bg, colorReplacements, handle, bundled };
    if (name) themes.set(name, record);
    return record;
  };
  const themeRecordOfObject = (theme) => {
    let record = themeObjects.get(theme);
    if (!record) {
      record = registerTheme(JSON.stringify(theme));
      themeObjects.set(theme, record);
    } else if (record.name) themes.set(record.name, record);
    return record;
  };
  function getTheme(name) {
    if (isNoneTheme(name)) return NONE_THEME;
    ensureNotDisposed();
    if (name === undefined || name === null) throw new ShikiError(`Theme \`${name}\` not found, you may need to load it first`);
    if (typeof name !== 'string') return themeRecordOfObject(name);
    const record = themes.get(name);
    if (!record) throw new ShikiError(`Theme \`${name}\` not found, you may need to load it first`);
    return record;
  }
  async function loadTheme(...list) {
    ensureNotDisposed();
    const loaded = await Promise.all(
      list.flat(1).map(async (theme) => {
        if (isNoneTheme(theme)) return null;
        if (typeof theme === 'string') {
          if (!manifest.themes.includes(theme)) throw new ShikiError(`Theme \`${theme}\` is not included in this bundle. You may want to load it from external source.`);
          // Loading a bundled theme again changes nothing (and keeps its wasm highlighters).
          if (themes.get(theme)?.bundled === theme) return null;
          return { json: await core.themeText(theme), bundled: theme };
        }
        const value = typeof theme === 'function' ? await theme() : await theme;
        return { object: value.default || value };
      }),
    );
    ensureNotDisposed();
    for (const theme of loaded) {
      if (!theme) continue;
      if (theme.json !== undefined) registerTheme(theme.json, theme.bundled);
      else themeRecordOfObject(theme.object);
    }
  }

  // Languages.
  const grammarNamesOf = (lang) => {
    if (typeof lang !== 'string') {
      if (lang === undefined || lang === null || lang === '') return [];
      throw unsupported('custom languages', 'grammars must be precompiled by scripts/build-grammars.mjs');
    }
    lang = options.langAlias?.[lang] || lang;
    if (isSpecialLang(lang)) return [];
    const entry = manifest.languages[lang];
    if (!entry) throw new ShikiError(`Language \`${lang}\` is not included in this bundle. You may want to load it from external source.`);
    return entry.grammars;
  };
  // Shiki `Registry.loadLanguage`, for a grammar whose text is loaded.
  const inRegistry = new Set();
  const loadGrammar = (name, texts) => {
    if (loadedGrammars.has(resolveLangAlias(name))) return;
    const lazilyEmbeddedBy = [...known].filter((other) => manifest.grammars[other]?.embeddedLangsLazy?.includes(name));
    if (!inRegistry.has(name)) {
      binding.addGrammar(registry, texts.get(name));
      inRegistry.add(name);
    }
    loadedGrammars.set(name, true);
    for (const aliasName of manifest.grammars[name]?.aliases ?? []) alias[aliasName] = name;
    for (const other of lazilyEmbeddedBy) {
      dropHighlighters(other);
      loadedGrammars.delete(other);
      loadGrammar(other, texts);
    }
  };
  async function loadLanguage(...langs) {
    ensureNotDisposed();
    const names = [...new Set(langs.flat(1).flatMap(grammarNamesOf))];
    const texts = new Map(await Promise.all(names.filter((name) => !loadedGrammars.has(name)).map(async (name) => [name, await core.grammarText(name)])));
    ensureNotDisposed();
    // Shiki `Registry.loadLanguages`.
    for (const name of names) {
      known.add(name);
      graph.set(name, true);
      for (const embedded of manifest.grammars[name]?.embeddedLangs ?? []) graph.set(embedded, known.has(embedded));
    }
    for (const [name, registered] of graph) if (registered && texts.has(name)) loadGrammar(name, texts);
  }
  function getLanguage(name) {
    ensureNotDisposed();
    const resolved = resolveLangAlias(name);
    if (!loadedGrammars.has(resolved)) throw new ShikiError(`Language \`${name}\` not found, you may need to load it first`);
    return resolved;
  }

  // Wasm highlighters, one per grammar and theme list.
  function dropHighlighters(grammar) {
    for (const [key, entry] of highlighters) {
      if (entry.grammar === grammar) {
        binding.freeHighlighter(entry.handle);
        highlighters.delete(key);
      }
    }
  }
  function highlighterFor(grammar, records) {
    const key = `${grammar}\0${records.map((record) => record.handle).join(',')}`;
    let entry = highlighters.get(key);
    if (!entry) {
      const handle = binding.newHighlighter(registry, grammar, records.map((record) => record.handle));
      entry = { key, grammar, handle, records, styles: [], views: new Map() };
      highlighters.set(key, entry);
    }
    return entry;
  }

  /** Tokenizes with the wasm highlighter; returns [state handle, numbers]. */
  function tokenize(entry, code, options) {
    const maxLineLength = options.tokenizeMaxLineLength > 0 ? options.tokenizeMaxLineLength : 0;
    let state = 0;
    if (options.grammarState) {
      const grammarState = options.grammarState;
      if (!(grammarState instanceof GrammarState)) throw new ShikiError('Invalid grammar state');
      if (grammarState._highlighterKey !== entry.key) throw unsupported('grammarState from a call with other themes', 'pass the same `theme` or `themes`');
      state = grammarState._handle;
    } else if (options.grammarContextCode != null) {
      state = binding.tokenize(entry.handle, options.grammarContextCode, 0, maxLineLength)[0];
    }
    const result = binding.tokenize(entry.handle, code, state, maxLineLength);
    if (!options.grammarState && state) binding.freeState(state);
    if (result[2] > entry.styles.length) entry.styles.push(...binding.styles(entry.handle, entry.styles.length));
    return result;
  }

  /** Per style id, `make(themeStyles)` for one set of options, computed once. */
  function styleView(entry, key, make) {
    let view = entry.views.get(key);
    if (!view) {
      view = { make, values: [] };
      entry.views.set(key, view);
    }
    for (let id = view.values.length; id < entry.styles.length; id++) view.values.push(view.make(entry.styles[id]));
    return view.values;
  }

  function checkGrammarState(grammarState, lang, themeName) {
    if (!grammarState) return;
    if (grammarState.lang !== lang) throw new ShikiError(`Grammar state language "${grammarState.lang}" does not match highlight language "${lang}"`);
    if (!grammarState.themes.includes(themeName)) throw new ShikiError(`Grammar state themes "${grammarState.themes}" do not contain highlight theme "${themeName}"`);
  }

  const plainLines = (code) => splitLines(code).map(([content, offset]) => [{ content, offset }]);

  /**
   * Builds token objects of one shape (one of the SHAPE_ constants) from wasm
   * numbers and per-style values. One loop with a switch rather than a callback
   * per shape, so the call stays monomorphic.
   */
  function buildTokens(code, numbers, values, shape) {
    const lines = new Array(numbers[0]);
    for (let at = 1, line = 0; line < lines.length; line++) {
      const count = numbers[at++];
      const row = new Array(count);
      for (let token = 0; token < count; token++, at += 3) {
        const offset = numbers[at];
        const content = code.slice(offset, offset + numbers[at + 1]);
        const value = values[numbers[at + 2]];
        switch (shape) {
          case SHAPE_THEMES:
            row[token] = { content, explanation: undefined, offset, htmlStyle: { ...value.htmlStyle } };
            break;
          case SHAPE_THEME:
            row[token] = { content, offset, color: value.color, fontStyle: value.fontStyle };
            break;
          case SHAPE_HTML:
            row[token] = { content, offset, fontStyle: value.fontStyle, style: value.style };
            break;
          default:
            row[token] = { content, variants: value(), offset };
        }
      }
      lines[line] = row;
    }
    return lines;
  }

  /**
   * Shiki `codeToTokensBase` for one theme, or the theme-by-theme part of
   * `codeToTokensWithThemes` for several, as one wasm pass. Returns null for
   * plain text; otherwise { entry, numbers, state, lang }.
   */
  function tokenizeWithThemes(code, options, themeOptions) {
    const lang = resolveLangAlias(options.lang || 'text');
    if (lang === 'ansi') throw unsupported('lang: "ansi"');
    if (isPlainLang(lang)) return null;
    const names = themeOptions.map((theme) => (typeof theme === 'string' ? theme : theme?.name));
    if (names.some(isNoneTheme)) {
      if (names.every(isNoneTheme)) return null;
      throw unsupported('the "none" theme together with other themes');
    }
    const records = themeOptions.map(getTheme);
    const grammar = getLanguage(options.lang || 'text');
    for (const record of records) checkGrammarState(options.grammarState, grammar, record.name);
    const entry = highlighterFor(grammar, records);
    const [state, numbers] = tokenize(entry, code, options);
    return { entry, numbers, state, lang: grammar };
  }

  const makeGrammarState = (result) => new GrammarState(binding, result.entry.key, result.state, result.lang, result.entry.records.map((record) => record.name));

  /** Per-theme `{ color, fontStyle }` of each style id, color replacements applied. */
  const variantsMaker = (entry, options) => {
    const replacements = entry.records.map((record) => resolveColorReplacements(record, options));
    return (styles) => styles.map(([color, fontStyle], theme) => ({ color: applyColorReplacements(color ?? undefined, replacements[theme]), fontStyle }));
  };

  /** Shiki `codeToTokensBase`. */
  function codeToTokensBase(code, options = {}) {
    ensureNotDisposed();
    checkOptions(options);
    const { theme = getLoadedThemes()[0] } = options;
    const result = tokenizeWithThemes(code, options, [theme]);
    if (!result) return plainLines(code);
    const key = `base\0${JSON.stringify(options.colorReplacements ?? null)}`;
    const make = variantsMaker(result.entry, options);
    const values = styleView(result.entry, key, (styles) => make(styles)[0]);
    const tokens = buildTokens(code, result.numbers, values, SHAPE_THEME);
    grammarStates.set(tokens, makeGrammarState(result));
    return tokens;
  }

  /** Shiki `codeToTokensWithThemes`: tokens with a `variants` style per theme. */
  function codeToTokensWithThemes(code, options) {
    ensureNotDisposed();
    checkOptions(options);
    const entries = Object.entries(options.themes).filter((item) => item[1]);
    const result = tokenizeWithThemes(code, options, entries.map((item) => item[1]));
    if (!result) return plainLines(code).map((line) => line.map((token) => ({ content: token.content, variants: Object.fromEntries(entries.map(([color]) => [color, {}])), offset: token.offset })));
    const key = `variants\0${JSON.stringify(options.colorReplacements ?? null)}`;
    const make = variantsMaker(result.entry, options);
    const values = styleView(result.entry, key, (styles) => {
      const perTheme = make(styles);
      return () => Object.fromEntries(entries.map(([color], index) => [color, { ...perTheme[index] }]));
    });
    const tokens = buildTokens(code, result.numbers, values, SHAPE_VARIANTS);
    grammarStates.set(tokens, makeGrammarState(result));
    return tokens;
  }

  /**
   * Shiki `codeToTokens`. With `forHtml`, tokens carry their stringified style
   * as `style` instead of Shiki's token fields.
   */
  function codeToTokensInternal(code, options, forHtml) {
    ensureNotDisposed();
    checkOptions(options);
    let bg, fg, tokens, themeName, rootStyle, grammarState;
    if ('themes' in options) {
      const { defaultColor = 'light', cssVariablePrefix = '--shiki-', colorsRendering = 'css-vars' } = options;
      const entries = Object.entries(options.themes).filter((item) => item[1]);
      const sorted = entries.map((item) => ({ color: item[0], theme: item[1] })).sort((a, b) => (a.color === defaultColor ? -1 : b.color === defaultColor ? 1 : 0));
      if (sorted.length === 0) throw new ShikiError('`themes` option must not be empty');
      const result = tokenizeWithThemes(code, options, entries.map((item) => item[1]));
      if (defaultColor && 'light-dark()' !== defaultColor && !sorted.some((t) => t.color === defaultColor)) throw new ShikiError(`\`themes\` option must contain the defaultColor key \`${defaultColor}\``);
      const themeRegs = sorted.map((t) => getTheme(t.theme));
      const themesOrder = sorted.map((t) => t.color);
      const flat = (variants) => flatVariantsStyle(variants, themesOrder, cssVariablePrefix, defaultColor, colorsRendering);
      if (!result) {
        const htmlStyle = flat(Object.fromEntries(entries.map(([color]) => [color, {}])));
        const style = stringifyTokenStyle(htmlStyle);
        tokens = plainLines(code).map((line) => line.map(({ content, offset }) => (forHtml ? { content, offset, style } : { content, explanation: undefined, offset, htmlStyle: { ...htmlStyle } })));
      } else {
        const key = `themes\0${JSON.stringify([entries.map((item) => item[0]), themesOrder, cssVariablePrefix, defaultColor, colorsRendering, options.colorReplacements ?? null])}`;
        const make = variantsMaker(result.entry, options);
        const values = styleView(result.entry, key, (styles) => {
          const perTheme = make(styles);
          const htmlStyle = flat(Object.fromEntries(entries.map(([color], index) => [color, perTheme[index]])));
          return { htmlStyle, style: stringifyTokenStyle(htmlStyle) };
        });
        tokens = buildTokens(code, result.numbers, values, forHtml ? SHAPE_HTML : SHAPE_THEMES);
        grammarState = stateOf(result, forHtml);
      }
      const themeColorReplacements = sorted.map((t) => resolveColorReplacements(t.theme, options));
      fg = mapThemeColors(sorted, themeRegs, themeColorReplacements, cssVariablePrefix, defaultColor, 'fg', colorsRendering);
      bg = mapThemeColors(sorted, themeRegs, themeColorReplacements, cssVariablePrefix, defaultColor, 'bg', colorsRendering);
      themeName = `shiki-themes ${themeRegs.map((t) => t.name).join(' ')}`;
      rootStyle = defaultColor ? undefined : [fg, bg].join(';');
    } else if ('theme' in options) {
      const colorReplacements = resolveColorReplacements(options.theme, options);
      const result = tokenizeWithThemes(code, options, [options.theme]);
      if (!result) {
        tokens = plainLines(code);
        if (forHtml) for (const line of tokens) for (const token of line) token.style = '';
      } else {
        const key = `theme\0${JSON.stringify(options.colorReplacements ?? null)}`;
        const make = variantsMaker(result.entry, options);
        const values = styleView(result.entry, key, (styles) => {
          const variant = make(styles)[0];
          return { ...variant, style: stringifyTokenStyle(getTokenStyleObject(variant)) };
        });
        tokens = buildTokens(code, result.numbers, values, forHtml ? SHAPE_HTML : SHAPE_THEME);
        grammarState = stateOf(result, forHtml);
      }
      const theme = getTheme(options.theme);
      bg = applyColorReplacements(theme.bg, colorReplacements);
      fg = applyColorReplacements(theme.fg, colorReplacements);
      themeName = theme.name;
    } else throw new ShikiError('Invalid options, either `theme` or `themes` must be provided');
    if (grammarState) grammarStates.set(tokens, grammarState);
    return { tokens, fg, bg, themeName, rootStyle, grammarState };
  }

  /** The result's grammar state; HTML has no use for it, so it is released. */
  function stateOf(result, forHtml) {
    if (!forHtml) return makeGrammarState(result);
    binding.freeState(result.state);
    return undefined;
  }

  function codeToHtml(code, options) {
    const { tokens, fg, bg, themeName, rootStyle } = codeToTokensInternal(code, options, true);
    return tokensToHtml(tokens, { ...options, fg, bg, themeName, rootStyle: options.rootStyle === false ? false : (options.rootStyle ?? rootStyle) });
  }

  /** Shiki `getLastGrammarState(code, options)` or `(tokens)`. */
  function getLastGrammarState(...args) {
    if (args.length === 1) return grammarStates.get(args[0]);
    const [code, options = {}] = args;
    ensureNotDisposed();
    checkOptions(options);
    const { lang = 'text', theme = getLoadedThemes()[0] } = options;
    if (isPlainLang(lang) || isNoneTheme(theme)) throw new ShikiError('Plain language does not have grammar state');
    if (lang === 'ansi') throw new ShikiError('ANSI language does not have grammar state');
    return makeGrammarState(tokenizeWithThemes(code, { ...options, lang }, [theme]));
  }

  function getLoadedThemes() {
    ensureNotDisposed();
    return [...themes.keys()];
  }

  function getLoadedLanguages() {
    ensureNotDisposed();
    return [...new Set([...loadedGrammars.keys(), ...Object.keys(alias)])];
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of highlighters.values()) binding.freeHighlighter(entry.handle);
    highlighters.clear();
    for (const handle of themeHandles) binding.freeTheme(handle);
    binding.freeRegistry(registry);
    themes.clear();
    loadedGrammars.clear();
  }

  await Promise.all([loadTheme(...(options.themes ?? [])), loadLanguage(...(options.langs ?? []))]);

  return {
    codeToTokens: (code, options) => codeToTokensInternal(code, options, false),
    codeToTokensBase,
    codeToTokensWithThemes,
    codeToHtml,
    getLastGrammarState,
    loadLanguage,
    loadTheme,
    getTheme: (name) => {
      const { handle, bundled, ...theme } = getTheme(name);
      return theme;
    },
    getLoadedThemes,
    getLoadedLanguages,
    resolveLangAlias,
    getBundledLanguages: () => manifest.languages,
    getBundledThemes: () => Object.fromEntries(manifest.themes.map((name) => [name, true])),
    dispose,
    [Symbol.dispose]: dispose,
  };
}

const RE_LANG_ATTR = /:?lang=["']([^"']+)["']/g;
const RE_CODE_FENCE = /(?:```|~~~)([\w-]+)/g;
const RE_LATEX_BEGIN = /\\begin\{([\w-]+)\}/g;
const RE_SCRIPT_LANG = /<script\s+(?:type|lang)=["']([^"']+)["']/gi;
const RE_FRONTMATTER = /^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\s*$)/;

/** Shiki `guessEmbeddedLanguages` (used by the shorthands). */
export function guessEmbeddedLanguages(code, _lang, highlighter) {
  const langs = new Set();
  for (const match of code.matchAll(RE_LANG_ATTR)) {
    const lang = match[1].toLowerCase().trim();
    if (lang) langs.add(lang);
  }
  for (const match of code.matchAll(RE_CODE_FENCE)) {
    const lang = match[1].toLowerCase().trim();
    if (lang) langs.add(lang);
  }
  for (const match of code.matchAll(RE_LATEX_BEGIN)) {
    const lang = match[1].toLowerCase().trim();
    if (lang) langs.add(lang);
  }
  for (const match of code.matchAll(RE_SCRIPT_LANG)) {
    const fullType = match[1].toLowerCase().trim();
    const lang = fullType.includes('/') ? fullType.split('/').pop() : fullType;
    if (lang) langs.add(lang);
  }
  if (RE_FRONTMATTER.test(code)) langs.add('yaml');
  if (!highlighter) return [...langs];
  const bundle = highlighter.getBundledLanguages();
  return [...langs].filter((lang) => lang && bundle[lang]);
}

/** Shiki `createSingletonShorthands` over `createHighlighter`. */
export function createShorthands(createHighlighter) {
  let singleton;
  async function getSingletonHighlighter(options = {}) {
    if (!singleton) singleton = createHighlighter({ ...options, themes: [], langs: [] });
    const highlighter = await singleton;
    await Promise.all([highlighter.loadTheme(...(options.themes || [])), highlighter.loadLanguage(...(options.langs || []))]);
    return highlighter;
  }
  async function get(code, options) {
    const highlighter = await getSingletonHighlighter({ langs: [options.lang], themes: 'theme' in options ? [options.theme] : Object.values(options.themes) });
    const langs = guessEmbeddedLanguages(code, options.lang, highlighter);
    if (langs.length) await highlighter.loadLanguage(...langs);
    return highlighter;
  }
  return {
    getSingletonHighlighter,
    codeToHtml: async (code, options) => (await get(code, options)).codeToHtml(code, options),
    codeToTokens: async (code, options) => (await get(code, options)).codeToTokens(code, options),
    codeToTokensBase: async (code, options) => (await get(code, options)).codeToTokensBase(code, options),
    codeToTokensWithThemes: async (code, options) => (await get(code, options)).codeToTokensWithThemes(code, options),
  };
}
