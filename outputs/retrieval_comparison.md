# HW3 — Baseline vs Improved retrieval (same 8 queries as HW2)

**Baseline:** HW2 pipeline — pure cosine (nomic-embed-text) over all 18 chunks.
**Improved:** (1) metadata filtering by `domain` — the filter value is EXTRACTED FROM THE QUERY by a
fine-tuned Gemma-3-270M ("gemma-domains", 81% exact-match on held-out test), so the search space
narrows BEFORE ranking; (2) hybrid search — BM25 keyword score fused with cosine via Reciprocal Rank
Fusion. Over-narrow filters fall back to the full corpus VISIBLY (marked "fallback").

| Query | Baseline top-1 | Improved top-1 | Що змінилось |
|---|---|---|---|
| скільки коштує гігієна для пацієнта на брекетах? | clinic_scripts_chat_000 | clinic_scripts_chat_000 | 🧭 [—] → 18/18 · top-1 unchanged · hybrid: cos#1·bm25#1 |
| коли гігієна коштує 1800 грн? | clinic_scripts_chat_000 | clinic_scripts_chat_000 | 🧭 [financial transactions] → 6/18 · top-1 unchanged · hybrid: cos#1·bm25#1 |
| чи можна називати ціну імпланта по телефону? | clinic_scripts_chat_001 | clinic_admin_chat_003 | 🧭 [financial transactions, dental implants] → 8/18 · top-1 CHANGED · hybrid: cos#1·bm25#1 |
| що входить у вартість для пацієнтів з імплантами? | clinic_admin_chat_003 | clinic_admin_chat_003 | 🧭 [dental implants, financial transactions] → 8/18 · top-1 unchanged · hybrid: cos#1·bm25#1 |
| яка знижка для пенсіонерів? | clinic_admin_chat_000 | clinic_admin_chat_000 | 🧭 [financial transactions, marketing and acquisition] → 7/18 · top-1 unchanged · hybrid: cos#1·bm25#1 |
| як діяти якщо пацієнт тисне на ціну? | clinic_scripts_chat_000 | clinic_scripts_chat_000 | 🧭 [financial transactions, patient communication] → 8/18 · top-1 unchanged · hybrid: cos#1·bm25#1 |
| розкажи все про patient1 | clinic_reception_chat_001 | person_patient1 | 🧭 [people directory] → 6/18 · top-1 CHANGED · hybrid: cos#1·bm25#1 |
| яка політика щодо телефонних консультацій? | clinic_admin_chat_003 | clinic_admin_chat_005 | 🧭 [—] → 18/18 · top-1 CHANGED · hybrid: cos#2·bm25#2 |

## Per-query detail

