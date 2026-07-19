#!/usr/bin/env node
// tg-chunker — a generalist Telegram-chat → anonymised → RAG-chunk pipeline, powered entirely by a
// local model (Ollama). Linear on purpose: read chats → Pass 1 anonymise → Pass 2 chunk → write.
//
//   node src/index.ts --sourceDir ./sample_input --ollamaIp 127.0.0.1:11434 [--window 12]
//
// Everything the model is asked lives in /prompts (audited). No cloud, no internet — that is the point.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import type { TgExport, TgMessage, Chunk } from './types.ts';
import { discoverPeople, applyTokens } from './anonymize.ts';
import { chunkChat } from './chunk.ts';
import { warmup } from './ollama.ts';

// ── args ──────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const sourceDir = arg('sourceDir');
const ollamaIp = arg('ollamaIp', '127.0.0.1:11434')!;
const windowN = parseInt(arg('window', '12')!, 10);   // N — bounded by how much context the GPU holds
if (!sourceDir) { console.error('usage: node src/index.ts --sourceDir <dir> --ollamaIp <host:port> [--window N]'); process.exit(1); }

const HERE = resolve(join(sourceDir, '..'));           // project root (sample_input/..)
const ANON_DIR = join(HERE, 'anonymized');
const OUT_DIR = join(HERE, 'output');
mkdirSync(ANON_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const log = (s = '') => console.log(s);
/** filename → stable document_id, e.g. "Адмінка Клініки.json" → "adminka_kliniky" (ascii-ish slug). */
const docId = (file: string) => basename(file).replace(/\.json$/i, '')
  .toLowerCase().replace(/[^a-z0-9а-яіїєґё]+/gi, '_').replace(/^_+|_+$/g, '');

// ── read every chat in the source dir ─────────────────────────────────────────────────────────────
const files = readdirSync(sourceDir).filter((f) => f.endsWith('.json')).map((f) => join(sourceDir, f)).sort();
if (!files.length) { console.error(`no .json chats in ${sourceDir}`); process.exit(1); }
const chats = files.map((file) => ({ file, doc: JSON.parse(readFileSync(file, 'utf8')) as TgExport }));

log(`tg-chunker — local model @ ${ollamaIp} (offline)`);
log(`  ${files.length} chat(s), ${chats.reduce((n, c) => n + (c.doc.messages?.length ?? 0), 0)} messages, window N=${windowN}\n`);
await warmup(ollamaIp);

// ── PASS 1: anonymise (shared map across all chats → consistent tokens everywhere) ─────────────────
log('Pass 1 — anonymise');
const people = await discoverPeople(ollamaIp, chats.map((c) => c.doc.messages ?? []), windowN, log);
for (const { file, doc } of chats) {
  applyTokens(doc.messages ?? [], people);
  writeFileSync(join(ANON_DIR, basename(file)), JSON.stringify(doc, null, 2), 'utf8');
}
writeFileSync(join(ANON_DIR, 'names-map.json'), JSON.stringify({ people }, null, 2), 'utf8'); // AUDIT file
const emp = people.filter((p) => p.class === 'employee').length, pat = people.filter((p) => p.class === 'patient').length;
log(`  → ${emp} employees + ${pat} patients mapped → anonymized/\n`);

// ── PASS 2: chunk each anonymised chat into propositions ───────────────────────────────────────────
if (args.includes('--no-chunk')) { log('(--no-chunk: skipping proposition extraction)'); process.exit(0); }
log('Pass 2 — chunk into propositions');
const allChunks: Chunk[] = [];
for (const { file, doc } of chats) {
  const id = docId(file);
  log(` ▸ ${basename(file)} (document_id: ${id})`);
  const chunks = await chunkChat(ollamaIp, id, `sample_input/${basename(file)}`, doc.name ?? id, doc.messages ?? [], windowN, log);
  allChunks.push(...chunks);
}

// ── write outputs: chunks.jsonl (the deliverable) + chunks.md (human-readable, to scroll) ──────────
writeFileSync(join(OUT_DIR, 'chunks.jsonl'), allChunks.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
writeFileSync(join(OUT_DIR, 'chunks.md'), renderMarkdown(allChunks), 'utf8');
log(`\n✅ ${allChunks.length} chunks → output/chunks.jsonl + output/chunks.md`);

/** Pretty, scrollable view of the chunks so the reviewer can eyeball the "blobs" comfortably. */
function renderMarkdown(chunks: Chunk[]): string {
  const byDoc = new Map<string, Chunk[]>();
  for (const c of chunks) (byDoc.get(c.document_id) ?? byDoc.set(c.document_id, []).get(c.document_id)!).push(c);
  let out = `# Extracted propositions (RAG chunks)\n\n${chunks.length} chunks from ${byDoc.size} chat(s). Each block is one self-contained "blob of sense".\n`;
  for (const [id, cs] of byDoc) {
    out += `\n---\n\n## ${cs[0].title}  \n\`document_id: ${id}\` · \`${cs[0].source_file}\`\n`;
    for (const c of cs) {
      out += `\n### \`${c.chunk_id}\`\n> ${c.text}\n\n`;
      out += `- **actors:** ${c.actors.join(', ') || '—'}\n`;
      out += `- **timeframe:** ${c.timeframe.join(', ') || '—'}\n`;
      out += `- **from messages:** ${c.message_ids.join(', ') || '—'}  ·  chunk_index ${c.chunk_index}\n`;
    }
  }
  return out;
}
