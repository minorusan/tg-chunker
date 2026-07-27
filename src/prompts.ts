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
const QA = load('04_qa_leakscan.md');
const RAG = load('05_rag_answer.md');
const AUDIT = load('06_alias_audit.md');
const CHAT = load('07_chat_agent.md');
const MINE = load('08_mine_domains.md');
const MINE_MAPPED = load('09_mine_domains_mapped.md');
const MEMBERSHIP = load('10_domain_membership.md');
const ASSIGN_CANON = load('11_assign_canon.md');
const SYNONYMS = load('12_domain_synonyms.md');
const EXTRACT = load('13_extract_domains.md');

export const prompts = {
  anonymizeDiscover: (vars: { GROUPS: string; GROUP0: string; PEOPLE: string; MESSAGES: string }) => fill(ANON, vars),
  chunkPropositions: (vars: { WINDOW_START: string; WINDOW_END: string; MESSAGES: string }) => fill(CHUNK, vars),
  mergeVerify: (vars: { A: string; B: string }) => fill(MERGE, vars),
  qaLeakScan: (vars: { MESSAGES: string }) => fill(QA, vars),
  ragAnswer: (vars: { CONTEXT: string; QUESTION: string }) => fill(RAG, vars),
  aliasAudit: (vars: { CANONICAL: string; GROUP: string; ALIASES: string }) => fill(AUDIT, vars),
  chatAgent: (vars: { CONTEXT: string; TRANSCRIPT: string; QUESTION: string }) => fill(CHAT, vars),
  // ── the HW3 domain machinery (each backed by a user-designed optimization — see the prompt files) ──
  mineDomains: (vars: { COUNT: string; PROPOSITIONS: string }) => fill(MINE, vars),
  mineDomainsMapped: (vars: { COUNT: string; MIN: string; MAX: string; CHUNKS: string }) => fill(MINE_MAPPED, vars),
  domainMembership: (vars: { TEXT: string; DOMAINS: string }) => fill(MEMBERSHIP, vars),
  assignCanon: (vars: { TEXT: string; TAXONOMY: string }) => fill(ASSIGN_CANON, vars),
  domainSynonyms: (vars: { ANCHOR: string; CANDIDATES: string }) => fill(SYNONYMS, vars),
  extractDomains: (vars: { QUERY: string }) => fill(EXTRACT, vars),
};
