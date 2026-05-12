// build-presentation.cjs
// Generates henry-presentation.pptx — a dark trading-terminal styled deck
// describing Henry The Hoover for technical traders / subscribers / investors.
//
// Run:  node build-presentation.cjs

const pptxgen = require("pptxgenjs");

// -------------------------------------------------------------
// Palette  (dark trading-terminal aesthetic)
// -------------------------------------------------------------
const C = {
  bg:      "08090D", // page background
  panel:   "11141B", // card surface
  panel2:  "161A23", // alt card
  border:  "1F2735",
  divider: "2A3344",
  text:    "E6EDF3",
  muted:   "7A8390",
  dim:     "4A5260",
  cyan:    "00D4FF",
  green:   "00E5A0",
  red:     "FF4466",
  amber:   "FFB830",
  purple:  "8B5CF6",
};

const FONT = "Calibri";
const MONO = "Consolas";

// -------------------------------------------------------------
// Presentation setup
// -------------------------------------------------------------
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.3" × 7.5"
pres.author = "Henry The Hoover";
pres.title  = "Henry The Hoover — AI Futures Trading Terminal";

const W = 13.3;
const H = 7.5;

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function addBackground(slide) {
  slide.background = { color: C.bg };
}

function addFooter(slide, pageNum) {
  // Top accent strip
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 0.04,
    fill: { color: C.cyan }, line: { color: C.cyan, width: 0 },
  });

  // Footer divider
  slide.addShape(pres.shapes.LINE, {
    x: 0.4, y: H - 0.42, w: W - 0.8, h: 0,
    line: { color: C.divider, width: 0.75 },
  });

  // Footer left
  slide.addText("HENRY THE HOOVER · henrythehoover.com", {
    x: 0.4, y: H - 0.38, w: 7, h: 0.3,
    fontSize: 9, fontFace: MONO, color: C.muted,
    valign: "middle", margin: 0,
  });

  // Footer right
  if (pageNum != null) {
    slide.addText(String(pageNum).padStart(2, "0"), {
      x: W - 1.2, y: H - 0.38, w: 0.8, h: 0.3,
      fontSize: 9, fontFace: MONO, color: C.cyan,
      align: "right", valign: "middle", margin: 0,
    });
  }
}

function addSlideHeader(slide, eyebrow, title) {
  // Eyebrow (small monospace label)
  slide.addText(eyebrow, {
    x: 0.5, y: 0.35, w: 8, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.cyan,
    bold: true, charSpacing: 4, margin: 0,
  });

  // Title
  slide.addText(title, {
    x: 0.5, y: 0.7, w: 12.3, h: 0.7,
    fontSize: 30, fontFace: FONT, color: C.text,
    bold: true, margin: 0,
  });

  // Underline accent — short cyan bar
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: 1.45, w: 0.6, h: 0.04,
    fill: { color: C.cyan }, line: { color: C.cyan, width: 0 },
  });
}

// Card with optional left accent bar.
function addCard(slide, x, y, w, h, fillColor, accentColor) {
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: fillColor || C.panel },
    line: { color: C.border, width: 0.75 },
  });
  if (accentColor) {
    slide.addShape(pres.shapes.RECTANGLE, {
      x, y, w: 0.07, h,
      fill: { color: accentColor },
      line: { color: accentColor, width: 0 },
    });
  }
}

// Numbered step card with tag, title, and body.
function addStepCard(slide, x, y, w, h, num, title, body, accent) {
  addCard(slide, x, y, w, h, C.panel, accent);
  // Number badge
  slide.addText(String(num).padStart(2, "0"), {
    x: x + 0.2, y: y + 0.18, w: 0.7, h: 0.4,
    fontSize: 22, fontFace: MONO, color: accent,
    bold: true, valign: "middle", margin: 0,
  });
  // Title
  slide.addText(title, {
    x: x + 0.95, y: y + 0.18, w: w - 1.1, h: 0.4,
    fontSize: 14, fontFace: FONT, color: C.text,
    bold: true, valign: "middle", margin: 0,
  });
  // Body
  slide.addText(body, {
    x: x + 0.25, y: y + 0.7, w: w - 0.45, h: h - 0.85,
    fontSize: 11, fontFace: FONT, color: C.muted,
    valign: "top", margin: 0,
  });
}

// =============================================================
// SLIDE 1 — TITLE
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);

  // top accent strip
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 0.04,
    fill: { color: C.cyan }, line: { color: C.cyan, width: 0 },
  });

  // Eyebrow tag
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 1.7, w: 1.7, h: 0.36,
    fill: { color: "0E2734" },
    line: { color: C.cyan, width: 0.75 },
  });
  s.addText("● LIVE · v2026", {
    x: 0.6, y: 1.7, w: 1.7, h: 0.36,
    fontSize: 10, fontFace: MONO, color: C.cyan,
    bold: true, align: "center", valign: "middle", margin: 0,
    charSpacing: 3,
  });

  // Big monospace title
  s.addText("HENRY", {
    x: 0.55, y: 2.1, w: 12, h: 1.5,
    fontSize: 110, fontFace: FONT, color: C.text,
    bold: true, charSpacing: 8, margin: 0,
  });
  s.addText("THE HOOVER", {
    x: 0.55, y: 3.3, w: 12, h: 1.0,
    fontSize: 64, fontFace: FONT, color: C.cyan,
    bold: true, charSpacing: 6, margin: 0,
  });

  // Subtitle
  s.addText("AI FUTURES TRADING TERMINAL", {
    x: 0.6, y: 4.4, w: 12, h: 0.5,
    fontSize: 18, fontFace: MONO, color: C.muted,
    charSpacing: 6, margin: 0,
  });

  // Tagline cards
  const tagY = 5.3;
  const tagH = 0.85;
  const tagW = 4.0;
  const gap  = 0.18;

  function tag(x, label, value, color) {
    addCard(s, x, tagY, tagW, tagH, C.panel, color);
    s.addText(label, {
      x: x + 0.2, y: tagY + 0.1, w: tagW - 0.3, h: 0.28,
      fontSize: 9, fontFace: MONO, color: C.muted,
      bold: true, charSpacing: 2, margin: 0,
    });
    s.addText(value, {
      x: x + 0.2, y: tagY + 0.38, w: tagW - 0.3, h: 0.42,
      fontSize: 13, fontFace: FONT, color: C.text,
      bold: true, valign: "middle", margin: 0,
    });
  }
  tag(0.6,                            "AUTONOMOUS",  "Server-side AI scanning",  C.cyan);
  tag(0.6 + tagW + gap,               "CONCURRENT",  "Multi-pair parallel scan", C.green);
  tag(0.6 + (tagW + gap) * 2,         "CONFLUENCE",  "11 layered data sources",  C.amber);

  // Footer brand line
  s.addShape(pres.shapes.LINE, {
    x: 0.6, y: H - 0.55, w: W - 1.2, h: 0,
    line: { color: C.divider, width: 0.75 },
  });
  s.addText("henrythehoover.com  ·  Powered by Claude Sonnet 4.6", {
    x: 0.6, y: H - 0.45, w: 12, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.muted, margin: 0,
  });
}

