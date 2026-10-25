/**
 * Open a URL in the default browser (cross-platform)
 * Uses execFile/spawn with args array to avoid shell injection
 */
export declare function openBrowser(url: string): Promise<void>;
/**
 * Open the Desktop Commander welcome page
 */
export declare function openWelcomePage(clientName?: string): Promise<void>;
