const pptxgen = require("/home/claude/.npm-global/lib/node_modules/pptxgenjs");
const React = require("/home/claude/.npm-global/lib/node_modules/react");
const ReactDOMServer = require("/home/claude/.npm-global/lib/node_modules/react-dom/server");
const sharp = require("/home/claude/.npm-global/lib/node_modules/sharp");

// Icons
const { FaBrain, FaHeartbeat, FaChartLine, FaUserMd, FaFlask, FaShieldAlt, FaMobileAlt, FaCheckCircle, FaArrowRight, FaClock, FaUsers, FaLightbulb, FaSyringe, FaUtensils, FaGlobe, FaWifi, FaSlidersH, FaEdit, FaEye, FaFingerprint, FaExchangeAlt, FaLock } = require("/home/claude/.npm-global/lib/node_modules/react-icons/fa");
const { MdTrendingUp, MdSecurity, MdDashboard, MdScience } = require("/home/claude/.npm-global/lib/node_modules/react-icons/md");

// ─── Color Palette ───────────────────────────────────────────────────────────
const C = {
  navy:    "0A1628",   // Dark navy - title slides
  blue:    "0B4F8A",   // Main blue
  teal:    "0891B2",   // Teal accent
  mint:    "06B6D4",   // Bright cyan
  green:   "059669",   // Success green
  orange:  "F97316",   // Warning / meal
  purple:  "7C3AED",   // Insulin purple
  white:   "FFFFFF",
  offwhite:"F8FAFC",
  light:   "E0F2FE",
  muted:   "64748B",
  card:    "F1F5F9",
  darkcard:"1E3A5F",
};

async function iconPng(IconComp, color = "#FFFFFF", size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComp, { color, size: String(size) })
  );
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

const makeShadow = () => ({ type: "outer", color: "000000", blur: 8, offset: 3, angle: 135, opacity: 0.12 });