// =============================================================
// SLIDE 2 — WHAT IS HENRY?
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 02 / OVERVIEW", "What is Henry?");

  // Left: paragraph
  addCard(s, 0.5, 1.9, 6.8, 4.6, C.panel, C.cyan);
  s.addText("Autonomous AI trading assistant.", {
    x: 0.75, y: 2.1, w: 6.4, h: 0.4,
    fontSize: 16, fontFace: FONT, color: C.text,
    bold: true, margin: 0,
  });
  s.addText([
    { text: "Henry scans futures markets ", options: { color: C.text } },
    { text: "24/7", options: { color: C.cyan, bold: true } },
    { text: ", generates trade signals using ", options: { color: C.text } },
    { text: "Claude Sonnet 4.6", options: { color: C.cyan, bold: true } },
    { text: ", and monitors entries and exits in real time. Everything is posted to Discord and pushed to your phone.", options: { color: C.text } },
  ], {
    x: 0.75, y: 2.55, w: 6.4, h: 1.2,
    fontSize: 13, fontFace: FONT, valign: "top", margin: 0,
  });

  s.addText([
    { text: "▸  Runs server-side — no browser needed.", options: { breakLine: true, color: C.text } },
    { text: "▸  Built on Claude Sonnet 4.6 with custom prompts.", options: { breakLine: true, color: C.text } },
    { text: "▸  11 layered data sources per signal.", options: { breakLine: true, color: C.text } },
    { text: "▸  Multi-exchange routing for clean prints.", options: { color: C.text } },
  ], {
    x: 0.75, y: 3.85, w: 6.4, h: 2.5,
    fontSize: 12.5, fontFace: FONT, valign: "top", margin: 0, paraSpaceAfter: 6,
  });

  // Right: stats grid
  const gx = 7.6, gw = 5.2, gy = 1.9;
  function stat(x, y, w, h, label, value, color) {
    addCard(s, x, y, w, h, C.panel2, color);
    s.addText(label, {
      x: x + 0.2, y: y + 0.15, w: w - 0.3, h: 0.28,
      fontSize: 9, fontFace: MONO, color: C.muted, bold: true, charSpacing: 2, margin: 0,
    });
    s.addText(value, {
      x: x + 0.2, y: y + 0.42, w: w - 0.3, h: h - 0.5,
      fontSize: 22, fontFace: FONT, color: color, bold: true, valign: "top", margin: 0,
    });
  }
  stat(gx,             gy,             2.5, 1.4, "PAIRS",    "23",      C.cyan);
  stat(gx + 2.7,       gy,             2.5, 1.4, "EXCHANGES","4",       C.green);
  stat(gx,             gy + 1.55,      2.5, 1.4, "DATA SRC", "11",      C.amber);
  stat(gx + 2.7,       gy + 1.55,      2.5, 1.4, "MODEL",    "v4.6",    C.purple);

  // Exchanges card
  addCard(s, gx, gy + 3.1, 5.2, 1.5, C.panel, C.green);
  s.addText("MULTI-EXCHANGE ROUTING", {
    x: gx + 0.2, y: gy + 3.2, w: 5.0, h: 0.25,
    fontSize: 9, fontFace: MONO, color: C.muted, bold: true, charSpacing: 2, margin: 0,
  });
  s.addText("Weex  ·  Binance Futures  ·  Hyperliquid  ·  Polygon", {
    x: gx + 0.2, y: gy + 3.5, w: 5.0, h: 0.4,
    fontSize: 13, fontFace: FONT, color: C.text, bold: true, margin: 0,
  });
  s.addText("BTC · ETH · SOL · XRP · DOGE · AVAX · AAVE · PEPE · GOLD · BNB · ADA · DOT · LINK · SUI · ARB · OP · NEAR · INJ · XAUT · XAG · XTI · XBR", {
    x: gx + 0.2, y: gy + 3.9, w: 5.0, h: 0.6,
    fontSize: 9, fontFace: MONO, color: C.muted, valign: "top", margin: 0,
  });

  addFooter(s, 2);
}

