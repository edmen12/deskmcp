import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import MarkdownIt from 'markdown-it';
import { chromium } from 'playwright-core';
import { pdf2md } from './lib/pdf2md.js';
import { CONFIG_FILE } from '../../config.js';
const isUrl = (source) => source.startsWith('http://') || source.startsWith('https://');
// Cached Chrome path to avoid repeated lookups
let cachedChromePath = null; // null = not checked yet
let chromeCheckPromise = null;
/**
 * Get Desktop Commander's private Puppeteer cache directory.
 */
function getPuppeteerCacheDir() {
    return join(dirname(CONFIG_FILE), 'puppeteer-cache');
}
/**
 * Get the cache path where Puppeteer stores Chrome for Testing builds.
 */
function getPuppeteerChromeDir(cacheDir = getPuppeteerCacheDir()) {
    return join(cacheDir, 'chrome');
}
/**
 * Find the platform-specific executable within a cached Chrome build directory.
 */
function getChromeExecutablePath(chromeDir, version) {
    const chromePath = process.platform === 'win32'
        ? join(chromeDir, version, 'chrome-win64', 'chrome.exe')
        : process.platform === 'darwin'
            ? join(chromeDir, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
            : join(chromeDir, version, 'chrome-linux64', 'chrome');
    if (existsSync(chromePath)) {
        return chromePath;
    }
    // Also check for arm64 mac
    if (process.platform === 'darwin') {
        const armPath = join(chromeDir, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(armPath)) {
            return armPath;
        }
    }
    return undefined;
}
/**
 * Resolve the cached Chrome build directory that owns an executable path.
 */
function getCachedChromeBuildDir(chromeDir, executablePath) {
    const relativePath = relative(chromeDir, executablePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        return undefined;
    }
    const [buildDir] = relativePath.split(sep);
    return buildDir ? join(chromeDir, buildDir) : undefined;
}
/**
 * Find Chrome in puppeteer's cache directory
 * Returns the executable path if found, undefined otherwise
 */
export function findPuppeteerChrome(cacheDir = getPuppeteerCacheDir()) {
    const chromeDir = getPuppeteerChromeDir(cacheDir);
    if (!existsSync(chromeDir)) {
        return undefined;
    }
    try {
        // Look for chrome directories (e.g., win64-143.0.7499.169)
        const versions = readdirSync(chromeDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
            const executablePath = getChromeExecutablePath(chromeDir, version);
            if (executablePath) {
                return { executablePath };
            }
        }
    }
    catch {
        // Ignore errors reading cache directory
    }
    return undefined;
}
/**
 * Remove stale Puppeteer Chrome builds while preserving the active build.
 */
export async function pruneOldPuppeteerChromeBuilds(activeExecutablePath, cacheDir = getPuppeteerCacheDir()) {
    const chromeDir = getPuppeteerChromeDir(cacheDir);
    const activeBuildDir = getCachedChromeBuildDir(chromeDir, activeExecutablePath);
    if (!activeBuildDir) {
        return;
    }
    let entries;
    try {
        entries = await fs.readdir(chromeDir, { withFileTypes: true });
    }
    catch {
        return;
    }
    await Promise.all(entries
        .filter(entry => entry.isDirectory())
        .map(async (entry) => {
        const buildDir = join(chromeDir, entry.name);
        if (resolve(buildDir) === resolve(activeBuildDir)) {
            return;
        }
        try {
            await fs.rm(buildDir, { recursive: true, force: true });
        }
        catch (error) {
            console.error(`Failed to remove old Chrome cache build at ${buildDir}:`, error);
        }
    }));
}
/**
 * Find system-installed Chrome/Chromium browser
 * Returns the executable path if found, undefined otherwise
 */
function findSystemChrome() {
    const paths = process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
                '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            ]
            : [
                // Linux paths
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/snap/bin/chromium',
            ];
    return paths.find(p => existsSync(p));
}
/**
 * Download and install Chrome using @puppeteer/browsers
 * Returns the executable path after installation
 */
async function installChrome() {
    // Dynamic import to avoid loading if not needed
    const { install, Browser, detectBrowserPlatform, resolveBuildId } = await import('@puppeteer/browsers');
    const cacheDir = getPuppeteerCacheDir();
    const platform = detectBrowserPlatform();
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    console.error('Downloading Chrome for PDF generation (this may take a few minutes)...');
    await fs.mkdir(cacheDir, { recursive: true });
    const installedBrowser = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir,
        downloadProgressCallback: (downloadedBytes, totalBytes) => {
            const percent = Math.round((downloadedBytes / totalBytes) * 100);
            process.stderr.write(`\rDownloading Chrome: ${percent}%`);
        },
    });
    console.error('\nChrome download complete.');
    return {
        executablePath: installedBrowser.executablePath,
    };
}
/**
 * Find or install Chrome for PDF generation
 * Priority: 1. Puppeteer cache, 2. System Chrome, 3. Install Chrome
 * Results are cached to avoid repeated lookups
 */
