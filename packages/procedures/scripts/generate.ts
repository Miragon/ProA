// Writes the Claude Code plugin's copy of the relations procedure: the skill
// plugins/proa/skills/relations/SKILL.md and the plugin version (the
// procedure version) in plugins/proa/.claude-plugin/plugin.json.
// test/plugin.test.ts fails while the committed files differ from this output.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProcedure, renderSkill, skillPath } from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const procedure = getProcedure('proa-relations');
if (!procedure) throw new Error('the proa-relations procedure is missing');

const skill = fileURLToPath(new URL(skillPath(procedure), root));
await mkdir(dirname(skill), { recursive: true });
await writeFile(skill, renderSkill(procedure));
console.log(`wrote ${skill}`);

// Only the version string changes, so the file keeps its Prettier layout.
const manifest = fileURLToPath(new URL('plugins/proa/.claude-plugin/plugin.json', root));
const source = await readFile(manifest, 'utf8');
const updated = source.replace(/("version":\s*)"[^"]*"/, `$1"${procedure.version}"`);
if (updated === source && !source.includes(`"version": "${procedure.version}"`)) {
  throw new Error(`${manifest} has no "version" to update`);
}
await writeFile(manifest, updated);
console.log(`wrote ${manifest} (version ${procedure.version})`);