// =============================================================
// SLIDE 3 — THE PROBLEM
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 03 / THE PROBLEM", "Manual trading doesn't scale.");

  const items = [
    { t: "24/7 markets, finite humans", b: "Crypto never closes. Watching multiple pairs around the clock burns out even disciplined traders." },
    { t: "“AI signal” services are shallow", b: "Most are generic prompts on cheap models with zero market context. No HTF, no order flow, no news." },
    { t: "Setups missed during sleep & work", b: "The best trigger of the day rarely fires when you're staring at the chart." },
    { t: "Backtesting & validation is hard", b: "Changing a prompt or rule and proving it improved anything? Almost no one actually measures it." },
    { t: "Risk management is bolted-on", b: "Most signal services hand you an entry. You're left to size, breakeven, and circuit-break manually." },
  ];

  // 5 cards in a 2-row grid (3 + 2)
  const colW = 4.0, colH = 1.85, gap = 0.18;
  const startY = 2.0;
  const startX = (W - (3 * colW + 2 * gap)) / 2;
  const accents = [C.red, C.red, C.amber, C.amber, C.cyan];

  items.forEach((it, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = startX + col * (colW + gap);
    const y = startY + row * (colH + gap);
    addCard(s, x, y, colW, colH, C.panel, accents[i]);
    s.addText(it.t, {
      x: x + 0.25, y: y + 0.18, w: colW - 0.4, h: 0.45,
      fontSize: 13, fontFace: FONT, color: C.text, bold: true, valign: "top", margin: 0,
    });
    s.addText(it.b, {
      x: x + 0.25, y: y + 0.7, w: colW - 0.4, h: colH - 0.85,
      fontSize: 10.5, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  });

  // Bottom red note
  addCard(s, 0.6, startY + 2 * (colH + gap) + 0.1, W - 1.2, 0.7, C.panel2, C.red);
  s.addText("→  The result: missed opportunities, stale prompts, and uncontrolled drawdowns.", {
    x: 0.85, y: startY + 2 * (colH + gap) + 0.1, w: W - 1.7, h: 0.7,
    fontSize: 13, fontFace: FONT, color: C.text, bold: true, valign: "middle", margin: 0,
  });

  addFooter(s, 3);
}

// =============================================================
// SLIDE 4 — THE SOLUTION
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 04 / THE SOLUTION", "An always-on AI co-pilot with real risk controls.");

  const items = [
    { t: "Continuous server-side scanning", b: "Every pair, every 30s, in parallel. Browser closed? Henry keeps working." },
    { t: "Pre-AI confluence filter", b: "A cheap score gates the expensive AI call. Cuts ~40% of weak triggers before spending tokens." },
    { t: "11-source AI prompt", b: "Each signal sees HTF, BTC/DXY, funding, OI, liquidity, footprint, CVD, broker spread, news, calendar, and the trigger itself." },
    { t: "Autonomous trade lifecycle", b: "Entry watcher → BE alert → TP/SL → expiry. All tracked server-side and reconciled with Supabase." },
    { t: "Built-in circuit breaker", b: "Three SLs on a pair? It's paused for 6 hours. Three across the board? 2-hour global cool-off." },
    { t: "Discord + push notifications", b: "Rich embeds for triggers, BE moves, outcomes. Phone push on entry / TP / SL — even with the app closed." },
  ];

  const colW = 4.0, colH = 1.85, gap = 0.18;
  const startY = 1.95;
  const startX = (W - (3 * colW + 2 * gap)) / 2;
  const accent = [C.cyan, C.cyan, C.green, C.green, C.amber, C.purple];

  items.forEach((it, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = startX + col * (colW + gap);
    const y = startY + row * (colH + gap);
    addCard(s, x, y, colW, colH, C.panel, accent[i]);
    s.addText("✓", {
      x: x + 0.2, y: y + 0.18, w: 0.4, h: 0.4,
      fontSize: 18, fontFace: FONT, color: accent[i], bold: true, valign: "middle", margin: 0,
    });
    s.addText(it.t, {
      x: x + 0.6, y: y + 0.18, w: colW - 0.75, h: 0.45,
      fontSize: 13, fontFace: FONT, color: C.text, bold: true, valign: "top", margin: 0,
    });
    s.addText(it.b, {
      x: x + 0.25, y: y + 0.72, w: colW - 0.4, h: colH - 0.85,
      fontSize: 10.5, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  });

  addFooter(s, 4);
}

// =============================================================
// SLIDE 5 — SYSTEM ARCHITECTURE
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 05 / ARCHITECTURE", "System overview");

  // Three vertical lanes: Frontend / Backend / External
  const laneY = 2.0;
  const laneH = 4.6;
  const laneW = 4.05;
  const gap = 0.2;
  const lanes = [
    { x: 0.5,                     title: "FRONTEND",    color: C.cyan },
    { x: 0.5 + laneW + gap,       title: "BACKEND",     color: C.green },
    { x: 0.5 + (laneW + gap) * 2, title: "EXTERNAL",    color: C.amber },
  ];
  lanes.forEach(l => {
    addCard(s, l.x, laneY, laneW, laneH, C.panel, l.color);
    s.addText(l.title, {
      x: l.x + 0.2, y: laneY + 0.15, w: laneW - 0.4, h: 0.3,
      fontSize: 10, fontFace: MONO, color: l.color, bold: true, charSpacing: 3, margin: 0,
    });
  });

  // Helper: small node inside a lane
  function node(laneIdx, slot, label, sub, color) {
    const l = lanes[laneIdx];
    const ny = laneY + 0.6 + slot * 0.78;
    s.addShape(pres.shapes.RECTANGLE, {
      x: l.x + 0.25, y: ny, w: laneW - 0.5, h: 0.62,
      fill: { color: C.panel2 },
      line: { color: C.border, width: 0.75 },
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: l.x + 0.25, y: ny, w: 0.06, h: 0.62,
      fill: { color: color || l.color },
      line: { color: color || l.color, width: 0 },
    });
    s.addText(label, {
      x: l.x + 0.4, y: ny + 0.05, w: laneW - 0.7, h: 0.3,
      fontSize: 12, fontFace: FONT, color: C.text, bold: true, valign: "middle", margin: 0,
    });
    s.addText(sub, {
      x: l.x + 0.4, y: ny + 0.32, w: laneW - 0.7, h: 0.28,
      fontSize: 9, fontFace: MONO, color: C.muted, valign: "middle", margin: 0,
    });
  }

  // Frontend lane
  node(0, 0, "Browser UI",          "vanilla JS · LightweightCharts");
  node(0, 1, "Manual analysis",     "ad-hoc signal generation");
  node(0, 2, "Performance dash",    "/performance");
  node(0, 3, "Backtest mode",       "/backtest");
  node(0, 4, "PWA / Web Push",      "phone notifications");

  // Backend lane
  node(1, 0, "Express server",      "Node 22 · Railway");
  node(1, 1, "Auto-scan engine",    "30s × N pairs · parallel");
  node(1, 2, "Trade monitor",       "entry → BE → TP/SL");
  node(1, 3, "SSE multiplexer",     "live prices to browser");
  node(1, 4, "Supabase client",     "auth + signal history");

  // External lane
  node(2, 0, "Anthropic API",       "Claude Sonnet 4.6", C.purple);
  node(2, 1, "Weex / Binance / HL", "candles · funding · OI", C.green);
  node(2, 2, "Polygon",             "DXY · Gold context", C.amber);
  node(2, 3, "Discord webhooks",    "auto / status / journal", C.cyan);
  node(2, 4, "Paddle",              "subscription billing", C.muted);

  // Arrows between lanes
  function arrow(x1, x2, y) {
    s.addShape(pres.shapes.LINE, {
      x: x1, y, w: x2 - x1, h: 0,
      line: { color: C.cyan, width: 1.25, endArrowType: "triangle" },
    });
  }
  arrow(lanes[0].x + laneW, lanes[1].x, laneY + 0.93);
  arrow(lanes[1].x, lanes[0].x + laneW, laneY + 1.05);
  arrow(lanes[1].x + laneW, lanes[2].x, laneY + 0.93);
  arrow(lanes[2].x, lanes[1].x + laneW, laneY + 1.05);

  addFooter(s, 5);
}

// =============================================================
// SLIDE 6 — TRADING PIPELINE
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 06 / PIPELINE", "From candle to outcome — six stages.");

  const steps = [
    { t: "Trigger Detection",    b: "Server scans the latest 30 candles every 30s for BOS, sweep, or ICT patterns.",                accent: C.cyan },
    { t: "Pre-AI Filter",        b: "0–85 confluence score from kill-zone, trigger strength, HTF align, funding bias, vol momentum. <45 → reject.", accent: C.green },
    { t: "AI Analysis",          b: "Sonnet 4.6 receives 11 data sources and emits JSON: entry, SL, TP, RR, confidence, BE plan.",  accent: C.purple },
    { t: "Validation",           b: "RR<1.5 auto-downgrades to NO TRADE. Wrong-side BE notes are corrected to halfway-to-TP.",      accent: C.amber },
    { t: "Trade Monitor",        b: "Server tracks price every 30s for entry hit, BE level, TP, SL, BE-stop, expiry.",              accent: C.cyan },
    { t: "Outcome Logging",      b: "Auto-logs to Supabase. Posts a rich Discord journal embed with running stats per pair.",       accent: C.green },
  ];

  const cardW = 4.0, cardH = 2.1, gap = 0.2;
  const startY = 1.9;
  const startX = (W - (3 * cardW + 2 * gap)) / 2;

  steps.forEach((step, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = startX + col * (cardW + gap);
    const y = startY + row * (cardH + gap);
    addStepCard(s, x, y, cardW, cardH, i + 1, step.t, step.b, step.accent);
  });

  function rArrow(x1, x2, y) {
    s.addShape(pres.shapes.LINE, {
      x: x1, y, w: x2 - x1, h: 0,
      line: { color: C.cyan, width: 1.5, endArrowType: "triangle" },
    });
  }
  rArrow(startX + cardW,             startX + cardW + gap,             startY + cardH / 2);
  rArrow(startX + 2 * cardW + gap,   startX + 2 * (cardW + gap),       startY + cardH / 2);
  const r2y = startY + cardH + gap + cardH / 2;
  rArrow(startX + cardW,             startX + cardW + gap,             r2y);
  rArrow(startX + 2 * cardW + gap,   startX + 2 * (cardW + gap),       r2y);

  // Down arrow from card 3 to card 4 (row turn)
  s.addShape(pres.shapes.LINE, {
    x: startX + 2 * (cardW + gap) + cardW / 2,
    y: startY + cardH,
    w: 0,
    h: gap,
    line: { color: C.cyan, width: 1.5 },
  });

  addFooter(s, 6);
}

