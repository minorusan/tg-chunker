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
import { discoverPeople, mergePass, applyTokens } from './anonymize.ts';
import { chunkChat } from './chunk.ts';
import { warmup } from './ollama.ts';

// ── args ──────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const sourceDir = arg('sourceDir');
const ollamaIp = arg('ollamaIp', '127.0.0.1:11434')!;
const windowN = parseInt(arg('window', '12')!, 10);   // N — bounded by how much context the GPU holds
// The groups people are sorted into. Generic: default employee,patient — but pass anything
// (goodies,baddies / staff,client,vendor / …). The FIRST group is the chat's own participants.
const groups = (arg('groupingTags', 'employee,patient')!).split(',').map((g) => g.trim()).filter(Boolean);
const domain = arg('domain', 'chat')!;                // free-form metadata tag for the KB
if (!sourceDir) { console.error('usage: node src/index.ts --sourceDir <dir> --ollamaIp <host:port> [--groupingTags employee,patient] [--domain chat] [--window N]'); process.exit(1); }
if (groups.length === 0) { console.error('--groupingTags needs at least one group'); process.exit(1); }

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
log(`  ${files.length} chat(s), ${chats.reduce((n, c) => n + (c.doc.messages?.length ?? 0), 0)} messages, window N=${windowN}`);
log(`  groups: ${groups.join(', ')}  (first = chat participants)\n`);
await warmup(ollamaIp);

// ── PASS 1: anonymise (shared map across all chats → consistent tokens everywhere) ─────────────────
log('Pass 1 — anonymise');
const people = await discoverPeople(ollamaIp, chats.map((c) => c.doc.messages ?? []), groups, windowN, log);
// PASS 1.5 — the 3rd LLM loop: verify/merge duplicate identities (semantic, not string overlap).
log('Pass 1.5 — entity-merge verification');
await mergePass(ollamaIp, people, log);
for (const { file, doc } of chats) {
  applyTokens(doc.messages ?? [], people);
  writeFileSync(join(ANON_DIR, basename(file)), JSON.stringify(doc, null, 2), 'utf8');
}
writeFileSync(join(ANON_DIR, 'names-map.json'), JSON.stringify({ people }, null, 2), 'utf8'); // AUDIT file
const perGroup = groups.map((g) => `${people.filter((p) => p.group === g).length} ${g}`).join(' + ');
log(`  → ${perGroup} mapped → anonymized/\n`);

// ── PASS 2: chunk each anonymised chat into propositions ───────────────────────────────────────────
if (args.includes('--no-chunk')) { log('(--no-chunk: skipping proposition extraction)'); process.exit(0); }
log('Pass 2 — chunk into propositions');
const allChunks: Chunk[] = [];
for (const { file, doc } of chats) {
  const id = docId(file);
  log(` ▸ ${basename(file)} (document_id: ${id})`);
  const chunks = await chunkChat(ollamaIp, id, `sample_input/${basename(file)}`, doc.name ?? id, domain, doc.messages ?? [], windowN, log);
  allChunks.push(...chunks);
}

// ── PASS 2.5 — ENTITY LINKING: build the mentionedAt back-references and emit PERSON chunks ─────────
// INTENTION: PEOPLE ARE ROUTERS, NOT SEMANTIC CONTENT. Every proposition already lists its `actors`
// (tokens). So DETERMINISTICALLY (no LLM) we collect, per person, the proposition chunk_ids they
// appear in — that is `mentionedAt`. Then we emit one `person` chunk per person: matched by NAME/alias
// (cheap lexical/trigram), it ROUTES into the sense-blobs. This is the entity-linking / graph-RAG layer
// that lets "tell me everything about X" work as a two-hop lookup instead of a fuzzy semantic search.
log('\nPass 2.5 — entity linking (mentionedAt + person chunks)');
for (const p of people) p.mentionedAt = allChunks.filter((c) => c.actors.includes(p.token)).map((c) => c.chunk_id);
writeFileSync(join(ANON_DIR, 'names-map.json'), JSON.stringify({ people }, null, 2), 'utf8'); // re-save with mentionedAt
const personChunks: Chunk[] = people.map((p) => ({
  chunk_type: 'person',
  chunk_id: `person_${p.token}`,
  document_id: '_people',
  source_file: 'anonymized/names-map.json',
  chunk_index: 0,
  text: `${p.token} — a ${p.group}. Appears in ${p.mentionedAt!.length} discussion(s).`,
  title: 'People',
  domain, document_type: 'entity_card', language: 'uk-ru',
  actors: [p.token],
  message_ids: [],
  timeframe: [],
  group: p.group,
  aliases: p.forms,
  mentioned_at: p.mentionedAt,
}));
allChunks.push(...personChunks);
log(`  → ${personChunks.length} person chunks (each routes to its sense-blobs via mentioned_at)`);

// ── write outputs: chunks.jsonl (the deliverable) + chunks.md (human-readable, to scroll) ──────────
writeFileSync(join(OUT_DIR, 'chunks.jsonl'), allChunks.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
writeFileSync(join(OUT_DIR, 'chunks.md'), renderMarkdown(allChunks), 'utf8');
const props = allChunks.filter((c) => c.chunk_type === 'proposition').length;
log(`\n✅ ${props} proposition + ${personChunks.length} person chunks → output/chunks.jsonl + output/chunks.md`);

/** Pretty, scrollable view of the chunks so the reviewer can eyeball both types comfortably. */
function renderMarkdown(chunks: Chunk[]): string {
  const props = chunks.filter((c) => c.chunk_type === 'proposition');
  const persons = chunks.filter((c) => c.chunk_type === 'person');
  const byDoc = new Map<string, Chunk[]>();
  for (const c of props) (byDoc.get(c.document_id) ?? byDoc.set(c.document_id, []).get(c.document_id)!).push(c);

  let out = `# RAG chunks\n\n${props.length} **proposition** chunks (blobs of sense) + ${persons.length} **person** chunks (entity cards that route into them).\n`;

  out += `\n## Proposition chunks — the knowledge\n`;
  for (const [id, cs] of byDoc) {
    out += `\n### ${cs[0].title}  \n\`document_id: ${id}\` · \`${cs[0].source_file}\`\n`;
    for (const c of cs) {
      out += `\n**\`${c.chunk_id}\`** — ${c.text}\n`;
      out += `<sub>actors: ${c.actors.join(', ') || '—'} · timeframe: ${c.timeframe.join(', ') || '—'} · msgs: ${c.message_ids.join(', ') || '—'}</sub>\n`;
    }
  }

  out += `\n---\n\n## Person chunks — the entity-linking layer\n\nEach person is matched by name/alias and **routes** into the proposition chunks that mention them (\`mentioned_at\`). Ask "tell me about patient2" → match here → follow the ids.\n`;
  for (const p of persons) {
    out += `\n**\`${p.chunk_id}\`** (${p.group}) — aliases: \`${(p.aliases ?? []).join('`, `')}\`\n`;
    out += `<sub>mentioned_at → ${(p.mentioned_at ?? []).join(', ') || '(none)'}</sub>\n`;
  }
  return out;
}
