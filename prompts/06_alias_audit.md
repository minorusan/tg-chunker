<!--
ALIAS AUDIT — the agentic verification loop over the names map (Pass 1.7).
Discovery is greedy and snowballs: one person ends up holding aliases of OTHER people ("Олег", "Оля",
"Макс" inside Олександр) plus outright hallucinations. This pass walks person by person, alias by
alias, and forces the model to ANSWER QUESTIONS about each alias — suggested full name, gender,
occupation — and only then give a verdict WITH A REASON. No reason → the verdict is void. Each alias
comes with the real message text it was seen in, so the reasoning is grounded, not imagined.
-->
You are auditing ONE person's alias list in an anonymization map built from Ukrainian/Russian Telegram chats. The list was built greedily and may wrongly contain aliases of OTHER people, chat/company titles, or corrupted spellings.

THE PERSON:
- working name: {{CANONICAL}}
- role group: {{GROUP}}

EACH ALIAS below comes with the actual message text it was first seen in (`context`). Judge every alias INDEPENDENTLY, in this exact way — answer the questions FIRST, then conclude:

1. `full_name`: what full name does this alias most likely expand to? (e.g. "Саша" → "Олександр"; "Оля" → "Ольга")
2. `gender`: male / female / unknown — judged from the FORM ITSELF (grammar of the name/declension) and the context.
3. `occupation`: what role does the context suggest (doctor, admin, patient, company, …) or "unknown".
4. `verdict`: "keep" if — and only if — the answers above are consistent with the person being audited. Otherwise "discard".
5. `reason`: ONE short sentence justifying the verdict. MANDATORY for BOTH keep and discard. A verdict without a real reason is invalid.

Hard rules:
- Ukrainian/Russian DECLENSIONS and diminutives of the SAME name are the same person: Олександр/Олександра(gen.)/Олександром/Саша/Сашею → keep for Олександр. BUT beware: "Олександра" can also be the female name — decide from context.
- GENITIVE TRAP: male names in genitive/accusative END in -а/-я ("у Олександра Байдо", "запишіть до Олександра"). An -а ending alone NEVER proves female. Judge gender ONLY from how the name is USED in the context sentence (prepositions, verbs, agreement) — if the context shows a declined reference to the male person being audited, KEEP it.
- A DIFFERENT first name is a DIFFERENT person, no matter how close it looks: Олег, Гліб, Макс/Максим, Наташа, Оля are NOT aliases of Олександр → discard, and say who they likely are in `full_name`.
- Gender mismatch with the audited person → discard (e.g. female forms inside a male person's list).
- Chat titles, company/clinic names, brand names are NOT people → discard.
- Single letters, corrupted/mixed-script strings → discard.
- A surname alone ("Байдо") keeps ONLY if the context does not point at a different family member.
- When the context is too thin to judge, lean keep ONLY if the form is a plausible declension/diminutive of the audited name; otherwise discard with reason "cannot connect to this person".

ALIASES TO AUDIT (JSON array of {form, context}):
{{ALIASES}}

Return STRICT JSON, one entry PER alias, same order, no extra text:
{"aliases":[{"form":"...","full_name":"...","gender":"male|female|unknown","occupation":"...","verdict":"keep|discard","reason":"..."}]}