async function getChromePath() {
    // Return cached result if available
    if (cachedChromePath !== null) {
        return cachedChromePath;
    }
    // If a check is already in progress, wait for it
    if (chromeCheckPromise) {
        return chromeCheckPromise;
    }
    // Start the check
    chromeCheckPromise = (async () => {
        // 1. Check puppeteer cache first (exact compatible version)
        const cachedChrome = findPuppeteerChrome();
        if (cachedChrome) {
            await pruneOldPuppeteerChromeBuilds(cachedChrome.executablePath);
            cachedChromePath = cachedChrome.executablePath;
            return cachedChrome.executablePath;
        }
        // 2. Check system Chrome
        const systemChrome = findSystemChrome();
        if (systemChrome) {
            cachedChromePath = systemChrome;
            return systemChrome;
        }
        // 3. Install Chrome as last resort
        try {
            const installedChrome = await installChrome();
            await pruneOldPuppeteerChromeBuilds(installedChrome.executablePath);
            cachedChromePath = installedChrome.executablePath;
            return installedChrome.executablePath;
        }
        catch (error) {
            console.error('Failed to install Chrome:', error);
            cachedChromePath = undefined;
            return undefined;
        }
    })();
    const result = await chromeCheckPromise;
    chromeCheckPromise = null;
    return result;
}
/**
 * Preemptively ensure Chrome is available for PDF generation.
 * Call this at server startup to trigger download in background if needed.
 * Returns immediately, download happens in background.
 */
export function ensureChromeAvailable() {
    // Don't await - let it run in background
    getChromePath().catch((error) => {
        console.error('Background Chrome check failed:', error);
    });
}
async function loadPdfToBuffer(source) {
    if (isUrl(source)) {
        const response = await fetch(source);
        return await response.arrayBuffer();
    }
    else {
        return await fs.readFile(source);
    }
}
/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function parsePdfToMarkdown(source, pageNumbers = []) {
    try {
        const data = await loadPdfToBuffer(source);
        // @ts-ignore: Type definition mismatch for ESM usage
        return await pdf2md(new Uint8Array(data), pageNumbers);
    }
    catch (error) {
        console.error("Error converting PDF to Markdown (v3):", error);
        throw error;
    }
}
async function readPdfStylesheet(source, basedir) {
    if (isUrl(source)) {
        const response = await fetch(source);
        if (!response.ok) {
            throw new Error(`Could not load PDF stylesheet ${source}: HTTP ${response.status}`);
        }
        return await response.text();
    }
    const stylesheetPath = isAbsolute(source) ? source : resolve(basedir, source);
    return await fs.readFile(stylesheetPath, 'utf8');
}
function asStringArray(value) {
    if (typeof value === 'string')
        return [value];
    if (!Array.isArray(value))
        return [];
    return value.filter(item => typeof item === 'string');
}
function escapeHtmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
export async function parseMarkdownToPdf(markdown, options = {}) {
    let browser;
    try {
        // Find Chrome: puppeteer cache -> system Chrome -> install.
        const chromePath = await getChromePath();
        if (!chromePath) {
            throw new Error('Could not find Chrome');
        }
        const basedir = typeof options.basedir === 'string' ? resolve(options.basedir) : process.cwd();
        const markdownOptions = options.markdown_it_options && typeof options.markdown_it_options === 'object'
            ? options.markdown_it_options
            : {};
        const renderer = new MarkdownIt({
            html: true,
            linkify: true,
            ...markdownOptions,
        });
        const body = renderer.render(markdown);
        const stylesheetSources = asStringArray(options.stylesheet);
        const externalCss = await Promise.all(stylesheetSources.map(source => readPdfStylesheet(source, basedir)));
        const inlineCss = typeof options.css === 'string' ? options.css : '';
        const bodyClass = asStringArray(options.body_class).map(escapeHtmlAttribute).join(' ');
        const baseHref = pathToFileURL(basedir.endsWith(sep) ? basedir : basedir + sep).href;
        const defaultCss = [
            'html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
            'body { font-family: Arial, Helvetica, sans-serif; line-height: 1.5; margin: 32px; color: #111; }',
            'img { max-width: 100%; }',
            'pre { white-space: pre-wrap; overflow-wrap: anywhere; }',
            'table { border-collapse: collapse; max-width: 100%; }',
            'th, td { border: 1px solid #ddd; padding: 6px 8px; }',
            'blockquote { border-left: 4px solid #ddd; margin-left: 0; padding-left: 16px; color: #555; }',
        ].join('\n');
        const html = [
            '<!doctype html>',
            '<html><head><meta charset="utf-8">',
            `<base href="${escapeHtmlAttribute(baseHref)}">`,
            `<style>${defaultCss}\n${externalCss.join('\n')}\n${inlineCss}</style>`,
            '</head>',
            `<body class="${bodyClass}">${body}</body></html>`,
        ].join('');
        const requestedLaunchOptions = options.launch_options && typeof options.launch_options === 'object'
            ? { ...options.launch_options }
            : {};
        delete requestedLaunchOptions.executablePath;
        // Keep PDF generation background-only even if a caller passes a visible launch option.
        requestedLaunchOptions.headless = true;
        browser = await chromium.launch({
            ...requestedLaunchOptions,
            executablePath: chromePath,
        });
        const context = await browser.newContext({
            javaScriptEnabled: options.allow_javascript === true,
        });
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        const pdfOptions = options.pdf_options && typeof options.pdf_options === 'object'
            ? { ...options.pdf_options }
            : {};
        if (pdfOptions.printBackground === undefined) {
            pdfOptions.printBackground = true;
        }
        const content = await page.pdf(pdfOptions);
        await context.close();
        return Buffer.from(content);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Could not find Chrome')) {
            throw new Error('PDF generation requires Chrome or Chromium browser. ' +
                'Please install Google Chrome from https://www.google.com/chrome/ ' +
                'or Chromium, then try again.');
        }
        console.error('Error creating PDF:', error);
        throw error;
    }
    finally {
        if (browser) {
            await browser.close().catch(() => undefined);
        }
    }
}
