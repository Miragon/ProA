/**
 * Miragon palette as a pure TS module (no DOM), mirroring the vendored
 * `cd-tokens.generated.css`. Code that needs a colour outside CSS (canvas,
 * SVG attributes) reads it from here; `test/theme.test.ts` fails when the two
 * drift apart. One mode only (modeler-tool-design §3.5).
 */
export const palette = {
  blau: '#335DE5',
  blauLink: '#2B50D4',
  blauHell: '#6B8AFF',
  gruen: '#00E676',
  grau: '#F9F7F7',
  schwarz: '#1D1D1D',
  weiss: '#FFFFFF',
  linie: '#E6E2E2',
  kontur: '#8F8A8A',
  textLeise: '#6B6666',
  nacht: '#080A20',
  success: '#0B7A55',
  warning: '#92610A',
  danger: '#C92A2A',
  info: '#2B50D4',
} as const;

export type PaletteKey = keyof typeof palette;

/** CSS custom property of each palette entry (`blauLink` → `--cd-blau-link`). */
export function cssVariableOf(key: PaletteKey): string {
  return `--cd-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
