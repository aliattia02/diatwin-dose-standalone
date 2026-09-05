# Presentation Script — IMI Münster Interview
**Ali Mohamed Attia | May 6, 2026 | 15–20 min | English**

> **How to use this script:**
> Each section shows the slide cue, the timing target, and the words to say.
> Highlighted lines marked `[pause]` are intentional beats — let the room absorb them.
> Do not read this verbatim. Know the ideas; speak them naturally.

---

## Slide 1 — Title slide
**⏱ 0:00 – 0:30 | Opening**

> *(stand, make eye contact, smile — do not start until the room is quiet)*

"Good morning. My name is Ali Attia.
I'm a pharmacist turned digital health engineer, and today I want to show you
what three years of building something personally urgent looks like —
and why I think it belongs in the work you're doing here at IMI."

---

## Slide 2 — The moment it started
**⏱ 0:30 – 2:00 | Personal story — the reason**

> *(this is the most important slide emotionally — speak slowly)*

"Before I came to Germany — while I was still working in Egypt,
helping to roll out a national electronic health record system —
a close family member was diagnosed with Type 1 Diabetes.

Standard insulin pen. Finger-prick testing. A paper diary.
And a dosing formula that was set once in clinic and never changed.

I watched them guess. Every meal, every exercise session, every stressful day —
a guess, adjusted by memory and intuition.

[pause]

I also saw the wider picture from my work.
Communities with limited access to endocrinologists.
Patients who travelled hours to get a correction factor adjusted
by a few units. People who were doing everything right —
and still ending up in emergency.

That's when I started asking: why does the pen not know what the pump knows?
Why is there no affordable tool that actually models what insulin does
inside a specific person's body — in real time?

[pause]

That question became DiaTwin.
I started building it three years ago. It is still running today."

---

## Slide 3 — The clinical gap
**⏱ 2:00 – 3:30 | Problem framing**

"Let me be precise about the problem.

Over 8 million people with Type 1 Diabetes worldwide use insulin pens.
CGM sensors are increasingly common. The data exists.
But no affordable decision-support tool connects that data
to a real pharmacodynamic model — one that accounts for
**what insulin is doing right now**, what the meal is still absorbing,
what exercise did to insulin sensitivity an hour ago,
and how this patient's biology changes across the day.

Clinicians prescribe a static Insulin Sensitivity Factor — ISF — and a Carb Ratio — ICR.
Those numbers are measured once, and then used for months.

But insulin sensitivity is not static. It changes by time of day.
It changes after exercise. It changes after illness.
And it's different for every patient.

The result: chronic dosing errors, elevated hypoglycaemia risk,
and enormous cognitive burden on patients who deserve better tools.

That is the gap DiaTwin is designed to close."

---

## Slide 4 — The real engineering problem: scattered, incompatible data
**⏱ 3:30 – 5:30 | The core challenge — data heterogeneity** ⭐

> *(this is the intellectual heart of the talk — set it up carefully)*

"Before I describe the system, I want to name the hardest problem —
because it is not the algorithm, and it is not the UI.

The hardest problem is the data.

[pause]

To build a Digital Twin of a diabetes patient,
you need to know four things continuously:
what they ate, what their blood sugar is doing,
what insulin they have active in their body,
and what physical activity they've done.

That sounds straightforward.
It is not — because each of those four things
arrives in a completely different format, from a completely different source,
with completely different precision and timing.

[pause — click to show data sources diagram]

Take food first.
One patient photographs a full plate and the system has to estimate carbohydrates
from a visual — a plate of rice, a piece of bread, a mixed dish.
Another patient says 'one spoon of honey.'
Another says '200 millilitres of orange juice.'
Another says '80 grams of pasta, dry weight.'

Photo. Spoon. Volume. Grams. Dry weight. Cooked weight.
All describing the same thing — carbohydrate load —
but in entirely different units, with entirely different uncertainty ranges.