// =============================================================
// SLIDE 7 — THE 11 DATA SOURCES
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 07 / CONFLUENCE", "The 11 data sources Henry feeds the model.");

  const sources = [
    { n: "01", t: "Trigger detection",      b: "BOS / sweep / OB mitigation / FVG-in-OTE — what fired the scan." },
    { n: "02", t: "Multi-timeframe",        b: "1H + 4H candles for higher-timeframe bias and structure." },
    { n: "03", t: "BTC corr · DXY",         b: "BTC for crypto, DXY for gold/metals/oil — macro reference." },
    { n: "04", t: "Funding rate",           b: "Surfaces positioning extremes that punish trapped late entries." },
    { n: "05", t: "Open interest",          b: "Conviction read — rising OI with directional flow = real participation." },
    { n: "06", t: "Liquidity heatmap",      b: "Swing highs/lows and equal H/L — where stops cluster." },
    { n: "07", t: "Order flow / footprint", b: "Buy-sell delta, POC, imbalances inside the trigger candle." },
    { n: "08", t: "CVD trend",              b: "5-window cumulative volume delta to confirm or fade aggression." },
    { n: "09", t: "Cross-broker check",     b: "Weex / Binance / Hyperliquid agreement — catches one-venue prints." },
    { n: "10", t: "News headlines",         b: "Sentiment-tagged RSS so the model sees what just hit the wire." },
    { n: "11", t: "Economic calendar",      b: "High-impact events in the next 4h, so it can sit on its hands." },
  ];

  const cols = 4;
  const cardW = 3.0, cardH = 1.55, gx = 0.2, gy = 0.2;
  const totalW = cols * cardW + (cols - 1) * gx;
  const startX = (W - totalW) / 2;
  const startY = 1.9;

  sources.forEach((src, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = startX + col * (cardW + gx);
    const y = startY + row * (cardH + gy);
    addCard(s, x, y, cardW, cardH, C.panel, C.cyan);
    s.addText(src.n, {
      x: x + 0.2, y: y + 0.15, w: 0.6, h: 0.3,
      fontSize: 11, fontFace: MONO, color: C.cyan, bold: true, margin: 0,
    });
    s.addText(src.t, {
      x: x + 0.2, y: y + 0.42, w: cardW - 0.35, h: 0.35,
      fontSize: 12, fontFace: FONT, color: C.text, bold: true, margin: 0,
    });
    s.addText(src.b, {
      x: x + 0.2, y: y + 0.78, w: cardW - 0.35, h: cardH - 0.85,
      fontSize: 9.5, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  });

  // 12th cell — callout
  const cx = startX + 3 * (cardW + gx);
  const cy = startY + 2 * (cardH + gy);
  addCard(s, cx, cy, cardW, cardH, "0E2734", C.green);
  s.addText("INSTITUTIONAL-GRADE CONTEXT", {
    x: cx + 0.2, y: cy + 0.2, w: cardW - 0.35, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.green, bold: true, charSpacing: 2, margin: 0,
  });
  s.addText("Every signal sees what a desk sees — without you stitching tabs together.", {
    x: cx + 0.2, y: cy + 0.55, w: cardW - 0.35, h: cardH - 0.65,
    fontSize: 11, fontFace: FONT, color: C.text, valign: "top", margin: 0,
  });

  addFooter(s, 7);
}

// =============================================================
// SLIDE 8 — PRE-AI CONFLUENCE FILTER
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 08 / COST CONTROL", "Pre-AI confluence filter");

  // Left: explanation card
  addCard(s, 0.5, 1.9, 6.5, 4.7, C.panel, C.green);
  s.addText("Cheap before expensive.", {
    x: 0.75, y: 2.05, w: 6.1, h: 0.45,
    fontSize: 18, fontFace: FONT, color: C.text, bold: true, margin: 0,
  });
  s.addText("Score a trigger from local signals before paying for an LLM call. Let weak setups die for free.", {
    x: 0.75, y: 2.55, w: 6.1, h: 0.7,
    fontSize: 12, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
  });

  s.addText([
    { text: "▸  6 components, max ", options: { color: C.text, breakLine: false } },
    { text: "85", options: { color: C.green, bold: true, breakLine: false } },
    { text: " points", options: { color: C.text, breakLine: true } },
    { text: "▸  Threshold tunable (default 45)", options: { color: C.text, breakLine: true } },
    { text: "▸  Cuts ~40% of weak triggers without losing good signals", options: { color: C.text, breakLine: true } },
    { text: "▸  Estimated savings: $5–10/day at moderate scan rate", options: { color: C.text } },
  ], {
    x: 0.75, y: 3.4, w: 6.1, h: 2.5,
    fontSize: 12.5, fontFace: FONT, valign: "top", margin: 0, paraSpaceAfter: 6,
  });

  // Right: components breakdown
  addCard(s, 7.3, 1.9, 5.5, 4.7, C.panel, C.cyan);
  s.addText("SCORE COMPONENTS", {
    x: 7.5, y: 2.05, w: 5.1, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.cyan, bold: true, charSpacing: 3, margin: 0,
  });

  const comps = [
    { label: "Kill-zone alignment",    pts: "20" },
    { label: "Trigger strength",       pts: "20" },
    { label: "HTF (4H) alignment",     pts: "15" },
    { label: "Funding bias",           pts: "10" },
    { label: "Volume momentum",        pts: "10" },
    { label: "Cross-broker agreement", pts: "10" },
  ];
  comps.forEach((c, i) => {
    const y = 2.5 + i * 0.55;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 7.5, y, w: 5.1, h: 0.45,
      fill: { color: C.panel2 },
      line: { color: C.border, width: 0.5 },
    });
    s.addText(c.label, {
      x: 7.65, y, w: 3.6, h: 0.45,
      fontSize: 11, fontFace: FONT, color: C.text, valign: "middle", margin: 0,
    });
    s.addText(c.pts + " pts", {
      x: 11.3, y, w: 1.2, h: 0.45,
      fontSize: 11, fontFace: MONO, color: C.cyan, bold: true,
      align: "right", valign: "middle", margin: 0,
    });
  });

  // Threshold callout at bottom
  const cy = 5.95;
  s.addShape(pres.shapes.RECTANGLE, {
    x: 7.5, y: cy, w: 5.1, h: 0.5,
    fill: { color: "0E2734" },
    line: { color: C.green, width: 1 },
  });
  s.addText("→  Threshold 45/85 · weak triggers killed before AI", {
    x: 7.65, y: cy, w: 4.95, h: 0.5,
    fontSize: 11, fontFace: MONO, color: C.green, bold: true, valign: "middle", margin: 0,
  });

  addFooter(s, 8);
}