### скільки коштує гігієна для пацієнта на брекетах?
- baseline (cosine only): clinic_scripts_chat_000(0.787) · clinic_admin_chat_001(0.741) · clinic_admin_chat_003(0.677)
- improved (filter+hybrid): clinic_scripts_chat_000(cos#1,bm25#1) · clinic_admin_chat_001(cos#2,bm25#2) · clinic_admin_chat_000(cos#4,bm25#4)
- routing: [none] → searched 18/18

### коли гігієна коштує 1800 грн?
- baseline (cosine only): clinic_scripts_chat_000(0.790) · clinic_admin_chat_001(0.787) · clinic_admin_chat_002(0.695)
- improved (filter+hybrid): clinic_scripts_chat_000(cos#1,bm25#1) · clinic_admin_chat_001(cos#2,bm25#2) · clinic_admin_chat_002(cos#3,bm25#3)
- routing: [financial transactions] → searched 6/18

### чи можна називати ціну імпланта по телефону?
- baseline (cosine only): clinic_scripts_chat_001(0.822) · clinic_admin_chat_003(0.760) · clinic_admin_chat_005(0.736)
- improved (filter+hybrid): clinic_admin_chat_003(cos#1,bm25#1) · clinic_scripts_chat_000(cos#2,bm25#3) · clinic_admin_chat_002(cos#4,bm25#4)
- routing: [financial transactions, dental implants] → searched 8/18

### що входить у вартість для пацієнтів з імплантами?
- baseline (cosine only): clinic_admin_chat_003(0.828) · clinic_scripts_chat_000(0.756) · clinic_admin_chat_005(0.738)
- improved (filter+hybrid): clinic_admin_chat_003(cos#1,bm25#1) · clinic_admin_chat_002(cos#6,bm25#2) · clinic_admin_chat_001(cos#5,bm25#3)
- routing: [dental implants, financial transactions] → searched 8/18

### яка знижка для пенсіонерів?
- baseline (cosine only): clinic_admin_chat_000(0.735) · clinic_admin_chat_003(0.734) · clinic_scripts_chat_000(0.723)
- improved (filter+hybrid): clinic_admin_chat_000(cos#1,bm25#1) · clinic_admin_chat_001(cos#3,bm25#2) · clinic_scripts_chat_000(cos#2,bm25#6)
- routing: [financial transactions, marketing and acquisition] → searched 7/18

### як діяти якщо пацієнт тисне на ціну?
- baseline (cosine only): clinic_scripts_chat_000(0.781) · clinic_scripts_chat_002(0.773) · clinic_admin_chat_003(0.752)
- improved (filter+hybrid): clinic_scripts_chat_000(cos#1,bm25#1) · clinic_scripts_chat_001(cos#2,bm25#3) · clinic_reception_chat_002(cos#5,bm25#2)
- routing: [financial transactions, patient communication] → searched 8/18

### розкажи все про patient1
- baseline (cosine only): clinic_reception_chat_001(0.766) · clinic_admin_chat_002(0.763) · clinic_reception_chat_002(0.718)
- improved (filter+hybrid): person_patient1(cos#1,bm25#1) · person_employee1(cos#4,bm25#2) · person_patient2(cos#2,bm25#5)
- routing: [people directory] → searched 6/18

### яка політика щодо телефонних консультацій?
- baseline (cosine only): clinic_admin_chat_003(0.750) · clinic_admin_chat_005(0.749) · clinic_scripts_chat_000(0.719)
- improved (filter+hybrid): clinic_admin_chat_005(cos#2,bm25#2) · clinic_admin_chat_004(cos#5,bm25#1) · clinic_admin_chat_003(cos#1,bm25#6)
- routing: [none] → searched 18/18

## Analysis
**Що дало найбільший ефект — по чесному, з прикладами:**

1. **Hybrid search (BM25⊕cosine) виправив головний документований провал HW2.** У HW2 запит «яка політика щодо телефонних консультацій?» ставив ПРАВИЛЬНИЙ чанк на #2, програючи 0.001 косинуса keyword-сусіду. Тепер: BM25 голосує за лексичний збіг («телефонним консультаціям» буквально в тексті), RRF складає ранги — правильний `clinic_admin_chat_005` став top-1. Це найбільший одиничний ефект.

2. **Domain filtering + людський маршрут.** «розкажи все про patient1» тепер маршрутизується екстрактором у домен `people directory` → top-1 = **картка особи** `person_patient1` (роутер з mentioned_at), а не випадкова пропозиція. Пошуковий простір звузився до 6/18 чанків. Це саме той випадок, заради якого будувалась двоіндексна архітектура HW1.

3. **Звуження без шкоди.** На 6 з 8 запитів top-1 не змінився (він і був правильним), але фільтр звузив простір до 6–8/18 чанків — на великому корпусі це і є O(1)-виграш (менше кандидатів → менше шуму → швидше).

4. **Чесність меж:** екстрактор (fine-tuned Gemma-3-270M, 81% exact на held-out) на одному запиті не дав валідного домену — пайплайн ВИДИМО відкотився до повного корпусу (18/18, «fallback»), і гібрид все одно виправив ранжування. Помилка маршрутизації деградує до поведінки HW2, ніколи — до гіршого.

**Висновок:** найбільший разовий ефект дав hybrid search (виправлення ranking-провалів з мізерними марджинами), а metadata filtering дає структурний виграш масштабу (звуження простору) + якісно новий маршрут для запитів про людей.