A plate photo might be ± 30% accurate.
A gram measurement might be ± 5%.
The system has to work with all of them, and it has to be honest
about the confidence of each estimate — because the dosing decision depends on it.

[pause — click]

Now blood glucose.
Some patients have a CGM — a continuous sensor that reads every 4 minutes.
Rich, continuous, high-resolution data.
Others use finger-prick testing — two or three readings per day, manually timed,
often missed after meals, often logged late.

Both are valid. Both tell you something.
But they cannot be treated the same way.
A CGM reading gives you a slope — you can see whether glucose is rising or falling.
A finger-prick gives you a point — and you have to infer the context.

The system needs a unified glucose timeline that works
whether the patient has a CGM, a finger-prick device, or both.

[pause — click]

Then insulin.
DiaTwin supports 14 different insulin analogues.
Rapid-acting: Humalog, NovoRapid, Fiasp — each with a different peak time,
different duration, different tail behaviour.
Standard: Actrapid. Basal: Lantus, Toujeo, Tresiba.
Each one has a distinct pharmacokinetic curve —
a gamma distribution that describes how much of that insulin
is still active at any given minute after injection.

If a patient takes Fiasp instead of NovoRapid,
the insulin-on-board calculation is different.
The dosing recommendation is different.
And if they stack two doses an hour apart, you need to model both curves
simultaneously — because the peaks may overlap.

[pause — click]

Finally, physical activity.
A smartwatch streams heart rate — timestamped beats per minute.
But what does that data actually mean?
Is that a resting period, a walk, a gym session?
When did the exercise session start and end?
What intensity zone was the patient in?

Raw HR data has no session structure. That structure has to be inferred.

[pause]

---
> 📸 **SHOW SCREENSHOT — Image 2: Effects tab (Insulin, Meal & Net Effects chart)**
> *This is the live app view showing meal effect (orange, above zero) and insulin effect (purple, below zero) on the same timeline. Point out: "These are two of the four data streams — already normalised onto one axis in mg/dL, so they can be compared and combined. The green line is the net cumulative shift. That unified view is what the Digital Twin profile looks like in practice."*
---

So before any algorithm runs — before any dose is recommended —
all four of these data streams have to be cleaned,
normalised, and placed onto a single unified timeline.

Photo carb estimates converted to a common carb-equivalent unit.
Glucose readings — whether CGM or finger-prick — fused onto one trace
with appropriate confidence weights.
Insulin doses converted to pharmacokinetic curves using the specific analogue model.
HR data segmented into exercise sessions with intensity and duration.

That unified patient state — that is the Digital Twin profile.
That is what everything else runs on top of.

And solving that data integration problem
is, I would argue, more medically informatics
than building the algorithm itself."

---

## Slide 5 — The unified pipeline: from chaos to prediction
**⏱ 5:30 – 8:30 | How DiaTwin processes unified data into a result**

> *(show architecture diagram: React · Flask/Python · MongoDB · React Native)*

"Once all four data streams are on the same timeline,
the dosing engine can run.

For meals, the carb-equivalent load is computed as:
carbohydrates plus half the protein plus a fifth of the fat —
consistent with the UVA/Padova glucose absorption model.
Five absorption profiles are assigned automatically,
from very fast — pure glucose — to very slow — a high-fat, high-protein meal.
The system knows that a slice of pizza absorbs differently from a banana,
and models the meal-on-board curve accordingly.

For insulin, each dose is assigned its specific pharmacokinetic curve.
DiaTwin supports 14 insulin analogues —
each with a distinct gamma distribution describing when it peaks
and how long it remains active.
Insulin-on-board at any moment is the sum of active fractions
from every injection in the last 6 to 8 hours.
Overlapping doses are stacked — the model handles polypharmacy.

For glucose, the system maintains a dynamic baseline —
a back-calculation that subtracts all known PK/PD effects from the latest reading
to estimate the underlying fasting glucose level.
A circadian correction accounts for the dawn phenomenon
and the overnight nadir.

