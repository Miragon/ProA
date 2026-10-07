import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cssVariableOf, palette, type PaletteKey } from '../src/theme/tokens';

const tokensCss = readFileSync(
  join(import.meta.dirname, '../src/theme/cd-tokens.generated.css'),
  'utf8',
);
const indexCss = readFileSync(join(import.meta.dirname, '../src/index.css'), 'utf8');

function cssVariables(css: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    vars.set(match[1]!, match[2]!.trim());
  return vars;
}

describe('Miragon tokens (modeler-tool-design §13 drift test)', () => {
  const vars = cssVariables(tokensCss);

  it('the TS palette equals the vendored --cd-* tokens', () => {
    for (const key of Object.keys(palette) as PaletteKey[]) {
      expect(vars.get(cssVariableOf(key))?.toUpperCase(), key).toBe(palette[key].toUpperCase());
    }
  });

  it('the vendored file is marked as generated and imported by the app CSS', () => {
    expect(tokensCss.split('\n')[0]).toContain('Nicht ändern');
    expect(indexCss).toContain("@import './theme/cd-tokens.generated.css';");
  });

  it('the app CSS defines no colours of its own (one mode, no dark theme)', () => {
    const own = indexCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(own).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(own).not.toMatch(/\brgba?\(/);
    expect(own).not.toMatch(/\boklch\(/);
    expect(own).not.toMatch(/^\.dark\b/m);
  });
});
