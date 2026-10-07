/**
 * Resolve ripgrep binary path with multiple fallback strategies
 * This handles cases where @vscode/ripgrep postinstall fails in npx environments
 */
export declare function getRipgrepPath(): Promise<string>;
/**
 * Clear the cached ripgrep path (useful for testing)
 */
export declare function clearRipgrepCache(): void;
