#!/usr/bin/env node
// DOMAIN ASSIGNMENT, stage 2 — resolve to canon + gemma ONE-SHOT bool judging.
//
// Takes the mined chunk→domain candidates (assign-bulks.jsonl), resolves every raw domain name to its
// CANONICAL form through the whole merge lineage (deterministic merge → canon pass 1 → 2 → 3), then for
// each chunk asks gemma ONCE: "here is the chunk, here are its candidate canonical domains — belongs:
// true/false per domain". Judged assignments land in assignments.jsonl (append, crash-resumable).
//
//   LLM_GATEWAY=… node scripts/assign-domains-judge.ts [--chunks <path>] [--tag v4]
//     --tag picks which prompt-sweep lineage to use for canon (default: the untagged 3-pass chain)

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/domains');
const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CHUNKS = flag('chunks', join(process.env.HOME ?? '', 'brochat-test/processed/chunks.jsonl'));
const TAG = flag('tag', '');
const SUF = TAG ? `-${TAG}` : '';
const OUT = join(DIR, `assignments${SUF}.jsonl`);
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — one door only'); process.exit(1); }

// ── canon resolver: raw mined name → canonical, composed across the whole lineage ──────────────────
const resolve = new Map<string, string>();
const learn = (canon: string, variants: string[]) => { for (const v of variants) resolve.set(v, canon); };
// deterministic merge layer (raw → det-canon)
for (const e of JSON.parse(readFileSync(join(DIR, 'domains-merged.json'), 'utf8')) as Array<{ domain: string; variants: string[] }>)
  learn(e.domain, e.variants);
// canon passes (each: anchor ← merged[])
for (const f of [`domains-canon${SUF}.json`, `domains-canon${SUF}-pass2.json`, `domains-canon${SUF}-pass3.json`]) {
  const p = join(DIR, f);
  if (!existsSync(p)) { console.error(`lineage file missing: ${f} — run the canon passes first`); process.exit(1); }
  for (const e of JSON.parse(readFileSync(p, 'utf8')) as Array<{ domain: string; merged: string[] }>) learn(e.domain, e.merged);
}
const toCanon = (name: string): string => { let n = name; const seen = new Set<string>(); while (resolve.has(n) && !seen.has(n)) { seen.add(n); n = resolve.get(n)!; } return n; };
const finalCanon = new Set((JSON.parse(readFileSync(join(DIR, `domains-canon${SUF}-pass3.json`), 'utf8')) as Array<{ domain: string }>).map((d) => d.domain));

// ── candidates per chunk (mined mapping → canon, deduped; unknown-to-lineage names kept as-is, flagged) ──
const candidates = new Map<string, Set<string>>();
let unknown = 0;
for (const l of readFileSync(join(DIR, 'assign-bulks.jsonl'), 'utf8').trim().split('\n').filter(Boolean))
  for (const a of JSON.parse(l).assignments as Array<{ domain: string; chunkIds: string[] }>) {
    const canon = toCanon(a.domain);
    if (!finalCanon.has(canon)) unknown++;
    for (const id of a.chunkIds) (candidates.get(id) ?? candidates.set(id, new Set()).get(id)!).add(canon);
  }
if (unknown) console.log(`⚠ ${unknown} mined domain mention(s) resolve outside the final canon — kept verbatim, judge decides`);

const chunkText = new Map<string, string>();
for (const l of readFileSync(CHUNKS, 'utf8').trim().split('\n')) { const c = JSON.parse(l); if (c.chunk_type === 'proposition') chunkText.set(String(c.chunk_id), String(c.text)); }

const done = new Set<string>();
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).chunk_id);

const ids = [...candidates.keys()].filter((id) => chunkText.has(id) && !done.has(id));
console.log(`judging ${ids.length} chunk(s) (one-shot each; ${done.size} already done)`);

let judged = 0;
for (const id of ids) {
  const doms = [...candidates.get(id)!];
  const prompt = `Knowledge chunk from a dental clinic KB:
"${chunkText.get(id)}"

Candidate domains:
${doms.map((d, i) => `${i + 1}. ${d}`).join('\n')}

For EACH domain: does this chunk belong to it? STRICT JSON, same order:
{"verdicts":[{"n":1,"belongs":true|false}...]}`;
  const raw = await gate.generate(prompt);
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let belongs: string[] = [];
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(raw.slice(a, b + 1)) as { verdicts?: Array<{ n?: number; belongs?: boolean }> };
      belongs = (j.verdicts ?? []).filter((v) => v.belongs === true).map((v) => doms[Number(v.n) - 1]).filter(Boolean);
    } catch { /* empty → logged, visible */ }
  }
  appendFileSync(OUT, JSON.stringify({ chunk_id: id, candidates: doms, domains: belongs }) + '\n', 'utf8');
  judged++;
  if (judged % 100 === 0) console.log(`  ${judged}/${ids.length} judged`);
}
await gate.release();

// summary
const perDomain = new Map<string, number>();
let orphans = 0;
for (const l of readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)) {
  const e = JSON.parse(l) as { domains: string[] };
  if (!e.domains.length) orphans++;
  for (const d of e.domains) perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
}
console.log(`\n✅ assignments${SUF}.jsonl — ${[...perDomain.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([d, n]) => `${d}:${n}`).join(' · ')}${orphans ? ` · ⚠ ${orphans} chunks with all candidates rejected` : ''}`);