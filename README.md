# tg-chunker — private, LLM-native RAG chunking for messy chat data

> **This tool solves a task that is otherwise impossible without a local LLM: turning a raw, messy
> group chat into a semantically- and internally-coherent, RAG-ready chunk structure that can answer
> broad, generic questions — while keeping the data completely PRIVATE.**
>
> **There are exactly two ways to do this: (1) send the data to a third party (OpenAI / Claude / etc.),
> or (2) run a capable model in-house, like here. There is no third option.** Regex and fixed-size
> splitters cannot understand a conversation; and the moment the data is private (medical, legal, a
> client's business), option (1) is off the table. That is the entire reason this exists.

Homework #1 for the RAG course: prepare a knowledge base. Instead of a toy dataset, this is a **real,
generalist ingestion pipeline** — feed it any Telegram chat export and it produces a privacy-safe,
RAG-ready knowledge base, using nothing but a **local model (Ollama + gemma)**. No cloud, no internet.

---

## Subject area

**A dental clinic's internal admin chat → a knowledge base for a support/ops RAG agent.**

Real clinics run on Telegram: staff argue out pricing rules, flag problem patients, write scripts,
record "here's what we do when X". That knowledge is gold for an assistant ("how much is a hygiene
cleaning for a braces patient?", "what's our policy on phone consultations?", "is the pensioner
discount still a thing?") — but it is drowning in fragments, small talk, and **real patient names**.

The pipeline turns that raw chat into clean, cited, anonymised knowledge chunks.

---

## What it does — a two-pass agentic pipeline

Everything the model is told lives in [`/prompts`](./prompts) as plain files, so each prompt can be
**read and audited on its own** (here, a prompt *is* code — it decides what the model does).

### Pass 1 — Anonymise ([`src/anonymize.ts`](./src/anonymize.ts), [prompt](./prompts/01_anonymize_discover.md))
Slides a window over the messages and asks the local model to find every real person and say who is
**staff** vs. a **patient**, listing every spelling of their name. Because people are written in
declined/nicknamed forms (`Світлана` · `Свєта` · `Головко` = one person), only an LLM can collapse
them. The **model only decides**; the **code applies** the swap deterministically (whole-word, so a
name is never replaced inside another word) — real people become stable tokens (`employee1`,
`patient1`, `patient2`…). A shared map across all chats means **the same person is the same token
everywhere**. Placeholders like `Vasya Pupkin`, brands and cities are left alone.

### Pass 2 — Chunk into propositions ([`src/chunk.ts`](./src/chunk.ts), [prompt](./prompts/02_chunk_propositions.md))
This is the part a splitter can't do. People write one thought across several messages, and one window
can hold several thoughts. The model reads a window of **N** messages and returns **propositions** —
each a self-contained *fact / rule / situation* ("blob of sense") that stands on its own and could
answer a real question. It also returns an **`abruptionOffset`**: if the last thought is cut off at the
window edge, the model says how far to back up so the next window re-reads it whole — an **LLM-decided
overlap**, smarter than a blind fixed-character overlap.

> **N (window size) is bounded only by how much context the GPU can hold.** A bigger GPU → a bigger N
> → fewer thoughts get clipped → better chunks. (This whole project runs on an RTX 3090; gemma's 65k
> context lets N be generous.)

```
raw chats ──▶ Pass 1: anonymise ──▶ anonymized/*.json + names-map.json (audit)
                                         │
                                         ▼
                              Pass 2: extract propositions ──▶ output/chunks.jsonl + chunks.md
```

---

## Run it

Requires **Node ≥ 22.6** (runs TypeScript directly, no build) and a local **Ollama** serving
`gemma4:26b`.

```bash
node src/index.ts --sourceDir ./sample_input --ollamaIp 127.0.0.1:11434 --window 12
# or: npm start
```

Outputs land in [`anonymized/`](./anonymized) and [`output/`](./output) — **both are committed**, so
you can inspect the results in this repo without running anything (they are safe to publish precisely
because every real person is now a token).

---

## Sources ([`sample_input/`](./sample_input))

Three fabricated Telegram exports of a dental clinic (real format, invented content — so nothing here
is anyone's actual data):

| file | chat | why it's here |
|---|---|---|
| `clinic_admin_chat.json` | *Адмінка Клініки* | rules, situations, an **old (2019)** rule to test recency |
| `clinic_reception_chat.json` | *Ресепшн* | reminders + a patient who **also appears in chat 1** (cross-chat token consistency) |
| `clinic_scripts_chat.json` | *Скрипти для адмінів* | talking scripts + a `Vasya Pupkin` placeholder that must **stay** |

Using **three** files (not one) is deliberate — it's what makes `document_id` and `source_file`
meaningful, and it proves a patient gets the **same token across different chats**.

---

## Chunk metadata

Each line of `output/chunks.jsonl` is one chunk:

| field | meaning |
|---|---|
| `chunk_id` | **globally unique** id — `${document_id}_${chunk_index}`, e.g. `clinic_admin_003` |
| `document_id` | which chat (logical id) — the grouping key |
| `source_file` | the exact file it came from — provenance for citation |
| `chunk_index` | ordinal **within** its document (resets per document) |
| `text` | the proposition — the "blob of sense" |
| `title` | chat title |
| `domain`, `document_type`, `language` | `dental_clinic_admin`, `telegram_chat`, `uk-ru` |
| `actors` | the tokens involved (`patient2`, `employee1`) — enables patient-centric retrieval |
| `message_ids` | which raw messages this came from — provenance / neighbour lookup |
| `timeframe` | the message date(s) — **cheap, deterministic recency check** ("is this rule still current, or 5 years old?") |

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

<!-- EXAMPLES_PLACEHOLDER -->

---

## Reflection — what went well, what to improve

**Went well**
- The anonymiser collapses declined/nicknamed spellings into one token and keeps it consistent across
  files — coreference a regex could never do.
- Propositions are genuinely self-contained: each answers a question without needing its neighbours.
- Deterministic metadata (dates, ids) makes recency/provenance free.

**To improve (honest limitations)**
- **Coref is not perfect.** On large chats the model occasionally splits one person into two tokens or
  misses a spelling; the production version of this pipeline adds a consolidation + QA pass that
  re-scans the output for any real name that isn't a token. (Left out here to keep the loop readable.)
- **Proposition granularity is a judgement call** — the model sometimes merges two related rules or
  splits one. Human review of the chunk output is still worth it.
- **Inlined context vs. embedding:** patient bios could be inlined into chunks for self-contained
  citation, but inlining them into the *embedded* text can dilute a rule's meaning — a real trade-off
  to tune per retriever.
- **Small model, local trade-off:** a 26B local model is weaker than GPT-4/Claude at this — but it is
  the *only* option when the data cannot leave the building. That trade is the entire point.