[pause — click to show wearable ODE diagram]

And then physical activity enters the model.

The smartwatch HR stream is segmented automatically
using a swim-lane debounce state machine —
five intensity zones, time-gated session detection, no manual tagging.

Each session feeds a three-state ODE system — Y, Z, W —
from Dalla Man, Breton and Cobelli, 2009.
Y filters the exercise signal from resting HR.
Z models acute GLUT4-driven glucose uptake during exercise — 10-minute effect.
W models the prolonged post-exercise insulin sensitivity increase — up to 90 minutes,
capped at a plus 60 percent ISF multiplier.

[pause]

[pause]

> 📸 **SHOW SCREENSHOT — Image 3: Active Effects (live pharmacodynamic summary)**
> *Point to each panel: "Insulin On Board: −18 mg/dL — that is 0.46 units still active, pulling glucose down. Meal On Board: +27 mg/dL — 6.8 grams of carbs still digesting, pushing glucose up. Activity Effects: none logged for this session. And at the top: last reading was 99, estimated now is 99, projected in the next hour: 108. This is the unified state — all four data types, one view, updated in real time."*

The output of all of this — after unifying the scattered data,
normalising it onto one timeline, and running it through the physiological model —
is a projected blood glucose curve for the next 4 hours,
and a recommended insulin dose with the specific analogue matched to the meal.

That is the Digital Twin profile.
That is how you go from a phone photo and a smartwatch HR stream
to a clinically grounded dosing recommendation —
helping the patient predict where their blood sugar is going,
and giving them the best possible estimate of how much insulin they need.

> 📸 **SHOW SCREENSHOT — Image 1: BG Projected chart**
> *Point to the chart: "The purple curve is the projected BG — baseline of 65, plus a cumulative shift of +34 from all active effects, giving a current estimate of 99 mg/dL. The orange shaded area is the meal absorption still in progress. The dashed red line is now. Everything to the right is the projection. The patient can see in real time where their glucose is heading — without a single manual calculation."*

> 📸 **SHOW SCREENSHOT — Image 4: Suggested Insulin Dose breakdown**
> *Walk through the table: "Base insulin needs: 1.5 units for the meal. Activity impact: 0% this session. Pharmacodynamic adjustment: none needed. Current state correction: −0.9 units, because the patient is currently at a good glucose level. Active effects adjustment: +0.2 units, because there is still meal-on-board from a previous meal. Final suggestion: 0.8 units of Ultra-Rapid Analog — with timing guidance, because the insulin type is matched to the meal's absorption speed. Every number in that table traces back directly to one of the four data streams we talked about."*

[pause — click to FHIR output slide]

Every element of that profile is stored as a FHIR R4 resource.
Observation for glucose and HR.
DeviceUseStatement for the wearable.
MedicationRequest for the insulin recommendation.
All pushable to a FHIR server, or directly into a NUM data space via REST.

That is exactly the sensor-to-FHIR-to-research-database pipeline
that NUM ENRICH is building."

---

## Slide 6 — CGM integration & RL personalisation
**⏱ 9:00 – 10:30 | Completing the DiaTwin picture**

"Two more components worth mentioning briefly.

For continuous glucose, DiaTwin integrates with Abbott LibreLinkUp —
auto-syncing every 4 minutes across 10+ regions,
using Fernet-encrypted credentials.
Dexcom integration is planned.
The CGM reading closes the feedback loop — it keeps the baseline current
between finger-prick readings.

For personalisation, DiaTwin uses reinforcement learning.
The engine was pre-trained on over 50,000 meal-outcome pairs,
and stress-tested against the AZT1D dataset —
25 T1D patients with real CGM, bolus, and carbohydrate data.

The planned next phase is automated ISF and ICR refinement
per two-hour circadian block — 12 time-of-day parameters per patient —
updated weekly based on observed outcomes.
Q-learning on a 24-hour temporal basis.

