<!--
PROMPT 1 — ANONYMISE / DISCOVER PEOPLE   (audited prompt)
Loop: Pass 1 of the pipeline. Runs once per sliding window of messages.
Job:  find every REAL person in the window, list every exact spelling of their name, and sort each
      into one of the caller's GROUPS (--groupingTags, e.g. employee,patient — but the tool is generic:
      it could be goodies,baddies or any set the caller supplies).
Why an LLM: names appear in messy, declined, nicknamed forms ("Світлана","Свєта","Головко" = one
      person). Regex cannot do this coreference, nor can it decide which group a person belongs to.
Placeholders filled by the code: {{GROUPS}}, {{GROUP0}}, {{PEOPLE}}, {{MESSAGES}}
Output shape is forced by a JSON schema (Ollama structured outputs), so the keys are always exact.
-->
You anonymise a group chat. Identify every REAL PERSON in the messages below, list every spelling of
their name, and sort each into exactly ONE of these groups:

  {{GROUPS}}

The first group, "{{GROUP0}}", is the chat's own PARTICIPANTS (the people writing). Anyone who only
appears MENTIONED in the messages belongs to one of the other groups — decide which from the meaning of
the group name and the context. (If there is only one group, everyone goes there.)

DO NOT list (they are not private people to be tokenised): public figures, brands, companies, cities,
and obvious placeholder / example names such as "Vasya Pupkin".

ONE REAL PERSON = ONE ENTRY, but NEVER merge two DIFFERENT people. For each person list in `forms` every
exact spelling of THAT ONE INDIVIDUAL (full name, first name alone, surname alone, and every declined or
diminutive form). Give a `canonical` (fullest real name) and REUSE a canonical from CURRENT PEOPLE only
when it is unmistakably the same individual.

STRICT IDENTITY RULES — do not violate these:
- **Different surname → different people.** Never put two different surnames in one entry.
- **Different gender → different people.** A husband and a wife share a surname but are TWO separate
  people — keep them apart. Judge gender from the given name and surname endings (masculine
  -ов/-ев/-ський/-ий/-ин vs feminine -ова/-ева/-ська/-іна/-а). If forms disagree on gender, SPLIT them.
- **Same first name is NOT enough to merge.** Two people can both be "Олена". Only merge a bare first
  name / diminutive into an existing person when context makes it unambiguous it is THAT person.
- A diminutive belongs to the same person only if it is a diminutive of THAT person's first name and the
  gender matches (e.g. "Свєта" ↔ "Світлана" ✓; "Свєта" ↔ a male "Святослав" ✗).
When in doubt, prefer TWO entries over one wrong merge — a wrong merge is worse than a split.

CURRENT PEOPLE (already discovered — reuse their canonical for coreference):
{{PEOPLE}}

MESSAGES (for reference only — do not echo them back):
{{MESSAGES}}

Return STRICT JSON:
{
  "people": [
    { "canonical": "<fullest real name>",
      "group": "<one of: {{GROUPS}}>",
      "forms": ["<every exact spelling seen in the text>"] }
  ]
}
If no real people appear, return {"people": []}.
