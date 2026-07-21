# RAG chunks

12 **proposition** chunks (blobs of sense) + 6 **person** chunks (entity cards that route into them).

## Proposition chunks — the knowledge

### Адмінка Клініки  
`document_id: clinic_admin_chat` · `data/raw/clinic_admin_chat.json`

**`clinic_admin_chat_000`** — Старе правило: пенсіонерам знижка 5% на гігієну (поки діє).
<sub>actors: employee1 · timeframe: 2019-05-01T10:00:00 · msgs: 1</sub>

**`clinic_admin_chat_001`** — Оновлене правило по гігієні: поточна вартість становить 2300 грн, а 1800 грн діє лише коли пацієнт на брекетах і тільки після обробки порошком (уточнюйте у лікаря).
<sub>actors: employee1 · timeframe: 2024-02-01T09:00:00, 2024-02-01T09:01:00, 2024-02-01T09:02:00 · msgs: 2, 3, 4</sub>

**`clinic_admin_chat_002`** — Через ситуацію з patient1 (онлайн-консультація затягнулася з 30 хв до години та відмова платити встановлену ціну 1000 грн), було зроблено списання 1000 грн, і тепер пацієнтів типу patient1 на довгі онлайн-консультації більше не беремо.
<sub>actors: employee2, patient1 · timeframe: 2024-02-03T12:00:00, 2024-02-03T12:01:00, 2024-02-03T12:02:00, 2024-02-03T12:03:00 · msgs: 6, 7, 8, 9</sub>

**`clinic_admin_chat_003`** — Важливий нюанс по імплантах: коли пацієнт з імплантом, в технічну вартість входить ще вартість платформи, яку важко врахувати.
<sub>actors: employee1 · timeframe: 2024-02-10T15:00:00, 2024-02-10T15:01:00, 2024-02-10T15:02:00 · msgs: 10, 11, 12</sub>

**`clinic_admin_chat_004`** — Щодо patient2: працюємо тільки з відсутнім зубом (імплант та коронка), інше не чіпаємо.
<sub>actors: employee2, patient2, employee1 · timeframe: 2024-02-11T10:00:00, 2024-02-11T10:01:00, 2024-02-11T10:05:00 · msgs: 13, 14, 15</sub>

**`clinic_admin_chat_005`** — Політика по телефонним консультаціям: employee1 не має можливості оцінити якість усього, що проводиться 'по телефону', тому такі консультації не зараховуються проти адміністратора.
<sub>actors: employee1 · timeframe: 2024-02-12T11:00:00, 2024-02-12T11:01:00, 2024-02-12T11:02:00 · msgs: 16, 17, 18</sub>

### Ресепшн  
`document_id: clinic_reception_chat` · `data/raw/clinic_reception_chat.json`

**`clinic_reception_chat_000`** — patient3 записана на 24 вересня, потрібно нагадати їй про гігієну.
<sub>actors: patient3, employee3 · timeframe: 2024-06-01T08:30:00 · msgs: 2</sub>

**`clinic_reception_chat_001`** — patient1 досі не оплатила акт за 03.06, employee3 має передзвонити їй ще раз сьогодні.
<sub>actors: patient1, employee3, employee2 · timeframe: 2024-06-01T08:30:00, 2024-06-01T08:40:00, 2024-06-01T08:41:00 · msgs: 3, 4, 5</sub>

**`clinic_reception_chat_002`** — У patient3 видалені всі зуби, планується повна імплантація; потрібно додати рахунок на платформу, як казав employee1; employee3 вже занесла всю інформацію в картку.
<sub>actors: patient3, employee2, employee1, employee3 · timeframe: 2024-06-02T09:00:00, 2024-06-02T09:01:00, 2024-06-02T09:10:00 · msgs: 6, 7, 8</sub>

### Скрипти для адмінів  
`document_id: clinic_scripts_chat` · `data/raw/clinic_scripts_chat.json`

**`clinic_scripts_chat_000`** — Скрипт відповіді на питання про ціну гігієни: якщо пацієнт питає 'скільки коштує чистка?', відповідь має бути: 'Поточна гігієна 2300 грн, а на брекетах порошком — 1800 грн.'
<sub>actors: employee1 · timeframe: 2024-03-01T10:00:00, 2024-03-01T10:01:00, 2024-03-01T10:02:00 · msgs: 1, 2, 3</sub>

**`clinic_scripts_chat_001`** — Ніколи не називайте ціну імпланта по телефону — тільки на очній консультації.
<sub>actors: employee1 · timeframe: 2024-03-01T10:05:00 · msgs: 4</sub>

**`clinic_scripts_chat_002`** — Якщо пацієнт тисне на ціну — записуйте на безкоштовний первинний огляд.
<sub>actors: employee1 · timeframe: 2024-03-01T10:06:00 · msgs: 5</sub>

---

## Person chunks — the entity-linking layer

Each person is matched by name/alias and **routes** into the proposition chunks that mention them (`mentioned_at`). Ask "tell me about patient2" → match here → follow the ids.

**`person_employee1`** (employee) — aliases: `Олег`
<sub>mentioned_at → clinic_admin_chat_000, clinic_admin_chat_001, clinic_admin_chat_003, clinic_admin_chat_004, clinic_admin_chat_005, clinic_reception_chat_002, clinic_scripts_chat_000, clinic_scripts_chat_001, clinic_scripts_chat_002</sub>

**`person_employee2`** (employee) — aliases: `Марина`
<sub>mentioned_at → clinic_admin_chat_002, clinic_admin_chat_004, clinic_reception_chat_001, clinic_reception_chat_002</sub>

**`person_employee3`** (employee) — aliases: `Ірина`
<sub>mentioned_at → clinic_reception_chat_000, clinic_reception_chat_001, clinic_reception_chat_002</sub>

**`person_patient1`** (patient) — aliases: `Світлані Головко`, `Світлани`, `Свєту`, `Світлана Головко`, `Світлані`, `Свєті`
<sub>mentioned_at → clinic_admin_chat_002, clinic_reception_chat_001</sub>

**`person_patient2`** (patient) — aliases: `Петру Ковалю`
<sub>mentioned_at → clinic_admin_chat_004</sub>

**`person_patient3`** (patient) — aliases: `Оксана Федій`, `Оксані`, `Федій`
<sub>mentioned_at → clinic_reception_chat_000, clinic_reception_chat_002</sub>
