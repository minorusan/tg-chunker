<!--
PROMPT 3 — ENTITY-MERGE VERIFICATION   (audited prompt)
Loop: Pass 1.5 of the pipeline. Runs AFTER discovery, once per candidate pair of people.
Job:  decide whether two discovered "people" are actually the SAME individual.
WHY THIS IS A SEPARATE LLM CALL (read this — it is the whole point):
  Deciding "is Свєта the same person as Світлана Головко, but NOT the same as her husband Петро
  Головко?" is a HARD SEMANTIC judgement about gender, surname and diminutives. String overlap gets
  it wrong (they share the surname "Головко") — it would merge a wife into her husband. So merging is
  an LLM decision, made pairwise under strict rules, never a string match.
Placeholders filled by the code: {{A}}, {{B}}
Output shape forced by a JSON schema (Ollama structured outputs).
-->
Two candidate people were extracted from the same chat. Decide if they are the SAME real individual.

Person A: {{A}}
Person B: {{B}}

Answer SAME only if they are unmistakably ONE individual — for example one name is a diminutive, first
name, or surname of the other, of the SAME person.

Answer DIFFERENT (this is the safe default) if ANY of these hold:
- Different surname.
- Different gender (judge from the given name and surname endings: masculine -ов/-ев/-ський/-ий/-ин vs
  feminine -ова/-ева/-ська/-іна/-а). A husband and wife share a surname but are DIFFERENT people.
- They merely share a common first name — two different people can both be "Олена".
- You are not sure.

Return STRICT JSON:
{ "same": true | false, "reason": "<one short clause>" }
