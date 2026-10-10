// Writes the Claude Code plugin's copies of the pipeline procedures: one skill
// per released procedure, plugins/proa/skills/<name>/SKILL.md, and the plugin
// version (PLUGIN_VERSION, src/plugin.ts) in plugins/proa/.claude-plugin/plugin.json.
// test/plugin.test.ts fails while the committed files differ from this output.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_VERSION, pipelineProcedures, renderSkill, skillPath } from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const procedures = pipelineProcedures();
if (!procedures.some((p) => p.id === 'proa-relations')) {
  throw new Error('the proa-relations procedure is missing');
}

for (const procedure of procedures) {
  const skill = fileURLToPath(new URL(skillPath(procedure), root));
  await mkdir(dirname(skill), { recursive: true });
  await writeFile(skill, renderSkill(procedure));
  console.log(`wrote ${skill} (${procedure.id}@${procedure.version})`);
}

// Only the version string changes, so the file keeps its Prettier layout.
const manifest = fileURLToPath(new URL('plugins/proa/.claude-plugin/plugin.json', root));
const source = await readFile(manifest, 'utf8');
const updated = source.replace(/("version":\s*)"[^"]*"/, `$1"${PLUGIN_VERSION}"`);
if (updated === source && !source.includes(`"version": "${PLUGIN_VERSION}"`)) {
  throw new Error(`${manifest} has no "version" to update`);
}
await writeFile(manifest, updated);
console.log(`wrote ${manifest} (version ${PLUGIN_VERSION})`);
