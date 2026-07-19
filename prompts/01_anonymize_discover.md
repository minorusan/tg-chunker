<!--
PROMPT 1 — ANONYMIZE / DISCOVER PEOPLE   (audited prompt)
Loop: Pass 1 of the pipeline. Runs once per sliding window of messages.
Job:  find every REAL person in the window and say who is staff vs. a client (patient), listing
      every exact spelling of their name so the code can swap them for stable tokens.
Why an LLM: names appear in messy, declined, nicknamed forms ("Світлана", "Свєта", "Головко" = one
      person). A regex cannot do this coreference; a small local model can.
Placeholders filled in by the code: {{ROSTER}}, {{PEOPLE}}, {{MESSAGES}}
Output is forced to strict JSON by Ollama's `format: "json"`.
-->
You anonymise a Telegram group chat. Identify every REAL PERSON in the messages below and classify each
as **employee** (the clinic's own staff — the chat participants) or **patient** (a client mentioned in
the chat). Do NOT rewrite the messages.

EMPLOYEES — the chat's own participants. Roster (treat anyone matching these as staff):
{{ROSTER}}

DO NOT list (they are not private people): public figures, brands, companies, cities, and obvious
placeholder / example names such as "Vasya Pupkin".

ONE REAL PERSON = ONE ENTRY, but NEVER merge two DIFFERENT people. For each person list in `forms`
every exact spelling of THAT ONE INDIVIDUAL (full name, first name alone, surname alone, and every
declined or diminutive form). Give a `canonical` (fullest real name) and REUSE a canonical from CURRENT
PEOPLE only when it is unmistakably the same individual.

STRICT IDENTITY RULES — do not violate these:
- **Different surname → different people.** Never put two different surnames in one entry.
- **Different gender → different people.** A husband and a wife share a surname but are TWO separate
  people — keep them apart. Judge gender from the given name and from surname endings (masculine
  -ов/-ев/-ський/-ий/-ин vs feminine -ова/-ева/-ська/-іна/-а). If forms disagree on gender, SPLIT them.
- **Same first name is NOT enough to merge.** Two people can both be "Олена". Only merge a bare first
  name / diminutive into an existing person when the context makes it unambiguous that it is THAT
  person. If it could be someone else, start a NEW entry instead of guessing.
- A diminutive belongs to the same person only if it is a diminutive of THAT person's first name and
  the gender matches (e.g. "Свєта" ↔ "Світлана" ✓; "Свєта" ↔ a male "Святослав" ✗).
When in doubt, prefer TWO entries over one wrong merge — a wrongly merged pair is worse than a split.

CURRENT PEOPLE (already discovered — reuse their canonical for coreference):
{{PEOPLE}}

MESSAGES (for reference only — do not echo them back):
{{MESSAGES}}

Return STRICT JSON, nothing else:
{
  "people": [
    { "canonical": "<fullest real name>",
      "class": "employee" | "patient",
      "forms": ["<every exact spelling seen in the text>"] }
  ]
}
If no real people appear, return {"people": []}.
