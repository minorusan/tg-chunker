#!/usr/bin/env node
// HW3 groundwork — DOMAIN MINING (exploratory pass, output feeds the user's planning).
//
// Step 1: gather every proposition text from chunks.jsonl into ONE big file (data/domains/propositions.txt).
// Step 2: the model reads it in big bulks (through the Maradel gateway as GUEST — one door, gemma,
//         lowest priority, yields to maradel/ayin/podcast) and, per bulk, spits out the 2–3 word
//         domain names it can come up with for that material.
// Output: data/domains/bulks.jsonl (raw per-bulk lists, appended as we go — a crash loses nothing and
//         a rerun skips finished bulks) + data/domains/domains-raw.md (aggregated, frequency-sorted).
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/mine-domains.ts [--chunks <path>] [--bulk 200]

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CHUNKS = flag('chunks', join(process.env.HOME ?? '', 'brochat-test/processed/chunks.jsonl'));
const BULK = parseInt(flag('bulk', '200'), 10);

const OUT_DIR = join(ROOT, 'data/domains');
mkdirSync(OUT_DIR, { recursive: true });
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — this pass runs ONLY through the gateway (one door)'); process.exit(1); }

// ── step 1: one big file of propositions ─────────────────────────────────────
const props = readFileSync(CHUNKS, 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l))
  .filter((c) => c.chunk_type === 'proposition')
  .map((c) => String(c.text).replace(/\s+/g, ' ').trim());
writeFileSync(join(OUT_DIR, 'propositions.txt'), props.join('\n') + '\n', 'utf8');
console.log(`step 1: ${props.length} propositions → data/domains/propositions.txt`);

// ── step 2: bulk-read → domain names ─────────────────────────────────────────
const BULKS_LOG = join(OUT_DIR, 'bulks.jsonl');
const done = new Set<number>();
if (existsSync(BULKS_LOG)) for (const l of readFileSync(BULKS_LOG, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).bulk);

const prompt = (batch: string[]) => `You are building a topic taxonomy for a knowledge base of a dental clinic's internal work chats (Ukrainian/Russian).
Below are ${batch.length} knowledge propositions. Read them all, then list the DOMAIN NAMES you can come up with that these propositions belong to.

Rules:
- each domain name: 2-3 words, English, lowercase (e.g. "pricing rules", "patient scheduling")
- domains describe TOPICS of the material, not the clinic itself
- 5-15 domains per answer — only ones genuinely present in this material
- answer with ONLY a JSON array of strings, nothing else

PROPOSITIONS:
${batch.map((p, i) => `${i + 1}. ${p}`).join('\n')}

JSON array:`;

/** Lenient parse: JSON array anywhere in the text, else line-split fallback. */
function parseDomains(raw: string): string[] {
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return (JSON.parse(raw.slice(a, b + 1)) as unknown[]).map(String); } catch { /* fall through */ } }
  return raw.split('\n').map((s) => s.replace(/^[\s\-*"'\d.]+|["',]+$/g, '').trim()).filter((s) => s && s.split(/\s+/).length <= 4);
}

const nBulks = Math.ceil(props.length / BULK);
console.log(`step 2: ${nBulks} bulk(s) of ~${BULK} propositions — via gateway as guest (yields to anyone active)`);
for (let bi = 0; bi < nBulks; bi++) {
  if (done.has(bi)) { console.log(`  bulk ${bi + 1}/${nBulks}: already done (resume)`); continue; }
  const batch = props.slice(bi * BULK, (bi + 1) * BULK);
  const raw = await gate.generate(prompt(batch));
  const domains = [...new Set(parseDomains(raw).map((d) => d.toLowerCase().trim()).filter(Boolean))];
  appendFileSync(BULKS_LOG, JSON.stringify({ bulk: bi, domains }) + '\n', 'utf8');
  console.log(`  bulk ${bi + 1}/${nBulks}: ${domains.length} domains — ${domains.slice(0, 6).join(' · ')}${domains.length > 6 ? ' · …' : ''}`);
}

// ── aggregate ────────────────────────────────────────────────────────────────
const counts = new Map<string, number>();
for (const l of readFileSync(BULKS_LOG, 'utf8').trim().split('\n').filter(Boolean))
  for (const d of JSON.parse(l).domains as string[]) counts.set(d, (counts.get(d) ?? 0) + 1);
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
let md = `# Raw mined domains — ${CHUNKS}\n\n${props.length} propositions · ${nBulks} bulks of ~${BULK} · ${sorted.length} distinct domain names\n\n| domain | bulks it appeared in |\n|---|---|\n`;
for (const [d, n] of sorted) md += `| ${d} | ${n} |\n`;
writeFileSync(join(OUT_DIR, 'domains-raw.md'), md, 'utf8');
await gate.release();
console.log(`\n✅ ${sorted.length} distinct domains → data/domains/domains-raw.md (top: ${sorted.slice(0, 8).map(([d]) => d).join(' · ')})`);