// Shared types for the pipeline. Kept in one place so the data shapes are easy to audit.

/** One message inside a Telegram export (`result.json`). Telegram uses many optional fields; we only
 *  type the ones we touch. `text` is either a plain string or an array of "runs" (bold/link/plain…). */
export interface TgMessage {
  id: number;
  type?: string;
  date?: string;            // "2024-02-01T14:09:00"
  from?: string;            // sender display name (a real person → gets tokenised)
  from_id?: string;
  actor?: string;           // for service messages ("X added Y")
  forwarded_from?: string;
  text: string | Array<string | { type?: string; text?: string }>;
  text_entities?: unknown;
  [k: string]: unknown;     // keep everything else untouched
}

/** A Telegram export file. */
export interface TgExport {
  name?: string;            // chat title (NOT a person — safe to keep)
  type?: string;
  id?: number;
  messages: TgMessage[];
  [k: string]: unknown;
}

/** One real person in the anonymisation map. `forms` = every spelling seen; `token` = the stable
 *  replacement (employee1 / patient3). Written to names-map.json (the audit file). */
export interface Person {
  token: string;
  class: 'employee' | 'patient';
  canonical: string;
  forms: string[];
}

/** What the chunking model returns for one window. */
export interface Blob {
  messageIds: number[];
  thought: string;
  actors: string[];
  timeframe: string[];
}
export interface ChunkWindowResult {
  blobs: Blob[];
  abruptionOffset: number;  // 0, or a small negative int (LLM-decided overlap for the next window)
}

/** One final chunk row written to chunks.jsonl. The first five fields are the assignment's required
 *  metadata; the rest are what makes these chunks actually useful for a RAG agent. */
export interface Chunk {
  chunk_id: string;         // globally unique, e.g. "clinic_admin_007"
  document_id: string;      // which chat, e.g. "clinic_admin"
  source_file: string;      // exact file this came from (provenance for citation)
  chunk_index: number;      // 0,1,2… position WITHIN the document (resets per document)
  text: string;             // the proposition — the "blob of sense"
  // --- extra metadata (recommended by the assignment + needed for real retrieval) ---
  title: string;            // the chat title
  domain: string;           // "dental_clinic_admin"
  document_type: string;    // "telegram_chat"
  language: string;         // "uk"/"ru" (mixed) → "uk-ru"
  actors: string[];         // tokens involved (patient2, employee1…)
  message_ids: number[];    // provenance: which raw messages this proposition came from
  timeframe: string[];      // the message date(s) → recency / "is this still valid?" checks
}
