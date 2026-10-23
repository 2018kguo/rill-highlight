// Types for @2018kguo/rill-highlight/core. The highlighter API mirrors Shiki
// 4.5.0's (`createHighlighter` from 'shiki') for the options listed here.

/** A theme in VS Code / TextMate JSON form, as Shiki accepts it. */
export interface ThemeRegistration {
  name?: string;
  type?: 'light' | 'dark' | string;
  fg?: string;
  bg?: string;
  colors?: Record<string, string>;
  settings?: unknown[];
  tokenColors?: unknown[];
  colorReplacements?: Record<string, string>;
  [key: string]: unknown;
}

/** A bundled theme name, `'none'`, or a theme object. */
export type ThemeInput = string | ThemeRegistration;

export interface ThemedToken {
  content: string;
  offset: number;
  color?: string;
  fontStyle?: number;
}

export interface ThemedTokenWithVariants {
  content: string;
  offset: number;
  variants: Record<string, { color?: string; fontStyle?: number }>;
}

/** A token of a multi-theme result. */
export interface ThemedTokenWithStyle {
  content: string;
  offset: number;
  explanation: undefined;
  htmlStyle: Record<string, string>;
}

export declare class GrammarState {
  readonly lang: string;
  readonly themes: string[];
  readonly theme: string;
  getScopes(): string[];
  toJSON(): { lang: string; theme: string; themes: string[]; scopes: string[] };
}

export declare class ShikiError extends Error {}

export interface TokenizeOptions {
  /** A loaded language id or alias; plain text when omitted. */
  lang?: string;
  /** Tokenize as if the code followed this state (from a call with the same themes). */
  grammarState?: GrammarState;
  /** Tokenize as if the code followed this code. */
  grammarContextCode?: string;
  /** Lines this long or longer stay one unstyled token (0: no limit). */
  tokenizeMaxLineLength?: number;
  /** String values apply to every theme; object values to the theme of that name. */
  colorReplacements?: Record<string, string | Record<string, string>>;
}

export interface SingleThemeOptions extends TokenizeOptions {
  theme: ThemeInput;
}

export interface MultipleThemesOptions extends TokenizeOptions {
  /** Up to four themes keyed by color name, such as `{ light, dark }`. */
  themes: Record<string, ThemeInput | undefined | null | false>;
  /** The theme whose colors are the defaults; `false` for CSS variables only. Default `'light'`. */
  defaultColor?: string | false | 'light-dark()';
  /** Default `'--shiki-'`. */
  cssVariablePrefix?: string;
  /** Default `'css-vars'`. */
  colorsRendering?: 'css-vars' | 'none';
}

export type CodeToTokensOptions = SingleThemeOptions | MultipleThemesOptions;

export interface TokensResult {
  tokens: ThemedToken[][] | ThemedTokenWithStyle[][];
  fg: string;
  bg: string;
  themeName: string;
  rootStyle?: string;
  grammarState?: GrammarState;
}

export type CodeToHtmlOptions = CodeToTokensOptions & {
  /** Default `true`. */
  mergeWhitespaces?: boolean | 'never';
  /** Default `false`. */
  mergeSameStyleTokens?: boolean;
  /** Default `'classic'`. */
  structure?: 'classic' | 'inline';
  /** Default `'0'`. */
  tabindex?: number | string | false;
  rootStyle?: string | false;
};

export interface HighlighterOptions {
  /** Bundled theme names or theme objects to load. */
  themes?: (ThemeInput | Promise<ThemeInput>)[];
  /** Bundled language ids or aliases to load. */
  langs?: string[];
  /** Extra language aliases. */
  langAlias?: Record<string, string>;
}

export interface Highlighter {
  codeToTokens(code: string, options: CodeToTokensOptions): TokensResult;
  codeToTokensBase(code: string, options?: TokenizeOptions & { theme?: ThemeInput }): ThemedToken[][];
  codeToTokensWithThemes(code: string, options: TokenizeOptions & { themes: MultipleThemesOptions['themes'] }): ThemedTokenWithVariants[][];
  codeToHtml(code: string, options: CodeToHtmlOptions): string;
  getLastGrammarState(code: string, options: TokenizeOptions & { theme?: ThemeInput }): GrammarState;
  getLastGrammarState(tokens: unknown): GrammarState | undefined;
  loadLanguage(...langs: (string | string[])[]): Promise<void>;
  loadTheme(...themes: (ThemeInput | Promise<ThemeInput> | ThemeInput[])[]): Promise<void>;
  getTheme(name: ThemeInput): { name: string; type: string; fg: string; bg: string; colorReplacements: Record<string, string> };
  getLoadedThemes(): string[];
  getLoadedLanguages(): string[];
  resolveLangAlias(name: string): string;
  getBundledLanguages(): Record<string, { name: string; aliases: string[]; grammars: string[] }>;
  getBundledThemes(): Record<string, true>;
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Where the wasm module and the data files come from. */
export interface DataSource {
  /** The JSON text of dist/grammars/<name>.json. */
  grammar(name: string): string | Promise<string>;
  /** The JSON text of dist/themes/<name>.json. */
  theme(name: string): string | Promise<string>;
}

export type WasmSource = WebAssembly.Module | ArrayBuffer | ArrayBufferView | Response | URL | string;

export interface HighlightCoreOptions {
  wasm?: WasmSource | Promise<WasmSource>;
  data?: DataSource;
  /** A hosted copy of the package's dist/ directory, instead of `wasm` and `data`. */
  baseUrl?: string | URL;
}

export interface HighlightCore {
  createHighlighter(options?: HighlighterOptions): Promise<Highlighter>;
}

export declare function createHighlightCore(options: HighlightCoreOptions): Promise<HighlightCore>;

export declare function dataFromBaseUrl(baseUrl: string | URL): { wasm: URL; data: DataSource };
