<!--
DOMAIN EXTRACTOR FORMAT — the single source of truth for the fine-tuned Gemma-3-270M's I/O contract.
USER-DESIGNED OPTIMIZATION (the "navmesh"): a tiny trained model extracts domains from the user prompt
so retrieval can cut the search space at O(1) BEFORE any ranking. Used VERBATIM in three places:
training (train/train_domains.py), eval (train/eval_domains.py), runtime (scripts/retrieval_improved.ts).
Changing this file after training breaks the model's contract — retrain if you touch it.
Slot: {{QUERY}}.
-->
Extract the knowledge-base domains for this query.
Query: {{QUERY}}
Domains:
