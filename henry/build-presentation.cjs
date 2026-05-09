// Henry The Hoover — investor/trader-facing presentation
// Run with: NODE_PATH=$(npm root -g) node build-presentation.js
const pptxgen = require('pptxgenjs');

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.3 x 7.5
pres.title = 'Henry The Hoover — AI Futures Trading Terminal';
pres.author = 'Henry The Hoover';

// ── DESIGN SYSTEM ───────────────────────────────────────────────────
const SLIDE_W = 13.3;
const SLIDE_H = 7.5;

const C = {
  bg:       '08090d',  // deep black background
  bg2:      '12141b',  // raised cards
  bg3:      '1a1d28',  // grid lines / sub-cards
  border:   '23262e',
  fg:       'e8eaf0',  // primary text
  mu:       '9aa0a6',  // muted text
  di:       '5a5f7a',  // dim
  cy:       '00d4ff',  // cyan accent (primary)
  gr:       '00e5a0',  // green (positive)
  re:       'ff4466',  // red (negative)
  am:       'ffb830',  // amber (warning)
  pu:       '9966ff',  // purple (info)
};

const FONT_HEAD = 'Calibri';
const FONT_BODY = 'Calibri';
const FONT_MONO = 'Consolas';

// Shadow factory (must return a fresh object each time — pptxgenjs mutates them)
const shadow = () => ({ type: 'outer', color: '000000', blur: 8, offset: 2, angle: 90, opacity: 0.4 });

// ── HELPERS ─────────────────────────────────────────────────────────
function addBackground(slide) {
  slide.background = { color: C.bg };
}

function addHeader(slide, sectionName) {
  // Top thin cyan accent bar
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: SLIDE_W, h: 0.06, fill: { color: C.cy }, line: { type: 'none' },
  });
  // Section label top-left
  slide.addText(sectionName, {
    x: 0.6, y: 0.18, w: 6, h: 0.3,
    fontSize: 9, fontFace: FONT_MONO, color: C.mu, charSpacing: 4, bold: true, margin: 0,
  });
}

function addFooter(slide, slideNum, totalSlides) {
  // Bottom border
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: SLIDE_H - 0.05, w: SLIDE_W, h: 0.05, fill: { color: C.border }, line: { type: 'none' },
  });
  // Brand
  slide.addText('Henry The Hoover · henrythehoover.com', {
    x: 0.6, y: SLIDE_H - 0.42, w: 9, h: 0.25,
    fontSize: 9, fontFace: FONT_MONO, color: C.di, margin: 0,
  });
  // Slide number
  slide.addText(`${slideNum} / ${totalSlides}`, {
    x: SLIDE_W - 1.5, y: SLIDE_H - 0.42, w: 0.9, h: 0.25,
    fontSize: 9, fontFace: FONT_MONO, color: C.mu, align: 'right', margin: 0,
  });
}

function addTitle(slide, text, opts = {}) {
  slide.addText(text, {
    x: 0.6, y: 0.6, w: SLIDE_W - 1.2, h: 0.85,
    fontSize: opts.size || 36, fontFace: FONT_HEAD, color: opts.color || C.fg,
    bold: true, charSpacing: 2, margin: 0, ...opts,
  });
}

function addSubtitle(slide, text, y = 1.45) {
  slide.addText(text, {
    x: 0.6, y, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 13, fontFace: FONT_BODY, color: C.cy, margin: 0,
  });
}

