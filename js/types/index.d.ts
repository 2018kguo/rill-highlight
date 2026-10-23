// Types for @2018kguo/rill-highlight.
import type { CodeToHtmlOptions, CodeToTokensOptions, Highlighter, HighlighterOptions, MultipleThemesOptions, ThemeInput, ThemedToken, ThemedTokenWithVariants, TokenizeOptions, TokensResult } from './core.js';

export * from './core.js';

/** Shiki's `createHighlighter`: loads `themes` and `langs`, then highlights synchronously. */
export declare function createHighlighter(options?: HighlighterOptions): Promise<Highlighter>;

/** One highlighter shared by the shorthands, loading what each call needs. */
export declare function getSingletonHighlighter(options?: HighlighterOptions): Promise<Highlighter>;

/** Shorthands that load the language (and those embedded in the code) and themes on demand. */
export declare function codeToHtml(code: string, options: CodeToHtmlOptions): Promise<string>;
export declare function codeToTokens(code: string, options: CodeToTokensOptions): Promise<TokensResult>;
export declare function codeToTokensBase(code: string, options: TokenizeOptions & { theme: ThemeInput }): Promise<ThemedToken[][]>;
export declare function codeToTokensWithThemes(code: string, options: TokenizeOptions & { themes: MultipleThemesOptions['themes'] }): Promise<ThemedTokenWithVariants[][]>;

export declare function guessEmbeddedLanguages(code: string, lang?: string, highlighter?: Highlighter): string[];
export declare function splitLines(code: string, preserveEnding?: boolean): [string, number][];
export declare function getTokenStyleObject(token: { color?: string; bgColor?: string; fontStyle?: number }): Record<string, string>;
export declare function stringifyTokenStyle(style: string | Record<string, string>): string;
