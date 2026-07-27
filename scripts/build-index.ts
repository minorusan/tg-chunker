#!/usr/bin/env node
// HW2 — build the vector index.
// Reads the chunks from HW1 (data/processed/chunks.jsonl), embeds each with the LOCAL model, and saves
// the vectors to index/index.json. That file IS our vector store (a plain matrix — the rubric's allowed
// "NumPy matrix" option, in Node). No FAISS: for a few hundred chunks, exact brute-force search is instant.
//
//   node scripts/build-index.ts [--ollamaIp 127.0.0.1:11434]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedDocuments } from '../src/embed.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ollamaIp = (() => { const i = args.indexOf('--ollamaIp'); return i >= 0 && args[i + 1] ? args[i + 1] : '127.0.0.1:11434'; })();
const MODEL = 'nomic-embed-text';

// load chunks
const chunks = readFileSync(join(ROOT, 'data/processed/chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
console.log(`embedding ${chunks.length} chunks with ${MODEL} (local, offline)…`);

// What we embed per chunk: the proposition text; for a person chunk, its text + aliases so name queries
// find it (this is the two-index design — sense chunks matched by meaning, person chunks by name).
const textOf = (c: { chunk_type: string; text: string; aliases?: string[] }) =>
  c.chunk_type === 'person' ? `${c.text} — known as ${(c.aliases ?? []).join(', ')}` : c.text;

const vectors = await embedDocuments(ollamaIp, chunks.map(textOf));

writeFileSync(join(ROOT, 'index/index.json'), JSON.stringify({
  model: MODEL,
  dim: vectors[0]?.length ?? 0,
  items: chunks.map((c, i) => ({ chunk_id: c.chunk_id, vector: vectors[i] })),
}, null, 0), 'utf8');

console.log(`✅ index/index.json — ${chunks.length} vectors, dim ${vectors[0]?.length}`);
