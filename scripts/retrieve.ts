#!/usr/bin/env node
// HW2 — top-k semantic search.
// Takes a user query, embeds it with the SAME local model as the chunks, scores it against every stored
// vector (brute-force cosine), and returns the k closest chunks with their id, score, text preview and
// metadata (source_file / document_id).
//
//   node scripts/retrieve.ts "how much is a hygiene cleaning?" [--k 3] [--ollamaIp host:port]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { embedQuery, topK } from '../src/embed.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// load the vector store + the chunks (for text + metadata), join by chunk_id — done once at import.
const index = JSON.parse(readFileSync(join(ROOT, 'index/index.json'), 'utf8')) as { items: Array<{ chunk_id: string; vector: number[] }> };
const chunks = new Map<string, Record<string, unknown>>();
for (const l of readFileSync(join(ROOT, 'data/processed/chunks.jsonl'), 'utf8').trim().split('\n')) { const c = JSON.parse(l); chunks.set(c.chunk_id, c); }

/** Run one query → the k best chunks with score + metadata. Exposed so the examples runner reuses it. */
export async function retrieve(q: string, k: number, ip: string) {
  const qv = await embedQuery(ip, q);
  return topK(qv, index.items.map((it) => it.vector), k).map((hit) => {
    const c = chunks.get(index.items[hit.index].chunk_id) as any;
    return { chunk_id: c.chunk_id, score: hit.score, text: String(c.text), source_file: c.source_file, document_id: c.document_id, chunk_type: c.chunk_type };
  });
}

// ── CLI (only when run directly, so importing retrieve() doesn't trigger any of this) ────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const k = parseInt(flag('k', '3'), 10);
  const ollamaIp = flag('ollamaIp', '127.0.0.1:11434');
  const skip = new Set(['--k', '--ollamaIp']);
  const query = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1])).join(' ');
  if (!query) { console.error('usage: node scripts/retrieve.ts "<query>" [--k 3] [--ollamaIp host:port]'); process.exit(1); }

  const results = await retrieve(query, k, ollamaIp);
  console.log(`\nQuery: ${query}\n`);
  results.forEach((r, i) => {
    console.log(`Top-${i + 1}: ${r.chunk_id} | score: ${r.score.toFixed(3)} | ${r.chunk_type}`);
    console.log(`  Text: ${r.text.slice(0, 120)}${r.text.length > 120 ? '…' : ''}`);
    console.log(`  Source: ${r.source_file}  (document_id: ${r.document_id})\n`);
  });
}
