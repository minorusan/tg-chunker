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
 *  replacement built from the caller's group (employee1 / patient3 / goodie2 / …). `group` is one of
 *  the caller-supplied --groupingTags. Written to names-map.json (the audit file). */
export interface Person {
  token: string;
  group: string;            // one of --groupingTags (e.g. "employee", "patient", "goodie"…)
  canonical: string;
  forms: string[];
  // INTENTION: ENTITY LINKING — after Pass 2, every proposition-chunk this person appears in is
  // recorded here, so a person becomes a ROUTER into the sense-blobs ("show me everything about X").
  mentionedAt?: string[];   // chunk_ids of proposition chunks that reference this person
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
 *  metadata; the rest make these chunks useful for a RAG agent.
 *  INTENTION: TWO CHUNK TYPES IN ONE FILE — `proposition` (a "blob of sense") and `person` (an entity
 *  card). They are DIFFERENT DATA and should not be blindly mixed in one vector space; `chunk_type`
 *  lets the retriever namespace/filter them (people matched by name, sense matched semantically). */
export interface Chunk {
  chunk_type: 'proposition' | 'person';
  chunk_id: string;         // globally unique, e.g. "clinic_admin_007" or "person_patient2"
  document_id: string;      // which chat, e.g. "clinic_admin" (person chunks: "_people")
  source_file: string;      // exact file this came from (provenance for citation)
  chunk_index: number;      // 0,1,2… position WITHIN the document (resets per document)
  text: string;             // proposition text, OR a person's profile line
  // --- extra metadata (recommended by the assignment + needed for real retrieval) ---
  title: string;            // the chat title
  domain: string;           // caller-supplied --domain (default "chat")
  document_type: string;    // "telegram_chat"
  language: string;         // detected/declared, e.g. "uk-ru"
  actors: string[];         // tokens involved (patient2, employee1, goodie3…)
  message_ids: number[];    // provenance: which raw messages this proposition came from
  timeframe: string[];      // the message date(s) → recency / "is this still valid?" checks
  // --- person-chunk-only fields (the ENTITY-LINKING layer) ---
  group?: string;           // person chunks: which --groupingTags bucket
  aliases?: string[];       // person chunks: every real→token alias (matched by name, incl. trigram)
  mentioned_at?: string[];  // person chunks: the proposition chunk_ids that mention this person (ROUTER)
}
