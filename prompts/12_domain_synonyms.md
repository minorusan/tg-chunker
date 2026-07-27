<!--
SHRINKING SYNONYM LOOP — USER-DESIGNED OPTIMIZATION (his spec, verbatim requirements): anchor domain +
its 10 nearest unused neighbours (vector proposes); the model picks which are just other names for the
SAME topic (LLM disposes); picked synonyms are EXCLUDED from the pool so the loop shrinks dynamically
until nothing is left to look at. "Keep instruction minimal so full focus on simple task."
This is the PRODUCTION prompt (sweep variants v2-v6 live in scripts/canon-domains.ts as experiments).
Slots: {{ANCHOR}}; {{CANDIDATES}} — numbered nearest domains.
-->
Topic: "{{ANCHOR}}"

Candidates:
{{CANDIDATES}}

Which candidates are just other names for the SAME topic? Answer with a JSON array of their numbers, e.g. [1,4]. If none: []
