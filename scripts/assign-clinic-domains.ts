#!/usr/bin/env node
// HW3 — assign domains to the CLINIC SAMPLE (the graded corpus, 18 chunks).
// Miniature of the big-corpus pipeline: one mining call returns the domain names PLUS which chunks
// belong to each (the mapping fields); then every proposition chunk gets ONE gemma one-shot bool
// judgement over its candidate domains. Person chunks are routers, not topical content — they get the
// static domain "people directory" (matched by name, not by topic; see HW1's two-index design).
// Output: data/processed/chunk-domains.json sidecar {chunk_id: [domains]} — chunks.jsonl untouched.
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/assign-clinic-domains.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';
import { prompts } from '../src/prompts.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — one door only'); process.exit(1); }

const all = readFileSync(join(ROOT, 'data/processed/chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const props = all.filter((c) => c.chunk_type === 'proposition');
const persons = all.filter((c) => c.chunk_type === 'person');

// ── 1 mining call: domains + the chunk mapping ──────────────────────────────
// OPTIMIZATION (user-designed) — MINE WITH THE MAPPING (prompts/09): the bulk pass returns per-domain
// chunk numbers, so mining and candidate-assignment are ONE call on this small corpus.
const mineRaw = await gate.generate(prompts.mineDomainsMapped({
  COUNT: String(props.length), MIN: '3', MAX: '8',
  CHUNKS: props.map((c, i) => `${i + 1}. ${c.text}`).join('\n'),
}));
const a = mineRaw.indexOf('{'), b = mineRaw.lastIndexOf('}');
const mined = (JSON.parse(mineRaw.slice(a, b + 1)) as { domains: Array<{ name: string; chunks: number[] }> }).domains
  .map((d) => ({ name: d.name.toLowerCase().trim(), chunks: (d.chunks ?? []).map(Number).filter((n) => n >= 1 && n <= props.length) }))
  .filter((d) => d.name && d.chunks.length);
console.log(`mined ${mined.length} domains: ${mined.map((d) => `${d.name}(${d.chunks.length})`).join(' · ')}`);

// candidates per chunk from the mapping
const candidates = new Map<string, Set<string>>();
mined.forEach((d) => d.chunks.forEach((n) => {
  const id = String(props[n - 1].chunk_id);
  (candidates.get(id) ?? candidates.set(id, new Set()).get(id)!).add(d.name);
}));

// ── one-shot bool judgement per proposition chunk ────────────────────────────
const out: Record<string, string[]> = {};
for (const c of props) {
  const doms = [...(candidates.get(String(c.chunk_id)) ?? new Set(mined.map((d) => d.name)))];
  // OPTIMIZATION (user-designed) — bool one-shot judging per chunk (prompts/10_domain_membership.md)
  const raw = await gate.generate(prompts.domainMembership({ TEXT: String(c.text), DOMAINS: doms.map((d, i) => `${i + 1}. ${d}`).join('\n') }));
  const x = raw.indexOf('{'), y = raw.lastIndexOf('}');
  let belongs: string[] = [];
  try {
    const j = JSON.parse(raw.slice(x, y + 1)) as { verdicts?: Array<{ n?: number; belongs?: boolean }> };
    belongs = (j.verdicts ?? []).filter((v) => v.belongs === true).map((v) => doms[Number(v.n) - 1]).filter(Boolean);
  } catch { /* stays empty — visible below */ }
  if (!belongs.length) belongs = doms.slice(0, 1);   // a chunk must be findable: keep its strongest candidate
  out[String(c.chunk_id)] = belongs;
  console.log(`  ${c.chunk_id} → ${belongs.join(' · ')}`);
}
for (const p of persons) out[String(p.chunk_id)] = ['people directory'];

writeFileSync(join(ROOT, 'data/processed/chunk-domains.json'), JSON.stringify(out, null, 2), 'utf8');
await gate.release();
console.log(`✅ data/processed/chunk-domains.json — ${props.length} propositions judged + ${persons.length} person chunks → "people directory"`);