Clinical evaluation was conducted at LMU München
under Professor Klaus Parhofer.
Clinical utility score: 8.7 out of 10.
The thesis was graded with the highest distinction."

---

## Slide 7 — Morafek EHR
**⏱ 10:30 – 12:30 | Second project — origin story + live FHIR export**

"Morafek — which means 'companion' in Arabic —
is a different project with a different origin story.

When I was working in Egypt implementing Dedalus software
for the national EHR rollout at the Healthcare Authority,
I spent two years inside a real hospital information system —
understanding how data actually flows between departments,
where the standards break down, where the workarounds live.

During that time I started building a prototype —
a FHIR-native EHR designed from the ground up
for the German regulatory environment.

Morafek is now a live production application.
It is ISiK-Stufe-1 compliant —
that means the mandatory FHIR R4 resources: Patient, Encounter,
Condition, Procedure, Observation, MedicationStatement —
all handcoded, not generated.
35 REST endpoints. Full FHIR CapabilityStatement.
DSGVO-compliant architecture with pseudonymisation at ingestion.
OMOP-CDM-ready ETL mapping layer.
And AI-assisted ICD-10-GM coding powered by Google Gemini,
with physician review before any code is finalised.

[pause — open fhir-export-2026-05-03.json on screen]

> 📂 **SHOW LIVE FILE — fhir-export-2026-05-03.json**
> *Open the file and point to three things in sequence:*
>
> **1. The Bundle header:**
> `"resourceType": "Bundle"`, `"type": "document"` —
> *"This is not a database dump. It is a proper FHIR document Bundle,
> anchored by a Composition resource titled 'Morafek CareMate — Patientenakte',
> generated on demand from the patient profile button in the app."*
>
> **2. A Blood Pressure Observation — show the component structure:**
> `"code": { "coding": [{ "system": "http://loinc.org", "code": "55284-4" }] }` with
> `"component"` containing systolic (LOINC 8480-6) = 120 mmHg and diastolic = 80 mmHg —
> *"Blood pressure is not stored as a single value — it uses the FHIR component
> structure with LOINC codes for each measurement. That is correct R4 compliance,
> not a workaround."*
>
> **3. A Condition entry — show ICD-10-GM coding:**
> `"Sekundärer Diabetes mellitus ohne Komplikationen"` with ICD-10-GM system URI —
> *"Seven diagnoses in this patient record — all ICD-10-GM coded in German,
> exactly as a KIS or MeDIC interface would expect to receive them."*
>
> *Total bundle: 46 entries across 8 sections — Patient, Vitalzeichen (18 vitals),
> Besuche (7 encounters), Diagnosen (7 conditions), Medikationen, Verordnungen,
> Einnahmen (10 medication statements). That is a complete structured patient record,
> exportable as a single portable FHIR document from one button in the app.*

[pause]

The Dedalus experience gave me something that most developers lack:
I understand KIS systems from the inside.
I know where the data comes from before it ever reaches a FHIR endpoint.
That context matters enormously when you're designing interfaces
between a hospital system and a research database like MeDIC's."

---

## Slide 8 — AI-OVR (E·OVR)
**⏱ 12:30 – 14:30 | Third project — most recent**

"The third project — E·OVR, which stands for Electronic Occurrence and Variance Reporting —
is the most recent. I started it five months ago.

But before writing a single line of code,
I flew back to Egypt to do proper requirements engineering.
Surveys across multiple primary health clinics in Aswan governorate.
Interviews with quality managers, clinical staff, and hospital administrators.
Observation of the actual incident reporting workflows currently in use.

[pause]

The problem was clear and well-documented in the fieldwork:
adverse event reporting in Egyptian public health facilities is almost entirely paper-based.
It is slow, inconsistent, and massively under-reported —
not because staff don't care, but because they distrust the process,
fear personal consequences, and find the paperwork too burdensome
to complete after an already exhausting shift.

