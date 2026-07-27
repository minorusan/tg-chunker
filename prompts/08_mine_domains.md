<!--
DOMAIN MINING (bulk) — USER-DESIGNED OPTIMIZATION: don't predefine a taxonomy; feed raw propositions
to the model in big bulks and let domain names EMERGE from the data ("we can't tell what they will be").
Consistency comes later from recurrence across independent bulks + the synonym loop.
Slots: {{COUNT}} — propositions in this bulk; {{PROPOSITIONS}} — numbered list.
-->
You are building a topic taxonomy for a knowledge base of a dental clinic's internal work chats (Ukrainian/Russian).
Below are {{COUNT}} knowledge propositions. Read them all, then list the DOMAIN NAMES you can come up with that these propositions belong to.

Rules:
- each domain name: 2-3 words, English, lowercase (e.g. "pricing rules", "patient scheduling")
- domains describe TOPICS of the material, not the clinic itself
- 5-15 domains per answer — only ones genuinely present in this material
- answer with ONLY a JSON array of strings, nothing else

PROPOSITIONS:
{{PROPOSITIONS}}

JSON array:
