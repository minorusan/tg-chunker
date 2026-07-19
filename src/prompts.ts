// Prompt loader. Every prompt the pipeline sends to the model lives as a file in /prompts so it can be
// read and audited on its own (a prompt IS code here — it decides what the model does). We strip the
// leading HTML comment (the human-facing note) and fill {{PLACEHOLDER}} slots with runtime data.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'prompts');

function load(name: string): string {
  const raw = readFileSync(join(PROMPTS_DIR, name), 'utf8');
  return raw.replace(/^<!--[\s\S]*?-->\s*/, '').trim(); // drop the audit note at the top
}

/** Fill {{KEY}} slots. Values are plain strings the caller has already serialised. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

const ANON = load('01_anonymize_discover.md');
const CHUNK = load('02_chunk_propositions.md');
const MERGE = load('03_merge_verify.md');

export const prompts = {
  anonymizeDiscover: (vars: { GROUPS: string; GROUP0: string; PEOPLE: string; MESSAGES: string }) => fill(ANON, vars),
  chunkPropositions: (vars: { WINDOW_START: string; WINDOW_END: string; MESSAGES: string }) => fill(CHUNK, vars),
  mergeVerify: (vars: { A: string; B: string }) => fill(MERGE, vars),
};