Patients and visitors have no reporting mechanism at all.

[pause — open E·OVR demo]

> 📂 **SHOW LIVE APP — E·OVR system (eovr_system_updated.jsx running)**
> *Walk through the system in this order — spend about 90 seconds total:*

The system has two completely separate entry paths.

The first is for patients and visitors.
No login required. No name needed. Fully anonymous.
Each clinic has a unique URL — something like eovr.moh.gov.eg/report/elbayara-a3f9 —
printed on a card at the reception desk.
The patient fills in a three-step form in Arabic or English,
submits, and receives a reference number.
Their identity is never recorded.

> 📂 **SHOW — Patient anonymous form (3-step flow)**
> *Point to: the step indicator, the Arabic/English bilingual placeholder text,
> and the reference number confirmation screen.*
> *"A patient who waited three hours and felt ignored can report that in two minutes,
> from their phone, without giving their name. That is a real shift
> from what exists today."*

[pause — switch to staff login]

The second path is for healthcare staff and managers.
Staff log in with assigned credentials.
Their facility is pre-attached to their account — no manual selection.
The incident form is a three-step guided process:
reporter information, incident details, and event classification.

> 📂 **SHOW — Staff incident form, Step 2**
> *Point to the incident category dropdown: Medication, Administrative, Clinical,
> Equipment, Infection Control, Falls, Documentation, Behaviour / Communication.*
> *"These eight categories came directly from the fieldwork —
> they reflect the actual incident types reported in Egyptian primary care,
> not a copied WHO template."*

[pause — switch to Quality Admin view]

Once a report is submitted, it enters a structured five-stage workflow.

Received → Under Review → Risk Assessment → Action Taken → Completed.

The Quality Admin reviews the report and assigns a risk score
using a 3-by-3 matrix — severity of harm against probability of recurrence.
The score is calculated automatically from those two inputs:
Major harm times High probability gives a Critical score of 9.
Minor harm times Low probability gives a Low score of 1.

> 📂 **SHOW — Risk Assessment Matrix (interactive grid in QA view)**
> *Point to a selected cell — e.g. Moderate × Medium = 4 (Medium risk, blue).*
> *"The QA admin clicks one cell. The score, the risk level label, and the
> urgency colour are all assigned automatically. No manual calculation."*

Once the risk is scored, the admin documents two things specifically:
corrective action — what was done immediately to address this incident —
and preventive action — what structural change will stop it happening again.
That distinction maps directly onto CAPA methodology,
which is a JCI accreditation requirement.

Finally, a formal written report closes the incident and archives it.

[pause — switch to Governorate Manager view]

The role hierarchy has four levels.
Staff Reporter can submit and track their own reports.
Quality Admin reviews all reports for their clinic, assigns scores, closes incidents.
Governorate Manager — in this demo, covering all of Aswan —
sees analytics across all facilities in the region: total reports, high-risk incidents,
resolution rates, reporting source breakdown — staff versus anonymous patient.
National System Admin has full access across all of Egypt,
and can configure the AI classification module.

[pause]

The AI component classifies incoming incident descriptions automatically —
assigning a suggested category and event type from the free-text description,
before the Quality Admin reviews.
It reduces the time to triage and flags high-severity incidents for priority attention.

It is almost complete.
The fieldwork, the requirements, the design, and the build —
I did all of this myself, from on-site survey in Aswan
to a working full-stack application in five months."

---

## Slide 9 — The thread connecting all three
**⏱ 14:00 – 15:30 | Synthesis — why these projects matter here**

> *(this is your closing argument — deliver it with confidence)*

"Three projects. Three different problems. But one thread.

[pause]

Every one of them is about making health data flow to where it creates value —
across devices, across systems, across organisational boundaries —
using open standards so that no one is locked in,
and so that the data can be used for research, not just care.

