#!/usr/bin/env node
// Re-assign the clinic sample's chunks to the CANON taxonomy (data/train/labels.json — the same 31
// labels the gemma-domains extractor speaks). One gemma one-shot per proposition chunk; person chunks
// get "people directory". Overwrites data/processed/chunk-domains.json (the retrieval sidecar).
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/assign-clinic-canon.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — one door only'); process.exit(1); }

const labels = JSON.parse(readFileSync(join(ROOT, 'data/train/labels.json'), 'utf8')) as string[];
const all = readFileSync(join(ROOT, 'data/processed/chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const out: Record<string, string[]> = {};
for (const c of all) {
  if (c.chunk_type === 'person') { out[String(c.chunk_id)] = ['people directory']; continue; }
  const raw = await gate.generate(`Knowledge chunk from a dental clinic KB:\n"${c.text}"\n\nDomain taxonomy:\n${labels.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n\nWhich 1-3 domains does this chunk belong to? JSON array of numbers only.`);
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  let doms: string[] = [];
  if (a >= 0 && b > a) { try { doms = (JSON.parse(raw.slice(a, b + 1)) as unknown[]).map((n) => labels[Number(n) - 1]).filter(Boolean); } catch { /* below */ } }
  if (!doms.length) throw new Error(`no domains parsed for ${c.chunk_id}: ${raw.slice(0, 120)}`);   // fail loud
  out[String(c.chunk_id)] = doms;
  console.log(`  ${c.chunk_id} → ${doms.join(' · ')}`);
}
writeFileSync(join(ROOT, 'data/processed/chunk-domains.json'), JSON.stringify(out, null, 2), 'utf8');
await gate.release();
console.log(`✅ sidecar re-assigned to canon taxonomy (${labels.length} labels)`);