#!/usr/bin/env node
// tg-chunker — a generalist Telegram-chat → anonymised → RAG-chunk pipeline, powered entirely by a
// local model (Ollama). Linear on purpose: read chats → Pass 1 anonymise → Pass 2 chunk → write.
//
//   node src/index.ts --sourceDir ./data/raw --ollamaIp 127.0.0.1:11434 [--window 12]
//
// Everything the model is asked lives in /prompts (audited). No cloud, no internet — that is the point.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import type { TgExport, TgMessage, Chunk } from './types.ts';
import { discoverPeople, mergePass, qaPass, applyTokens } from './anonymize.ts';
import { chunkChat } from './chunk.ts';
import { warmup } from './ollama.ts';
import { inputSig, loadCheckpoint, saveCheckpoint, clearCheckpoint } from './checkpoint.ts';
import type { Checkpoint } from './checkpoint.ts';

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
if (!sourceDir) { console.error('usage: node src/index.ts --sourceDir <dir> --ollamaIp <host:port> [--groupingTags employee,patient] [--domain chat] [--window N] [--no-chunk] [--fresh]'); process.exit(1); }
if (groups.length === 0) { console.error('--groupingTags needs at least one group'); process.exit(1); }

const HERE = resolve(join(sourceDir, '..'));           // e.g. data/ when sourceDir is data/raw
const ANON_DIR = join(HERE, 'anonymized');             // → data/anonymized
const OUT_DIR = join(HERE, 'processed');               // → data/processed (chunks.jsonl lives here)
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

// ── STATE SAVE/RESTORE: resume an interrupted run, or start fresh ──────────────────────────────────
// INTENTION: A LONG RUN MUST BE RESUMABLE. Every windowed pass checkpoints after each window; if the run
// dies we pick up at the exact window instead of re-spending hours of GPU. The checkpoint is keyed to the
// input signature, so changed inputs start fresh. `--fresh` forces a clean start.
const sig = inputSig(files);
if (args.includes('--fresh')) { clearCheckpoint(HERE); log('(--fresh: existing checkpoint discarded)\n'); }
let ckpt: Checkpoint = loadCheckpoint(HERE, sig, log)
  ?? { sig, phase: 'discover', people: [], chunks: [], unit: 0, start: 0, qaRound: 1, qaAdded: 0, chunkIndex: 0 };
if (ckpt.phase !== 'discover' || ckpt.people.length) log(`↻ resuming — phase '${ckpt.phase}', ${ckpt.people.length} people, ${ckpt.chunks.length} chunks so far\n`);
const save = () => saveCheckpoint(HERE, ckpt);

const chatMsgs = chats.map((c) => c.doc.messages ?? []);                       // stable refs (mutated in place by applyTokens)
const applyToAll = () => { for (const m of chatMsgs) applyTokens(m, ckpt.people); };
const writeAnon = () => {
  for (const { file, doc } of chats) writeFileSync(join(ANON_DIR, basename(file)), JSON.stringify(doc, null, 2), 'utf8');
  writeFileSync(join(ANON_DIR, 'names-map.json'), JSON.stringify({ people: ckpt.people }, null, 2), 'utf8'); // AUDIT file
};

// ── PASS 1: discover (resumable per window) ────────────────────────────────────────────────────────
if (ckpt.phase === 'discover') {
  log('Pass 1 — anonymise');
  const resume = (ckpt.people.length || ckpt.unit || ckpt.start)
    ? { startUnit: ckpt.unit, startWin: ckpt.start, people: ckpt.people } : undefined;
  ckpt.people = await discoverPeople(ollamaIp, chatMsgs, groups, windowN, log, resume,
    (unit, nextStart, people) => { ckpt.unit = unit; ckpt.start = nextStart; ckpt.people = people; save(); });
  ckpt.phase = 'merge'; ckpt.unit = 0; ckpt.start = 0; save();
}

// ── PASS 1.5: fuzzy + LLM identity merge (atomic — re-runs cleanly if interrupted) ─────────────────
if (ckpt.phase === 'merge') {
  log('Pass 1.5 — entity-merge verification (fuzzy + LLM)');
  await mergePass(ollamaIp, ckpt.people, log);
  ckpt.phase = 'qa'; ckpt.unit = 0; ckpt.start = 0; ckpt.qaRound = 1; ckpt.qaAdded = 0; save();
}