DiaTwin: wearable sensor data → physiological model → FHIR → research-ready output.
Morafek: clinical encounter data → ISiK-compliant FHIR → OMOP-CDM → analytics.
AI-OVR: real-world safety data → structured incident record → quality evidence.

NUM ENRICH is asking for exactly the first of those pipelines —
at scale, across institutions, using interoperability standards.
EyeMatics is asking for exactly the second —
harmonising clinical data across six university clinics.

I did not build these projects because they looked good on a CV.
I built them because the problems were real,
the people affected were real,
and I had the skills to do something about it.

[pause]

I am applying to IMI because the work you're doing here
is the infrastructure layer that makes all of this possible —
at a scale I cannot reach alone.

I want to build that infrastructure with you."

---

## Slide 10 — Closing / Thank you
**⏱ 15:30 – 16:00**

"Thank you.

The live demo is at dia-twin.vercel.app —
doctor login: doctor / 4444, patient: ahmed / 4444 —
if you want to explore after the presentation.

I'm happy to go deep on any part of the technical stack,
the FHIR architecture, the ODE model, or how any of this
would connect to the NUM ENRICH prototype.

What questions do you have?"

---

## Appendix — Backup answers to anticipate

### "Why not build this in Java/Kotlin from the start?"
"I made pragmatic choices — Python for the scientific computing stack,
TypeScript for the frontend, React Native for cross-platform mobile.
These were the right tools for solo research-grade development.
For NUM ENRICH's production cross-platform app, I understand the preference
for Kotlin Multiplatform or Flutter. I've been reviewing Kotlin actively.
The OOP concepts transfer directly from TypeScript — I expect to be
functional within the first week and productive within the first month."

### "How would you actually connect DiaTwin's wearable output to NUM's infrastructure?"
"The wearable data is already structured as FHIR R4 Observation resources.
The integration path is: push those resources to a FHIR server
conforming to the MII Kerndatensatz profiles —
specifically the Observation profile for vital signs —
and from there into the NUM data space via the existing federated infrastructure.
The subscription model in FHIR R4 would allow near-real-time push.
The batch upload path would use FHIR Bundles via the transaction endpoint."

### "What is your German language level — can you work here?"
"My German is B2 to C1 — I passed the Fachsprachenprüfung
at the Bavarian Chamber of Pharmacists, which is the clinical language exam
for healthcare professionals. I can discuss technical and clinical topics in German.
I'm continuing to improve."

### "Where do you see yourself after this contract ends in 2028?"
"I'd like to continue in federated health data infrastructure —
ideally in a doctoral programme or a senior research engineer role.
The MII and NUM ecosystem is exactly the environment
I want to grow in long-term."

---

## Timing summary

| Slide | Content | Target time |
|---|---|---|
| 1 | Title | 0:30 |
| 2 | Personal story — family, Egypt, why DiaTwin | 1:30 |
| 3 | Clinical gap — the problem | 1:30 |
| 4 | The core challenge: scattered, incompatible data ⭐ | 2:00 |
| 5 | Unified pipeline — normalisation, ODE, FHIR output ⭐ | 3:00 |
| 6 | CGM + RL personalisation | 1:30 |
| 7 | Morafek EHR + live FHIR JSON export demo ⭐ | 2:30 |
| 8 | AI-OVR / E·OVR — fieldwork + live app walkthrough | 2:30 |
| 9 | The thread / closing argument | 1:30 |
| 10 | Thank you + questions | 0:30 |
| **Total** | | **~17:00** |

> ⚠️ **Timing note:** With three live demos (DiaTwin app, FHIR JSON, E·OVR),
> the talk can easily run to 19–20 min if you linger.
> Practise with a timer. If you need to cut, shorten Slide 6 (CGM/RL) first —
> it is the least directly relevant to the IMI role.

---

*Prepared May 3, 2026 — for Ali Mohamed Attia | IMI Münster interview, May 6, 2026*
