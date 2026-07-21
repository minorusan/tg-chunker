# tg-chunker — private, LLM-native RAG chunking for messy chat data

> **This tool solves a task that is otherwise impossible without a local LLM: turning a raw, messy
> group chat into a semantically- and internally-coherent, RAG-ready chunk structure that can answer
> broad, generic questions — while keeping the data completely PRIVATE.**
>
> **There are exactly two ways to do this: (1) send the data to a third party (OpenAI / Claude / etc.),
> or (2) run a capable model in-house, like here. There is no third option.** Regex and fixed-size
> splitters cannot understand a conversation; and the moment the data is private (medical, legal, a
> client's business, an HR investigation), option (1) is off the table. That is the entire reason this exists.

RAG course homeworks. **HW1** (this pipeline) prepares the knowledge base; **HW2** ([jump ↓](#homework-2--semantic-retrieval))
adds the semantic retrieval layer on top of it. Instead of a toy dataset, HW1 is a **real, generalist
ingestion pipeline** — feed it *any* Telegram chat export and it produces a privacy-safe, RAG-ready
knowledge base, using nothing but a **local model (Ollama + gemma)**. No cloud, no internet.

**It is domain-agnostic.** Nothing about the tool is tied to any subject. Who counts as "who" is a
runtime parameter (`--groupingTags`); the metadata domain is a parameter (`--domain`). The example
shipped in [`data/raw/`](./data/raw) happens to be a **dental clinic's admin chat**, but that
is just the worked example for grading — point it at a support team, a landlord group, a game guild,
anything.

---

## The generalisation that matters: `--groupingTags`

Anonymisation isn't just "hide names" — it's "replace each person with a stable token that still tells
the retriever *what role they play*". Those roles are **your** call, not the tool's:

```bash
--groupingTags employee,patient      # default → employee1, patient1, patient2 …
--groupingTags staff,client,vendor   # → staff1, client3, vendor2 …
--groupingTags goodies,baddies       # → goodie1, baddie2 …
```

The model sorts every real person into one of the groups you name (the **first** group is the chat's
own participants; everyone else is classified from context). One group, two, or more — the tool
doesn't care. That is what makes it generalist rather than a one-off dental script.

---

## What it does — a two-pass agentic pipeline

Everything the model is told lives in [`/prompts`](./prompts) as plain files, so each prompt can be
**read and audited on its own** (here, a prompt *is* code — it decides what the model does).

### Pass 1 — Anonymise ([`src/anonymize.ts`](./src/anonymize.ts), [prompt](./prompts/01_anonymize_discover.md))
Slides a window over the messages and asks the local model to find every real person, list every
spelling of their name, and sort them into your `--groupingTags`. Because people are written in
declined/nicknamed forms (`Світлана` · `Свєта` · `Головко` = one person), only an LLM can collapse
them — and only an LLM can keep two *different* people apart (a husband and wife share a surname but
are two people; the prompt enforces strict **gender- and surname-aware** identity so they never merge).
The **model only decides**; the **code applies** the swap deterministically (whole-word, Unicode-safe,
so a name is never replaced inside another word). A shared map across all chats means **the same person
is the same token everywhere**. Placeholders like `Vasya Pupkin`, brands and cities are left alone.

### Pass 2 — Chunk into propositions ([`src/chunk.ts`](./src/chunk.ts), [prompt](./prompts/02_chunk_propositions.md))
This is the part a splitter can't do. People write one thought across several messages, and one window
can hold several thoughts. The model reads a window of **N** messages and returns **propositions** —
each a self-contained *fact / rule / situation* ("blob of sense") that stands on its own and could
answer a real question. It also returns an **`abruptionOffset`**: if the last thought is cut off at the
window edge, the model says how far to back up so the next window re-reads it whole — an **LLM-decided
overlap**, smarter than a blind fixed-character overlap.

> **N (window size) is bounded only by how much context the GPU can hold.** A bigger GPU → a bigger N
> → fewer thoughts get clipped → better chunks. (This runs on an RTX 3090; gemma's 65k context lets N
> be generous.)

```
raw chats ──▶ Pass 1: anonymise ──▶ anonymized/*.json + names-map.json (audit)
                                         │
                                         ▼
                              Pass 2: extract propositions ──▶ data/processed/chunks.jsonl + chunks.md
```

Two design decisions that keep it robust:
- **Tolerant JSON, not grammar-constrained.** We call `/api/chat` (proper chat templating), ask for
  JSON in the prompt, and parse it out of the text. We deliberately *avoid* Ollama's grammar-constrained
  JSON/schema mode: it pushes the sampler into a repetition collapse (a decoding artefact, not a model
  limit). The parser tolerates key variants and salvages a truncated tail, so one runaway field never
  drops a whole record. (See the write-up in [`src/ollama.ts`](./src/ollama.ts).)
- **Decide vs. apply.** The model never rewrites a message; it only reports *what* to swap and *what*
  a proposition is. The code does the deterministic edits. That makes the whole run reproducible.

---

## Run it

Requires **Node ≥ 22.6** (runs TypeScript directly — no build) and a local **Ollama** serving
`gemma4:26b`.

```bash
node src/index.ts --sourceDir ./data/raw --ollamaIp 127.0.0.1:11434 \
                  --groupingTags employee,patient --domain clinic_admin --window 12
# or just: npm start
```

Outputs land in [`data/anonymized/`](./data/anonymized) and [`data/processed/`](./data/processed) — **both are committed**, so
you can inspect the results in this repo without running anything (they are safe to publish precisely
because every real person is now a token).

---

## Sources ([`data/raw/`](./data/raw)) — the worked example

Three fabricated Telegram exports (real format, invented content — nothing here is anyone's real data):

| file | chat | why it's here |
|---|---|---|
| `clinic_admin_chat.json` | *Адмінка Клініки* | rules, situations, an **old (2019)** rule to test recency |
| `clinic_reception_chat.json` | *Ресепшн* | reminders + a person who **also appears in chat 1** (cross-chat token consistency) |
| `clinic_scripts_chat.json` | *Скрипти для адмінів* | scripts + a `Vasya Pupkin` placeholder that must **stay** |

Using **three** files (not one) is deliberate — it's what makes `document_id` and `source_file`
meaningful, and it proves a person gets the **same token across different chats**.

---

## Chunk metadata

Each line of `data/processed/chunks.jsonl` is one chunk:

| field | meaning |
|---|---|
| `chunk_id` | **globally unique** — `${document_id}_${chunk_index}`, e.g. `clinic_admin_chat_003` |
| `document_id` | which chat (logical id) — the grouping key |
| `source_file` | the exact file it came from — provenance for citation |
| `chunk_index` | ordinal **within** its document (resets per document) |
| `text` | the proposition — the "blob of sense" |
| `title` | chat title |
| `domain`, `document_type`, `language` | `--domain`, `telegram_chat`, `uk-ru` |
| `actors` | the tokens involved (`patient2`, `employee1`, …) — enables role-centric retrieval |
| `message_ids` | which raw messages this came from — provenance / neighbour lookup |
| `timeframe` | the message date(s) — **cheap, deterministic recency check** ("is this rule still current, or years old?") |

Design note: `actors`, `message_ids` and `timeframe` are extracted so the *easy* questions (who? when?
still valid?) are answered by cheap deterministic fields, and the GPU is spent only on the hard
semantic work. Deterministic-where-possible, semantic-where-needed.

---

## Chunking strategy (summary)

- **Unit:** a *proposition* (self-contained fact/rule/situation), **not** a fixed character count and
  **not** a single message. A lone message ("ок") is noise; a proposition is retrievable knowledge.
- **Window:** N messages (default 12), advanced by `N + abruptionOffset` so cut-off thoughts are
  re-read. Overlap is **decided by the model**, not fixed.
- **Boundaries:** respect meaning — the model splits where the topic changes, so chunks stay
  internally coherent and self-readable.

## Example chunks

Real output from `data/raw/` (see [`data/processed/chunks.jsonl`](./data/processed/chunks.jsonl) and the readable [`data/processed/chunks.md`](./data/processed/chunks.md)).

A **proposition** (a rule, self-contained):
```json
{
  "chunk_type": "proposition",
  "chunk_id": "clinic_admin_chat_001",
  "document_id": "clinic_admin_chat",
  "source_file": "data/raw/clinic_admin_chat.json",
  "chunk_index": 1,
  "text": "Оновлене правило по гігієні: поточна вартість становить 2300 грн, а 1800 грн коштує лише тоді, коли пацієнт на брекетах і процедура проводилася лише з використанням порошка (уточнюйте у лікаря).",
  "title": "Адмінка Клініки",
  "domain": "clinic_admin",
  "document_type": "telegram_chat",
  "language": "uk-ru",
  "actors": [
    "employee1"
  ],
  "message_ids": [
    2,
    3,
    4
  ],
  "timeframe": [
    "2024-02-01T09:00:00",
    "2024-02-01T09:01:00",
    "2024-02-01T09:02:00"
  ]
}
```

A **proposition tied to a person** (note `actors` + `timeframe`):
```json
{
  "chunk_type": "proposition",
  "chunk_id": "clinic_admin_chat_002",
  "document_id": "clinic_admin_chat",
  "source_file": "data/raw/clinic_admin_chat.json",
  "chunk_index": 2,
  "text": "У випадку з patient1, якщо онлайн-консультація затягується понад 30 хвилин (наприклад, тривала годину), проводиться списання 1000 грн; при цьому такі тривалі онлайн-консультації для patient1 більше не беруться.",
  "title": "Адмінка Клініки",
  "domain": "clinic_admin",
  "document_type": "telegram_chat",
  "language": "uk-ru",
  "actors": [
    "employee2",
    "patient1"
  ],
  "message_ids": [
    6,
    7,
    8,
    9
  ],
  "timeframe": [
    "2024-02-03T12:00:00",
    "2024-02-03T12:01:00",
    "2024-02-03T12:02:00",
    "2024-02-03T12:03:00"
  ]
}
```

The **same person in a different chat** — same token, different `source_file`:
```json
{
  "chunk_type": "proposition",
  "chunk_id": "clinic_reception_chat_001",
  "document_id": "clinic_reception_chat",
  "source_file": "data/raw/clinic_reception_chat.json",
  "chunk_index": 1,
  "text": "patient1 досі не оплатила акт за 03.06, employee3 має передзвонити їй ще раз сьогодні.",
  "title": "Ресепшн",
  "domain": "clinic_admin",
  "document_type": "telegram_chat",
  "language": "uk-ru",
  "actors": [
    "patient1",
    "employee3",
    "employee2"
  ],
  "message_ids": [
    3,
    4,
    5
  ],
  "timeframe": [
    "2024-06-01T08:32:00",
    "2024-06-01T08:40:00",
    "2024-06-01T08:41:00"
  ]
}
```

A **person chunk** — the entity-linking router. Matched by an alias, it points at every proposition that mentions her (`mentioned_at`), so "tell me everything about patient1" is a two-hop lookup:
```json
{
  "chunk_type": "person",
  "chunk_id": "person_patient1",
  "document_id": "_people",
  "source_file": "anonymized/names-map.json",
  "chunk_index": 0,
  "text": "patient1 — a patient. Appears in 2 discussion(s).",
  "title": "People",
  "domain": "clinic_admin",
  "document_type": "entity_card",
  "language": "uk-ru",
  "actors": [
    "patient1"
  ],
  "message_ids": [],
  "timeframe": [],
  "group": "patient",
  "aliases": [
    "Світлані Головко",
    "Світлани",
    "Свєту",
    "Світлана Головко",
    "Світлані",
    "Свєті"
  ],
  "mentioned_at": [
    "clinic_admin_chat_002",
    "clinic_reception_chat_001"
  ]
}
```


---

## Review please — idea → code map

Each design idea and where it lives in the code. Every intention is pinned in the source as an
`// INTENTION: …` comment IN CAPS so it reads next to the implementation.

| idea (the *why*) | technique | code (the *what*) |
|---|---|---|
| private prep, no cloud | local LLM only | [`src/ollama.ts`](./src/ollama.ts) — direct Ollama, `--ollamaIp` |
| robust JSON out of an LLM | **`/api/chat` + tolerant parse** (no grammar constraint, `think:false`, salvage truncation) | `askJson` / `parseLoose` in [`src/ollama.ts`](./src/ollama.ts) |
| roles are the caller's, not the tool's | **parameterised grouping** | `--groupingTags` in [`src/index.ts`](./src/index.ts) + [`prompts/01_anonymize_discover.md`](./prompts/01_anonymize_discover.md) |
| keep different people apart | **gender/surname-aware coref** | strict rules in [`prompts/01…`](./prompts/01_anonymize_discover.md) |
| find same-person candidates cheaply | **fuzzy string match** (edit-distance on name tokens) | `fuzzyCandidate` / `mergePass` in [`src/anonymize.ts`](./src/anonymize.ts) · `INTENTION: FUZZY STRING PROPOSES` |
| "is this the same person?" is semantic | **LLM verify** each candidate (gender/surname strict) | `mergePass` + [`prompts/03_merge_verify.md`](./prompts/03_merge_verify.md) · `INTENTION: FUZZY STRING PROPOSES, LLM DISPOSES` |
| don't guess an ambiguous name | **ambiguity-safe apply** | `buildPairs()` in [`src/anonymize.ts`](./src/anonymize.ts) · `INTENTION: AMBIGUITY-SAFE` |
| self-contained knowledge units | **proposition-based chunking** | `chunkChat()` in [`src/chunk.ts`](./src/chunk.ts) + [`prompts/02…`](./prompts/02_chunk_propositions.md) |
| model-decided overlap | **`abruptionOffset`** | window loop in [`src/chunk.ts`](./src/chunk.ts) |
| people vs sense are different data | **`chunk_type` namespacing** | `Chunk.chunk_type` in [`src/types.ts`](./src/types.ts) · `INTENTION: TWO CHUNK TYPES` |
| "tell me everything about X" | **entity linking / graph-RAG** — person chunks as routers | Pass 2.5 in [`src/index.ts`](./src/index.ts) · `INTENTION: PEOPLE ARE ROUTERS` — `mentioned_at` back-refs |
| recency / "still valid?" | **temporal metadata** | `timeframe` in [`src/chunk.ts`](./src/chunk.ts) |

---

## Reflection — what went well, what to improve

**Went well**
- The anonymiser collapses declined/nicknamed spellings into one token, keeps it consistent across
  files, and (with the strict identity rules) keeps different people apart — coreference a regex could
  never do.
- Making the roles a parameter (`--groupingTags`) turned a one-off script into a generalist tool.
- Propositions are genuinely self-contained; deterministic metadata (dates, ids) makes recency/
  provenance free.

**To improve (honest limitations)**
- **Coref/identity is not perfect.** On large, messy chats the model occasionally splits one person
  into two tokens, or (before the gender/surname rules) merged a wife into a husband. A dedicated
  entity-merge verification pass (short, strict per-pair model calls) is the next step for very large
  inputs.
- **Proposition granularity is a judgement call** — the model sometimes merges two related rules or
  splits one. Human review of the chunk output is still worth it.
- **We tried vector-clustered merge and it didn't work here — worth writing down.** The idea (embed
  each person, cluster near-neighbours, LLM-verify) is sound, but the local embedder (`nomic-embed-text`)
  can't resolve names: bare names all sit at ~cosine 1.0, and adding context just adds domain-homogeneous
  noise (in a clinic chat everyone's context is "clinic stuff"), so no threshold separates people. The
  *actual* duplicates in real data are orthographic (`Пискуновська`/`Піскуновська`, declensions), which
  cheap **edit-distance** catches directly — so the merge nominates candidates by fuzzy string match and
  lets the LLM adjudicate. A stronger embedder might revive the vector approach for nickname↔formal cases.
- **Local trade-off:** a local 26B model is weaker than a frontier API at this — but it is the *only*
  option when the data cannot leave the building. That trade is the entire point.

---

# Homework #2 — semantic retrieval

HW1 gave us the chunks. HW2 makes them **searchable by meaning**: embed every chunk, store the vectors,
and answer a natural-language question by returning the top-k closest chunks. Same principle as HW1 —
**everything runs on the local box**, no cloud.

## The pieces

| step | file | what it does |
|---|---|---|
| embeddings core | [`src/embed.ts`](./src/embed.ts) | `embedDocuments` / `embedQuery` (local `nomic-embed-text`), `cosine`, brute-force `topK` |
| build the index | [`scripts/build-index.ts`](./scripts/build-index.ts) | embeds every chunk in `data/processed/chunks.jsonl` → saves `index/index.json` |
| search | [`scripts/retrieve.ts`](./scripts/retrieve.ts) | embeds a query, cosine-scores it against all vectors, prints top-k with metadata |
| the examples | [`scripts/run-examples.ts`](./scripts/run-examples.ts) | runs 8 test queries → [`outputs/retrieval_examples.md`](./outputs/retrieval_examples.md) |

```bash
npm run build-index                                  # → index/index.json (18 vectors, dim 768)
npm run retrieve -- "скільки коштує гігієна на брекетах?"   # → top-3 with score + source
npm run examples                                     # → outputs/retrieval_examples.md
```

## Choices, and why

- **Embedding model: `nomic-embed-text` (local).** A retrieval-native model — exactly the job here
  (topic-similarity), and the same model embeds both chunks and queries. It is **asymmetric**: chunks
  get a `search_document:` prefix, queries a `search_query:` prefix, so a short question lands near the
  long passage that answers it. (Aside: we first tried this embedder to *merge names* in HW1 and it
  failed — it can't tell "Саша" from "Александр". That was the wrong job for it; **this** is the right one.)
- **Vector store: a plain saved matrix (`index/index.json`), searched by brute-force cosine.** The rubric
  allows a "NumPy matrix" as an alternative to FAISS; this is that, in Node. For 18 chunks (or a few
  thousand) exact brute-force is **instant** and has zero approximation error — FAISS's ANN index would
  be pure overhead at this scale. The trade would flip in the millions; then swap in FAISS/HNSW.
- **We index both chunk types.** Proposition chunks are embedded on their text; person chunks on their
  text + aliases. This is HW1's two-index idea carried through — sense matched by meaning, people by name.

## Results & analysis

Full run of 8 queries with per-query relevance comments and a conclusion:
**[`outputs/retrieval_examples.md`](./outputs/retrieval_examples.md)**. In short:

- **Works well** on distinctive factual questions (implant-price-on-phone → 0.822, exact hit) and on
  "tell me about *person X*" (surfaces her facts from **two different chats** — the anonymization payoff).
- **Weak spots, honestly:** nomic leans partly lexical, so keyword-overlap chunks ("вартість"/"грн")
  intrude; scores cluster in a tight 0.72–0.83 band, so ranking is fragile (one query put the right
  chunk at #2, beaten by **0.001**); very short chunks embed weakly. **Next step:** a hybrid
  lexical+vector retriever with rank fusion + a cross-encoder reranker over the top-k.

## HW2 idea → code map

| idea (the *why*) | technique | code (the *what*) |
|---|---|---|
| search by meaning, offline | **local embeddings** | `embedDocuments`/`embedQuery` in [`src/embed.ts`](./src/embed.ts) |
| question ↔ passage matching | **asymmetric prefixes** (`search_query:` / `search_document:`) | [`src/embed.ts`](./src/embed.ts) |
| store vectors | **saved matrix** (rubric's NumPy-matrix option) | [`scripts/build-index.ts`](./scripts/build-index.ts) → `index/index.json` |
| top-k semantic search | **brute-force cosine** (exact, no ANN needed at this scale) | `cosine`/`topK` in [`src/embed.ts`](./src/embed.ts) |
| results carry provenance | **metadata in every hit** (chunk_id, score, source_file, document_id, type) | `retrieve()` in [`scripts/retrieve.ts`](./scripts/retrieve.ts) |
| people found by name, sense by meaning | **index both chunk types** | `textOf` in [`scripts/build-index.ts`](./scripts/build-index.ts) |
