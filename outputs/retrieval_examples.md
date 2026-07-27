# HW2 — semantic retrieval examples

**Embedding model:** `nomic-embed-text` (local, Ollama), same model for chunks and queries, with nomic's
`search_document:` / `search_query:` prefixes.
**Vector store:** brute-force cosine over a saved matrix (`index/index.json`) — exact, instant for 18 chunks.
**k = 3.** Corpus: 18 chunks (12 propositions + 6 person cards) from the anonymized dental-clinic KB.

Queries are in the KB's language (uk/ru). Comments written after inspecting the actual results.

---

**Query:** скільки коштує гігієна для пацієнта на брекетах?

Top-1: `clinic_scripts_chat_000` | score: 0.787 | proposition
  Text: Скрипт відповіді на питання про ціну гігієни: '…Поточна гігієна 2300 грн, а на брекетах порошком — 1800 грн.'
  Source: data/raw/clinic_scripts_chat.json
Top-2: `clinic_admin_chat_001` | score: 0.741 | proposition
  Text: Оновлене правило по гігієні: 2300 грн, а 1800 грн діє лише коли пацієнт на брекетах і тільки після обробки порошком.
  Source: data/raw/clinic_admin_chat.json
Top-3: `clinic_admin_chat_003` | score: 0.677 | proposition
  Text: Важливий нюанс по імплантах: у технічну вартість входить ще вартість платформи.
  Source: data/raw/clinic_admin_chat.json

Comment: **Relevant.** Top-1 and Top-2 both answer it (the script and the underlying rule); Top-2 is the precise rule. Top-3 is a false neighbour — pulled by "вартість" keyword overlap, not meaning.

---

**Query:** коли гігієна коштує 1800 грн?

Top-1: `clinic_scripts_chat_000` | score: 0.790 | proposition — the price script
Top-2: `clinic_admin_chat_001` | score: 0.787 | proposition — "1800 грн лише на брекетах, порошком"
Top-3: `clinic_admin_chat_002` | score: 0.695 | proposition — patient1 situation (a "1000 грн" write-off)

Comment: **Relevant.** Top-2 is exactly the answer (nearly tied with Top-1). Top-3 is **not relevant** — retrieved on the "грн/ціна" keyword, not the condition being asked about.

---

**Query:** чи можна називати ціну імпланта по телефону?

Top-1: `clinic_scripts_chat_001` | score: 0.822 | proposition — "Ніколи не називайте ціну імпланта по телефону — тільки на очній консультації."
Top-2: `clinic_admin_chat_003` | score: 0.760 | proposition — implant platform cost
Top-3: `clinic_admin_chat_005` | score: 0.736 | proposition — phone-consultation policy

Comment: **Highly relevant.** Top-1 is a perfect hit (0.822, the highest score in the whole set). Top-2/3 are partially relevant — same implant/phone themes. Best-case behaviour.

---

**Query:** що входить у вартість для пацієнтів з імплантами?

Top-1: `clinic_admin_chat_003` | score: 0.828 | proposition — "у технічну вартість входить ще вартість платформи"
Top-2: `clinic_scripts_chat_000` | score: 0.756 | proposition — price script
Top-3: `clinic_admin_chat_005` | score: 0.738 | proposition — phone policy

Comment: **Relevant.** Top-1 is the exact answer (0.828). Top-2/3 are weak keyword neighbours ("вартість"/"ціна"). Strong top-1, noisy tail.

---

**Query:** яка знижка для пенсіонерів?

Top-1: `clinic_admin_chat_000` | score: 0.735 | proposition — "пенсіонерам знижка 5% на гігієну"
Top-2: `clinic_admin_chat_003` | score: 0.734 | proposition — implant platform cost
Top-3: `clinic_scripts_chat_000` | score: 0.723 | proposition — price script

Comment: **Partially relevant.** Top-1 IS correct — but the margin is tiny (0.735 vs 0.734 vs 0.723), so the pensioner rule barely wins. It's a *short* chunk, which embeds weakly, so the signal is thin. A good example of where retrieval is shaky.

---

**Query:** як діяти якщо пацієнт тисне на ціну?

Top-1: `clinic_scripts_chat_000` | score: 0.781 | proposition — price script
Top-2: `clinic_scripts_chat_002` | score: 0.773 | proposition — "Якщо пацієнт тисне на ціну — записуйте на безкоштовний огляд."
Top-3: `clinic_admin_chat_003` | score: 0.752 | proposition — implant cost

Comment: **Relevant.** Top-2 is the exact answer; Top-1 is closely related (both scripts). Top-3 not relevant.

---

**Query:** розкажи все про patient1

Top-1: `clinic_reception_chat_001` | score: 0.766 | proposition — "patient1 досі не оплатила акт за 03.06"
Top-2: `clinic_admin_chat_002` | score: 0.763 | proposition — patient1's online-consult situation
Top-3: `clinic_reception_chat_002` | score: 0.718 | proposition — patient3 (different person)

Comment: **Relevant** for a "tell me about X" query — Top-1 and Top-2 are the two facts about patient1, pulled from **different chats** (the shared-token design paying off). Top-3 is patient3, a false neighbour (similar structure). Notable: the **person-router chunk** (`person_patient1`) did NOT win here — the propositions about her ranked higher. Lesson: person chunks are better used via their `mentioned_at` back-references (a deterministic lookup) than via semantic search.

---

**Query:** яка політика щодо телефонних консультацій?

Top-1: `clinic_admin_chat_003` | score: 0.750 | proposition — implant platform cost (WRONG)
Top-2: `clinic_admin_chat_005` | score: 0.749 | proposition — "Політика по телефонним консультаціям: …" (the answer)
Top-3: `clinic_scripts_chat_000` | score: 0.719 | proposition — price script

Comment: **Partially relevant — a ranking miss.** The correct chunk (Top-2) is edged out by an irrelevant implant chunk by **0.001**. This is the clearest failure: with tiny score margins, the right answer can land at #2. A reranker or hybrid keyword+vector step would fix it.

---

## Conclusion — where retrieval works, where it doesn't

**Works well:**
- **Direct factual questions with distinctive wording** — implant-price-on-phone (0.822) and implant-billing (0.828) are near-perfect: one dominant chunk, clear margin.
- **"Tell me about X" (a person)** — surfaces the right facts about `patient1` from *two different chats*, which is exactly what the shared-token anonymization + proposition design was for.
- **Cross-lingual robustness** — queries and chunks mix Ukrainian/Russian and it still matches.

**Where it's weak:**
- **Keyword-overlap false neighbours.** "вартість" / "грн" / "ціна" repeatedly drag in the implant-cost or price-script chunk even when the topic differs. nomic leans partly lexical.
- **Tiny margins → ranking errors.** The phone-policy query put the *wrong* chunk at Top-1 by 0.001. Scores cluster in a narrow 0.72–0.83 band, so ranking is fragile.
- **Short chunks embed weakly.** The one-line pensioner rule barely won its own query (0.735 vs 0.734). Very short propositions carry little signal.
- **Person-router chunks lose at semantic search.** Their text is thin; they're designed to be reached by *name* (lexical / `mentioned_at`), not by cosine — confirmed here.

**What would improve it (next step):** a **hybrid retriever** — combine this vector search with a lexical/BM25 or trigram pass and fuse the rankings (RRF), plus a cross-encoder reranker over the top-k. That directly addresses the two real failure modes (keyword false-neighbours winning, and 0.001 margin flips).
