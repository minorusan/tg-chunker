#!/usr/bin/env node
// HW3 — the IMPROVED retrieval pipeline (rubric: scripts/retrieval_improved.*).
// Two upgrades over HW2's baseline (scripts/retrieve.ts):
//
//   1. METADATA FILTERING (rubric item 1): every chunk carries `domain` metadata (assigned by the
//      chunk→domain pipeline, see assign-clinic-domains.ts). At query time gemma one-shots the query
//      into 1-2 domains from the taxonomy, and scoring runs ONLY over chunks in those domains — the
//      search space narrows BEFORE any ranking happens (the navmesh idea: route first, walk after).
//      If the filtered set is smaller than k, we fall back to the full set and SAY so (an over-eager
//      filter must be visible, not silent).
//
//   2. HYBRID SEARCH (rubric item 2, chosen option): BM25 keyword score fused with cosine semantic
//      score via Reciprocal Rank Fusion — RRF(d) = Σ 1/(60 + rank). HW2's documented failure was
//      keyword-blind ranking with 0.001 margins; BM25 votes fix exactly that, and RRF needs no score
//      normalisation (ranks only), so the fusion is robust and explainable.
//
//   LLM_GATEWAY=… node scripts/retrieval_improved.ts "<query>" [--k 3]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { embedQuery, cosine } from '../src/embed.ts';
import { labGate } from '../src/guest.ts';
import { prompts } from '../src/prompts.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── corpus: index + chunks + the domain sidecar ─────────────────────────────────────────────────────
const index = JSON.parse(readFileSync(join(ROOT, 'index/index.json'), 'utf8')) as { items: Array<{ chunk_id: string; vector: number[] }> };
const domainsOf = JSON.parse(readFileSync(join(ROOT, 'data/processed/chunk-domains.json'), 'utf8')) as Record<string, string[]>;
const chunks = new Map<string, Record<string, unknown>>();
for (const l of readFileSync(join(ROOT, 'data/processed/chunks.jsonl'), 'utf8').trim().split('\n')) { const c = JSON.parse(l); chunks.set(c.chunk_id, c); }
const TAXONOMY = [...new Set(Object.values(domainsOf).flat())];

// ── BM25 over the corpus (word tokens; uk/ru handled by unicode word chars) ─────────────────────────
const tokenize = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
class BM25 {
  private df = new Map<string, number>();
  private docs: string[][] = [];
  private avg = 0;
  private k1: number;
  private b: number;
  constructor(texts: string[], k1 = 1.5, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.docs = texts.map(tokenize);
    this.avg = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  score(query: string, di: number): number {
    const doc = this.docs[di];
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const q of new Set(tokenize(query))) {
      const n = this.df.get(q); if (!n) continue;
      const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
      const f = tf.get(q) ?? 0;
      s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * doc.length / this.avg));
    }
    return s;
  }
}

/** Query → domains: THE TRAINED EXTRACTOR (gemma-domains, fine-tuned Gemma-3-270M served by Ollama
 *  behind the gateway as an allowlisted utility model). Same prompt format it was trained on; output
 *  is "domain1; domain2". Only domains that actually exist in this corpus's sidecar survive —
 *  an extractor hallucination can then only widen to fallback, never route to a ghost domain. */
async function classifyQuery(q: string, ip: string): Promise<string[]> {
  // OPTIMIZATION (user-designed) — THE NAVMESH: a tiny TRAINED model (Gemma-3-270M fine-tuned on 5k
  // synthetic pairs) extracts domains from the user prompt, so the search space is cut at O(1) BEFORE
  // ranking. Prompt = prompts/13_extract_domains.md — the model's trained I/O contract, single-sourced
  // across training, eval and runtime.
  const prompt = prompts.extractDomains({ QUERY: q });
  const gate = labGate();
  let raw: string;
  if (gate) {
    raw = await gate.generate(prompt, { model: 'gemma-domains' });
  } else {
    // standalone path (no gateway — demo/dev): straight to Ollama, same as embed.ts's raw fallback
    const res = await fetch(`http://${ip}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma-domains', messages: [{ role: 'user', content: prompt }], stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ollama gemma-domains ${res.status}: ${await res.text()}`);
    raw = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
  }
  // the trained answer is ONE line ("domain1; domain2"); the GGUF sometimes rambles past its EOS —
  // everything after the first newline is degeneration, not signal
  const firstLine = raw.trim().split('\n')[0] ?? '';
  return firstLine.split(';').map((s) => s.trim().toLowerCase()).filter((d) => d && TAXONOMY.includes(d));
}

