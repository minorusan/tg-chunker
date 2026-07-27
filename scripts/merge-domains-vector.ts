#!/usr/bin/env node
// ═══ OPTIMIZATION AUTHORED BY THE USER: "we need to vectorize results and perform vector-based
// merge" — after strings proved blind to synonymy. The threshold SWEEP (rather than one guess) found
// the usable 0.85–0.88 band for domains and the 0.80 chaining cliff — unlike person names, where no
// usable threshold existed at all. ═══
// HW3 groundwork — VECTOR-based domain merge.
// Embed the deterministically-merged domain names (nomic, through the Maradel gateway as guest),
// cosine every pair, cluster with union-find at several thresholds, and show the sweep — pick the
// threshold by looking, not by faith. (Name-merge taught us nomic can't separate PEOPLE; domains are
// TOPICS — exactly what a retrieval embedder is built to compare. Let's see.)
// Sources untouched; writes data/domains/domains-vector.md.
//
//   LLM_GATEWAY=http://127.0.0.1:9100 node scripts/merge-domains-vector.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labGate } from '../src/guest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/domains');
const gate = labGate();
if (!gate) { console.error('LLM_GATEWAY not set — one door only'); process.exit(1); }

const items = JSON.parse(readFileSync(join(DIR, 'domains-merged.json'), 'utf8')) as Array<{ domain: string; count: number }>;
console.log(`embedding ${items.length} domain names via gateway (guest)…`);
const vecs = await gate.embed(items.map((d) => d.domain), 'document');   // same prefix for all — symmetric compare
await gate.release();

const cos = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9); };

// pairwise similarity once; cluster at each threshold in the sweep
const sim: number[][] = items.map(() => []);
for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { const s = cos(vecs[i], vecs[j]); sim[i][j] = s; }

function clustersAt(thr: number): string[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (sim[i][j] >= thr) parent[find(i)] = find(j);
  const m = new Map<number, string[]>();
  items.forEach((d, i) => { const r = find(i); (m.get(r) ?? m.set(r, []).get(r)!).push(d.domain); });
  // canonical first: highest count, then shortest
  const byCount = new Map(items.map((d) => [d.domain, d.count]));
  return [...m.values()].map((c) => c.sort((a, b) => (byCount.get(b)! - byCount.get(a)!) || (a.length - b.length)))
    .sort((a, b) => byCount.get(b[0])! - byCount.get(a[0])!);
}

let md = `# Vector-based domain merge — threshold sweep (nomic via gateway)\n\n${items.length} names in. For each cosine threshold: resulting cluster count + every multi-member cluster (canonical first). Sources untouched.\n`;
for (const thr of [0.95, 0.92, 0.9, 0.88, 0.85, 0.8, 0.75]) {
  const cs = clustersAt(thr);
  const multi = cs.filter((c) => c.length > 1);
  md += `\n## threshold ${thr} → ${cs.length} domains (${multi.length} merged clusters)\n`;
  for (const c of multi) md += `- **${c[0]}** ← ${c.slice(1).join(' · ')}\n`;
  console.log(`thr ${thr}: ${items.length} → ${cs.length} domains (${multi.length} clusters merged)`);
}
writeFileSync(join(DIR, 'domains-vector.md'), md, 'utf8');
console.log('✅ sweep → data/domains/domains-vector.md');