// =============================================================
// SLIDE 9 — AUTO-SCAN ENGINE
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 09 / SCAN ENGINE", "Auto-scan engine");

  const sw = 4.0, sh = 1.4, sgap = 0.2;
  const sStartX = (W - (3 * sw + 2 * sgap)) / 2;
  const sy = 1.9;

  function statCard(idx, label, value, sub, color) {
    const x = sStartX + idx * (sw + sgap);
    addCard(s, x, sy, sw, sh, C.panel, color);
    s.addText(label, {
      x: x + 0.2, y: sy + 0.15, w: sw - 0.3, h: 0.3,
      fontSize: 9, fontFace: MONO, color: C.muted, bold: true, charSpacing: 2, margin: 0,
    });
    s.addText(value, {
      x: x + 0.2, y: sy + 0.42, w: sw - 0.3, h: 0.55,
      fontSize: 28, fontFace: FONT, color: color, bold: true, margin: 0,
    });
    s.addText(sub, {
      x: x + 0.2, y: sy + 0.95, w: sw - 0.3, h: 0.4,
      fontSize: 10, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  }
  statCard(0, "WATCHLIST",      "21",   "pairs available",                C.cyan);
  statCard(1, "SCAN INTERVAL",  "30s",  "per pair · all in parallel",     C.green);
  statCard(2, "DEAD-ZONE",      "1hr",  "auto cooldown 22:00–08:00 UTC",  C.amber);

  // Bottom: state machine diagram
  addCard(s, 0.5, 3.55, W - 1.0, 3.0, C.panel, C.cyan);
  s.addText("PER-PAIR STATE MACHINE", {
    x: 0.7, y: 3.7, w: 6, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.cyan, bold: true, charSpacing: 3, margin: 0,
  });
  s.addText("Each pair runs its own state — 21 in parallel.", {
    x: 0.7, y: 4.0, w: 11, h: 0.3,
    fontSize: 11, fontFace: FONT, color: C.muted, margin: 0,
  });

  const states = [
    { label: "scanning",   color: C.cyan },
    { label: "waiting",    color: C.amber },
    { label: "in-trade",   color: C.green },
    { label: "cooldown",   color: C.muted },
    { label: "paused",     color: C.red },
  ];
  const pillW = 2.0, pillH = 0.8, pillGap = 0.35;
  const pillTotal = 5 * pillW + 4 * pillGap;
  const pillStart = (W - pillTotal) / 2;
  const pillY = 4.5;

  states.forEach((st, i) => {
    const x = pillStart + i * (pillW + pillGap);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: pillY, w: pillW, h: pillH,
      fill: { color: C.panel2 },
      line: { color: st.color, width: 1.25 },
      rectRadius: 0.1,
    });
    s.addText(st.label.toUpperCase(), {
      x, y: pillY, w: pillW, h: pillH,
      fontSize: 13, fontFace: MONO, color: st.color, bold: true,
      align: "center", valign: "middle", margin: 0, charSpacing: 3,
    });
    if (i < states.length - 1) {
      s.addShape(pres.shapes.LINE, {
        x: x + pillW + 0.04, y: pillY + pillH / 2,
        w: pillGap - 0.08, h: 0,
        line: { color: C.divider, width: 1.25, endArrowType: "triangle" },
      });
    }
  });

  s.addText("Browser shows a live mini-card grid — every watchlist pair, every state, in real time.", {
    x: 0.7, y: 5.7, w: W - 1.4, h: 0.3,
    fontSize: 11, fontFace: FONT, color: C.text, italic: true, align: "center", margin: 0,
  });
  s.addText("Per-pair cooldown 3–15 min · user-configurable.", {
    x: 0.7, y: 6.05, w: W - 1.4, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.muted, align: "center", margin: 0,
  });

  addFooter(s, 9);
}

