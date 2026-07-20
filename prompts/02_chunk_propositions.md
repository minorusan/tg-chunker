<!--
PROMPT 2 — CHUNK / EXTRACT PROPOSITIONS ("blobs of sense")   (audited prompt)
Loop: Pass 2 of the pipeline. Runs over the ALREADY-ANONYMISED chat, one sliding window at a time.
Job:  people write in fragments; a single coherent thought is often spread across several messages,
      and one window can contain more than one thought (and a thought can be cut off at the window
      edge). The model groups messages into self-contained "propositions" — each a fact / rule /
      situation that stands on its own and could answer a real question.
Why an LLM: coherence and topic boundaries are semantic, not mechanical. This is the "generalist"
      knowledge-extraction step — the reason we prepare data with an in-house model instead of a
      dumb splitter.
abruptionOffset: if the LAST thought in the window is clearly cut off (continues past the window),
      the model returns a NEGATIVE offset so the next window backs up and re-reads those messages —
      an LLM-decided overlap instead of a blind fixed one.
Placeholders filled by the code: {{WINDOW_START}}, {{WINDOW_END}}, {{MESSAGES}}
Output forced to strict JSON by Ollama's `format: "json"`.
-->
These Telegram messages are already anonymised (people are tokens like `employee1`, `patient2`). The
authors write in short fragments, so one coherent thought is usually spread over several messages, and
this window may contain more than one thought.

Group the messages into **propositions** — each a SELF-CONTAINED unit of meaning (a rule, a fact, a
situation, a decision, a protocol) that reads on its own and could answer a real question later. Rewrite
each as one clear standalone statement; keep the tokens (`patientN`, `employeeN`) exactly as they are.
Write each proposition in the SAME LANGUAGE as the source messages (do NOT translate to English) —
fidelity to the original wording matters for a knowledge base.

Rules:
- A proposition may span several messages — list their ids in `messageIds`.
- One window can yield several propositions. Split where the topic clearly changes.
- If the LAST proposition is clearly cut off (it continues into messages after this window), set
  `abruptionOffset` to a small NEGATIVE number = how many messages to re-read in the next window so
  that thought is captured whole. If nothing is cut off, use 0.
- `actors` = the tokens involved (e.g. ["patient2","employee1"]). `timeframe` = the date(s) of the
  messages this proposition came from (copy them verbatim, for "is this still current?" checks).

Window: messages {{WINDOW_START}}–{{WINDOW_END}}.
MESSAGES (id, date, from, text):
{{MESSAGES}}

Return STRICT JSON, nothing else:
{
  "blobs": [
    { "messageIds": [<int>, ...],
      "thought": "<the proposition as one clear standalone statement>",
      "actors": ["<token>", ...],
      "timeframe": ["<date>", ...] }
  ],
  "abruptionOffset": <0 or a small negative int>
}
If there is no real content (only greetings/acks), return {"blobs": [], "abruptionOffset": 0}.