// ── PASS 1.9: QA leak scan — re-read tokenised text, catch misses, re-apply, repeat (resumable) ────
if (ckpt.phase === 'qa') {
  applyToAll();                                    // reproduce tokenised text from raw + current map
  log('Pass 1.9 — QA leak scan');
  for (; ckpt.qaRound <= 5; ckpt.qaRound++) {
    const added = await qaPass(ollamaIp, chatMsgs, ckpt.people, groups, windowN, log,
      { startUnit: ckpt.unit, startWin: ckpt.start }, (unit, nextStart) => { ckpt.unit = unit; ckpt.start = nextStart; save(); });
    ckpt.qaAdded += added;                         // cumulative across a crash mid-round
    if (ckpt.qaAdded === 0) { log(`   QA round ${ckpt.qaRound}: ✓ clean — every name is a token`); break; }
    log(`   QA round ${ckpt.qaRound}: caught ${ckpt.qaAdded} missed name(s) → re-applying`);
    applyToAll();
    ckpt.unit = 0; ckpt.start = 0; ckpt.qaAdded = 0; save();    // reset cursor for next round
    if (ckpt.qaRound === 5) log('   QA hit the 5-round limit — re-run if the last round still found leaks');
  }
  writeAnon();
  const perGroup = groups.map((g) => `${ckpt.people.filter((p) => p.group === g).length} ${g}`).join(' + ');
  log(`  → ${perGroup} mapped → anonymized/\n`);
  ckpt.phase = 'chunk'; ckpt.unit = 0; ckpt.start = 0; ckpt.chunkIndex = 0; ckpt.chunks = []; save();
}

// anonymisation-only mode: we're done once the map is verified and applied
if (args.includes('--no-chunk')) { clearCheckpoint(HERE); log('(--no-chunk: skipping proposition extraction)'); process.exit(0); }

// ── PASS 2: chunk each anonymised chat into propositions (resumable per window, per file) ──────────
if (ckpt.phase === 'chunk') {
  applyToAll(); writeAnon();                        // ensure tokenised docs exist after a resume straight into chunking
  log('Pass 2 — chunk into propositions');
  for (let fi = ckpt.unit; fi < chats.length; fi++) {
    const { file, doc } = chats[fi];
    const id = docId(file);
    log(` ▸ ${basename(file)} (document_id: ${id})`);
    const prior = ckpt.chunks.filter((c) => c.document_id !== id);    // other files' chunks (keep)
    const partial = ckpt.chunks.filter((c) => c.document_id === id);  // this file, produced before a crash
    const resume = { start: fi === ckpt.unit ? ckpt.start : 0, chunkIndex: fi === ckpt.unit ? ckpt.chunkIndex : 0, chunks: partial };
    const fileChunks = await chunkChat(ollamaIp, id, `data/raw/${basename(file)}`, doc.name ?? id, domain, doc.messages ?? [], windowN, log,
      resume, (nextStart, chunkIndex, produced) => {
        ckpt.unit = fi; ckpt.start = nextStart; ckpt.chunkIndex = chunkIndex; ckpt.chunks = [...prior, ...produced]; save();
      });
    ckpt.chunks = [...prior, ...fileChunks]; ckpt.unit = fi + 1; ckpt.start = 0; ckpt.chunkIndex = 0; save();
  }
  ckpt.phase = 'done'; save();
}

// ── PASS 2.5 — ENTITY LINKING: build the mentionedAt back-references and emit PERSON chunks ─────────
// INTENTION: PEOPLE ARE ROUTERS, NOT SEMANTIC CONTENT. Every proposition already lists its `actors`
// (tokens). So DETERMINISTICALLY (no LLM) we collect, per person, the proposition chunk_ids they
// appear in — that is `mentionedAt`. Then we emit one `person` chunk per person: matched by NAME/alias
// (cheap lexical/trigram), it ROUTES into the sense-blobs. This is the entity-linking / graph-RAG layer
// that lets "tell me everything about X" work as a two-hop lookup instead of a fuzzy semantic search.
// (Deterministic + fast → not checkpointed; a resume at phase 'done' simply re-runs it.)
log('\nPass 2.5 — entity linking (mentionedAt + person chunks)');
const propositionChunks = ckpt.chunks.filter((c) => c.chunk_type === 'proposition');
for (const p of ckpt.people) p.mentionedAt = propositionChunks.filter((c) => c.actors.includes(p.token)).map((c) => c.chunk_id);
writeFileSync(join(ANON_DIR, 'names-map.json'), JSON.stringify({ people: ckpt.people }, null, 2), 'utf8'); // re-save with mentionedAt
const personChunks: Chunk[] = ckpt.people.map((p) => ({
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
const allChunks: Chunk[] = [...propositionChunks, ...personChunks];
log(`  → ${personChunks.length} person chunks (each routes to its sense-blobs via mentioned_at)`);

// ── write outputs: chunks.jsonl (the deliverable) + chunks.md (human-readable, to scroll) ──────────
writeFileSync(join(OUT_DIR, 'chunks.jsonl'), allChunks.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
writeFileSync(join(OUT_DIR, 'chunks.md'), renderMarkdown(allChunks), 'utf8');
clearCheckpoint(HERE);                              // success → nothing left to resume
log(`\n✅ ${propositionChunks.length} proposition + ${personChunks.length} person chunks → data/processed/chunks.jsonl + chunks.md`);

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