// =============================================================
// SLIDE 10 — RISK MANAGEMENT
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 10 / RISK", "Risk management — built into the engine.");

  const items = [
    {
      tag: "RR FLOOR",
      t: "Hard reward:risk gate",
      b: "Any signal with RR < 1.5 is auto-downgraded to NO TRADE. The model can't talk you into bad math.",
      color: C.red,
    },
    {
      tag: "CIRCUIT BREAKER",
      t: "Pause on losing streaks",
      b: "3 SLs on the same pair in 24h → pause that pair for 6h.   3 SLs across any pairs in 4h → 2h global pause.",
      color: C.amber,
    },
    {
      tag: "BE-STOP",
      t: "Smart breakeven exit",
      b: "If price returns to entry after the BE alert fires, it's logged as breakeven — not held to original SL.",
      color: C.cyan,
    },
    {
      tag: "BE NOTE FIX",
      t: "Wrong-side BE auto-correction",
      b: "AI sometimes places BE on the SL side of entry. The validator catches it and snaps to halfway-to-TP.",
      color: C.green,
    },
    {
      tag: "ENTRY WATCHER",
      t: "Confirmation before drawing",
      b: "Waits for a 1m / 5m bullish or bearish pattern inside the entry zone before publishing the signal card.",
      color: C.purple,
    },
  ];

  const cardW = 4.0, cardH = 2.05, gap = 0.2;
  const startY = 1.95;
  const topX = (W - (3 * cardW + 2 * gap)) / 2;
  const botX = (W - (2 * cardW + gap)) / 2;

  items.forEach((it, i) => {
    let x, y;
    if (i < 3) {
      x = topX + i * (cardW + gap);
      y = startY;
    } else {
      x = botX + (i - 3) * (cardW + gap);
      y = startY + cardH + gap;
    }
    addCard(s, x, y, cardW, cardH, C.panel, it.color);
    s.addText(it.tag, {
      x: x + 0.25, y: y + 0.18, w: cardW - 0.45, h: 0.28,
      fontSize: 9, fontFace: MONO, color: it.color, bold: true, charSpacing: 3, margin: 0,
    });
    s.addText(it.t, {
      x: x + 0.25, y: y + 0.5, w: cardW - 0.45, h: 0.4,
      fontSize: 14, fontFace: FONT, color: C.text, bold: true, margin: 0,
    });
    s.addText(it.b, {
      x: x + 0.25, y: y + 0.95, w: cardW - 0.45, h: cardH - 1.1,
      fontSize: 11, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  });

  addFooter(s, 10);
}

// =============================================================
// SLIDE 11 — TRADE MONITORING
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 11 / MONITOR", "Trade monitoring loop");

  // Left: monitor description
  addCard(s, 0.5, 1.9, 6.4, 4.7, C.panel, C.cyan);
  s.addText("Server is the canonical observer.", {
    x: 0.75, y: 2.05, w: 6, h: 0.45,
    fontSize: 17, fontFace: FONT, color: C.text, bold: true, margin: 0,
  });
  s.addText("A long-running monitor checks every active trade every 30 seconds and reconciles state with Supabase.", {
    x: 0.75, y: 2.55, w: 6.0, h: 0.8,
    fontSize: 12, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
  });
  s.addText([
    { text: "▸  Detects entry hit, BE level, TP, SL, BE-stop, expiry", options: { color: C.text, breakLine: true } },
    { text: "▸  Server + browser monitor (deduped — server posts to Discord)", options: { color: C.text, breakLine: true } },
    { text: "▸  Auto-logs outcomes to Supabase signals table", options: { color: C.text, breakLine: true } },
    { text: "▸  Resilient logger backfills DB rows from in-memory state if save failed", options: { color: C.text } },
  ], {
    x: 0.75, y: 3.55, w: 6.0, h: 2.8,
    fontSize: 12.5, fontFace: FONT, valign: "top", margin: 0, paraSpaceAfter: 8,
  });

  // Right: lifecycle diagram
  addCard(s, 7.2, 1.9, 5.6, 4.7, C.panel2, C.green);
  s.addText("TRADE LIFECYCLE", {
    x: 7.4, y: 2.05, w: 5, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.green, bold: true, charSpacing: 3, margin: 0,
  });

  const events = [
    { t: "SIGNAL",  d: "AI emits entry / SL / TP / BE",  color: C.cyan },
    { t: "ENTRY",   d: "price reaches entry zone",       color: C.cyan },
    { t: "BE",      d: "70% to TP — alert + move SL",    color: C.amber },
    { t: "RESOLVE", d: "TP / SL / BE-stop / expiry",     color: C.green },
    { t: "LOG",     d: "Supabase + Discord journal",     color: C.purple },
  ];
  events.forEach((e, i) => {
    const ey = 2.5 + i * 0.78;
    s.addShape(pres.shapes.OVAL, {
      x: 7.5, y: ey + 0.18, w: 0.22, h: 0.22,
      fill: { color: e.color },
      line: { color: e.color, width: 0 },
    });
    if (i < events.length - 1) {
      s.addShape(pres.shapes.LINE, {
        x: 7.61, y: ey + 0.4, w: 0, h: 0.38,
        line: { color: C.divider, width: 1.25 },
      });
    }
    s.addText(e.t, {
      x: 7.85, y: ey, w: 1.6, h: 0.4,
      fontSize: 12, fontFace: MONO, color: e.color, bold: true,
      valign: "middle", charSpacing: 2, margin: 0,
    });
    s.addText(e.d, {
      x: 9.4, y: ey, w: 3.2, h: 0.4,
      fontSize: 11, fontFace: FONT, color: C.muted,
      valign: "middle", margin: 0,
    });
  });

  addFooter(s, 11);
}

