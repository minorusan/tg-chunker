#!/usr/bin/env node
// ═══ OPTIMIZATION AUTHORED BY THE USER: deterministic-first — "first do levenshtein to prepare
// better exact match, then try merge by exact match. See what happens." Outcome: 120→118 (2 merges) —
// the honest negative result PROVING the tail was synonym drift, not spelling drift, which is what
// justified the vector pass next. Cheap experiment, expensive insight. ═══
// HW3 groundwork — DETERMINISTIC domain merge (no LLM).
// Pass A (levenshtein prep): cluster near-identical spellings — plural/singular, tiny drifts
//   ("patient communication" ↔ "patient communications") — via whole-string edit distance.
// Pass B (exact match): after each cluster collapses to its best-supported spelling, merge exact strings
//   and sum bulk-counts.
// Source material untouched: reads data/domains/bulks.jsonl, writes NEW files
// (domains-merged.md + domains-merged.json).
//
//   node scripts/merge-domains-deterministic.ts [--lev 3]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/domains');
const args = process.argv.slice(2);
const LEV_MAX = parseInt((args[args.indexOf('--lev') + 1] || '3'), 10) || 3;

// aggregate raw counts from the untouched bulk log
const counts = new Map<string, number>();
for (const l of readFileSync(join(DIR, 'bulks.jsonl'), 'utf8').trim().split('\n').filter(Boolean))
  for (const d of JSON.parse(l).domains as string[]) counts.set(d, (counts.get(d) ?? 0) + 1);
const names = [...counts.keys()];

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// PASS A — near-duplicate spellings cluster together (union-find over the lev graph).
// Threshold: distance ≤ LEV_MAX AND ≤ 20% of the shorter string — small absolute drift on
// phrases this length is plural/singular or one-word inflection, never a different topic.
const parent = names.map((_, i) => i);
const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const union = (i: number, j: number) => { parent[find(i)] = find(j); };
let levLinks = 0;
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const d = lev(names[i], names[j]);
  if (d <= LEV_MAX && d <= Math.min(names[i].length, names[j].length) * 0.2) { union(i, j); levLinks++; }
}

// each cluster collapses to its best-supported spelling (highest count; tie → shorter string)
const clusters = new Map<number, string[]>();
names.forEach((n, i) => { const r = find(i); (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(n); });
const canonicalOf = new Map<string, string>();
for (const members of clusters.values()) {
  const canon = [...members].sort((a, b) => (counts.get(b)! - counts.get(a)!) || (a.length - b.length) || a.localeCompare(b))[0];
  for (const m of members) canonicalOf.set(m, canon);
}

// PASS B — exact-match merge on the canonicalised names, counts summed
const merged = new Map<string, { count: number; variants: string[] }>();
for (const [name, c] of counts) {
  const canon = canonicalOf.get(name)!;
  const e = merged.get(canon) ?? merged.set(canon, { count: 0, variants: [] }).get(canon)!;
  e.count += c;
  if (name !== canon) e.variants.push(name);
}
const sorted = [...merged.entries()].sort((a, b) => b[1].count - a[1].count);

let md = `# Deterministically merged domains (lev ≤ ${LEV_MAX} & ≤20% → exact match)\n\n`;
md += `${names.length} raw names → **${sorted.length} merged domains** (${levLinks} levenshtein links). Source (bulks.jsonl / domains-raw.md) untouched.\n\n`;
md += `| # | domain | total bulk-hits | merged variants |\n|---|---|---|---|\n`;
sorted.forEach(([d, e], i) => { md += `| ${i + 1} | ${d} | ${e.count} | ${e.variants.join(' · ') || '—'} |\n`; });
writeFileSync(join(DIR, 'domains-merged.md'), md, 'utf8');
writeFileSync(join(DIR, 'domains-merged.json'), JSON.stringify(sorted.map(([d, e]) => ({ domain: d, count: e.count, variants: e.variants })), null, 2), 'utf8');
console.log(`✅ ${names.length} raw → ${sorted.length} merged (${levLinks} lev links) → data/domains/domains-merged.{md,json}`);