// Card with title + bullets — used heavily across content slides
function addBulletCard(slide, opts) {
  const { x, y, w, h, title, bullets, accentColor = C.cy, titleColor = C.fg } = opts;
  // Background
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h, fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
  });
  // Left accent bar
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w: 0.08, h, fill: { color: accentColor }, line: { type: 'none' },
  });
  if (title) {
    slide.addText(title, {
      x: x + 0.3, y: y + 0.2, w: w - 0.5, h: 0.35,
      fontSize: 13, fontFace: FONT_HEAD, color: titleColor, bold: true, charSpacing: 1, margin: 0,
    });
  }
  if (bullets && bullets.length) {
    const bulletItems = bullets.map((b, i) => {
      const isLast = i === bullets.length - 1;
      const opt = { bullet: { code: '25AA' }, paraSpaceAfter: 4, color: C.fg, fontSize: 11 };
      if (!isLast) opt.breakLine = true;
      return { text: b, options: opt };
    });
    slide.addText(bulletItems, {
      x: x + 0.3, y: y + (title ? 0.65 : 0.25), w: w - 0.5, h: h - (title ? 0.85 : 0.45),
      fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }
}

function addStatBox(slide, opts) {
  const { x, y, w, h, value, label, color = C.cy } = opts;
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h, fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
  });
  slide.addText(value, {
    x, y: y + 0.15, w, h: h * 0.55,
    fontSize: 32, fontFace: FONT_MONO, color, bold: true,
    align: 'center', valign: 'middle', margin: 0,
  });
  slide.addText(label, {
    x, y: y + h * 0.62, w, h: h * 0.3,
    fontSize: 9, fontFace: FONT_MONO, color: C.mu, charSpacing: 3,
    align: 'center', valign: 'middle', margin: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 1 — TITLE
// ─────────────────────────────────────────────────────────────────────────
const TOTAL = 15;
{
  const s = pres.addSlide();
  addBackground(s);

  // Cyan vertical accent on left
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 0.18, h: SLIDE_H, fill: { color: C.cy }, line: { type: 'none' },
  });

  // Faint grid pattern on right (decorative)
  for (let i = 0; i < 15; i++) {
    s.addShape(pres.shapes.LINE, {
      x: SLIDE_W - 5 + i * 0.33, y: 0.5, w: 0, h: 6.5,
      line: { color: C.bg3, width: 0.5 },
    });
  }
  for (let i = 0; i < 12; i++) {
    s.addShape(pres.shapes.LINE, {
      x: SLIDE_W - 5, y: 0.5 + i * 0.55, w: 5, h: 0,
      line: { color: C.bg3, width: 0.5 },
    });
  }

  // Tag (top label)
  s.addText('AI FUTURES TRADING TERMINAL', {
    x: 0.8, y: 1.6, w: 8, h: 0.3,
    fontSize: 11, fontFace: FONT_MONO, color: C.cy, charSpacing: 8, bold: true, margin: 0,
  });

  // Title — large
  s.addText('HENRY THE HOOVER', {
    x: 0.8, y: 2.0, w: 12, h: 1.4,
    fontSize: 60, fontFace: FONT_HEAD, color: C.fg, bold: true, charSpacing: 3, margin: 0,
  });

  // Subtitle
  s.addText('Server-side autonomous AI · Multi-pair concurrent scanning · 11-source confluence', {
    x: 0.8, y: 3.5, w: 11.5, h: 0.5,
    fontSize: 16, fontFace: FONT_BODY, color: C.mu, margin: 0,
  });

  // Decorative key stats
  addStatBox(s, { x: 0.8,  y: 4.6, w: 2.6, h: 1.6, value: '11', label: 'DATA SOURCES', color: C.cy });
  addStatBox(s, { x: 3.5,  y: 4.6, w: 2.6, h: 1.6, value: '21', label: 'PAIRS WATCHED', color: C.gr });
  addStatBox(s, { x: 6.2,  y: 4.6, w: 2.6, h: 1.6, value: '4',  label: 'EXCHANGES',     color: C.am });
  addStatBox(s, { x: 8.9,  y: 4.6, w: 2.6, h: 1.6, value: '24/7', label: 'AUTONOMOUS',  color: C.pu });

  s.addText('henrythehoover.com', {
    x: 0.8, y: SLIDE_H - 0.85, w: 6, h: 0.3,
    fontSize: 11, fontFace: FONT_MONO, color: C.cy, margin: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 2 — WHAT IS HENRY
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '01 / OVERVIEW');
  addTitle(s, 'WHAT IS HENRY?');
  addSubtitle(s, 'Autonomous AI trading assistant for crypto futures + spot gold');

  // Left column — narrative
  s.addText([
    { text: 'Henry scans futures markets 24/7, generates trade signals using ', options: { breakLine: false } },
    { text: 'Claude Sonnet 4.6', options: { color: C.cy, bold: true, breakLine: false } },
    { text: ', monitors entries and exits in real time, and posts everything to Discord and your phone.', options: { breakLine: true } },
    { text: ' ', options: { breakLine: true, fontSize: 6 } },
    { text: 'It runs ', options: { breakLine: false } },
    { text: 'server-side', options: { color: C.gr, bold: true, breakLine: false } },
    { text: '. You don\'t need a browser open. Trades you didn\'t see still get logged, alerted, and journaled.', options: { breakLine: true } },
    { text: ' ', options: { breakLine: true, fontSize: 6 } },
    { text: 'Custom prompts layer ', options: { breakLine: false } },
    { text: '11 distinct data sources', options: { color: C.am, bold: true, breakLine: false } },
    { text: ' into every signal — institutional-grade context that off-the-shelf "AI signal" services skip.', options: {} },
  ], {
    x: 0.6, y: 2.0, w: 6.8, h: 4.5,
    fontSize: 14, fontFace: FONT_BODY, color: C.fg, margin: 0,
  });

  // Right column — pairs grid + exchanges
  addBulletCard(s, {
    x: 7.7, y: 2.0, w: 5.0, h: 2.5,
    title: 'PAIRS SUPPORTED (21)',
    bullets: [
      'Crypto: BTC ETH SOL XRP DOGE AVAX AAVE PEPE BNB ADA',
      'Crypto: DOT LINK SUI ARB OP NEAR INJ',
      'Metals & Oil: XAUT XAG XTI XBR',
      'Spot: GOLD (Polygon XAU/USD)',
    ],
    accentColor: C.gr,
  });
  addBulletCard(s, {
    x: 7.7, y: 4.7, w: 5.0, h: 1.9,
    title: 'EXCHANGES',
    bullets: [
      'Weex Futures · Binance Futures · Hyperliquid',
      'Polygon (Gold spot + DXY index)',
      'Per-pair routing — GOLD → Polygon, others → user choice',
    ],
    accentColor: C.am,
  });

  addFooter(s, 2, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 3 — THE PROBLEM
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '02 / WHY HENRY EXISTS');
  addTitle(s, 'THE PROBLEM');
  addSubtitle(s, 'Manual futures trading at scale is broken');

  const problems = [
    { t: 'EXHAUSTING', d: 'Crypto trades 24/7. Manually monitoring multiple pairs across sessions is impossible without burning out or missing setups.' },
    { t: 'GENERIC AI SERVICES', d: 'Most "AI signal" subscriptions wrap cheap LLMs around basic prompts. No multi-source context, no validation, no tracking.' },
    { t: 'BLINDSPOTS', d: 'Discretionary traders sleep, work, travel. The best setups always seem to fire when you can\'t watch the chart.' },
    { t: 'NO BACKTEST', d: 'Most platforms have no way to validate prompt or strategy changes against history before going live with real money.' },
    { t: 'WEAK RISK CONTROLS', d: 'Risk management is usually external — manual position sizing, no drawdown protection, no streak detection, no automatic pauses.' },
  ];

  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const y = 2.0 + i * 0.95;
    // Number
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.7, y, w: 0.7, h: 0.7,
      fill: { color: C.re, transparency: 80 }, line: { color: C.re, width: 1 },
    });
    s.addText(String(i + 1).padStart(2, '0'), {
      x: 0.7, y, w: 0.7, h: 0.7,
      fontSize: 18, fontFace: FONT_MONO, color: C.re, bold: true,
      align: 'center', valign: 'middle', margin: 0,
    });
    // Title
    s.addText(p.t, {
      x: 1.6, y: y + 0.02, w: 11, h: 0.32,
      fontSize: 13, fontFace: FONT_HEAD, color: C.re, bold: true, charSpacing: 2, margin: 0,
    });
    // Description
    s.addText(p.d, {
      x: 1.6, y: y + 0.36, w: 11, h: 0.5,
      fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }

  addFooter(s, 3, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 4 — THE SOLUTION
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '03 / WHY HENRY EXISTS');
  addTitle(s, 'THE SOLUTION');
  addSubtitle(s, 'Automate the boring parts, keep humans in the loop');

  const solutions = [
    { t: 'CONTINUOUS SCANNING', d: 'Server scans every 30 seconds, parallel across all watchlist pairs. Independent state per pair. No browser required.' },
    { t: 'PRE-AI FILTER', d: 'Cheap confluence score evaluates each trigger before firing the expensive AI. Cuts ~40% of weak setups, saves real money on Anthropic API.' },
    { t: 'INSTITUTIONAL CONTEXT', d: 'Every AI signal references 11 layered data sources: news, calendar, MTF, funding, OI, footprint, CVD, cross-broker, liquidity, BTC/DXY, trigger.' },
    { t: 'AUTONOMOUS MONITOR', d: 'Server tracks the full trade lifecycle — entry hit, BE level, TP, SL, BE-stop, expiry. Logs outcomes automatically. Zero clicks.' },
    { t: 'CIRCUIT BREAKER', d: 'After 3 SLs in 24h on a pair → 6h pause. After 3 SLs across pairs in 4h → 2h global pause. Bot can\'t revenge-trade itself into a hole.' },
  ];

  for (let i = 0; i < solutions.length; i++) {
    const p = solutions[i];
    const y = 2.0 + i * 0.95;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.7, y, w: 0.7, h: 0.7,
      fill: { color: C.gr, transparency: 80 }, line: { color: C.gr, width: 1 },
    });
    s.addText(String(i + 1).padStart(2, '0'), {
      x: 0.7, y, w: 0.7, h: 0.7,
      fontSize: 18, fontFace: FONT_MONO, color: C.gr, bold: true,
      align: 'center', valign: 'middle', margin: 0,
    });
    s.addText(p.t, {
      x: 1.6, y: y + 0.02, w: 11, h: 0.32,
      fontSize: 13, fontFace: FONT_HEAD, color: C.gr, bold: true, charSpacing: 2, margin: 0,
    });
    s.addText(p.d, {
      x: 1.6, y: y + 0.36, w: 11, h: 0.5,
      fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }

  addFooter(s, 4, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 5 — SYSTEM ARCHITECTURE
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '04 / ARCHITECTURE');
  addTitle(s, 'SYSTEM ARCHITECTURE');
  addSubtitle(s, 'Browser ↔ Express server on Railway ↔ Supabase + external APIs');

  // Three-tier diagram
  // Tier 1: Browser
  s.addShape(pres.shapes.RECTANGLE, {
    x: 1.2, y: 2.3, w: 3.0, h: 1.2,
    fill: { color: C.bg2 }, line: { color: C.cy, width: 2 },
  });
  s.addText('BROWSER', {
    x: 1.2, y: 2.4, w: 3.0, h: 0.3,
    fontSize: 12, fontFace: FONT_MONO, color: C.cy, bold: true, charSpacing: 2,
    align: 'center', margin: 0,
  });
  s.addText('UI / Manual analysis\nPair monitor / Performance', {
    x: 1.2, y: 2.75, w: 3.0, h: 0.7,
    fontSize: 10, fontFace: FONT_BODY, color: C.fg,
    align: 'center', margin: 0,
  });

  // Tier 2: Server
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.15, y: 2.3, w: 3.0, h: 1.2,
    fill: { color: C.bg2 }, line: { color: C.gr, width: 2 },
  });
  s.addText('EXPRESS SERVER', {
    x: 5.15, y: 2.4, w: 3.0, h: 0.3,
    fontSize: 12, fontFace: FONT_MONO, color: C.gr, bold: true, charSpacing: 2,
    align: 'center', margin: 0,
  });
  s.addText('Railway hosting / Node 22\nScan loop / Trade monitor', {
    x: 5.15, y: 2.75, w: 3.0, h: 0.7,
    fontSize: 10, fontFace: FONT_BODY, color: C.fg,
    align: 'center', margin: 0,
  });

  // Tier 3: Supabase
  s.addShape(pres.shapes.RECTANGLE, {
    x: 9.1, y: 2.3, w: 3.0, h: 1.2,
    fill: { color: C.bg2 }, line: { color: C.am, width: 2 },
  });
  s.addText('SUPABASE', {
    x: 9.1, y: 2.4, w: 3.0, h: 0.3,
    fontSize: 12, fontFace: FONT_MONO, color: C.am, bold: true, charSpacing: 2,
    align: 'center', margin: 0,
  });
  s.addText('Auth (HTTPOnly cookies)\nSignals + push subs', {
    x: 9.1, y: 2.75, w: 3.0, h: 0.7,
    fontSize: 10, fontFace: FONT_BODY, color: C.fg,
    align: 'center', margin: 0,
  });

  // Arrows between tiers
  // Browser ↔ Server
  s.addShape(pres.shapes.LINE, {
    x: 4.2, y: 2.9, w: 0.95, h: 0,
    line: { color: C.cy, width: 2 },
  });
  s.addText('HTTPS / SSE', {
    x: 4.0, y: 2.55, w: 1.4, h: 0.25,
    fontSize: 9, fontFace: FONT_MONO, color: C.cy, align: 'center', margin: 0,
  });

  // Server ↔ Supabase
  s.addShape(pres.shapes.LINE, {
    x: 8.15, y: 2.9, w: 0.95, h: 0,
    line: { color: C.gr, width: 2 },
  });
  s.addText('service_role', {
    x: 7.95, y: 2.55, w: 1.4, h: 0.25,
    fontSize: 9, fontFace: FONT_MONO, color: C.gr, align: 'center', margin: 0,
  });

  // External services row (below server)
  s.addText('EXTERNAL SERVICES (called by server)', {
    x: 0.6, y: 4.1, w: SLIDE_W - 1.2, h: 0.3,
    fontSize: 10, fontFace: FONT_MONO, color: C.mu, charSpacing: 4, bold: true,
    align: 'center', margin: 0,
  });

  const ext = [
    { x: 0.7,  label: 'ANTHROPIC',  sub: 'Claude Sonnet 4.6', color: C.pu },
    { x: 3.3,  label: 'WEEX',       sub: 'Futures candles + ticker', color: C.cy },
    { x: 5.9,  label: 'BINANCE',    sub: 'Futures + funding + OI', color: C.am },
    { x: 8.5,  label: 'HYPERLIQUID',sub: 'Perp API', color: C.pu },
    { x: 11.1, label: 'POLYGON',    sub: 'Gold + DXY', color: C.gr },
  ];
  for (const e of ext) {
    s.addShape(pres.shapes.RECTANGLE, {
      x: e.x, y: 4.55, w: 1.7, h: 1.1,
      fill: { color: C.bg2 }, line: { color: e.color, width: 1 },
    });
    s.addText(e.label, {
      x: e.x, y: 4.65, w: 1.7, h: 0.35,
      fontSize: 11, fontFace: FONT_MONO, color: e.color, bold: true, charSpacing: 1,
      align: 'center', margin: 0,
    });
    s.addText(e.sub, {
      x: e.x, y: 5.0, w: 1.7, h: 0.55,
      fontSize: 9, fontFace: FONT_BODY, color: C.fg,
      align: 'center', valign: 'top', margin: 0,
    });
    // Connector line up to server
    s.addShape(pres.shapes.LINE, {
      x: e.x + 0.85, y: 4.55, w: 0, h: -0.85,
      line: { color: e.color, width: 1, dashType: 'dash' },
    });
  }

  // Discord row
  s.addShape(pres.shapes.RECTANGLE, {
    x: 1.2, y: 6.1, w: 11.0, h: 1.0,
    fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
  });
  s.addText('OUTBOUND ALERTS', {
    x: 1.4, y: 6.2, w: 4, h: 0.3,
    fontSize: 10, fontFace: FONT_MONO, color: C.mu, bold: true, charSpacing: 2, margin: 0,
  });
  s.addText('3× Discord webhooks (auto-scan / status / journal)  ·  Web Push (VAPID-signed) for phone alerts  ·  SSE live prices', {
    x: 1.4, y: 6.55, w: 11.0, h: 0.4,
    fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
  });

  addFooter(s, 5, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 6 — THE TRADING PIPELINE
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '05 / PIPELINE');
  addTitle(s, 'THE TRADING PIPELINE');
  addSubtitle(s, '6 steps from raw candles to journaled outcome');

  const steps = [
    { n: '1', t: 'TRIGGER DETECTION',   d: 'Server scans 30 candles every 30s for BOS (break of structure) or sweep patterns.', color: C.cy },
    { n: '2', t: 'PRE-AI FILTER',       d: 'Score 0–85 from 6 components. Reject if < 45. Saves Anthropic spend on weak triggers.', color: C.cy },
    { n: '3', t: 'AI ANALYSIS',         d: 'Sonnet 4.6 + 11-source context generates JSON signal: entry / SL / TP / RR / confidence / be_note.', color: C.pu },
    { n: '4', t: 'VALIDATION',          d: 'RR<1.5 → NO TRADE. Wrong-side BE notes auto-corrected. Levels re-checked client + server.', color: C.am },
    { n: '5', t: 'TRADE MONITOR',       d: 'Server tracks price every 30s for entry hit, BE level, TP, SL, BE-stop, expiry — per pair.', color: C.gr },
    { n: '6', t: 'OUTCOME LOGGING',     d: 'Auto-saves to Supabase, posts journal embed to Discord, updates web journal + dashboard.', color: C.gr },
  ];

  const stepW = (SLIDE_W - 1.4) / steps.length;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const x = 0.7 + i * stepW;
    // Box
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.3, w: stepW - 0.15, h: 4.0,
      fill: { color: C.bg2 }, line: { color: st.color, width: 1 },
    });
    // Step number
    s.addText(st.n, {
      x, y: 2.45, w: stepW - 0.15, h: 0.55,
      fontSize: 32, fontFace: FONT_MONO, color: st.color, bold: true,
      align: 'center', margin: 0,
    });
    // Title
    s.addText(st.t, {
      x: x + 0.1, y: 3.05, w: stepW - 0.35, h: 0.7,
      fontSize: 11, fontFace: FONT_HEAD, color: st.color, bold: true, charSpacing: 1,
      align: 'center', margin: 0,
    });
    // Description
    s.addText(st.d, {
      x: x + 0.15, y: 3.85, w: stepW - 0.45, h: 2.3,
      fontSize: 10, fontFace: FONT_BODY, color: C.fg,
      align: 'left', valign: 'top', margin: 0,
    });
    // Arrow connector to next step
    if (i < steps.length - 1) {
      s.addShape(pres.shapes.LINE, {
        x: x + stepW - 0.15, y: 4.3, w: 0.15, h: 0,
        line: { color: C.di, width: 1.5 },
      });
    }
  }

  // Bottom note
  s.addText('Each pair runs this loop independently — one pair in trade does NOT pause the others.', {
    x: 0.6, y: 6.5, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 11, fontFace: FONT_MONO, color: C.am, italic: true, charSpacing: 1,
    align: 'center', margin: 0,
  });

  addFooter(s, 6, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 7 — THE 11 DATA SOURCES
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '06 / CONTEXT');
  addTitle(s, 'THE 11 DATA SOURCES');
  addSubtitle(s, 'Every signal references this stack — institutional-grade context');

  const sources = [
    { n: 1,  t: 'TRIGGER',          d: 'BOS / sweep — what fired the scan' },
    { n: 2,  t: 'MULTI-TIMEFRAME',  d: '1H + 4H structure for HTF bias' },
    { n: 3,  t: 'MACRO',            d: 'BTC correlation OR DXY (gold/oil)' },
    { n: 4,  t: 'FUNDING RATE',     d: 'Positioning extremes — fade signals' },
    { n: 5,  t: 'OPEN INTEREST',    d: 'Directional conviction confirmation' },
    { n: 6,  t: 'LIQUIDITY MAP',    d: 'Swing H/L + EQH/EQL + round numbers' },
    { n: 7,  t: 'ORDER FLOW',       d: 'Buy/sell delta · POC · imbalances' },
    { n: 8,  t: 'CVD TREND',        d: '5-window cumulative delta momentum' },
    { n: 9,  t: 'CROSS-BROKER',     d: 'Weex / Binance / HL agreement' },
    { n: 10, t: 'NEWS HEADLINES',   d: 'RSS feeds, sentiment-tagged' },
    { n: 11, t: 'CALENDAR',         d: 'High-impact events next 4 hours' },
  ];

  // 4×3 grid (last cell is empty)
  const cols = 4;
  const cellW = (SLIDE_W - 1.2) / cols;
  const cellH = 1.2;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 0.6 + col * cellW;
    const y = 2.0 + row * (cellH + 0.2);
    // Box
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.1, y, w: cellW - 0.2, h: cellH,
      fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
    });
    // Number badge
    s.addShape(pres.shapes.OVAL, {
      x: x + 0.25, y: y + 0.15, w: 0.5, h: 0.5,
      fill: { color: C.cy }, line: { type: 'none' },
    });
    s.addText(String(src.n), {
      x: x + 0.25, y: y + 0.15, w: 0.5, h: 0.5,
      fontSize: 14, fontFace: FONT_MONO, color: '000000', bold: true,
      align: 'center', valign: 'middle', margin: 0,
    });
    // Title
    s.addText(src.t, {
      x: x + 0.85, y: y + 0.15, w: cellW - 1.1, h: 0.35,
      fontSize: 12, fontFace: FONT_HEAD, color: C.cy, bold: true, charSpacing: 1, margin: 0,
    });
    // Description
    s.addText(src.d, {
      x: x + 0.85, y: y + 0.5, w: cellW - 1.1, h: 0.6,
      fontSize: 10, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }

  // Note
  s.addText('Macro source switches automatically: crypto pairs use BTC correlation, gold/silver/oil use DXY (inverse).', {
    x: 0.6, y: 6.4, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 11, fontFace: FONT_MONO, color: C.am, italic: true,
    align: 'center', margin: 0,
  });

  addFooter(s, 7, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 8 — PRE-AI CONFLUENCE FILTER
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '07 / COST OPTIMIZATION');
  addTitle(s, 'PRE-AI CONFLUENCE FILTER');
  addSubtitle(s, 'Cheap score gates expensive AI calls — saves ~40%');

  // Big stat callouts on left
  addStatBox(s, { x: 0.6, y: 2.0, w: 3.5, h: 1.8, value: '~40%', label: 'AI CALLS REJECTED', color: C.cy });
  addStatBox(s, { x: 0.6, y: 4.0, w: 3.5, h: 1.8, value: '85', label: 'MAX SCORE', color: C.gr });

  // Score breakdown bars on right
  s.addText('SCORING COMPONENTS', {
    x: 4.5, y: 2.0, w: 8, h: 0.3,
    fontSize: 11, fontFace: FONT_MONO, color: C.mu, charSpacing: 3, bold: true, margin: 0,
  });

  const components = [
    { t: 'Kill Zone (UTC time)',     pts: 20, color: C.cy,
      d: 'LDN-OPEN/NY-OPEN=20  ·  LDN-CLOSE=12  ·  ASIA=5  ·  OFF=0' },
    { t: 'Trigger Strength',         pts: 20, color: C.gr,
      d: 'BOS+volume=20  ·  BOS=12  ·  Sweep+volume=15  ·  Sweep=8' },
    { t: 'HTF Alignment',            pts: 20, color: C.pu,
      d: '1H trend matches trigger direction → +20  ·  conflicts → −15' },
    { t: 'Funding Bias',             pts: 15, color: C.am,
      d: 'Crowded-side fade aligned → +15  ·  against funding → −5' },
    { t: 'Volume Momentum',          pts: 10, color: C.cy,
      d: 'Last 3 candles vs prior 20 — accelerating volume = +10' },
  ];
  let cy = 2.4;
  const maxBarW = 5.5;
  for (const c of components) {
    // Component label
    s.addText(c.t, {
      x: 4.5, y: cy, w: 3.5, h: 0.25,
      fontSize: 10, fontFace: FONT_BODY, color: C.fg, bold: true, margin: 0,
    });
    s.addText(`+${c.pts} max`, {
      x: 4.5, y: cy + 0.25, w: 3.5, h: 0.2,
      fontSize: 9, fontFace: FONT_MONO, color: C.mu, margin: 0,
    });
    // Bar background
    s.addShape(pres.shapes.RECTANGLE, {
      x: 8.0, y: cy + 0.04, w: maxBarW, h: 0.32,
      fill: { color: C.bg3 }, line: { type: 'none' },
    });
    // Bar fill (proportional to max points / 20)
    const fillW = (c.pts / 20) * maxBarW;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 8.0, y: cy + 0.04, w: fillW, h: 0.32,
      fill: { color: c.color }, line: { type: 'none' },
    });
    // Value text on bar
    s.addText(`${c.pts}pt`, {
      x: 8.0, y: cy + 0.04, w: fillW - 0.1, h: 0.32,
      fontSize: 10, fontFace: FONT_MONO, color: '000000', bold: true,
      align: 'right', valign: 'middle', margin: 0,
    });
    cy += 0.8;
  }

  // Threshold line
  s.addText('THRESHOLD: 45 → AI fires.   Below → trigger logged, AI skipped (5min cooldown for retry).', {
    x: 0.6, y: 6.4, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 11, fontFace: FONT_MONO, color: C.cy, charSpacing: 1, bold: true,
    align: 'center', margin: 0,
  });

  addFooter(s, 8, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 9 — AUTO-SCAN ENGINE
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '08 / SCAN ENGINE');
  addTitle(s, 'AUTO-SCAN ENGINE');
  addSubtitle(s, 'Per-pair concurrent state machines · parallel processing');

  // Left: feature list
  addBulletCard(s, {
    x: 0.6, y: 2.0, w: 6.0, h: 4.5,
    title: 'HOW IT WORKS',
    bullets: [
      '21-pair watchlist — toggle any subset',
      'Each pair owns its own state: scanning / waiting / in-trade / cooldown / paused',
      'Server processes ALL pairs in parallel every 30s (Promise.all isolation per pair)',
      'Per-pair cooldown: 3–15 min (user-configurable)',
      'Dead-zone override: 22:00–08:00 UTC auto-extends to 1hr (NY close → LDN open)',
      'One pair in trade does NOT pause scanning on the others',
      'Live mini-card grid in browser, polled every 5s — at-a-glance visibility',
      'Each card shows: pair / status / price / signal levels / pair stats',
      'Click a card to focus that pair in the main view',
    ],
    accentColor: C.cy,
  });

  // Right: example mini-card grid (visual mockup)
  s.addText('LIVE MINI-CARD STATES', {
    x: 7.0, y: 2.0, w: 5.6, h: 0.3,
    fontSize: 11, fontFace: FONT_MONO, color: C.mu, charSpacing: 3, bold: true, margin: 0,
  });

  const cards = [
    { t: 'BTC',  state: 'IN TRADE',  stateColor: C.gr, line2: 'LONG @ 80,158',  line3: '67% to TP', priceColor: C.gr },
    { t: 'ETH',  state: 'WAITING',   stateColor: C.am, line2: 'SHORT @ 2,308', line3: 'Distance 0.6%', priceColor: C.am },
    { t: 'SOL',  state: 'SCANNING',  stateColor: C.cy, line2: 'Price 88.35',   line3: 'Last: bos [62]',priceColor: C.cy },
    { t: 'GOLD', state: 'COOLDOWN',  stateColor: C.mu, line2: 'Price 4,713',   line3: 'Resume in 47s', priceColor: C.mu },
  ];
  let cardY = 2.4;
  for (const c of cards) {
    s.addShape(pres.shapes.RECTANGLE, {
      x: 7.0, y: cardY, w: 5.6, h: 0.95,
      fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
    });
    // Pair name
    s.addText(c.t, {
      x: 7.15, y: cardY + 0.1, w: 1.5, h: 0.3,
      fontSize: 13, fontFace: FONT_HEAD, color: C.fg, bold: true, margin: 0,
    });
    // State badge
    s.addShape(pres.shapes.RECTANGLE, {
      x: 11.0, y: cardY + 0.1, w: 1.5, h: 0.3,
      fill: { color: c.stateColor, transparency: 80 }, line: { color: c.stateColor, width: 1 },
    });
    s.addText(c.state, {
      x: 11.0, y: cardY + 0.1, w: 1.5, h: 0.3,
      fontSize: 9, fontFace: FONT_MONO, color: c.stateColor, bold: true, charSpacing: 1,
      align: 'center', valign: 'middle', margin: 0,
    });
    // Lines
    s.addText(c.line2, {
      x: 7.15, y: cardY + 0.4, w: 5.3, h: 0.25,
      fontSize: 10, fontFace: FONT_BODY, color: c.priceColor, margin: 0,
    });
    s.addText(c.line3, {
      x: 7.15, y: cardY + 0.6, w: 5.3, h: 0.25,
      fontSize: 9, fontFace: FONT_MONO, color: C.mu, margin: 0,
    });
    cardY += 1.1;
  }

  addFooter(s, 9, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 10 — RISK MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '09 / DEFENSIVE');
  addTitle(s, 'RISK MANAGEMENT');
  addSubtitle(s, '5 layers of protection between you and a bad day');

  const layers = [
    { t: 'HARD RR FLOOR',         d: 'Any signal with RR < 1.5 auto-downgrades to NO TRADE. AI prompted to never stretch TP or tighten SL artificially.', color: C.cy },
    { t: 'CIRCUIT BREAKER',       d: '3 SLs on a pair in 24h → that pair pauses 6 hours. 3 SLs across pairs in 4h → ALL pairs pause 2 hours. Persists across restarts.', color: C.re },
    { t: 'BE-STOP DETECTION',     d: 'When BE alert fires + price returns to entry → auto-logged as BE outcome. No waiting for the original SL to trigger.', color: C.am },
    { t: 'BE-NOTE VALIDATION',    d: 'AI sometimes generates BE on the SL side of entry. Server + browser both auto-correct to halfway-to-TP before display.', color: C.pu },
    { t: 'ENTRY CONFIRMATION',    d: '1m/5m bullish/bearish pattern check inside the entry zone before drawing the signal card. Filters out aggressive entries.', color: C.gr },
  ];

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const y = 2.0 + i * 0.95;
    // Stack-style layer indicator
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.7, y, w: SLIDE_W - 1.4, h: 0.85,
      fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
    });
    // Left accent
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.7, y, w: 0.12, h: 0.85,
      fill: { color: l.color }, line: { type: 'none' },
    });
    // Number
    s.addText(`L${i + 1}`, {
      x: 0.95, y, w: 0.7, h: 0.85,
      fontSize: 22, fontFace: FONT_MONO, color: l.color, bold: true,
      align: 'center', valign: 'middle', margin: 0,
    });
    // Title
    s.addText(l.t, {
      x: 1.7, y: y + 0.08, w: 3.5, h: 0.35,
      fontSize: 13, fontFace: FONT_HEAD, color: l.color, bold: true, charSpacing: 1, margin: 0,
    });
    // Description
    s.addText(l.d, {
      x: 1.7, y: y + 0.42, w: SLIDE_W - 2.5, h: 0.45,
      fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }

  addFooter(s, 10, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 11 — TRADE MONITORING
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '10 / LIFECYCLE');
  addTitle(s, 'TRADE MONITORING');
  addSubtitle(s, 'Server tracks every trade end-to-end · server is canonical Discord source');

  // Lifecycle horizontal flow
  const stages = [
    { t: 'SIGNAL',         d: 'JSON parsed,\nlevels validated', color: C.cy },
    { t: 'WAITING ENTRY',  d: 'Limit fill check\nevery 30s',    color: C.am },
    { t: 'IN TRADE',       d: 'Entry hit alert\nfires',         color: C.gr },
    { t: 'BE LEVEL',       d: 'Price reaches\nhalfway to TP',   color: C.am },
    { t: 'TP / SL / BE',   d: 'Outcome detected\n+ logged',     color: C.pu },
    { t: 'JOURNAL',        d: 'Discord embed\n+ DB row',        color: C.gr },
  ];

  const stageW = (SLIDE_W - 1.4) / stages.length;
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const x = 0.7 + i * stageW;
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.08, y: 2.5, w: stageW - 0.16, h: 1.7,
      fill: { color: C.bg2 }, line: { color: st.color, width: 1.5 },
    });
    s.addText(st.t, {
      x: x + 0.08, y: 2.65, w: stageW - 0.16, h: 0.4,
      fontSize: 11, fontFace: FONT_HEAD, color: st.color, bold: true, charSpacing: 1,
      align: 'center', margin: 0,
    });
    s.addText(st.d, {
      x: x + 0.15, y: 3.15, w: stageW - 0.3, h: 0.95,
      fontSize: 10, fontFace: FONT_BODY, color: C.fg,
      align: 'center', valign: 'top', margin: 0,
    });
    // Arrow
    if (i < stages.length - 1) {
      s.addShape(pres.shapes.LINE, {
        x: x + stageW - 0.08, y: 3.35, w: 0.16, h: 0,
        line: { color: C.di, width: 1.5 },
      });
    }
  }

  // Bottom — duplicate-suppression note
  addBulletCard(s, {
    x: 0.6, y: 4.6, w: 6.1, h: 2.0,
    title: 'ALERT DEDUPLICATION',
    bullets: [
      'Server posts to Discord auto-webhook for entry/BE/TP/SL/expiry',
      'Browser monitor suppresses Discord when autoMode is ON',
      'Visual toast + push + sound still fire locally for UX',
      'No more duplicate alerts when both monitors are active',
    ],
    accentColor: C.am,
  });

  addBulletCard(s, {
    x: 6.95, y: 4.6, w: 5.75, h: 2.0,
    title: 'RESILIENT OUTCOME LOGGER',
    bullets: [
      'Updates DB row with outcome + outcome_rr + outcome_at',
      'If signalId missing → backfills row from in-memory data',
      'If row missing → posts journal anyway from fallback',
      'Idempotent: never double-posts journal on re-classification',
    ],
    accentColor: C.gr,
  });

  addFooter(s, 11, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 12 — NOTIFICATIONS & DISCORD
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '11 / NOTIFICATIONS');
  addTitle(s, 'DISCORD + PUSH');
  addSubtitle(s, '4 distinct channels — every event reaches you, even with browser closed');

  const channels = [
    { t: 'AUTO-SCAN', sub: 'Trigger + AI signal posts',
      d: ['Rich embed: entry / SL / TP / RR / confidence', 'Reasoning preview + key risk', 'Color-coded by direction (LONG=green, SHORT=red)'],
      color: C.cy },
    { t: 'STATUS',    sub: 'Periodic state digest',
      d: ['Fires every 15min (configurable)', 'Lists ALL watchlist pairs in one embed', 'Shows: scanning / waiting / in-trade / cooldown', 'Manual "POST NOW" button in UI'],
      color: C.am },
    { t: 'JOURNAL',   sub: 'Outcome posts',
      d: ['Fires on every TP / SL / BE outcome', 'Running stats footer: W/L/BE counts + total R + win rate', 'Color: green for TP, red for SL, amber for BE'],
      color: C.gr },
    { t: 'WEB PUSH',  sub: 'Phone notifications',
      d: ['VAPID-signed PWA notifications', 'Independent of Discord', 'Works with browser closed (service worker)', 'Per-event: entry / BE / TP / SL'],
      color: C.pu },
  ];

  const cardW = (SLIDE_W - 1.4) / 4;
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const x = 0.7 + i * cardW;
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.08, y: 2.0, w: cardW - 0.16, h: 4.5,
      fill: { color: C.bg2 }, line: { color: c.color, width: 1.5 },
    });
    // Title bar at top
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.08, y: 2.0, w: cardW - 0.16, h: 0.7,
      fill: { color: c.color, transparency: 85 }, line: { type: 'none' },
    });
    s.addText(c.t, {
      x: x + 0.08, y: 2.05, w: cardW - 0.16, h: 0.4,
      fontSize: 14, fontFace: FONT_HEAD, color: c.color, bold: true, charSpacing: 2,
      align: 'center', margin: 0,
    });
    s.addText(c.sub, {
      x: x + 0.08, y: 2.4, w: cardW - 0.16, h: 0.3,
      fontSize: 9, fontFace: FONT_MONO, color: C.mu,
      align: 'center', margin: 0,
    });
    // Bullets
    const items = c.d.map((b, j) => {
      const opt = { bullet: { code: '25AA' }, paraSpaceAfter: 6, color: C.fg, fontSize: 10 };
      if (j < c.d.length - 1) opt.breakLine = true;
      return { text: b, options: opt };
    });
    s.addText(items, {
      x: x + 0.2, y: 2.9, w: cardW - 0.4, h: 3.5,
      fontSize: 10, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }

  addFooter(s, 12, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 13 — PERFORMANCE DASHBOARD & BACKTEST
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '12 / VALIDATION');
  addTitle(s, 'DASHBOARD + BACKTEST');
  addSubtitle(s, 'Track real performance · validate prompt changes against history');

  // Left: Performance dashboard
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 2.0, w: 6.0, h: 4.5,
    fill: { color: C.bg2 }, line: { color: C.cy, width: 2 },
  });
  s.addText('/PERFORMANCE', {
    x: 0.7, y: 2.1, w: 5.8, h: 0.4,
    fontSize: 14, fontFace: FONT_MONO, color: C.cy, bold: true, charSpacing: 2, margin: 0,
  });
  s.addText('Real-time stats from closed trades', {
    x: 0.7, y: 2.45, w: 5.8, h: 0.3,
    fontSize: 11, fontFace: FONT_BODY, color: C.mu, margin: 0,
  });
  // Mini chart visualization
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.85, y: 2.95, w: 5.55, h: 1.4,
    fill: { color: C.bg3 }, line: { color: C.border, width: 1 },
  });
  // Synthetic cumulative-R line
  const points = [
    { x: 1.0, y: 4.2 }, { x: 1.5, y: 4.0 }, { x: 2.0, y: 4.1 },
    { x: 2.5, y: 3.8 }, { x: 3.0, y: 3.5 }, { x: 3.5, y: 3.7 },
    { x: 4.0, y: 3.4 }, { x: 4.5, y: 3.1 }, { x: 5.0, y: 3.3 },
    { x: 5.5, y: 3.0 }, { x: 6.0, y: 2.8 }, { x: 6.3, y: 3.05 },
  ];
  for (let i = 0; i < points.length - 1; i++) {
    s.addShape(pres.shapes.LINE, {
      x: points[i].x, y: points[i].y,
      w: points[i+1].x - points[i].x,
      h: points[i+1].y - points[i].y,
      line: { color: C.cy, width: 1.5 },
    });
  }
  s.addText('CUMULATIVE R OVER TIME', {
    x: 0.85, y: 4.4, w: 5.55, h: 0.2,
    fontSize: 9, fontFace: FONT_MONO, color: C.mu, charSpacing: 2,
    align: 'center', margin: 0,
  });
  // Bullets
  s.addText([
    { text: 'Win rate by pair / trigger / session / hour', options: { bullet: { code: '25AA' }, breakLine: true, color: C.fg } },
    { text: 'Best 10 / Worst 10 trades', options: { bullet: { code: '25AA' }, breakLine: true, color: C.fg } },
    { text: 'Expectancy per trade & total R', options: { bullet: { code: '25AA' }, breakLine: true, color: C.fg } },
    { text: 'Per-pair stats footer on every mini-card', options: { bullet: { code: '25AA' }, color: C.fg } },
  ], {
    x: 0.85, y: 4.7, w: 5.55, h: 1.7,
    fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
  });

  // Right: Backtest
  s.addShape(pres.shapes.RECTANGLE, {
    x: 6.85, y: 2.0, w: 6.0, h: 4.5,
    fill: { color: C.bg2 }, line: { color: C.gr, width: 2 },
  });
  s.addText('/BACKTEST', {
    x: 6.95, y: 2.1, w: 5.8, h: 0.4,
    fontSize: 14, fontFace: FONT_MONO, color: C.gr, bold: true, charSpacing: 2, margin: 0,
  });
  s.addText('Replay history through the full pipeline', {
    x: 6.95, y: 2.45, w: 5.8, h: 0.3,
    fontSize: 11, fontFace: FONT_BODY, color: C.mu, margin: 0,
  });

  // Backtest steps
  const bsteps = [
    { n: '1', t: 'Fetch candles', sub: 'Up to 30 days × any pair' },
    { n: '2', t: 'Iterate every candle', sub: 'Trigger detection + pre-AI score' },
    { n: '3', t: 'Fire AI', sub: 'Sonnet 4.6 with reduced context' },
    { n: '4', t: 'Walk forward', sub: 'Simulate entry / BE / TP / SL outcomes' },
    { n: '5', t: 'Aggregate stats', sub: 'By trigger / direction / hour + cum R' },
  ];
  let by = 3.0;
  for (const st of bsteps) {
    s.addShape(pres.shapes.OVAL, {
      x: 6.95, y: by, w: 0.4, h: 0.4,
      fill: { color: C.gr }, line: { type: 'none' },
    });
    s.addText(st.n, {
      x: 6.95, y: by, w: 0.4, h: 0.4,
      fontSize: 11, fontFace: FONT_MONO, color: '000000', bold: true,
      align: 'center', valign: 'middle', margin: 0,
    });
    s.addText(st.t, {
      x: 7.45, y: by + 0.02, w: 5.4, h: 0.25,
      fontSize: 11, fontFace: FONT_HEAD, color: C.fg, bold: true, margin: 0,
    });
    s.addText(st.sub, {
      x: 7.45, y: by + 0.25, w: 5.4, h: 0.2,
      fontSize: 9, fontFace: FONT_MONO, color: C.mu, margin: 0,
    });
    by += 0.6;
  }

  addFooter(s, 13, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 14 — TECH STACK
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);
  addHeader(s, '13 / TECHNOLOGY');
  addTitle(s, 'TECH STACK');
  addSubtitle(s, 'No frameworks bloat — direct, fast, observable');

  const stack = [
    { cat: 'BACKEND',   items: ['Node.js 22', 'Express', 'ES modules', 'Railway hosting'] },
    { cat: 'AI',        items: ['Claude Sonnet 4.6', 'Anthropic API direct', 'Custom prompt eng.', '$3 / $15 per MTok'] },
    { cat: 'DATABASE',  items: ['Supabase (Postgres)', 'Auth + RLS', 'service_role key', 'Realtime ready'] },
    { cat: 'FRONTEND',  items: ['Vanilla JS (no framework)', 'LightweightCharts', 'TradingView-style', 'PWA + service worker'] },
    { cat: 'AUTH',      items: ['HTTPOnly cookies', 'Password reset flow', 'Magic link optional', 'Implicit-flow handling'] },
    { cat: 'BILLING',   items: ['Paddle', 'Inline checkout (overlay)', 'Webhook reconciliation', 'HMAC-SHA256 verified'] },
    { cat: 'STREAMING', items: ['SSE for live prices', 'WebSocket multiplexing', 'Per-symbol pooling', 'Auto-reconnect'] },
    { cat: 'PUSH',      items: ['web-push library', 'VAPID signed', '410/404 cleanup', 'Per-user subs'] },
  ];

  const cols = 4;
  const cellW = (SLIDE_W - 1.2) / cols;
  const cellH = 2.1;
  for (let i = 0; i < stack.length; i++) {
    const item = stack[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 0.6 + col * cellW;
    const y = 2.0 + row * (cellH + 0.2);
    // Box
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.1, y, w: cellW - 0.2, h: cellH,
      fill: { color: C.bg2 }, line: { color: C.border, width: 1 },
    });
    // Top bar
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.1, y, w: cellW - 0.2, h: 0.5,
      fill: { color: C.cy, transparency: 85 }, line: { type: 'none' },
    });
    // Category
    s.addText(item.cat, {
      x: x + 0.1, y, w: cellW - 0.2, h: 0.5,
      fontSize: 12, fontFace: FONT_MONO, color: C.cy, bold: true, charSpacing: 3,
      align: 'center', valign: 'middle', margin: 0,
    });
    // Items
    const lines = item.items.map((it, j) => {
      const opt = { bullet: { code: '25AA' }, paraSpaceAfter: 4, color: C.fg, fontSize: 10 };
      if (j < item.items.length - 1) opt.breakLine = true;
      return { text: it, options: opt };
    });
    s.addText(lines, {
      x: x + 0.25, y: y + 0.6, w: cellW - 0.5, h: cellH - 0.7,
      fontSize: 10, fontFace: FONT_BODY, color: C.fg, margin: 0,
    });
  }

  addFooter(s, 14, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
// SLIDE 15 — SUMMARY / CTA
// ─────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  addBackground(s);

  // Big cyan accent
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: SLIDE_W, h: 0.06, fill: { color: C.cy }, line: { type: 'none' },
  });

  // Massive title
  s.addText('HENRY THE HOOVER', {
    x: 0.6, y: 0.6, w: SLIDE_W - 1.2, h: 1.0,
    fontSize: 48, fontFace: FONT_HEAD, color: C.fg, bold: true, charSpacing: 3, margin: 0,
  });
  s.addText('Built for traders who want institutional-grade signals on autopilot', {
    x: 0.6, y: 1.7, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 14, fontFace: FONT_BODY, color: C.cy, italic: true, margin: 0,
  });

  // Two columns: features | pricing
  // Left: 8 key features
  s.addText('WHAT YOU GET', {
    x: 0.6, y: 2.4, w: 7.5, h: 0.3,
    fontSize: 11, fontFace: FONT_MONO, color: C.mu, charSpacing: 4, bold: true, margin: 0,
  });

  const features = [
    '11-source AI confluence on every signal',
    'Multi-pair concurrent scanning (21 pairs, 4 exchanges)',
    'Server-side autonomous — works with browser closed',
    'Pre-AI filter saves ~40% on Anthropic costs',
    'RR floor + circuit breaker + BE-stop + entry confirm',
    'Performance dashboard + backtest validation',
    'Discord (3 channels) + Web Push notifications',
    'Smart broker routing (gold→Polygon, crypto→user choice)',
  ];
  const featItems = features.map((f, i) => {
    const opt = { bullet: { code: '2713' }, paraSpaceAfter: 6, color: C.gr, fontSize: 13 };
    if (i < features.length - 1) opt.breakLine = true;
    return { text: f, options: opt };
  });
  s.addText(featItems, {
    x: 0.6, y: 2.8, w: 7.5, h: 4.0,
    fontSize: 13, fontFace: FONT_BODY, color: C.fg, margin: 0,
  });

  // Right: Pricing card
  s.addShape(pres.shapes.RECTANGLE, {
    x: 8.6, y: 2.4, w: 4.1, h: 4.0,
    fill: { color: C.bg2 }, line: { color: C.cy, width: 2 },
  });
  s.addText('PRO', {
    x: 8.6, y: 2.55, w: 4.1, h: 0.4,
    fontSize: 13, fontFace: FONT_MONO, color: C.cy, bold: true, charSpacing: 6,
    align: 'center', margin: 0,
  });
  s.addText('$500', {
    x: 8.6, y: 3.1, w: 4.1, h: 1.0,
    fontSize: 60, fontFace: FONT_HEAD, color: C.fg, bold: true,
    align: 'center', margin: 0,
  });
  s.addText('per month · billed via Paddle', {
    x: 8.6, y: 4.0, w: 4.1, h: 0.3,
    fontSize: 11, fontFace: FONT_MONO, color: C.mu,
    align: 'center', margin: 0,
  });
  // Divider
  s.addShape(pres.shapes.LINE, {
    x: 9.0, y: 4.4, w: 3.3, h: 0,
    line: { color: C.border, width: 1 },
  });
  s.addText([
    { text: 'Unlimited AI signals', options: { bullet: { code: '2713' }, color: C.fg, breakLine: true } },
    { text: 'All 21 watchlist pairs', options: { bullet: { code: '2713' }, color: C.fg, breakLine: true } },
    { text: 'Multi-exchange coverage', options: { bullet: { code: '2713' }, color: C.fg, breakLine: true } },
    { text: 'Cancel anytime', options: { bullet: { code: '2713' }, color: C.fg } },
  ], {
    x: 8.85, y: 4.55, w: 3.6, h: 1.7,
    fontSize: 11, fontFace: FONT_BODY, color: C.fg, margin: 0,
  });

  // CTA
  s.addText('henrythehoover.com', {
    x: 0.6, y: 6.7, w: SLIDE_W - 1.2, h: 0.3,
    fontSize: 14, fontFace: FONT_MONO, color: C.cy, charSpacing: 4, bold: true,
    align: 'center', margin: 0,
  });

  addFooter(s, 15, TOTAL);
}

// ─────────────────────────────────────────────────────────────────────────
pres.writeFile({ fileName: 'C:\\Users\\User\\henry\\henry-presentation.pptx' })
  .then(name => console.log('Written:', name))
  .catch(err => { console.error(err); process.exit(1); });