async function build() {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.title = "DiaTwin — Diabetes Digital Twin";

  // ── PRE-RENDER ICONS ─────────────────────────────────────────────────────
  const [
    icoBrain, icoPD, icoChart, icoDoctor, icoMeal,
    icoInsulin, icoShield, icoMobile, icoCheck, icoUsers,
    icoGlobe, icoLight, icoArrow, icoClock
  ] = await Promise.all([
    iconPng(FaBrain,    "#06B6D4"),
    iconPng(MdScience,  "#06B6D4"),
    iconPng(FaChartLine,"#06B6D4"),
    iconPng(FaUserMd,   "#06B6D4"),
    iconPng(FaUtensils, "#F97316"),
    iconPng(FaSyringe,  "#7C3AED"),
    iconPng(FaShieldAlt,"#059669"),
    iconPng(FaMobileAlt,"#0891B2"),
    iconPng(FaCheckCircle,"#059669"),
    iconPng(FaUsers,    "#FFFFFF"),
    iconPng(FaGlobe,    "#FFFFFF"),
    iconPng(FaLightbulb,"#F97316"),
    iconPng(FaArrowRight,"#FFFFFF"),
    iconPng(FaClock,    "#06B6D4"),
  ]);

  const icoCheckWhite = await iconPng(FaCheckCircle, "#FFFFFF");
  const icoChartWhite = await iconPng(FaChartLine, "#FFFFFF");
  const icoInsulinWhite = await iconPng(FaSyringe, "#FFFFFF");
  const icoMealWhite = await iconPng(FaUtensils, "#FFFFFF");
  const icoBrainWhite = await iconPng(FaBrain, "#FFFFFF");
  const icoDoctorWhite = await iconPng(FaUserMd, "#FFFFFF");
  const icoPDWhite = await iconPng(MdScience, "#FFFFFF");

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 1 — TITLE
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };

    // Left dark panel (full height)
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 5.5, h: 5.625, fill: { color: C.navy }, line: { color: C.navy } });

    // Right teal accent panel
    s.addShape(pres.shapes.RECTANGLE, { x: 5.5, y: 0, w: 4.5, h: 5.625, fill: { color: C.blue }, line: { color: C.blue } });

    // Decorative circles on right panel
    s.addShape(pres.shapes.OVAL, { x: 7.0, y: -0.8, w: 3.5, h: 3.5, fill: { color: C.teal, transparency: 75 }, line: { color: C.teal, transparency: 75 } });
    s.addShape(pres.shapes.OVAL, { x: 5.8, y: 3.2, w: 2.5, h: 2.5, fill: { color: C.mint, transparency: 80 }, line: { color: C.mint, transparency: 80 } });

    // Small teal bar at top-left
    s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 0.45, w: 0.35, h: 0.06, fill: { color: C.teal }, line: { color: C.teal } });

    // "DiaTwin" — main title
    s.addText("DiaTwin", {
      x: 0.5, y: 0.7, w: 4.8, h: 1.1,
      fontSize: 54, fontFace: "Calibri", bold: true,
      color: C.white, align: "left", margin: 0,
    });

    // Tagline
    s.addText("Diabetes Digital Twin", {
      x: 0.5, y: 1.75, w: 4.8, h: 0.5,
      fontSize: 20, fontFace: "Calibri",
      color: C.mint, align: "left", margin: 0,
    });

    // Description
    s.addText("A real-time pharmacodynamic platform for insulin-requiring diabetes — turning passive logging into predictive self-care.", {
      x: 0.5, y: 2.45, w: 4.7, h: 1.1,
      fontSize: 13, fontFace: "Calibri",
      color: "B0C4D8", align: "left", margin: 0,
    });

    // Three small feature pills at bottom-left
    const pills = ["IOB Tracking", "MOB Modelling", "Dose Advisory"];
    pills.forEach((txt, i) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.5 + i * 1.55, y: 3.9, w: 1.4, h: 0.38, fill: { color: C.teal, transparency: 25 }, line: { color: C.teal }, rectRadius: 0.05 });
      s.addText(txt, { x: 0.5 + i * 1.55, y: 3.9, w: 1.4, h: 0.38, fontSize: 9.5, color: C.white, align: "center", valign: "middle", fontFace: "Calibri" });
    });

    // Right side — icon + stats
    s.addImage({ data: icoBrainWhite, x: 7.1, y: 1.2, w: 1.2, h: 1.2 });

    s.addText([
      { text: "8.7", options: { fontSize: 38, bold: true, color: C.white } },
      { text: "/10", options: { fontSize: 18, color: "B0C4D8" } },
    ], { x: 5.8, y: 2.9, w: 2.2, h: 0.8, align: "center", margin: 0 });
    s.addText("Clinical Utility Score", { x: 5.8, y: 3.65, w: 2.2, h: 0.3, fontSize: 9, color: "90A8C0", align: "center" });

    s.addText([
      { text: "50K+", options: { fontSize: 30, bold: true, color: C.white } },
    ], { x: 7.8, y: 2.9, w: 1.8, h: 0.8, align: "center", margin: 0 });
    s.addText("Meal-outcome pairs\nvalidated", { x: 7.8, y: 3.65, w: 1.8, h: 0.4, fontSize: 9, color: "90A8C0", align: "center" });

    // Footer
    s.addText("Advisory use only — does not replace clinical judgement", {
      x: 0, y: 5.25, w: 10, h: 0.3,
      fontSize: 8, color: "506070", align: "center",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 2 — THE PROBLEM
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    // Top navy header bar
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("THE PROBLEM", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 11, fontFace: "Calibri", bold: true, color: C.mint, align: "left", valign: "middle", charSpacing: 4 });
    s.addText("Managing T1D is a 24/7 balancing act", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, fontFace: "Calibri", bold: true, color: C.white, align: "right", valign: "middle" });

    // Three problem cards
    const problems = [
      { icon: icoLight,  color: C.orange, title: "The Precision Gap",   body: "Doctor-set therapy plans are complex to apply daily. Patients lack tools to translate clinical parameters into real-time decisions." },
      { icon: icoBrain,  color: C.teal,   title: "Data Without Insight", body: "CGM and finger-prick devices show current glucose levels — but offer no guidance on how much insulin to take or when." },
      { icon: icoShield, color: "C0392B",  title: "Risk of Harm",        body: "Without IOB/MOB awareness, insulin stacking causes dangerous hypoglycemia. High cognitive burden leads to dosing errors." },
    ];

    problems.forEach((p, i) => {
      const x = 0.35 + i * 3.12;
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.3, w: 2.9, h: 3.7, fill: { color: C.white }, line: { color: "E2E8F0", width: 1 }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.3, w: 2.9, h: 0.08, fill: { color: p.color }, line: { color: p.color } });
      // Icon circle
      s.addShape(pres.shapes.OVAL, { x: x + 1.0, y: 1.55, w: 0.9, h: 0.9, fill: { color: p.color, transparency: 15 }, line: { color: p.color } });
      s.addImage({ data: p.icon, x: x + 1.12, y: 1.67, w: 0.65, h: 0.65 });
      s.addText(p.title, { x, y: 2.6, w: 2.9, h: 0.55, fontSize: 14, fontFace: "Calibri", bold: true, color: C.navy, align: "center" });
      s.addText(p.body, { x: x + 0.18, y: 3.2, w: 2.54, h: 1.65, fontSize: 11, fontFace: "Calibri", color: C.muted, align: "left", valign: "top" });
    });

    // Bottom stat bar
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.1, w: 10, h: 0.525, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("~1.3 million insulin-pen users in Germany alone lack structured dosing guidance", {
      x: 0.5, y: 5.1, w: 9, h: 0.525, fontSize: 12, color: C.white, align: "center", valign: "middle", italic: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 3 — WHAT IS DIATWIN
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };

    // Subtle background circle
    s.addShape(pres.shapes.OVAL, { x: 5.5, y: -1.5, w: 6, h: 6, fill: { color: C.blue, transparency: 82 }, line: { color: C.blue, transparency: 82 } });

    s.addText("WHAT IS DIATWIN?", { x: 0.5, y: 0.35, w: 9, h: 0.4, fontSize: 10, color: C.teal, charSpacing: 4, bold: true });
    s.addText("A pharmacodynamic\ndigital twin for T1D", { x: 0.5, y: 0.7, w: 5.5, h: 1.3, fontSize: 32, fontFace: "Calibri", bold: true, color: C.white });

    s.addText("DiaTwin builds a real-time model of each patient's glucose state — tracking how insulin and carbohydrates behave physiologically — to answer three critical questions every minute:", {
      x: 0.5, y: 2.15, w: 5.0, h: 1.1, fontSize: 12, color: "B0C4D8", align: "left",
    });

    // Three questions
    const qs = [
      { q: "What is my BG right now?",               icon: icoChart },
      { q: "Where will it go in the next few hours?", icon: icoClock },
      { q: "Is it safe to eat or dose?",             icon: icoCheck },
    ];
    qs.forEach((item, i) => {
      const y = 3.45 + i * 0.55;
      s.addShape(pres.shapes.OVAL, { x: 0.5, y: y, w: 0.38, h: 0.38, fill: { color: C.teal }, line: { color: C.teal } });
      s.addImage({ data: item.icon, x: 0.55, y: y + 0.04, w: 0.28, h: 0.28 });
      s.addText(item.q, { x: 1.05, y: y + 0.02, w: 4.1, h: 0.35, fontSize: 13, fontFace: "Calibri", color: C.white, bold: true, margin: 0 });
    });

    // Right side — 3 core value cards
    const vals = [
      { label: "IOB",  sub: "Insulin On Board",  desc: "Insulin still pharmacologically active — calculated via trapezoidal integration", color: C.purple },
      { label: "MOB",  sub: "Meal On Board",      desc: "Carbohydrates still being absorbed — modelled via gamma-distribution kinetics",    color: C.orange },
      { label: "Net",  sub: "Net BG Effect",      desc: "Meal impact minus insulin impact — positive = rising, negative = falling",         color: C.teal },
    ];
    vals.forEach((v, i) => {
      const y = 0.9 + i * 1.5;
      s.addShape(pres.shapes.RECTANGLE, { x: 6.0, y, w: 3.6, h: 1.3, fill: { color: C.darkcard }, line: { color: v.color, width: 1 }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x: 6.0, y, w: 0.08, h: 1.3, fill: { color: v.color }, line: { color: v.color } });
      s.addText(v.label, { x: 6.2, y: y + 0.12, w: 0.9, h: 0.45, fontSize: 22, fontFace: "Calibri", bold: true, color: v.color, margin: 0 });
      s.addText(v.sub,   { x: 7.1, y: y + 0.12, w: 2.35, h: 0.4, fontSize: 11, color: "90A8C0", valign: "middle", margin: 0 });
      s.addText(v.desc,  { x: 6.2, y: y + 0.57, w: 3.2, h: 0.65, fontSize: 10, color: "7A95B0", margin: 0 });
    });

    s.addText("Advisory use only — does not replace clinical judgement", {
      x: 0, y: 5.3, w: 10, h: 0.25, fontSize: 8, color: "40607F", align: "center",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 4 — PHARMACODYNAMICS ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    // Header
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.blue }, line: { color: C.blue } });
    s.addText("THE ENGINE", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("Pharmacodynamics Engine", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    // Two columns
    // Left: Meal absorption
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 1.25, w: 4.4, h: 3.9, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 1.25, w: 4.4, h: 0.07, fill: { color: C.orange }, line: { color: C.orange } });
    s.addImage({ data: icoMealWhite, x: 0.65, y: 1.4, w: 0.42, h: 0.42 });
    // icon background
    s.addShape(pres.shapes.OVAL, { x: 0.58, y: 1.35, w: 0.55, h: 0.55, fill: { color: C.orange }, line: { color: C.orange } });
    s.addImage({ data: icoMealWhite, x: 0.65, y: 1.42, w: 0.4, h: 0.4 });

    s.addText("Meal Absorption (MOB)", { x: 1.25, y: 1.35, w: 3.4, h: 0.5, fontSize: 14, bold: true, color: C.navy, margin: 0 });
    s.addText("Gamma-distribution curve modelling:", { x: 0.6, y: 1.95, w: 4.0, h: 0.35, fontSize: 11, color: C.muted });
    const mealPoints = [
      "Delayed gastric emptying onset",
      "Peak absorption rise",
      "Gradual metabolic tail",
      "5 absorption speeds: very slow → very fast",
      "Personalised absorption modifier per patient",
    ];
    s.addText(mealPoints.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < mealPoints.length - 1 } })), {
      x: 0.65, y: 2.3, w: 3.9, h: 2.2, fontSize: 11, color: C.navy,
    });

    // Right: Insulin activity
    s.addShape(pres.shapes.RECTANGLE, { x: 5.2, y: 1.25, w: 4.4, h: 3.9, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.2, y: 1.25, w: 4.4, h: 0.07, fill: { color: C.purple }, line: { color: C.purple } });
    s.addShape(pres.shapes.OVAL, { x: 5.38, y: 1.35, w: 0.55, h: 0.55, fill: { color: C.purple }, line: { color: C.purple } });
    s.addImage({ data: icoInsulinWhite, x: 5.45, y: 1.42, w: 0.4, h: 0.4 });
    s.addText("Insulin Activity (IOB)", { x: 6.05, y: 1.35, w: 3.4, h: 0.5, fontSize: 14, bold: true, color: C.navy, margin: 0 });
    s.addText("Two curve families — S3 Clinical Guidelines:", { x: 5.4, y: 1.95, w: 4.0, h: 0.35, fontSize: 11, color: C.muted });

    // Peaked vs Peakless sub-boxes
    s.addShape(pres.shapes.RECTANGLE, { x: 5.4, y: 2.35, w: 1.9, h: 0.35, fill: { color: C.purple, transparency: 85 }, line: { color: C.purple } });
    s.addText("Peaked Insulins", { x: 5.4, y: 2.35, w: 1.9, h: 0.35, fontSize: 10, bold: true, color: C.purple, align: "center", valign: "middle" });
    s.addShape(pres.shapes.RECTANGLE, { x: 7.5, y: 2.35, w: 1.9, h: 0.35, fill: { color: "4A148C", transparency: 85 }, line: { color: "7B1FA2" } });
    s.addText("Peakless Insulins", { x: 7.5, y: 2.35, w: 1.9, h: 0.35, fontSize: 10, bold: true, color: "9C27B0", align: "center", valign: "middle" });

    const insulinPoints = ["Rapid, short, intermediate acting", "Gamma distribution with type-specific params", "Long-acting, ultra-long acting", "4-phase model, capped at 75% max activity"];
    insulinPoints.forEach((pt, i) => {
      s.addShape(pres.shapes.OVAL, { x: 5.42, y: 2.85 + i * 0.52, w: 0.14, h: 0.14, fill: { color: C.purple }, line: { color: C.purple } });
      s.addText(pt, { x: 5.65, y: 2.82 + i * 0.52, w: 3.75, h: 0.35, fontSize: 11, color: C.navy });
    });

    // Bottom info box
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 5.05, w: 9.2, h: 0.45, fill: { color: C.light }, line: { color: C.teal } });
    s.addText("The same mathematical model runs identically in Python (backend) and TypeScript (frontend) — guaranteeing consistency across all platforms.", {
      x: 0.55, y: 5.05, w: 8.9, h: 0.45, fontSize: 10, color: C.blue, align: "center", valign: "middle", italic: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 5 — PATIENT FEATURES
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("FOR PATIENTS", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("Predictive Self-Care", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    const features = [
      { icon: icoChart,     color: C.teal,   title: "Real-Time IOB & MOB",    body: "See exactly how much insulin and meal carbs are still active — eliminating guesswork before a correction dose." },
      { icon: icoLight,     color: C.orange,  title: "Advisory Bolus Calculator", body: "Dose suggestions accounting for current BG, active IOB, planned meal, activity level, and time-of-day resistance." },
      { icon: icoClock,     color: C.blue,    title: "Pre-Bolus Timing",       body: "Recommends optimal pre-meal injection window (0–20 min) based on the glycaemic index of the logged meal." },
      { icon: icoMeal,      color: C.orange,  title: "Structured Meal Logging", body: "Extensive food database including local cuisine categories — reducing carb-counting burden and improving adherence." },
      { icon: icoInsulin,   color: C.purple,  title: "BG Rise Prediction",     body: "MOB is converted into an estimated future glucose rise — letting patients anticipate hyperglycaemia before it occurs." },
      { icon: icoShield,    color: C.green,   title: "Activity Adjustment",    body: "Physical activity logging automatically adjusts dose suggestions — supporting safer exercise management." },
    ];

    features.forEach((f, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 0.35 + col * 3.12;
      const y = 1.3 + row * 2.0;
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.9, h: 1.75, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.07, h: 1.75, fill: { color: f.color }, line: { color: f.color } });
      s.addShape(pres.shapes.OVAL, { x: x + 0.18, y: y + 0.25, w: 0.48, h: 0.48, fill: { color: f.color, transparency: 15 }, line: { color: f.color } });
      s.addImage({ data: f.icon, x: x + 0.22, y: y + 0.29, w: 0.38, h: 0.38 });
      s.addText(f.title, { x: x + 0.8, y: y + 0.2, w: 2.0, h: 0.5, fontSize: 11.5, bold: true, color: C.navy });
      s.addText(f.body, { x: x + 0.18, y: y + 0.82, w: 2.6, h: 0.8, fontSize: 9.5, color: C.muted });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 6 — PHYSICIAN FEATURES
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };

    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.blue }, line: { color: C.blue } });
    s.addText("FOR PHYSICIANS", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("Evidence-Based Remote Monitoring", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    const features = [
      { icon: icoChartWhite, color: C.teal,   title: "Remote Patient Monitoring", body: "Authorised physicians access a dedicated dashboard: BG history, meal logs, insulin records, and activity data for informed pre-consultation review." },
      { icon: icoBrainWhite, color: C.purple,  title: "Glycaemic Response Analysis", body: "Meal-glucose correlation charts reveal postprandial response patterns across days or weeks — objective evidence for ICR or ISF titration." },
      { icon: icoCheckWhite, color: C.green,   title: "Clinical Parameter Review", body: "All patient-specific constants (ICR, CF, target glucose, absorption modifiers) are visible in a structured view." },
      { icon: icoDoctorWhite, color: C.orange, title: "Pattern-Based Titration", body: "Time-in-range statistics, SMBG analysis, and glycaemic variability metrics (MAGE, CV%) provide a structured evidence base for dose conversations." },
      { icon: icoShield,      color: C.teal,   title: "Consent-Gated Access", body: "Bilateral authorisation model ensures patient data sovereignty. Physicians see only consented patients — GDPR-aligned clinical data governance." },
      { icon: icoUsers,       color: C.blue,   title: "Multi-Patient Overview", body: "Full panel of authorised patients, each searchable by name — enabling efficient review workflows in specialist clinics or GP settings." },
    ];

    features.forEach((f, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 0.35 + col * 3.12;
      const y = 1.3 + row * 2.0;
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.9, h: 1.75, fill: { color: C.darkcard }, line: { color: f.color, transparency: 60 }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.07, h: 1.75, fill: { color: f.color }, line: { color: f.color } });
      s.addShape(pres.shapes.OVAL, { x: x + 0.18, y: y + 0.25, w: 0.48, h: 0.48, fill: { color: f.color, transparency: 30 }, line: { color: f.color } });
      s.addImage({ data: f.icon, x: x + 0.22, y: y + 0.29, w: 0.38, h: 0.38 });
      s.addText(f.title, { x: x + 0.8, y: y + 0.2, w: 2.0, h: 0.55, fontSize: 11.5, bold: true, color: C.white });
      s.addText(f.body, { x: x + 0.18, y: y + 0.82, w: 2.6, h: 0.8, fontSize: 9.5, color: "90A8C0" });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 7 — DASHBOARD & VISUALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("THE DASHBOARD", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("At-a-Glance Metabolic Control", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    // Central "ActiveEffectsDisplay" description
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 1.25, w: 4.2, h: 4.0, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 1.25, w: 4.2, h: 0.08, fill: { color: C.teal }, line: { color: C.teal } });
    s.addText("ActiveEffectsDisplay", { x: 0.55, y: 1.35, w: 3.9, h: 0.45, fontSize: 14, bold: true, color: C.navy });
    s.addText("Primary home-screen widget — refreshes every 60 seconds synced to wall-clock :00 boundary", {
      x: 0.55, y: 1.78, w: 3.9, h: 0.5, fontSize: 10, color: C.muted, italic: true,
    });

    const metrics = [
      { label: "Last Meter Reading",   desc: "Most recent fingerstick with time-since badge (e.g. '14 min ago')" },
      { label: "Insulin Card (IOB)",    desc: "✅ Already absorbed  ⏳ Further drop still to come" },
      { label: "Meal Card (MOB)",       desc: "✅ BG rise absorbed  ⏳ Hidden rise still coming" },
      { label: "Current Est. BG",       desc: "Baseline + cumulative net — colour-coded green/orange/red" },
      { label: "Projected Final BG",    desc: "Where BG will land if nothing new is added" },
    ];
    metrics.forEach((m, i) => {
      const y = 2.38 + i * 0.54;
      s.addShape(pres.shapes.OVAL, { x: 0.55, y: y + 0.07, w: 0.2, h: 0.2, fill: { color: C.teal }, line: { color: C.teal } });
      s.addText(m.label, { x: 0.85, y, w: 1.5, h: 0.5, fontSize: 10, bold: true, color: C.navy });
      s.addText(m.desc,  { x: 2.4, y, w: 2.0, h: 0.5, fontSize: 9.5, color: C.muted });
    });

    // Right: Visualization screens list
    const screens = [
      { name: "EffectsVisualization",  desc: "IOB + MOB evolution over next few hours", color: C.teal },
      { name: "BloodSugarVisualization", desc: "Full BG history vs. model estimates",    color: C.blue },
      { name: "MealVisualization",     desc: "Active meals, absorption rates, pending BG rise", color: C.orange },
      { name: "InsulinVisualization",  desc: "Dose history, active insulin, stacking risk",    color: C.purple },
    ];
    s.addText("Additional Visualizations", { x: 5.0, y: 1.3, w: 4.6, h: 0.4, fontSize: 13, bold: true, color: C.navy });
    screens.forEach((sc, i) => {
      const y = 1.85 + i * 0.9;
      s.addShape(pres.shapes.RECTANGLE, { x: 5.0, y, w: 4.6, h: 0.78, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x: 5.0, y, w: 0.07, h: 0.78, fill: { color: sc.color }, line: { color: sc.color } });
      s.addText(sc.name, { x: 5.2, y: y + 0.07, w: 4.2, h: 0.3, fontSize: 11, bold: true, color: C.navy });
      s.addText(sc.desc, { x: 5.2, y: y + 0.38, w: 4.2, h: 0.3, fontSize: 10, color: C.muted });
    });

    s.addText("Advisory use only — does not replace clinical judgement", {
      x: 0, y: 5.35, w: 10, h: 0.25, fontSize: 8, color: "AAAAAA", align: "center",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 8 — TECH STACK & ARCHITECTURE
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };

    s.addShape(pres.shapes.OVAL, { x: -1, y: 3, w: 5, h: 5, fill: { color: C.blue, transparency: 88 }, line: { color: C.blue, transparency: 88 } });
    s.addShape(pres.shapes.OVAL, { x: 7, y: -1, w: 5, h: 5, fill: { color: C.teal, transparency: 90 }, line: { color: C.teal, transparency: 90 } });

    s.addText("ARCHITECTURE", { x: 0.5, y: 0.3, w: 9, h: 0.35, fontSize: 10, color: C.teal, charSpacing: 4, bold: true });
    s.addText("Full-Stack Cross-Platform System", { x: 0.5, y: 0.6, w: 9, h: 0.55, fontSize: 26, bold: true, color: C.white });

    const layers = [
      { label: "Mobile (React Native / Expo)", items: ["iOS + Android + Web", "TypeScript components", "Offline-capable with sync", "Libre CGM integration"], color: C.mint },
      { label: "Frontend (React Web)",         items: ["JS + TS components", "Real-time visualization", "Doctor & Patient dashboards", "Import/Export support"],   color: C.teal },
      { label: "Backend (Python / Flask)",     items: ["MongoDB database", "Pharmacodynamics engine", "JWT authentication", "REST API endpoints"],               color: C.blue },
    ];

    layers.forEach((l, i) => {
      const x = 0.4 + i * 3.2;
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.4, w: 3.0, h: 3.8, fill: { color: C.darkcard }, line: { color: l.color, transparency: 50 }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.4, w: 3.0, h: 0.5, fill: { color: l.color, transparency: 20 }, line: { color: l.color } });
      s.addText(l.label, { x: x + 0.15, y: 1.4, w: 2.7, h: 0.5, fontSize: 11, bold: true, color: C.white, valign: "middle" });
      s.addText(l.items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < l.items.length - 1 } })), {
        x: x + 0.2, y: 2.05, w: 2.6, h: 2.9, fontSize: 11, color: "90A8C0",
      });
    });

    // Bottom: Shared constants note
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 5.1, w: 9.2, h: 0.4, fill: { color: C.darkcard }, line: { color: C.mint } });
    s.addText("Single source of truth: pharmacodynamic constants shared between Python backend and TypeScript frontend — zero drift", {
      x: 0.55, y: 5.1, w: 8.9, h: 0.4, fontSize: 10, color: C.mint, italic: true, align: "center", valign: "middle",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 9 — MARKET OPPORTUNITY
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("MARKET", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("A Growing, Underserved Market", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    // Big stats
    const stats = [
      { num: "1.3M",   label: "Insulin-pen users in Germany\nlacking structured dosing guidance", color: C.blue },
      { num: "8.7%",   label: "CAGR for global diabetes\ndigital management market",             color: C.teal },
      { num: "~26K",   label: "Conservative 2% German market\npenetration within 3 years",       color: C.green },
      { num: "€100/yr",label: "DiaTwin cost vs €3–5K/yr\nfor CGM hardware",                      color: C.orange },
    ];

    stats.forEach((st, i) => {
      const x = 0.35 + i * 2.35;
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.25, w: 2.15, h: 2.4, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.25, w: 2.15, h: 0.07, fill: { color: st.color }, line: { color: st.color } });
      s.addText(st.num, { x, y: 1.5, w: 2.15, h: 0.85, fontSize: 30, bold: true, color: st.color, align: "center" });
      s.addText(st.label, { x: x + 0.1, y: 2.35, w: 1.95, h: 1.05, fontSize: 10, color: C.muted, align: "center" });
    });

    // Competitive table
    s.addText("Competitive Landscape", { x: 0.4, y: 3.85, w: 9.2, h: 0.4, fontSize: 13, bold: true, color: C.navy });

    const tableData = [
      [
        { text: "Feature", options: { bold: true, fill: { color: C.navy }, color: C.white } },
        { text: "DiaTwin", options: { bold: true, fill: { color: C.blue }, color: C.white } },
        { text: "CGM Only", options: { bold: true, fill: { color: "607D8B" }, color: C.white } },
        { text: "Basic Apps", options: { bold: true, fill: { color: "607D8B" }, color: C.white } },
        { text: "Insulin Pumps", options: { bold: true, fill: { color: "607D8B" }, color: C.white } },
      ],
      ["Intelligent Dosing",      "✓ IOB, MOB, Projection", "✗", "✗", "✓ Closed-loop only"],
      ["Works with Insulin Pens", "✓",                       "✓",  "✓",  "✗"],
      ["Annual Cost",             "~€100",                   "€3,000–5,000", "Low", "€10,000–16,000"],
    ];

    s.addTable(tableData, {
      x: 0.4, y: 4.3, w: 9.2, h: 1.15,
      border: { pt: 0.5, color: "D1D5DB" },
      fontSize: 10,
      align: "center",
      colW: [2.2, 2.0, 1.6, 1.6, 1.8],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 10 — CLINICAL VALIDATION & TEAM
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };

    s.addShape(pres.shapes.OVAL, { x: 7, y: 3, w: 4.5, h: 4.5, fill: { color: C.blue, transparency: 85 }, line: { color: C.blue, transparency: 85 } });

    s.addText("VALIDATION & TEAM", { x: 0.5, y: 0.3, w: 9, h: 0.35, fontSize: 10, color: C.teal, charSpacing: 4, bold: true });
    s.addText("Built on Clinical Evidence", { x: 0.5, y: 0.6, w: 9, h: 0.55, fontSize: 26, bold: true, color: C.white });

    // Left: Validation badges
    const validations = [
      { label: "Master's Thesis", value: "Grade 1.6 'Excellent'", sub: "Core algorithms validated at DIT" },
      { label: "Clinical Utility", value: "8.7 / 10",             sub: "Scored by certified diabetologist" },
      { label: "Dataset",         value: "50,000+ pairs",          sub: "Real clinical meal-outcome data" },
      { label: "Readiness",       value: "TRL 4–5",                sub: "Web + mobile prototypes operational" },
    ];

    validations.forEach((v, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const x = 0.4 + col * 2.5;
      const y = 1.4 + row * 1.45;
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.3, h: 1.2, fill: { color: C.darkcard }, line: { color: C.teal, transparency: 50 }, shadow: makeShadow() });
      s.addText(v.value, { x, y: y + 0.1, w: 2.3, h: 0.5, fontSize: 20, bold: true, color: C.mint, align: "center" });
      s.addText(v.label, { x, y: y + 0.55, w: 2.3, h: 0.3, fontSize: 10, bold: true, color: C.white, align: "center" });
      s.addText(v.sub,   { x, y: y + 0.82, w: 2.3, h: 0.28, fontSize: 8.5, color: "7090B0", align: "center" });
    });

    // Right: Team & Advisors
    s.addText("Team & Advisors", { x: 5.5, y: 1.35, w: 4.1, h: 0.4, fontSize: 13, bold: true, color: C.white });

    const team = [
      { name: "Ali Attia",               role: "Lead — Pharmacist, M.Sc. Digital Health" },
      { name: "Prof. Dr. Klaus Parhofer", role: "LMU Munich — Protocol Advisor" },
      { name: "Prof. Dr. Katarina Braune", role: "Charité/HPI — Clinical Trial Co-PI" },
      { name: "ForTra Consultants",       role: "Regulatory pathway (CE IIa / DiGA)" },
    ];
    team.forEach((m, i) => {
      s.addShape(pres.shapes.RECTANGLE, { x: 5.5, y: 1.85 + i * 0.76, w: 4.1, h: 0.65, fill: { color: C.darkcard }, line: { color: "2A4A6A" }, shadow: makeShadow() });
      s.addText(m.name, { x: 5.65, y: 1.88 + i * 0.76, w: 3.8, h: 0.28, fontSize: 11, bold: true, color: C.white });
      s.addText(m.role, { x: 5.65, y: 2.13 + i * 0.76, w: 3.8, h: 0.28, fontSize: 9.5, color: "7090B0" });
    });

    // Partners
    s.addText("Partnerships: Charité · LMU Network · Abbott / Dexcom (API discussions)", {
      x: 0.4, y: 5.1, w: 9.2, h: 0.38, fontSize: 10, color: "7090B0", align: "center", italic: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 11 — ROADMAP
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("ROADMAP", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("Path to CE IIa Certification & DiGA", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    // Timeline line
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 2.8, w: 8.8, h: 0.06, fill: { color: C.teal }, line: { color: C.teal } });

    const phases = [
      { x: 0.5,  label: "Now",        sub: "TRL 4–5",           items: ["Core algorithms validated", "Web + mobile prototypes", "Clinical utility 8.7/10"], color: C.green },
      { x: 2.85, label: "Phase I",    sub: "EXIST Funding",     items: ["Team expansion", "Full-stack dev", "DiGA strategy co-founder"], color: C.teal },
      { x: 5.2,  label: "Phase II",   sub: "TRL 6–7",           items: ["Clinical trial N=100, 6 months", "Safety/efficacy validation", "Physician workflow integration"], color: C.blue },
      { x: 7.55, label: "Phase III",  sub: "Regulatory",        items: ["CE Class IIa certification", "DiGA pathway approval", "International expansion"], color: C.purple },
    ];

    phases.forEach((ph) => {
      // Dot on timeline
      s.addShape(pres.shapes.OVAL, { x: ph.x + 0.85, y: 2.65, w: 0.32, h: 0.32, fill: { color: ph.color }, line: { color: ph.color } });
      // Card above
      s.addShape(pres.shapes.RECTANGLE, { x: ph.x, y: 1.25, w: 2.1, h: 1.32, fill: { color: C.white }, line: { color: ph.color, transparency: 40 }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x: ph.x, y: 1.25, w: 2.1, h: 0.07, fill: { color: ph.color }, line: { color: ph.color } });
      s.addText(ph.label, { x: ph.x + 0.08, y: 1.28, w: 1.0, h: 0.38, fontSize: 13, bold: true, color: ph.color, margin: 0 });
      s.addText(ph.sub,   { x: ph.x + 0.08, y: 1.63, w: 1.9, h: 0.28, fontSize: 9,  color: C.muted, margin: 0 });

      // Card below timeline
      s.addShape(pres.shapes.RECTANGLE, { x: ph.x, y: 3.05, w: 2.1, h: 2.35, fill: { color: C.white }, line: { color: ph.color, transparency: 60 }, shadow: makeShadow() });
      s.addText(ph.items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < ph.items.length - 1 } })), {
        x: ph.x + 0.1, y: 3.1, w: 1.9, h: 2.2, fontSize: 10, color: C.navy,
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 12 — TWO TARGET CUSTOMERS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const icoWifi      = await iconPng(FaWifi,        "#FFFFFF");
    const icoFinger    = await iconPng(FaFingerprint,  "#FFFFFF");
    const icoExchange  = await iconPng(FaExchangeAlt,  "#FFFFFF");

    const s = pres.addSlide();
    s.background = { color: C.offwhite };

    // Header
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 1.1, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText("WHO WE SERVE", { x: 0.5, y: 0, w: 5, h: 1.1, fontSize: 11, color: C.mint, bold: true, charSpacing: 4, valign: "middle" });
    s.addText("Two Target Patient Groups", { x: 0.5, y: 0, w: 9, h: 1.1, fontSize: 22, bold: true, color: C.white, align: "right", valign: "middle" });

    // ── LEFT: CGM Users ──────────────────────────────────────────────────────
    s.addShape(pres.shapes.RECTANGLE, { x: 0.35, y: 1.25, w: 4.35, h: 4.1, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.35, y: 1.25, w: 4.35, h: 0.08, fill: { color: C.teal }, line: { color: C.teal } });

    // Header band
    s.addShape(pres.shapes.RECTANGLE, { x: 0.35, y: 1.25, w: 4.35, h: 0.72, fill: { color: C.teal, transparency: 88 }, line: { color: C.teal, transparency: 88 } });
    // Icon circle
    s.addShape(pres.shapes.OVAL, { x: 0.6, y: 1.35, w: 0.58, h: 0.58, fill: { color: C.teal }, line: { color: C.teal } });
    s.addImage({ data: icoWifi, x: 0.67, y: 1.42, w: 0.44, h: 0.44 });
    s.addText("Continuous CGM Users", { x: 1.3, y: 1.35, w: 3.2, h: 0.32, fontSize: 14, bold: true, color: C.navy, margin: 0 });
    s.addText("Germany / EU · Primary market", { x: 1.3, y: 1.66, w: 3.2, h: 0.25, fontSize: 10, color: C.teal, italic: true, margin: 0 });

    // Context
    s.addText("Already wearing a CGM sensor — but missing structured dosing guidance to act on their data.", {
      x: 0.55, y: 2.12, w: 3.95, h: 0.55, fontSize: 11, color: C.muted,
    });

    // What DiaTwin adds
    s.addText("What DiaTwin adds:", { x: 0.55, y: 2.75, w: 3.8, h: 0.3, fontSize: 11, bold: true, color: C.navy });
    const cgmPoints = [
      "Net Effect analysis on live glucose trends",
      "4-hour BG projection (IOB + MOB overlay)",
      "Intelligent bolus advice beyond trend arrows",
      "Reduces unnecessary corrective doses",
      "Saves €3,000–5,000/year vs. CGM hardware alone",
    ];
    s.addText(cgmPoints.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < cgmPoints.length - 1 } })), {
      x: 0.55, y: 3.1, w: 3.95, h: 2.0, fontSize: 11, color: C.navy,
    });

    // Cost badge
    s.addShape(pres.shapes.RECTANGLE, { x: 0.55, y: 4.95, w: 3.95, h: 0.3, fill: { color: C.teal, transparency: 88 }, line: { color: C.teal } });
    s.addText("CGM Companion — keeps precision, slashes cost", {
      x: 0.55, y: 4.95, w: 3.95, h: 0.3, fontSize: 9.5, color: C.teal, align: "center", valign: "middle", italic: true,
    });

    // ── Divider ──────────────────────────────────────────────────────────────
    s.addShape(pres.shapes.OVAL, { x: 4.78, y: 2.75, w: 0.44, h: 0.44, fill: { color: C.navy }, line: { color: C.navy } });
    s.addImage({ data: icoExchange, x: 4.83, y: 2.8, w: 0.34, h: 0.34 });
    s.addText("VS", { x: 4.72, y: 3.28, w: 0.56, h: 0.25, fontSize: 9, bold: true, color: C.muted, align: "center" });

    // ── RIGHT: SMBG Users ────────────────────────────────────────────────────
    s.addShape(pres.shapes.RECTANGLE, { x: 5.3, y: 1.25, w: 4.35, h: 4.1, fill: { color: C.white }, line: { color: "E2E8F0" }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.3, y: 1.25, w: 4.35, h: 0.08, fill: { color: C.purple }, line: { color: C.purple } });

    s.addShape(pres.shapes.RECTANGLE, { x: 5.3, y: 1.25, w: 4.35, h: 0.72, fill: { color: C.purple, transparency: 88 }, line: { color: C.purple, transparency: 88 } });
    s.addShape(pres.shapes.OVAL, { x: 5.55, y: 1.35, w: 0.58, h: 0.58, fill: { color: C.purple }, line: { color: C.purple } });
    s.addImage({ data: icoFinger, x: 5.62, y: 1.42, w: 0.44, h: 0.44 });
    s.addText("SMBG / Finger-Prick Users", { x: 6.25, y: 1.35, w: 3.2, h: 0.32, fontSize: 14, bold: true, color: C.navy, margin: 0 });
    s.addText("Global · Largest underserved group", { x: 6.25, y: 1.66, w: 3.2, h: 0.25, fontSize: 10, color: C.purple, italic: true, margin: 0 });

    s.addText("3–4 daily finger-sticks — significant gaps between readings where glucose direction is unknown.", {
      x: 5.5, y: 2.12, w: 3.95, h: 0.55, fontSize: 11, color: C.muted,
    });

    s.addText("What DiaTwin provides:", { x: 5.5, y: 2.75, w: 3.8, h: 0.3, fontSize: 11, bold: true, color: C.navy });
    const smbgPoints = [
      "Intelligent Glucose Estimation between readings",
      "MOB modelling (5 meal types, portion-based)",
      "IOB tracking across overlapping doses",
      "Future glucose projection without CGM",
      "Trend insight at a fraction of CGM cost (~€100/yr)",
    ];
    s.addText(smbgPoints.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < smbgPoints.length - 1 } })), {
      x: 5.5, y: 3.1, w: 3.95, h: 2.0, fontSize: 11, color: C.navy,
    });

    s.addShape(pres.shapes.RECTANGLE, { x: 5.5, y: 4.95, w: 3.95, h: 0.3, fill: { color: C.purple, transparency: 88 }, line: { color: C.purple } });
    s.addText("CGM-level insight — without the sensor", {
      x: 5.5, y: 4.95, w: 3.95, h: 0.3, fontSize: 9.5, color: C.purple, align: "center", valign: "middle", italic: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 13 — PHYSICIAN-CONTROLLED PARAMETERS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const icoSliders = await iconPng(FaSlidersH,    "#FFFFFF");
    const icoLock    = await iconPng(FaLock,         "#FFFFFF");
    const icoEdit    = await iconPng(FaEdit,         "#FFFFFF");
    const icoClip    = await iconPng(FaEdit,"#FFFFFF");

    const s = pres.addSlide();
    s.background = { color: C.navy };

    // Background decoration
    s.addShape(pres.shapes.OVAL, { x: 6.5, y: -1, w: 5.5, h: 5.5, fill: { color: C.blue, transparency: 85 }, line: { color: C.blue, transparency: 85 } });
    s.addShape(pres.shapes.OVAL, { x: -1.5, y: 3.5, w: 4, h: 4, fill: { color: C.teal, transparency: 90 }, line: { color: C.teal, transparency: 90 } });

    // Header
    s.addText("PHYSICIAN CONTROL", { x: 0.5, y: 0.3, w: 9, h: 0.35, fontSize: 10, color: C.teal, bold: true, charSpacing: 4 });
    s.addText("All Parameters Set & Managed by Doctors", { x: 0.5, y: 0.6, w: 9, h: 0.6, fontSize: 26, bold: true, color: C.white });

    s.addText("DiaTwin does not allow patients to modify clinical parameters. Every threshold, ratio, and limit is prescribed and\nadjusted exclusively by the treating physician — ensuring safety, clinical accountability, and regulatory compliance.", {
      x: 0.5, y: 1.28, w: 9, h: 0.75, fontSize: 12, color: "90A8C0", align: "left",
    });

    // Divider line
    s.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: 2.08, w: 9, h: 0.04, fill: { color: C.teal, transparency: 60 }, line: { color: C.teal, transparency: 60 } });

    // ── Parameter cards (2 rows × 3) ─────────────────────────────────────────
    const params = [
      {
        icon: icoSliders, color: C.teal,   label: "Insulin-to-Carb Ratio (ICR)",
        who: "Set by physician",
        desc: "Defines how many grams of carbohydrate one unit of insulin covers. Personalised per patient and time-of-day.",
      },
      {
        icon: icoEdit,   color: C.blue,   label: "Correction / Sensitivity Factor",
        who: "Set by physician",
        desc: "How much 1 unit of insulin lowers blood glucose. Used to calculate correction boluses against a target BG.",
      },
      {
        icon: icoLock,   color: C.purple, label: "Target Blood Glucose",
        who: "Set by physician",
        desc: "The individual BG goal for each patient — used to calculate the correction delta and colour-code estimates.",
      },
      {
        icon: icoLock,   color: C.orange, label: "Safety Limits & Dose Caps",
        who: "Set by physician",
        desc: "Maximum allowed bolus per dose and per day. Hard stops prevent the system from suggesting unsafe corrections.",
      },
      {
        icon: icoClip,   color: C.green,  label: "Absorption Modifiers",
        who: "Set by physician",
        desc: "Patient-specific multiplier that scales the gamma-distribution absorption curves for meals and insulin activity.",
      },
      {
        icon: icoSliders, color: C.mint,  label: "Basal Rate Equivalent",
        who: "Set by physician",
        desc: "Long-acting insulin baseline parameters — onset, duration, and activity profile used in IOB calculations.",
      },
    ];

    params.forEach((p, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 0.4 + col * 3.08;
      const y = 2.2 + row * 1.55;

      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 2.88, h: 1.38, fill: { color: C.darkcard }, line: { color: p.color, transparency: 55 }, shadow: makeShadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.06, h: 1.38, fill: { color: p.color }, line: { color: p.color } });

      // Icon circle
      s.addShape(pres.shapes.OVAL, { x: x + 0.15, y: y + 0.2, w: 0.44, h: 0.44, fill: { color: p.color, transparency: 25 }, line: { color: p.color } });
      s.addImage({ data: p.icon, x: x + 0.19, y: y + 0.24, w: 0.35, h: 0.35 });

      s.addText(p.label, { x: x + 0.72, y: y + 0.14, w: 1.55, h: 0.35, fontSize: 11, bold: true, color: C.white, margin: 0 });
      // "Set by physician" badge — positioned below title
      s.addShape(pres.shapes.RECTANGLE, { x: x + 0.14, y: y + 0.5, w: 1.3, h: 0.22, fill: { color: p.color, transparency: 72 }, line: { color: p.color } });
      s.addText("👨‍⚕️ Physician only", { x: x + 0.14, y: y + 0.5, w: 1.3, h: 0.22, fontSize: 7.5, color: p.color, align: "center", valign: "middle", bold: true });
      s.addText(p.desc,  { x: x + 0.14, y: y + 0.72, w: 2.62, h: 0.58, fontSize: 9.5, color: "7090B0" });
    });

    // Bottom safety note
    s.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 5.15, w: 9.2, h: 0.38, fill: { color: C.darkcard }, line: { color: C.teal } });
    s.addText("Patients interact only with logging and viewing functions. Parameter access is gated behind physician authentication.", {
      x: 0.5, y: 5.15, w: 9.0, h: 0.38, fontSize: 10, color: C.mint, align: "center", valign: "middle", italic: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDE 14 — CLOSING
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };

    s.addShape(pres.shapes.OVAL, { x: -2, y: -2, w: 7, h: 7, fill: { color: C.blue, transparency: 80 }, line: { color: C.blue, transparency: 80 } });
    s.addShape(pres.shapes.OVAL, { x: 6.5, y: 2.5, w: 5, h: 5, fill: { color: C.teal, transparency: 85 }, line: { color: C.teal, transparency: 85 } });

    s.addText("DiaTwin", { x: 0.5, y: 0.8, w: 9, h: 1.1, fontSize: 56, fontFace: "Calibri", bold: true, color: C.white, align: "center" });
    s.addText("Diabetes Digital Twin", { x: 0.5, y: 1.85, w: 9, h: 0.5, fontSize: 20, color: C.mint, align: "center" });

    s.addText("From reactive monitoring\nto predictive self-care.", {
      x: 1.5, y: 2.55, w: 7, h: 1.2, fontSize: 22, fontFace: "Calibri", color: "B0C4D8", align: "center", italic: true,
    });

    // Three summary points
    const pts = [
      { icon: icoCheckWhite, text: "Pharmacodynamic precision for every patient, every dose" },
      { icon: icoChartWhite,  text: "Real-time IOB + MOB — glucose predicted, not just measured" },
      { icon: icoDoctorWhite, text: "Physician-supervised, patient-centred, GDPR-compliant" },
    ];
    pts.forEach((pt, i) => {
      s.addShape(pres.shapes.OVAL, { x: 2.8, y: 3.9 + i * 0.48, w: 0.32, h: 0.32, fill: { color: C.teal }, line: { color: C.teal } });
      s.addImage({ data: pt.icon, x: 2.84, y: 3.93 + i * 0.48, w: 0.25, h: 0.25 });
      s.addText(pt.text, { x: 3.25, y: 3.88 + i * 0.48, w: 5.5, h: 0.38, fontSize: 12, color: C.white, margin: 0 });
    });

    s.addText("Advisory use only — does not replace clinical judgement", {
      x: 0, y: 5.3, w: 10, h: 0.25, fontSize: 8, color: "405060", align: "center",
    });
  }

  await pres.writeFile({ fileName: "/mnt/user-data/outputs/DiaTwin_Presentation.pptx" });
  console.log("✅ Saved to /mnt/user-data/outputs/DiaTwin_Presentation.pptx");
}

build().catch(console.error);
