/**
 * zod under ProA's Content Security Policy (`script-src 'self'`, M4 §5).
 *
 * The value chain schema-model builds its zod object schemas when its module
 * is evaluated, and zod 4 then probes `new Function("")` to decide whether it
 * may compile fast parsers. zod swallows the error, but the browser still
 * reports a `securitypolicyviolation` for the probe. zod skips the probe under
 * `jitless`, read from `globalThis.__zod_globalConfig` (zod creates the object
 * if it is missing and keeps a reference to it), so this module sets the flag
 * before any zod code runs: it is the first import of `main.tsx` and of the
 * lazy chain chunk. It imports nothing from zod itself.
 */

declare global {
  var __zod_globalConfig: { jitless?: boolean } & Record<string, unknown>;
}

const config = (globalThis.__zod_globalConfig ??= {});
config.jitless = true;

export {};
