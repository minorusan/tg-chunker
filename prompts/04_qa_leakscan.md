<!--
PROMPT 4 — QA LEAK SCAN   (audited prompt)
Loop: Pass 1.9 of the pipeline. Runs AFTER anonymisation, over the ALREADY-TOKENISED text, in rounds.
Job:  catch people the discovery pass MISSED. The residual/mapped-name check can only verify names we
      already know; it is BLIND to a person who was never discovered. So we ask the model to re-read the
      output and flag any REAL human name that is NOT already a token — those are leaks. They get mapped
      and re-applied, and we scan again, until clean.
WHY THIS EXISTS: without it, a missed person's real name ships in the clear and nothing notices. It is
      the difference between "probably anonymised" and "verified anonymised".
Placeholders filled by the code: {{MESSAGES}}
Output is JSON asked for in the prompt (we parse it out; no grammar constraint — that collapses the model).
-->
These chat messages are ALREADY anonymised: every real person should now be a token like `employee1`
or `patient2`. Your job is QA — find anyone who slipped through.

Report any REAL HUMAN NAME still present that is NOT a token. These are anonymisation misses. This
INCLUDES first name + patronymic references with no surname (e.g. "Олена Анатоліївна", "Іван Петрович")
— those are real people and must be caught.

Do NOT report (these are fine): tokens (`employee1`, `patient2`, …), brands, companies, clinics,
cities, public figures, and obvious placeholder names like "Vasya Pupkin".

MESSAGES:
{{MESSAGES}}

Return STRICT JSON:
{
  "leaks": [
    { "canonical": "<the real name as it appears>",
      "forms": ["<each exact spelling of it present in the text>"] }
  ]
}
If everything is properly tokenised, return {"leaks": []}.
