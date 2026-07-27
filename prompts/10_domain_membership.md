<!--
MEMBERSHIP JUDGE — USER-DESIGNED OPTIMIZATION: "assignment is judged by gemma one-shots" — after the
mapped mining proposes candidates, each chunk gets ONE one-shot bool verdict per candidate domain.
Cheap, parallel-friendly, and the verdict shape leaves no room to ramble.
Slots: {{TEXT}} — the chunk; {{DOMAINS}} — numbered candidate domains.
-->
Knowledge chunk from a dental clinic KB:
"{{TEXT}}"

Candidate domains:
{{DOMAINS}}

For EACH domain: does this chunk belong to it? STRICT JSON, same order:
{"verdicts":[{"n":1,"belongs":true|false}...]}
