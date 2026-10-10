/**
 * The interactive MCP prompt `draft_value_chain` (M4 §3.3): an agent drafts a
 * `.vc.json` from the landscape, and a human imports, edits and saves it on
 * the value chain page. Its text lives in
 * `packages/procedures/prompts/draft-value-chain.md` with `{{projectId}}` as
 * the only placeholder. It is no versioned procedure: `listProcedures` never
 * reads the `prompts/` folder, nothing records it, and its skeleton is
 * invented (no corpus data). `place_processes` wraps the `proa-placements`
 * procedure instead (`renderAdHocWrapper`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Directory of the prompt texts (not read by `listProcedures`). */
export const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

/** File name of the `draft_value_chain` text in {@link PROMPTS_DIR}. */
export const DRAFT_VALUE_CHAIN_FILE = 'draft-value-chain.md';

let template: string | undefined;

/** The `draft_value_chain` prompt for one project (id or key, validated by the caller). */
export function renderDraftValueChainPrompt(scope: { projectId: string }): string {
  template ??= readFileSync(`${PROMPTS_DIR}/${DRAFT_VALUE_CHAIN_FILE}`, 'utf8').trim();
  return template.replaceAll('{{projectId}}', scope.projectId);
}
