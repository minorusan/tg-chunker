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
  resume?: { start: number; chunkIndex: number; chunks: Chunk[] },
  onWindow?: (nextStart: number, chunkIndex: number, chunks: Chunk[]) => void,
): Promise<Chunk[]> {
  // RESUMABLE: continue from a saved window with the chunks already produced for THIS file.
  const chunks: Chunk[] = resume?.chunks ?? [];
  let chunkIndex = resume?.chunkIndex ?? 0;
  let start = resume?.start ?? 0;

  while (start < messages.length) {
    const window = messages.slice(start, start + windowN);
    const end = start + window.length - 1;
    const msgs = window.map((m) => ({ id: m.id, date: m.date ?? '', from: m.from ?? '', text: flatten(m.text) }))
      .filter((m) => m.text.trim() !== ''); // skip media-only / empty messages

    // A window of only empty/media messages → nothing to extract, just advance.
    if (msgs.length === 0) { start += windowN; onWindow?.(start, chunkIndex, chunks); continue; }

    log(`   window msgs ${start + 1}–${end + 1}/${messages.length}`);
    let res: Record<string, unknown>;
    try {
      res = await askJson(ollamaIp, prompts.chunkPropositions({
        WINDOW_START: String(start + 1), WINDOW_END: String(end + 1), MESSAGES: JSON.stringify(msgs, null, 0),
      }), CHUNK_SCHEMA);
    } catch { start += windowN; onWindow?.(start, chunkIndex, chunks); continue; }

    // Tolerant parsing: gemma may name the array `blobs` or `propositions`, and a proposition's text
    // `thought`/`text`, its ids `messageIds`/`message_ids`. Accept them all so we never silently drop work.
    const blobs = (Array.isArray(res.blobs) ? res.blobs : Array.isArray(res.propositions) ? res.propositions : []) as Array<Record<string, unknown>>;
    for (const b of blobs) {
      const thought = String(b.thought ?? b.text ?? '').trim();
      if (!thought) continue;
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      chunks.push({
        chunk_type: 'proposition',
        chunk_id: `${documentId}_${String(chunkIndex).padStart(3, '0')}`, // globally unique
        document_id: documentId,
        source_file: sourceFile,
        chunk_index: chunkIndex,                                          // ordinal within THIS doc
        text: thought,
        title,
        domain,
        document_type: 'telegram_chat',
        language: 'uk-ru',
        actors: arr(b.actors).map(String),
        message_ids: arr(b.messageIds ?? b.message_ids).map(Number).filter((n) => !Number.isNaN(n)),
        timeframe: arr(b.timeframe).map(String),
      });
      log(`     • ${thought.slice(0, 70)}${thought.length > 70 ? '…' : ''}`);
      chunkIndex++;
    }

    // Advance the window. The model's negative offset backs us up to re-read a cut-off thought.
    // We clamp so we ALWAYS move forward by at least one message (no infinite loop).
    const rawOffset = Number(res.abruptionOffset ?? res.abruption_offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.min(0, Math.trunc(rawOffset)) : 0;
    const step = Math.max(1, windowN + offset);
    if (offset < 0) log(`     ↩ abruption: re-reading last ${-offset} message(s) in the next window`);
    start += step;
    onWindow?.(start, chunkIndex, chunks);   // checkpoint: next window + chunks produced so far
  }
  return chunks;
}
