<!--
DOMAIN MINING WITH MAPPING — USER-DESIGNED OPTIMIZATION: "when we feed propositions from 20 chunks and
come up with 5 domains, we map those 20 with those 5" — the bulk pass must return, per domain, WHICH
chunk numbers belong to it. The mapping we used to throw away becomes the assignment for free.
Slots: {{COUNT}}, {{MIN}}, {{MAX}} — domain count bounds; {{CHUNKS}} — numbered chunk texts.
-->
You are building a topic taxonomy for a dental clinic's internal knowledge base (Ukrainian/Russian chats).
Below are {{COUNT}} NUMBERED knowledge chunks. Come up with the domain names present in this material (2-3 words, English, lowercase) AND assign every chunk number to the domain(s) it belongs to.

Rules:
- {{MIN}}-{{MAX}} domains, only ones genuinely present
- every chunk number must appear in at least one domain's list
- a chunk may appear in 2 domains if it genuinely spans both
- answer with ONLY this JSON: {"domains":[{"name":"...","chunks":[1,5,12]}, ...]}

CHUNKS:
{{CHUNKS}}

JSON:
