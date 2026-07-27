# Evaluate the tuned extractor on held-out queries: generate domains, compare as SETS to gold.
#   ~/gemma-domains-venv/bin/python train/eval_domains.py [val|test-extra]
import json, os, sys, torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
SPLIT = sys.argv[1] if len(sys.argv) > 1 else "val"
rows = [json.loads(l) for l in open(os.path.join(HERE, "..", "data", "train", f"{SPLIT}.jsonl"), encoding="utf-8") if l.strip()]
labels = set(json.load(open(os.path.join(HERE, "..", "data", "train", "labels.json"), encoding="utf-8")))

tok = AutoTokenizer.from_pretrained(os.path.join(HERE, "out", "merged"))
model = AutoModelForCausalLM.from_pretrained(os.path.join(HERE, "out", "merged"), dtype=torch.bfloat16, device_map="cuda")
model.eval()

# same single-sourced contract as training — see prompts/13_extract_domains.md
import re as _re
with open(os.path.join(HERE, "..", "prompts", "13_extract_domains.md"), encoding="utf-8") as _f:
    PROMPT = _re.sub(r"^<!--.*?-->\s*", "", _f.read(), flags=_re.S).strip().replace("{{QUERY}}", "{q}")
exact = partial = empty = invalid = 0
for r in rows:
    msgs = [{"role": "user", "content": PROMPT.format(q=r["text"])}]
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_dict=True, return_tensors="pt").to("cuda")
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=24, do_sample=False, pad_token_id=tok.eos_token_id)
    text = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()
    pred = set(p.strip() for p in text.split(";") if p.strip())
    gold = set(r["domains"])
    if not pred: empty += 1
    elif not pred.issubset(labels): invalid += 1
    elif pred == gold: exact += 1
    elif pred & gold: partial += 1

n = len(rows)
print(f"{SPLIT}: n={n} exact={exact} ({100*exact/n:.1f}%) partial-overlap={partial} ({100*partial/n:.1f}%) empty={empty} invalid-label={invalid}")
print(f"usable (exact+partial): {100*(exact+partial)/n:.1f}%")