// =============================================================
// SLIDE 12 — NOTIFICATIONS & DISCORD
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 12 / NOTIFICATIONS", "Discord, push, and embeds");

  const channels = [
    { tag: "AUTO-SCAN",  t: "Trigger + signal posts",        b: "Rich embed: pair · TF · entry · SL · TP · RR · confidence · trigger type. Color-coded long/short/skip.",  color: C.cyan },
    { tag: "STATUS",     t: "Periodic state digest",         b: "Every 15 min. One embed showing every watchlist pair's state — scanning / waiting / in-trade / cooldown.", color: C.amber },
    { tag: "JOURNAL",    t: "Live trade journal",            b: "Every TP / SL / BE outcome posts a journal embed with running stats per pair (win rate, R total).",        color: C.green },
    { tag: "WEB PUSH",   t: "Phone notifications",           b: "VAPID-signed push for entry / BE / TP / SL even when the browser is closed and the laptop is asleep.",     color: C.purple },
  ];

  const cardW = 6.1, cardH = 2.2, gap = 0.25;
  const startX = (W - (2 * cardW + gap)) / 2;
  const startY = 1.95;

  channels.forEach((ch, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = startX + col * (cardW + gap);
    const y = startY + row * (cardH + gap);
    addCard(s, x, y, cardW, cardH, C.panel, ch.color);

    s.addText(ch.tag, {
      x: x + 0.25, y: y + 0.2, w: 2.5, h: 0.3,
      fontSize: 10, fontFace: MONO, color: ch.color, bold: true, charSpacing: 3, margin: 0,
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + cardW - 1.5, y: y + 0.18, w: 1.3, h: 0.3,
      fill: { color: C.panel2 },
      line: { color: ch.color, width: 0.75 },
    });
    s.addText("#" + ["F1F2", "AB12", "9CD0", "PUSH"][i], {
      x: x + cardW - 1.5, y: y + 0.18, w: 1.3, h: 0.3,
      fontSize: 9, fontFace: MONO, color: ch.color,
      align: "center", valign: "middle", margin: 0,
    });

    s.addText(ch.t, {
      x: x + 0.25, y: y + 0.55, w: cardW - 0.45, h: 0.45,
      fontSize: 16, fontFace: FONT, color: C.text, bold: true, margin: 0,
    });
    s.addText(ch.b, {
      x: x + 0.25, y: y + 1.05, w: cardW - 0.45, h: cardH - 1.2,
      fontSize: 11.5, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  });

  addFooter(s, 12);
}

// =============================================================
// SLIDE 13 — PERFORMANCE DASHBOARD & BACKTEST
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 13 / VALIDATION", "Performance dashboard & backtest");

  // Left card: Performance
  addCard(s, 0.5, 1.9, 6.2, 4.7, C.panel, C.green);
  s.addText("PERFORMANCE  ·  /performance", {
    x: 0.75, y: 2.05, w: 5.8, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.green, bold: true, charSpacing: 3, margin: 0,
  });
  s.addText("Know what actually works.", {
    x: 0.75, y: 2.4, w: 5.8, h: 0.5,
    fontSize: 17, fontFace: FONT, color: C.text, bold: true, margin: 0,
  });
  s.addText([
    { text: "▸  Win rate by pair, trigger, session, UTC hour", options: { color: C.text, breakLine: true } },
    { text: "▸  Cumulative R chart (live equity curve)",        options: { color: C.text, breakLine: true } },
    { text: "▸  Best 10 / worst 10 trades — drilldown view",    options: { color: C.text, breakLine: true } },
    { text: "▸  Filter by date range, mode, trigger type",      options: { color: C.text } },
  ], {
    x: 0.75, y: 3.05, w: 5.8, h: 2.5,
    fontSize: 12.5, fontFace: FONT, valign: "top", margin: 0, paraSpaceAfter: 6,
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.75, y: 5.7, w: 5.8, h: 0.7,
    fill: { color: C.panel2 },
    line: { color: C.divider, width: 0.5 },
  });
  s.addText("Outcomes auto-logged from the live monitor → no spreadsheet, no missed trades.", {
    x: 0.9, y: 5.7, w: 5.5, h: 0.7,
    fontSize: 11, fontFace: FONT, color: C.muted, italic: true, valign: "middle", margin: 0,
  });

  // Right card: Backtest
  addCard(s, 7.0, 1.9, 5.8, 4.7, C.panel, C.amber);
  s.addText("BACKTEST  ·  /backtest", {
    x: 7.25, y: 2.05, w: 5.4, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.amber, bold: true, charSpacing: 3, margin: 0,
  });
  s.addText("Validate prompt changes before going live.", {
    x: 7.25, y: 2.4, w: 5.4, h: 0.5,
    fontSize: 16, fontFace: FONT, color: C.text, bold: true, margin: 0,
  });
  s.addText([
    { text: "▸  Replays historical candles through the full pipeline", options: { color: C.text, breakLine: true } },
    { text: "▸  Trigger → pre-AI filter → AI → walk-forward outcome",   options: { color: C.text, breakLine: true } },
    { text: "▸  Cost estimate preview before each run",                 options: { color: C.text, breakLine: true } },
    { text: "▸  Funnel view — what got rejected and why",               options: { color: C.text } },
  ], {
    x: 7.25, y: 3.05, w: 5.4, h: 2.0,
    fontSize: 12.5, fontFace: FONT, valign: "top", margin: 0, paraSpaceAfter: 6,
  });

  s.addShape(pres.shapes.RECTANGLE, {
    x: 7.25, y: 5.05, w: 5.4, h: 1.35,
    fill: { color: "2A1E0E" },
    line: { color: C.amber, width: 0.75 },
  });
  s.addText("HONEST LIMITATIONS", {
    x: 7.4, y: 5.1, w: 5.1, h: 0.25,
    fontSize: 9, fontFace: MONO, color: C.amber, bold: true, charSpacing: 2, margin: 0,
  });
  s.addText("Slippage = 0 · AI is non-deterministic · news, calendar, footprint not fully reconstructable historically.", {
    x: 7.4, y: 5.4, w: 5.1, h: 1.0,
    fontSize: 10.5, fontFace: FONT, color: C.text, valign: "top", margin: 0,
  });

  addFooter(s, 13);
}

