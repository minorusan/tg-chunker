// PASS 2 — CHUNK INTO PROPOSITIONS ("blobs of sense").
// This is the interesting loop. People write in fragments, so one coherent thought is smeared across
// several messages, and a window can hold several thoughts (and a thought can be cut off at the edge).
// The model reads a WINDOW of N messages and returns the propositions it sees + an `abruptionOffset`:
// if the last thought is cut off, it tells us how far to back up so the NEXT window re-reads it whole.
// That is an LLM-DECIDED overlap — smarter than a blind fixed overlap, and the reason we can afford a
// big window (N is bounded only by how much context the GPU can hold — bigger GPU → bigger N → fewer
// thoughts get clipped).

import type { TgMessage, Chunk, ChunkWindowResult } from './types.ts';
import { prompts } from './prompts.ts';
import { askJson } from './ollama.ts';

const flatten = (t: TgMessage['text']): string =>
  typeof t === 'string' ? t : Array.isArray(t) ? t.map((r) => (typeof r === 'string' ? r : r.text ?? '')).join('') : '';

// Schema so gemma returns exactly {blobs:[{messageIds,thought,actors,timeframe}],abruptionOffset}
// (plain json-mode let it rename keys → we got 0 blobs).
const CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    blobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          messageIds: { type: 'array', items: { type: 'integer' } },
          thought: { type: 'string' },
          actors: { type: 'array', items: { type: 'string' } },
          timeframe: { type: 'array', items: { type: 'string' } },
        },
        required: ['messageIds', 'thought', 'actors', 'timeframe'],
      },
    },
    abruptionOffset: { type: 'integer' },
  },
  required: ['blobs', 'abruptionOffset'],
};

/**
 * Extract propositions from one anonymised chat.
 * @param documentId  stable logical id of this chat ("clinic_admin")
 * @param sourceFile  the exact file it came from (provenance for citation)
 * @param title       the chat title
 * @param windowN     window size — "N regulated by how much GPU you have" :)
 */
export async function chunkChat(
  ollamaIp: string, documentId: string, sourceFile: string, title: string, domain: string,
  messages: TgMessage[], windowN: number, log: (s: string) => void,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  let start = 0;

  while (start < messages.length) {
    const window = messages.slice(start, start + windowN);
    const end = start + window.length - 1;
    const msgs = window.map((m) => ({ id: m.id, date: m.date ?? '', from: m.from ?? '', text: flatten(m.text) }))
      .filter((m) => m.text.trim() !== ''); // skip media-only / empty messages

    // A window of only empty/media messages → nothing to extract, just advance.
    if (msgs.length === 0) { start += windowN; continue; }

    log(`   window msgs ${start + 1}–${end + 1}/${messages.length}`);
    let res: ChunkWindowResult;
    try {
      res = await askJson(ollamaIp, prompts.chunkPropositions({
        WINDOW_START: String(start + 1), WINDOW_END: String(end + 1), MESSAGES: JSON.stringify(msgs, null, 0),
      }), CHUNK_SCHEMA);
    } catch { start += windowN; continue; }

    for (const b of res.blobs ?? []) {
      if (!b.thought || !b.thought.trim()) continue;
      chunks.push({
        chunk_id: `${documentId}_${String(chunkIndex).padStart(3, '0')}`, // globally unique
        document_id: documentId,
        source_file: sourceFile,
        chunk_index: chunkIndex,                                          // ordinal within THIS doc
        text: b.thought.trim(),
        title,
        domain,
        document_type: 'telegram_chat',
        language: 'uk-ru',
        actors: Array.isArray(b.actors) ? b.actors : [],
        message_ids: Array.isArray(b.messageIds) ? b.messageIds : [],
        timeframe: Array.isArray(b.timeframe) ? b.timeframe : [],
      });
      log(`     • ${b.thought.trim().slice(0, 70)}${b.thought.length > 70 ? '…' : ''}`);
      chunkIndex++;
    }

    // Advance the window. The model's negative offset backs us up to re-read a cut-off thought.
    // We clamp so we ALWAYS move forward by at least one message (no infinite loop).
    const offset = Number.isFinite(res.abruptionOffset) ? Math.min(0, Math.trunc(res.abruptionOffset)) : 0;
    const step = Math.max(1, windowN + offset);
    if (offset < 0) log(`     ↩ abruption: re-reading last ${-offset} message(s) in the next window`);
    start += step;
  }
  return chunks;
}
