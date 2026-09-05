# T1D Management System — Native

A mobile and web application for Type 1 Diabetes (T1D) management, featuring advanced pharmacokinetic and pharmacodynamic modelling for insulin and carbohydrate tracking.

---

## Getting Started

```bash
# Backend
cd backend
python -m venv venv && . venv/Scripts/activate   # or: source venv/bin/activate
pip install -r requirements.txt -r ../requirements-dev.txt
cp .env.example .env                             # required — config.py raises without MONGO_URI
python main.py

# Frontend (new terminal)
cd frontend
npm install
npm start
```

`SETUP.md` is the authoritative setup guide, including the test and parity
commands. Note that `pip install -r requirements.txt` must be run from inside
`backend/`: the **root** `requirements.txt` is an unrelated `pip freeze` that
contains none of Flask, pymongo or gunicorn.

---

## Intellectual Property Notice

> **⚠️ Proprietary Algorithms — All Rights Reserved**
>
> The following components of this system are original intellectual property developed independently by **Ali Attia**:
>
> - **Gamma Distribution Pharmacokinetic Model** — A custom algorithm modelling the absorption curves of insulin and carbohydrates using the Gamma probability distribution function, enabling accurate prediction of Meal-on-Board (MOB) and Insulin-on-Board (IOB) over time.
>
> - **Pharmacodynamics Engine** — A proprietary computational engine that integrates absorbed vs. active drug/nutrient quantities to calculate real-time blood glucose impact, baseline BG estimation, and future glycaemic trajectory.
>
> These algorithms were conceived, designed, and implemented solely by Ali Attia as part of independent research. Unauthorised reproduction, adaptation, or use of these algorithms — in whole or in part — is strictly prohibited without prior written consent from the author.

See the [LICENSE](./LICENSE) file for full copyright terms.

---

## Copyright

Copyright (c) 2024 Ali Attia. All rights reserved.