// =============================================================
// SLIDE 14 — TECH STACK
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 14 / STACK", "Tech stack");

  const stack = [
    { tag: "BACKEND",   t: "Node.js 22 + Express",       b: "ES modules · deployed on Railway", color: C.green },
    { tag: "AI",        t: "Claude Sonnet 4.6",          b: "Anthropic API direct · $3 / $15 per MTok", color: C.purple },
    { tag: "DATABASE",  t: "Supabase (Postgres)",        b: "Auth + RLS · service-role server-side", color: C.cyan },
    { tag: "AUTH",      t: "HTTPOnly cookies",           b: "Password reset · optional magic links", color: C.cyan },
    { tag: "BILLING",   t: "Paddle subscriptions",       b: "Webhook-reconciled · sandbox + live", color: C.amber },
    { tag: "FRONTEND",  t: "Vanilla JS",                 b: "No framework · LightweightCharts overlays", color: C.cyan },
    { tag: "STREAMING", t: "SSE for live prices",        b: "Multiplexed exchange WS · server-side", color: C.green },
    { tag: "PUSH",      t: "web-push (VAPID)",           b: "Phone notifications even with app closed", color: C.purple },
  ];

  const cardW = 3.0, cardH = 2.0, gx = 0.18, gy = 0.22;
  const totalW = 4 * cardW + 3 * gx;
  const startX = (W - totalW) / 2;
  const startY = 2.05;

  stack.forEach((it, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = startX + col * (cardW + gx);
    const y = startY + row * (cardH + gy);
    addCard(s, x, y, cardW, cardH, C.panel, it.color);
    s.addText(it.tag, {
      x: x + 0.2, y: y + 0.18, w: cardW - 0.35, h: 0.3,
      fontSize: 9, fontFace: MONO, color: it.color, bold: true, charSpacing: 3, margin: 0,
    });
    s.addText(it.t, {
      x: x + 0.2, y: y + 0.55, w: cardW - 0.35, h: 0.6,
      fontSize: 13, fontFace: FONT, color: C.text, bold: true, valign: "top", margin: 0,
    });
    s.addText(it.b, {
      x: x + 0.2, y: y + 1.2, w: cardW - 0.35, h: cardH - 1.3,
      fontSize: 10.5, fontFace: FONT, color: C.muted, valign: "top", margin: 0,
    });
  });

  addCard(s, startX, startY + 2 * (cardH + gy), totalW, 0.7, C.panel2, C.cyan);
  s.addText("DEPLOY", {
    x: startX + 0.2, y: startY + 2 * (cardH + gy), w: 1.2, h: 0.7,
    fontSize: 10, fontFace: MONO, color: C.cyan, bold: true, charSpacing: 3, valign: "middle", margin: 0,
  });
  s.addText("Railway · Docker · GitHub auto-deploy on push to main", {
    x: startX + 1.5, y: startY + 2 * (cardH + gy), w: totalW - 1.7, h: 0.7,
    fontSize: 11.5, fontFace: FONT, color: C.text, valign: "middle", margin: 0,
  });

  addFooter(s, 14);
}

// =============================================================
// SLIDE 15 — SUMMARY
// =============================================================
{
  const s = pres.addSlide();
  addBackground(s);
  addSlideHeader(s, "▎ 15 / SUMMARY", "Why traders run Henry.");

  const bullets = [
    { t: "11-source AI confluence",            color: C.cyan },
    { t: "Multi-pair concurrent scanning",     color: C.cyan },
    { t: "Server-side autonomous (browser closed)", color: C.green },
    { t: "Pre-AI filter saves ~40% on costs",  color: C.green },
    { t: "Built-in risk: RR floor + circuit breaker + BE detection", color: C.amber },
    { t: "Performance dashboard + backtest validation", color: C.amber },
    { t: "Discord + push integration",         color: C.purple },
    { t: "Subscription via Paddle",            color: C.purple },
  ];

  const cardW = 3.0, cardH = 1.45, gx = 0.18, gy = 0.22;
  const totalW = 4 * cardW + 3 * gx;
  const startX = (W - totalW) / 2;
  const startY = 1.95;

  bullets.forEach((b, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = startX + col * (cardW + gx);
    const y = startY + row * (cardH + gy);
    addCard(s, x, y, cardW, cardH, C.panel, b.color);
    s.addText("✓", {
      x: x + 0.2, y: y + 0.15, w: 0.4, h: 0.4,
      fontSize: 18, fontFace: FONT, color: b.color, bold: true, valign: "middle", margin: 0,
    });
    s.addText(b.t, {
      x: x + 0.65, y: y + 0.15, w: cardW - 0.8, h: cardH - 0.3,
      fontSize: 12.5, fontFace: FONT, color: C.text, bold: true, valign: "middle", margin: 0,
    });
  });

  // Big price band
  const py = 5.25;
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: py, w: W - 1, h: 1.4,
    fill: { color: C.panel },
    line: { color: C.cyan, width: 1.25 },
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: py, w: 0.07, h: 1.4,
    fill: { color: C.cyan },
    line: { color: C.cyan, width: 0 },
  });
  s.addText("SUBSCRIPTION", {
    x: 0.85, y: py + 0.2, w: 4, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.cyan, bold: true, charSpacing: 3, margin: 0,
  });
  s.addText("$500", {
    x: 0.85, y: py + 0.45, w: 4, h: 0.85,
    fontSize: 56, fontFace: FONT, color: C.text, bold: true, margin: 0,
  });
  s.addText("/ month", {
    x: 3.05, y: py + 0.7, w: 2.5, h: 0.5,
    fontSize: 18, fontFace: FONT, color: C.muted, valign: "middle", margin: 0,
  });
  s.addText("Billed via Paddle · cancel anytime", {
    x: 0.85, y: py + 1.0, w: 5, h: 0.3,
    fontSize: 10, fontFace: MONO, color: C.muted, margin: 0,
  });

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: W - 4.7, y: py + 0.35, w: 4.0, h: 0.7,
    fill: { color: "0E2734" },
    line: { color: C.cyan, width: 1 },
    rectRadius: 0.08,
  });
  s.addText("START SCANNING  →  henrythehoover.com", {
    x: W - 4.7, y: py + 0.35, w: 4.0, h: 0.7,
    fontSize: 13, fontFace: MONO, color: C.cyan, bold: true,
    align: "center", valign: "middle", margin: 0, charSpacing: 2,
  });

  addFooter(s, 15);
}

// -------------------------------------------------------------
// Write file
// -------------------------------------------------------------
pres.writeFile({ fileName: "henry-presentation.pptx" })
  .then((fileName) => {
    console.log("Wrote", fileName);
  })
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
