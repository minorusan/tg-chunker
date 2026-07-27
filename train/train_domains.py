# Fine-tune Gemma 3 270M into the query→domain extractor (LoRA SFT).
#
# WHY GENERATION-STYLE (not a classification head): the tuned model outputs domain names as TEXT
# ("patient scheduling; financial transactions"), so after a one-off GGUF conversion it can be served
# by OLLAMA — the box's existing one-door LLM infra. A classification head would need a Python server
# at inference forever; this needs Python only here, at training time.
#
# Data: data/train/train.jsonl + val.jsonl ({"text": query, "domains": [labels]}).
# Resumable: checkpoints every 50 steps; rerun with --resume to continue after an interruption.
#
#   ~/gemma-domains-venv/bin/python train/train_domains.py [--resume]

import json, os, sys, random
import torch
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTTrainer, SFTConfig

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data", "train")
OUT = os.path.join(HERE, "out")
MODEL_ID = "google/gemma-3-270m-it"
SEED = 42

random.seed(SEED); torch.manual_seed(SEED)

def load(split):
    rows = [json.loads(l) for l in open(os.path.join(DATA, f"{split}.jsonl"), encoding="utf-8") if l.strip()]
    return rows

PROMPT = "Extract the knowledge-base domains for this query.\nQuery: {q}\nDomains:"

def to_chat(tokenizer, rows):
    # one training example = chat turn (user: instruction+query, model: "d1; d2")
    texts = []
    for r in rows:
        msgs = [
            {"role": "user", "content": PROMPT.format(q=r["text"])},
            {"role": "assistant", "content": "; ".join(r["domains"])},
        ]
        texts.append(tokenizer.apply_chat_template(msgs, tokenize=False))
    return Dataset.from_dict({"text": texts})

def main():
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16, device_map="cuda", attn_implementation="eager")

    train_ds = to_chat(tok, load("train"))
    val_ds = to_chat(tok, load("val"))

    # FULL fine-tune per Google's official 270M tutorial (ai.google.dev huggingface_text_full_finetune):
    # LR 5e-5, 5 epochs, batch 4, adamw_torch_fused, constant scheduler, seq 512. The 270M is
    # "designed from the ground up for task-specific fine-tuning" — query routing is a named use case.
    args = SFTConfig(
        output_dir=OUT,
        num_train_epochs=5,
        per_device_train_batch_size=4,
        gradient_accumulation_steps=1,
        learning_rate=5e-5,
        lr_scheduler_type="constant",
        optim="adamw_torch_fused",
        max_length=512,
        logging_steps=50,
        save_steps=500,              # power-cut discipline: periodic checkpoints
        save_total_limit=2,
        eval_strategy="epoch",
        bf16=True,
        seed=SEED,
        report_to=[],
    )

    trainer = SFTTrainer(model=model, args=args, train_dataset=train_ds, eval_dataset=val_ds)
    trainer.train(resume_from_checkpoint="--resume" in sys.argv and any(os.scandir(OUT)) or None)
    trainer.save_model(os.path.join(OUT, "merged"))   # full model — GGUF-convertible as-is
    tok.save_pretrained(os.path.join(OUT, "merged"))
    print("DONE: train/out/merged (full fine-tuned model, GGUF-convertible)")

if __name__ == "__main__":
    main()