export interface ImprovedHit { chunk_id: string; score: number; rrf: number; cosRank: number; bm25Rank: number; text: string; source_file: string; document_id: string; chunk_type: string; domains: string[] }
export interface ImprovedResult { hits: ImprovedHit[]; filterDomains: string[]; searched: number; total: number; fellBack: boolean }

/** The improved pipeline: classify → domain-filter → hybrid BM25⊕cosine via RRF → top-k. */
export async function improvedRetrieve(q: string, k: number, ip: string): Promise<ImprovedResult> {
  const filterDomains = await classifyQuery(q, ip);
  const inDomain = (id: string) => filterDomains.length === 0 || (domainsOf[id] ?? []).some((d) => filterDomains.includes(d));
  let pool = index.items.filter((it) => inDomain(it.chunk_id));
  let fellBack = false;
  if (pool.length < k) { pool = index.items; fellBack = true; }   // over-eager filter → visible fallback

  const qv = await embedQuery(ip, q);
  const bm25 = new BM25(pool.map((it) => String((chunks.get(it.chunk_id) as any).text)));
  const cosScores = pool.map((it, i) => ({ i, s: cosine(qv, it.vector) })).sort((a, b) => b.s - a.s);
  const bmScores = pool.map((_, i) => ({ i, s: bm25.score(q, i) })).sort((a, b) => b.s - a.s);
  const cosRank = new Map(cosScores.map((x, r) => [x.i, r + 1]));
  const bmRank = new Map(bmScores.map((x, r) => [x.i, r + 1]));
  const rrf = (i: number) => 1 / (60 + cosRank.get(i)!) + 1 / (60 + bmRank.get(i)!);

  const hits = pool.map((it, i) => ({ it, i, r: rrf(i) })).sort((a, b) => b.r - a.r).slice(0, k).map(({ it, i, r }) => {
    const c = chunks.get(it.chunk_id) as any;
    return { chunk_id: c.chunk_id, score: cosScores.find((x) => x.i === i)!.s, rrf: r, cosRank: cosRank.get(i)!, bm25Rank: bmRank.get(i)!, text: String(c.text), source_file: c.source_file, document_id: c.document_id, chunk_type: c.chunk_type, domains: domainsOf[it.chunk_id] ?? [] };
  });
  return { hits, filterDomains, searched: pool.length, total: index.items.length, fellBack };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const k = parseInt(flag('k', '3'), 10);
  const ip = flag('ollamaIp', '127.0.0.1:11434');
  const skip = new Set(['--k', '--ollamaIp']);
  const query = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1])).join(' ');
  if (!query) { console.error('usage: node scripts/retrieval_improved.ts "<query>" [--k 3]'); process.exit(1); }
  const r = await improvedRetrieve(query, k, ip);
  console.log(`\nQuery: ${query}`);
  console.log(`Domain filter: [${r.filterDomains.join(', ') || 'none'}] → searched ${r.searched}/${r.total} chunks${r.fellBack ? ' (filter too narrow — fell back to all)' : ''}\n`);
  r.hits.forEach((h, i) => {
    console.log(`Top-${i + 1}: ${h.chunk_id} | rrf ${h.rrf.toFixed(4)} (cos#${h.cosRank}, bm25#${h.bm25Rank}) | ${h.domains.join('·')}`);
    console.log(`  ${h.text.slice(0, 110)}${h.text.length > 110 ? '…' : ''}\n`);
  });
  await labGate()?.release();
}