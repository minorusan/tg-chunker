#!/usr/bin/env node
// DOMAIN ASSIGNMENT, stage 1 — mine WITH the mapping (the fields we previously threw away).
// Same bulk reading as mine-domains.ts, but now every proposition is numbered with its chunk_id and
// the model must return, per domain it comes up with, WHICH chunks belong to it:
//   {"domains":[{"name":"pricing rules","chunks":[3,17,42]}, …]}
// So when 20 chunks meet 5 domains, we leave with the 20→5 mapping, not just the 5 names.
// Output: data/domains/assign-bulks.jsonl (append-as-we-go, crash-resumable).
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/assign-domains-mine.ts [--chunks <path>] [--bulk 100]

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';
import { prompts } from '../src/prompts.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/domains');
mkdirSync(DIR, { recursive: true });
const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CHUNKS = flag('chunks', join(process.env.HOME ?? '', 'brochat-test/processed/chunks.jsonl'));
const BULK = parseInt(flag('bulk', '100'), 10);
const LOG = join(DIR, 'assign-bulks.jsonl');
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — one door only'); process.exit(1); }

const chunks = readFileSync(CHUNKS, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((c) => c.chunk_type === 'proposition')
  .map((c) => ({ id: String(c.chunk_id), text: String(c.text).replace(/\s+/g, ' ').trim() }));

const done = new Set<number>();
if (existsSync(LOG)) for (const l of readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).bulk);

const nBulks = Math.ceil(chunks.length / BULK);
console.log(`${chunks.length} proposition chunks → ${nBulks} bulk(s) of ~${BULK}, mapping domains → chunk numbers`);

for (let bi = 0; bi < nBulks; bi++) {
  if (done.has(bi)) { console.log(`  bulk ${bi + 1}/${nBulks}: done (resume)`); continue; }
  const batch = chunks.slice(bi * BULK, (bi + 1) * BULK);
  // OPTIMIZATION (user-designed) — MINE WITH THE MAPPING: "feed propositions from 20 chunks, come up
  // with 5 domains, map those 20 with those 5" — the mapping we used to discard IS the assignment.
  // Prompt: prompts/09_mine_domains_mapped.md.
  const prompt = prompts.mineDomainsMapped({ COUNT: String(batch.length), MIN: '5', MAX: '15', CHUNKS: batch.map((c, i) => `${i + 1}. ${c.text}`).join('\n') });
  const raw = await gate.generate(prompt);
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let assignments: Array<{ name: string; chunks: number[] }> = [];
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(raw.slice(a, b + 1)) as { domains?: Array<{ name?: unknown; chunks?: unknown[] }> };
      assignments = (j.domains ?? [])
        .map((d) => ({ name: String(d.name ?? '').toLowerCase().trim(), chunks: (Array.isArray(d.chunks) ? d.chunks : []).map(Number).filter((n) => n >= 1 && n <= batch.length) }))
        .filter((d) => d.name && d.chunks.length);
    } catch { /* logged below as empty — visible, rerunnable */ }
  }
  // translate bulk-local numbers → real chunk_ids before logging (provenance, always)
  const mapped = assignments.map((d) => ({ domain: d.name, chunkIds: d.chunks.map((n) => batch[n - 1].id) }));
  const covered = new Set(mapped.flatMap((d) => d.chunkIds)).size;
  appendFileSync(LOG, JSON.stringify({ bulk: bi, assignments: mapped }) + '\n', 'utf8');
  console.log(`  bulk ${bi + 1}/${nBulks}: ${mapped.length} domains, ${covered}/${batch.length} chunks covered${covered < batch.length ? ' ⚠' : ''}`);
}
await gate.release();
console.log(`✅ mapping mined → data/domains/assign-bulks.jsonl`);