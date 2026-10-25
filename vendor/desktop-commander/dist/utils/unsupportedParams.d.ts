/**
 * Utility for detecting parameters a caller sent that a tool's Zod schema does
 * not accept.
 *
 * Zod's default `z.object()` silently strips unknown keys, so a model that
 * invents a parameter (e.g. `view_range`) gets a normal-looking response with no
 * signal that its input was ignored. These helpers let the dispatcher surface a
 * corrective warning instead.
 *
 * Detection is top-level only. That is sufficient here because none of the tool
 * arg schemas use a top-level `.passthrough()`/catchall — free-form fields
 * (`options`, `params`, `pdfOptions`) are named keys whose contents are
 * intentionally unvalidated.
 */
/** List the parameter names a tool schema accepts (empty array if it takes none). */
export declare function getSupportedParams(schema: unknown): string[];
/**
 * Return the names of top-level keys in `args` that the schema does not accept.
 * Returns [] when args is not a plain object or the schema's params can't be
 * determined (so we never warn on something we can't reason about).
 */
export declare function detectUnsupportedParams(args: unknown, schema: unknown): string[];
/** Build the corrective warning string shown to the model. */
export declare function buildUnsupportedParamsWarning(toolName: string, unsupported: string[], supported: string[]): string;
