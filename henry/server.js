import express from 'express';
import cookieParser from 'cookie-parser';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import WebSocket from 'ws';
import { createHmac, timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { WeexClient } from './lib/weex.js';
import { Executor } from './lib/executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mansoor.alotaiba@gmail.com').toLowerCase();
// Default Anthropic model — used by browser-side ANALYSE (/api/claude proxy).
// Override via HENRY_AI_MODEL env var on Railway when bumping to a new release.
// Models from generation 4.6+ use the dateless format `claude-{name}-{major}-{minor}`.
const AI_MODEL = process.env.HENRY_AI_MODEL || 'claude-sonnet-4-6';
// Auto-scan can use a different (typically more capable) model since the
// server-side path makes autonomous decisions that fire real WEEX orders.
// Manual ANALYSE stays on AI_MODEL to keep interactive latency low.
// Override via HENRY_AUTOSCAN_AI_MODEL env var. Falls back to AI_MODEL if not
// set so single-env-var setups still work unchanged.
const AUTOSCAN_AI_MODEL = process.env.HENRY_AUTOSCAN_AI_MODEL || AI_MODEL;
// BE trigger: how far in profit before SL moves to breakeven. Default 50% of
// the way to TP (was 70%, lowered 2026-05-30 after analyze_ny_sweep.py showed
// ~45-48% of all SL hits would have recovered to entry within 4h — tighter BE
// trigger protects more trades from the sweep). Override via
// HENRY_BE_TRIGGER_PCT env var on Railway.
const BE_TRIGGER_PCT = parseFloat(process.env.HENRY_BE_TRIGGER_PCT) || 0.5;
// Stop-loss ATR buffer multiplier. AI prompt instructs SL placement beyond
// structural invalidation + this many ATRs. Bumped 1.5 → 2.0 on 2026-05-30
// after the same sweep analysis showed wider SLs would survive sweep-and-
// recover patterns ~30-40% more often.
const SL_ATR_BUFFER = parseFloat(process.env.HENRY_SL_ATR_BUFFER) || 2.0;
// NY-open entry block window (UTC minutes). Skip new signal generation during
// the NY sweep window — existing trades stay monitored. Set to 'false' on
// Railway to disable.
const HENRY_BLOCK_NY_OPEN = (process.env.HENRY_BLOCK_NY_OPEN ?? 'true').toLowerCase() === 'true';
const NY_OPEN_BLOCK_START_MIN = 13 * 60;        // 13:00 UTC (1h before US cash open)
const NY_OPEN_BLOCK_END_MIN   = 14 * 60 + 30;   // 14:30 UTC (30m after US cash open)
// Gold weekend block. The real gold market closes ~Fri 21:00 UTC (NY close) and
// reopens Sun ~22:00 UTC, so over Fri-Sun XAUT only chops on thin crypto-only
// liquidity. Autoscan gold went 29% WR / -2.43R Fri-Sun vs 57% / +17R Mon-Thu
// (2026-06-07 analysis), so skip NEW gold autoscan entries Fri 21:00 UTC → Mon
// 00:00 UTC. Existing trades stay monitored; crypto pairs are untouched. Toggle
// via HENRY_BLOCK_GOLD_WEEKEND. Autoscan-only (manual ANALYSE never trades).
const HENRY_BLOCK_GOLD_WEEKEND = (process.env.HENRY_BLOCK_GOLD_WEEKEND ?? 'true').toLowerCase() === 'true';
const GOLD_WEEKEND_FRI_START_MIN = 21 * 60;     // Fri 21:00 UTC
function isGoldCoin(coin) { return /^(GOLD|XAU)/i.test(String(coin || '')); } // GOLD, XAUUSD, XAUTUSDT
function isGoldWeekendBlocked(now) {
  const day = now.getUTCDay();                   // 0=Sun, 1=Mon … 5=Fri, 6=Sat
  if (day === 6 || day === 0) return true;       // all of Sat + Sun
  if (day === 5 && (now.getUTCHours() * 60 + now.getUTCMinutes()) >= GOLD_WEEKEND_FRI_START_MIN) return true; // Fri from 21:00 UTC
  return false;
}
// Pre-NY-open SL→BE protection window (UTC minutes). Auto-move SL to BE for
// any in-profit trade when we enter the 5min window before NY open. Trades
// not in profit yet stay at original SL.
const PRE_NY_BE_WINDOW_START_MIN = 13 * 60 - 5; // 12:55 UTC
const PRE_NY_BE_WINDOW_END_MIN   = 13 * 60;     // 13:00 UTC
const PADDLE_API_HOST = process.env.PADDLE_ENV === 'sandbox'
  ? 'sandbox-api.paddle.com'
  : 'api.paddle.com';

// ── WEEX auto-trade (admin-only) ────────────────────────────────────────────
// Wires the scan-loop signals → WEEX orders. Kill switch defaults OFF on every
// boot — must be explicitly turned on via /api/bot/state. Falls back to no-op
// if WEEX env vars are missing so the website still runs without keys.
const HENRY_RISK_USD = parseFloat(process.env.HENRY_RISK_USD) || 50; // $50/trade since 2026-06-11 (was 30, before that 10)
const HENRY_LEVERAGE = parseInt(process.env.HENRY_LEVERAGE, 10) || 10;
// ── Dynamic per-trade leverage ────────────────────────────────────────────
// Risk ($) is fixed by position size; leverage only sets margin + how close
// liquidation sits. When enabled (default), the executor sizes leverage per
// trade from the stop distance: as high as is safe so the $-risk position is
// affordable, but always below the point where price would liquidate before
// the stop. HENRY_LEV_SAFETY is the fraction of the liquidation distance the
// stop is allowed to sit at (0.5 = stop at half the distance → 2× buffer).
// Set HENRY_DYNAMIC_LEVERAGE=false to revert to fixed HENRY_LEVERAGE/overrides.
const HENRY_DYNAMIC_LEVERAGE = (process.env.HENRY_DYNAMIC_LEVERAGE || 'true').toLowerCase() !== 'false';
const HENRY_LEV_MIN = parseInt(process.env.HENRY_LEV_MIN, 10) || 5;
const HENRY_LEV_MAX = parseInt(process.env.HENRY_LEV_MAX, 10) || 50;
const HENRY_LEV_SAFETY = parseFloat(process.env.HENRY_LEV_SAFETY) || 0.5;
// Per-symbol leverage overrides. JSON map like {"ETHUSDT":100,"BNBUSDT":50}.
// Symbols not in the map use HENRY_LEVERAGE. Set via Railway env var.
const HENRY_LEVERAGE_OVERRIDES = (() => {
  const raw = process.env.HENRY_LEVERAGE_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    console.log('[weex] leverage overrides:', parsed);
    return parsed;
  } catch (err) {
    console.warn('[weex] HENRY_LEVERAGE_OVERRIDES is not valid JSON:', err.message);
    return {};
  }
})();
const HENRY_BE_FEE_BUFFER_BPS = parseFloat(process.env.HENRY_BE_FEE_BUFFER_BPS) || 12;
// Per-symbol risk-$ overrides. Flat risk across all pairs since 2026-06-11
// ("risk on every trade = $50") — the old XAUTUSDT:30 default is gone. Env var
// override JSON like {"XAUTUSDT":30} still works for future per-pair tuning.
const HENRY_RISK_OVERRIDES = (() => {
  const raw = process.env.HENRY_RISK_OVERRIDES;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (err) {
    console.warn('[weex] HENRY_RISK_OVERRIDES not valid JSON:', err.message);
    return {};
  }
})();
// Per-symbol BE fee-buffer overrides. WEEX charges 0% fees on XAUT futures
// (verified 2026-05-24), so the 12 bps default buffer just gives back unrealised
// alpha on every BE move. Set to 0 for fee-free symbols.
const HENRY_BE_FEE_BUFFER_OVERRIDES = (() => {
  const raw = process.env.HENRY_BE_FEE_BUFFER_OVERRIDES;
  if (!raw) return { XAUTUSDT: 0 };
  try { return JSON.parse(raw); } catch (err) {
    console.warn('[weex] HENRY_BE_FEE_BUFFER_OVERRIDES not valid JSON:', err.message);
    return { XAUTUSDT: 0 };
  }
})();
// Bump XAUT default leverage to 50x (from base 10x) so the $30 risk doesn't
// eat all the available margin. WEEX maxLeverage on XAUT is 400; 50x leaves
// healthy headroom while still being capital-efficient.
if (!('XAUTUSDT' in HENRY_LEVERAGE_OVERRIDES)) {
  HENRY_LEVERAGE_OVERRIDES.XAUTUSDT = parseInt(process.env.HENRY_GOLD_LEVERAGE || '50', 10);
}
const HENRY_DRY_RUN = (process.env.HENRY_DRY_RUN || '').toLowerCase() === 'true';
let weexClient = null, weexExecutor = null;
if (process.env.WEEX_API_KEY && process.env.WEEX_API_SECRET && process.env.WEEX_API_PASSPHRASE) {
  weexClient = new WeexClient({
    apiKey: process.env.WEEX_API_KEY,
    apiSecret: process.env.WEEX_API_SECRET,
    apiPassphrase: process.env.WEEX_API_PASSPHRASE,
    baseUrl: process.env.WEEX_BASE_URL,
    dryRun: HENRY_DRY_RUN,
  });
  weexExecutor = new Executor({
    client: weexClient,
    riskUsd: HENRY_RISK_USD,
    leverage: HENRY_LEVERAGE,
    leverageOverrides: HENRY_LEVERAGE_OVERRIDES,
    riskOverrides: HENRY_RISK_OVERRIDES,
    dynamicLeverage: HENRY_DYNAMIC_LEVERAGE,
    levMin: HENRY_LEV_MIN,
    levMax: HENRY_LEV_MAX,
    levSafetyFactor: HENRY_LEV_SAFETY,
    beFeeBufferBps: HENRY_BE_FEE_BUFFER_BPS,
    beFeeBufferOverrides: HENRY_BE_FEE_BUFFER_OVERRIDES,
    notifier: async (msg) => {
      // WEEX auto-trade execution alerts go to their OWN dedicated webhook —
      // NOT the journal channel (that's signal outcomes) and NOT the signal
      // channels. Keeps the execution log isolated.
      if (process.env.DISCORD_WEEX_WEBHOOK) {
        try {
          await fetch(process.env.DISCORD_WEEX_WEBHOOK, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: msg }),
          });
        } catch (err) { console.warn('[executor notifier]', err.message || err); }
      }
    },
    // Persist every terminal trade to Supabase so PnL aggregates survive
    // Railway redeploys. Best-effort: if the table is missing (user hasn't
    // run db/weex_trades.sql yet) or Supabase is unreachable, log and move
    // on — the executor's in-memory map still works for this process.
    onTradeClosed: async (t) => {
      try {
        const { error } = await supaAdmin.from('weex_trades').upsert({
          signal_id: t.signalId,
          pair: t.pair || t.symbol,
          symbol: t.symbol,
          side: t.side,
          entry_price: t.entryPrice || null,
          sl_price: t.slPrice || null,
          tp_price: t.tpPrice || null,
          fill_price: t.fillPrice || null,
          exit_price: t.exitPrice || null,
          quantity: t.quantity || 0,
          leverage: t.leverage || null,
          state: t.state,
          closed_pnl: t.closedPnl || 0,
          slippage: t.slippage || 0,
          recovered: !!t.recovered,
          reject_reason: t.rejectReason || null,
          closed_at: new Date(t.updatedAt || Date.now()).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'signal_id' });
        if (error) console.warn('[weex_trades upsert]', error.message);
      } catch (err) {
        console.warn('[weex_trades upsert]', err.message || err);
      }
    },
  });
  console.log('[weex] executor ready — risk=$' + HENRY_RISK_USD
    + (HENRY_DYNAMIC_LEVERAGE
        ? ' lev=DYNAMIC(safety=' + HENRY_LEV_SAFETY + ' min=' + HENRY_LEV_MIN + 'x max=' + HENRY_LEV_MAX + 'x)'
        : ' lev=' + HENRY_LEVERAGE + 'x')
    + (HENRY_DRY_RUN ? ' DRY-RUN' : ''));
  console.log('[weex] leverageOverrides:', JSON.stringify(HENRY_LEVERAGE_OVERRIDES));
  console.log('[weex] riskOverrides:', JSON.stringify(HENRY_RISK_OVERRIDES));
  console.log('[weex] beFeeBufferOverrides:', JSON.stringify(HENRY_BE_FEE_BUFFER_OVERRIDES));
  // Reconcile on boot and every 60s so:
  //   - Redeploy doesn't lose BE management on open positions (forward path)
  //   - Stale trades close when WEEX's TP/SL plan fires server-side without
  //     our scan-loop monitor seeing it (reverse path) — chart panels then
  //     transition back to scanning within ~60s
  const runReconcile = () => {
    weexExecutor.reconcile().then(r => {
      if (r.recovered > 0) console.log(`[weex] reconcile recovered ${r.recovered} open position(s)`);
      if (r.cleaned > 0) console.log(`[weex] reconcile cleaned ${r.cleaned} stale trade(s)`);
      if (r.warnings && r.warnings.length) for (const w of r.warnings) console.warn(`[weex] reconcile warning: ${w}`);
    }).catch(err => console.warn('[weex] reconcile failed:', err.message || err));
  };
  runReconcile();
  setInterval(runReconcile, 60_000);
} else {
  console.log('[weex] disabled — WEEX_API_KEY/SECRET/PASSPHRASE not set');
}
// Module-level kill switch — flipped via /api/bot/state. Defaults OFF on boot.
let autoTradeEnabled = false;
function autoTradeAllowed(isAdmin) {
  return !!weexExecutor && !!autoTradeEnabled && !!isAdmin;
}

// Admin user_id — resolved once from the profiles table by ADMIN_EMAIL, then
// cached. Used by /api/kingdom/* endpoints so non-admin subscribers viewing
// Kingdom see Mansoor's record + his auto-scan charts, not their own (empty).
let _adminUserId = null;
let _adminUserIdLookupAt = 0;
async function getAdminUserId() {
  if (_adminUserId) return _adminUserId;
  // Throttle failed lookups to once per 60s so a missing profile row doesn't hammer Supabase.
  if (Date.now() - _adminUserIdLookupAt < 60_000) return null;
  _adminUserIdLookupAt = Date.now();
  try {
    const { data } = await supaAdmin
      .from('profiles')
      .select('user_id')
      .eq('email', ADMIN_EMAIL)
      .maybeSingle();
    if (data?.user_id) {
      _adminUserId = data.user_id;
      console.log('[admin] resolved user_id for', ADMIN_EMAIL, '=', _adminUserId);
    } else {
      console.warn('[admin] no profile row for', ADMIN_EMAIL, '— Kingdom will fall back to caller userId');
    }
  } catch (err) {
    console.warn('[admin] user_id lookup failed:', err.message || err);
  }
  return _adminUserId;
}
async function fireExecutor(method, payload, label) {
  if (!weexExecutor) return;
  try {
    await weexExecutor[method](payload);
  } catch (err) {
    console.warn(`[executor ${label}]`, err.message || err);
  }
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cookieParser());

// ── Supabase clients ────────────────────────────────────────────────────────
function reqEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required env var: ${name}`);
  return process.env[name];
}
const SUPABASE_URL = reqEnv('SUPABASE_URL');
const SUPABASE_ANON_KEY = reqEnv('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = reqEnv('SUPABASE_SERVICE_ROLE_KEY');

const supaAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const supaAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Cookie helpers ──────────────────────────────────────────────────────────
const ACCESS_COOKIE = 'sb-access-token';
const REFRESH_COOKIE = 'sb-refresh-token';
const cookieBase = {
  httpOnly: true,
  sameSite: 'lax',
  secure: PROD,
  path: '/',
};
function setAuthCookies(res, accessToken, refreshToken) {
  // Access token: short-lived, refreshed on demand
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase, maxAge: 60 * 60 * 1000 });
  // Refresh token: long-lived
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
}
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieBase);
  res.clearCookie(REFRESH_COOKIE, cookieBase);
}

// ── Auth middleware ─────────────────────────────────────────────────────────
async function resolveSession(req, res) {
  let accessToken = req.cookies[ACCESS_COOKIE];
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (!accessToken && !refreshToken) return null;

  let userResp = accessToken ? await supaAnon.auth.getUser(accessToken) : { data: { user: null }, error: new Error('no access') };

  if ((!userResp?.data?.user || userResp.error) && refreshToken) {
    const refreshClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await refreshClient.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data?.session) {
      accessToken = data.session.access_token;
      setAuthCookies(res, data.session.access_token, data.session.refresh_token);
      userResp = { data: { user: data.user }, error: null };
    }
  }

  const user = userResp?.data?.user;
  if (!user) {
    clearAuthCookies(res);
    return null;
  }
  return { user, accessToken };
}

async function loadProfile(email) {
  const { data, error } = await supaAdmin
    .from('profiles')
    .select('*')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Auto-expire subscriptions whose current_period_end has passed. Without this,
// a subscription_status='active' flag from a 30-day-old NowPayments payment
// would still grant access forever. Called from requireAuth on every gated
// request so expiry is enforced server-side (the user can't bypass it).
async function _expireIfPast(profile) {
  if (!profile || !profile.current_period_end) return profile;
  if (profile.subscription_status !== 'active') return profile;
  if (profile.email && profile.email.toLowerCase() === ADMIN_EMAIL) return profile; // admin never expires
  const periodEnd = new Date(profile.current_period_end).getTime();
  if (!isFinite(periodEnd) || periodEnd > Date.now()) return profile;
  // Period ended — flip status and persist
  await supaAdmin.from('profiles').update({
    subscription_status: 'expired',
    updated_at: new Date().toISOString(),
  }).eq('email', profile.email);
  console.log('[auth] subscription expired for', profile.email);
  return Object.assign({}, profile, { subscription_status: 'expired' });
}

async function requireAuth(req, res, next) {
  try {
    const session = await resolveSession(req, res);
    if (!session) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const email = session.user.email.toLowerCase();
    // Admin always has full access regardless of subscription
    if (email === ADMIN_EMAIL) {
      const profile = await loadProfile(email).catch(() => null);
      req.user = session.user;
      req.profile = profile || { email, is_admin: true, subscription_status: 'active', plan: 'admin' };
      return next();
    }
    let profile = await loadProfile(email);
    profile = await _expireIfPast(profile);
    if (!profile || profile.subscription_status !== 'active') {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/subscribe');
      return res.status(403).json({ error: 'subscription_required' });
    }
    req.user = session.user;
    req.profile = profile;
    next();
  } catch (err) {
    console.error('[auth]', err);
    res.status(500).json({ error: 'auth_error' });
  }
}

// Requires only a valid session (no subscription check) — used for Paddle, account, and password-reset endpoints.
async function requireSession(req, res, next) {
  try {
    const session = await resolveSession(req, res);
    if (!session) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
      return res.status(401).json({ error: 'unauthenticated' });
    }
    let profile = await loadProfile(session.user.email.toLowerCase()).catch(() => null);
    // Apply the same expiry sweep so /api/me + account page see honest status
    profile = await _expireIfPast(profile).catch(() => profile);
    req.user = session.user;
    req.profile = profile;
    next();
  } catch (err) {
    console.error('[session]', err);
    res.status(500).json({ error: 'auth_error' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const isAdmin = !!req.profile?.is_admin || req.user.email.toLowerCase() === ADMIN_EMAIL;
    if (!isAdmin) {
      if (req.method === 'GET' && req.accepts('html')) return res.status(403).send('Forbidden');
      return res.status(403).json({ error: 'admin_only' });
    }
    next();
  });
}

// ── Public auth routes ──────────────────────────────────────────────────────
app.post('/auth/start', express.json(), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  try {
    let profile = await loadProfile(email);
    if (!profile) {
      const { error } = await supaAdmin.from('profiles').insert({ email, approved: false });
      if (error) throw error;
      await notifyAdminOfRequest(email);
      return res.json({ status: 'requested' });
    }
    if (!profile.approved) return res.json({ status: 'pending' });

    const { error } = await supaAnon.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${SITE_URL}/auth/callback`,
        shouldCreateUser: true,
      },
    });
    if (error) throw error;
    return res.json({ status: 'sent' });
  } catch (err) {
    console.error('[auth/start]', err);
    res.status(500).json({ error: 'auth_start_failed' });
  }
});

app.get('/auth/callback', async (req, res) => {
  // The Supabase magic-link email template points here with
  //   ?token_hash=...&type=magiclink
  // We exchange that for a session server-side, set HTTPOnly cookies,
  // and redirect into the app — no client-side JS required.
  const tokenHash = typeof req.query.token_hash === 'string' ? req.query.token_hash : '';
  const type = typeof req.query.type === 'string' ? req.query.type : 'magiclink';
  const errDesc = typeof req.query.error_description === 'string' ? req.query.error_description : '';

  if (errDesc) return res.redirect('/login?error=' + encodeURIComponent(errDesc));

  if (tokenHash) {
    try {
      const { data, error } = await supaAnon.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error || !data?.session?.access_token) {
        console.error('[auth/callback verifyOtp]', error);
        return res.redirect('/login?error=' + encodeURIComponent(error?.message || 'verify_failed'));
      }
      const email = data.user.email.toLowerCase();
      setAuthCookies(res, data.session.access_token, data.session.refresh_token);
      // Recovery flow → send to password-reset page (session cookie is now set)
      if (type === 'recovery') return res.redirect('/reset-password');
      // Magic-link / email OTP flow → normal login
      const profile = await loadProfile(email).catch(() => null);
      if (profile && !profile.user_id) {
        await supaAdmin.from('profiles').update({ user_id: data.user.id }).eq('email', email);
      }
      const isAdmin = email === ADMIN_EMAIL;
      const subscribed = isAdmin || profile?.subscription_status === 'active';
      return res.redirect(subscribed ? '/terminal' : '/subscribe');
    } catch (err) {
      console.error('[auth/callback]', err);
      return res.redirect('/login?error=callback_error');
    }
  }

  // Fallback for the old implicit-flow link format (#access_token=...&refresh_token=...).
  // Still useful if someone has an unexpired email from before the template change.
  res.type('html').send(`<!doctype html>
<meta charset="utf-8"><title>Signing in…</title>
<body style="background:#08090d;color:#9aa0a6;font-family:Courier New,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div id="msg">Signing you in…</div>
<script>
(async () => {
  const msg = document.getElementById('msg');
  const params = new URLSearchParams(location.hash.slice(1));
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  const errDesc = params.get('error_description');
  if (errDesc) { msg.textContent = 'Auth error: ' + errDesc; return; }
  if (!access_token || !refresh_token) { msg.textContent = 'Missing tokens — open the link from your email again.'; return; }
  try {
    const r = await fetch('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, refresh_token })
    });
    if (r.ok) {
      const isRecovery = params.get('type') === 'recovery';
      location.replace(isRecovery ? '/reset-password' : '/terminal');
    } else { const t = await r.text(); msg.textContent = 'Sign-in failed (' + r.status + '): ' + t; }
  } catch (e) { msg.textContent = 'Network error: ' + e.message; }
})();
</script>`);
});

app.post('/auth/session', express.json(), async (req, res) => {
  const { access_token, refresh_token } = req.body || {};
  if (!access_token || !refresh_token) return res.status(400).json({ error: 'missing_tokens' });
  try {
    const { data, error } = await supaAnon.auth.getUser(access_token);
    if (error || !data?.user?.email) return res.status(401).json({ error: 'invalid_token' });
    const email = data.user.email.toLowerCase();
    const isAdmin = email === ADMIN_EMAIL;
    // Admin bypasses profile check — they may not have a profiles row
    if (!isAdmin) {
      const profile = await loadProfile(email).catch(() => null);
      if (!profile) return res.status(403).json({ error: 'no_profile' });
      if (!profile.user_id) {
        await supaAdmin
          .from('profiles')
          .update({ user_id: data.user.id })
          .eq('email', email);
      }
    }
    setAuthCookies(res, access_token, refresh_token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/session]', err);
    res.status(500).json({ error: 'session_error' });
  }
});

app.post('/auth/logout', (_req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.get('/login',          (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register',       (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));
app.get('/subscribe',      (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'subscribe.html')));
app.get('/subscribe/success', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'subscribe-success.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reset-password.html')));
app.get('/account',        requireSession, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'account.html')));
app.get('/performance',    requireAuth,    (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'performance.html')));
app.get('/kingdom',        requireAuth,    (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'kingdom.html')));
app.get('/backtest',       requireAuth,    (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'backtest.html')));

// Set a new password — requires valid session set by /auth/callback (recovery flow)
app.post('/api/auth/update-password', requireSession, express.json(), async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  try {
    const { error } = await supaAdmin.auth.admin.updateUserById(req.user.id, { password });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    console.error('[update-password]', err);
    res.status(500).json({ error: 'Password update failed.' });
  }
});

// ── Email + password auth ────────────────────────────────────────────────────
app.post('/api/auth/register', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  const addr = String(email || '').trim().toLowerCase();
  if (!addr || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) required.' });
  }
  try {
    const { data, error } = await supaAdmin.auth.admin.createUser({
      email: addr, password, email_confirm: true,
    });
    if (error) return res.status(400).json({ error: error.message });
    const existing = await loadProfile(addr).catch(() => null);
    if (!existing) {
      await supaAdmin.from('profiles').insert({
        email: addr, user_id: data.user.id,
        subscription_status: 'inactive', plan: 'none',
      });
    }
    // Auto sign-in so browser can proceed to subscribe page straight away
    const { data: si, error: sie } = await supaAnon.auth.signInWithPassword({ email: addr, password });
    if (sie || !si?.session) {
      console.error('[auth/register auto-signin]', sie);
      return res.status(500).json({ error: 'Account created but auto sign-in failed. Please log in manually.' });
    }
    setAuthCookies(res, si.session.access_token, si.session.refresh_token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  const addr = String(email || '').trim().toLowerCase();
  if (!addr || !password) return res.status(400).json({ error: 'missing_credentials' });
  try {
    const { data, error } = await supaAnon.auth.signInWithPassword({ email: addr, password });
    if (error || !data?.session) return res.status(401).json({ error: 'Invalid email or password.' });
    setAuthCookies(res, data.session.access_token, data.session.refresh_token);
    const profile = await loadProfile(addr).catch(() => null);
    const subscribed = addr === ADMIN_EMAIL || profile?.subscription_status === 'active';
    res.json({ ok: true, subscribed });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Forgot password — sends Supabase reset email
app.post('/api/auth/forgot-password', express.json(), async (req, res) => {
  const addr = String(req.body?.email || '').trim().toLowerCase();
  if (!addr) return res.status(400).json({ error: 'missing_email' });
  await supaAnon.auth.resetPasswordForEmail(addr, { redirectTo: `${SITE_URL}/auth/callback` });
  res.json({ ok: true }); // always OK — don't expose whether email exists
});

// Identity for the frontend — used to gate admin-only UI (share signal, auto-scan).
// requireSession (not requireAuth) so unsubscribed users on /subscribe can also fetch their info.
app.get('/api/me', requireSession, (req, res) => {
  res.json({
    id:                  req.user.id,
    email:               req.user.email,
    is_admin:            !!req.profile?.is_admin || req.user.email.toLowerCase() === ADMIN_EMAIL,
    plan:                req.profile?.plan || 'none',
    subscription_status: req.profile?.subscription_status || 'inactive',
    current_period_end:  req.profile?.current_period_end || null,
    ai_model:            AI_MODEL,
    autoscan_ai_model:   AUTOSCAN_AI_MODEL,
    strategy_mode:       STRATEGY_MODE,
  });
});

// ── Admin routes ────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/admin/pending', requireAdmin, async (_req, res) => {
  const { data, error } = await supaAdmin
    .from('profiles')
    .select('email, approved, is_admin, requested_at, approved_at')
    .order('requested_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profiles: data });
});

app.post('/admin/approve', requireAdmin, express.json(), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'missing_email' });
  const { error } = await supaAdmin
    .from('profiles')
    .update({ approved: true, approved_at: new Date().toISOString() })
    .eq('email', email);
  if (error) return res.status(500).json({ error: error.message });
  // Send them a magic link so they can sign in immediately
  await supaAnon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${SITE_URL}/auth/callback`, shouldCreateUser: true },
  });
  res.json({ ok: true });
});

app.post('/admin/deny', requireAdmin, express.json(), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'missing_email' });
  const { error } = await supaAdmin.from('profiles').delete().eq('email', email);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Paddle ──────────────────────────────────────────────────────────────────

// Paddle REST helper — server-side only (uses secret API key)
async function paddleFetch(method, path, body = null) {
  if (!process.env.PADDLE_API_KEY) throw new Error('PADDLE_API_KEY not set');
  const r = await fetch(`https://${PADDLE_API_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// Verify the Paddle-Signature header: ts=<timestamp>;h1=<hmac-sha256>
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const map = {};
  for (const part of String(signatureHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) map[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const { ts, h1 } = map;
  if (!ts || !h1) return false;
  const expected = createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');
  // Constant-time comparison — prevent timing attacks
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(h1, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Public — returns the client-side token (safe to expose) and price ID.
// subscribe.html uses these to initialise Paddle.js inline checkout.
app.get('/api/paddle/config', (_req, res) => {
  res.json({
    clientToken:  process.env.PADDLE_CLIENT_TOKEN || '',
    priceId:      process.env.PADDLE_PRICE_ID || '',
    environment:  process.env.PADDLE_ENV === 'sandbox' ? 'sandbox' : 'production',
  });
});

// Webhook — raw body required for signature verification.
app.post('/api/paddle/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const sig     = req.headers['paddle-signature'];
  const secret  = process.env.PADDLE_WEBHOOK_SECRET;

  if (!verifyPaddleSignature(rawBody, sig, secret)) {
    console.error('[paddle webhook] bad signature');
    return res.status(400).send('Bad signature');
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).send('Bad JSON'); }

  const data = event.data || {};
  try {
    switch (event.event_type) {
      // ── New subscription created (fires on first checkout) ─────────────────
      case 'subscription.created': {
        const uid = data.custom_data?.supabase_uid;
        const updates = {
          subscription_status: 'active',
          subscription_id:     data.id,
          paddle_customer_id:  data.customer_id,
          plan:                'monthly',
          current_period_end:  data.current_billing_period?.ends_at || null,
          updated_at:          new Date().toISOString(),
        };
        if (uid) {
          await supaAdmin.from('profiles').update(updates).eq('user_id', uid);
        } else if (data.customer_id) {
          await supaAdmin.from('profiles').update(updates).eq('paddle_customer_id', data.customer_id);
        }
        break;
      }
      // ── Subscription renewed / status changed ──────────────────────────────
      case 'subscription.updated': {
        const status = data.status === 'active'   ? 'active'
                     : data.status === 'canceled'  ? 'cancelled'
                     : data.status === 'past_due'  ? 'past_due'
                     : data.status || 'inactive';
        await supaAdmin.from('profiles').update({
          subscription_status: status,
          current_period_end:  data.current_billing_period?.ends_at || null,
          updated_at:          new Date().toISOString(),
        }).eq('paddle_customer_id', data.customer_id);
        break;
      }
      // ── Subscription fully cancelled ───────────────────────────────────────
      case 'subscription.canceled': {
        await supaAdmin.from('profiles').update({
          subscription_status: 'inactive',
          plan:                'none',
          updated_at:          new Date().toISOString(),
        }).eq('paddle_customer_id', data.customer_id);
        break;
      }
      // ── Payment received (backup activation for renewals) ──────────────────
      case 'transaction.completed': {
        if (data.subscription_id && data.customer_id) {
          await supaAdmin.from('profiles').update({
            subscription_status: 'active',
            updated_at:          new Date().toISOString(),
          }).eq('paddle_customer_id', data.customer_id);
        }
        break;
      }
    }
  } catch (err) {
    console.error('[paddle webhook]', event.event_type, err.message);
  }
  res.json({ received: true });
});

// Cancel subscription at period end.
app.post('/api/paddle/cancel', requireSession, async (req, res) => {
  try {
    const subId = req.profile?.subscription_id;
    if (!subId) return res.status(400).json({ error: 'No active subscription found.' });
    const result = await paddleFetch('PATCH', `/subscriptions/${subId}`, {
      scheduled_change: { action: 'cancel', effective_at: 'next_billing_period' },
    });
    if (result.error) {
      return res.status(400).json({ error: result.error.detail || 'Cancel failed.' });
    }
    await supaAdmin.from('profiles').update({
      subscription_status: 'cancelled',
      updated_at:          new Date().toISOString(),
    }).eq('email', req.user.email.toLowerCase());
    res.json({ ok: true });
  } catch (err) {
    console.error('[paddle/cancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── NowPayments (crypto subscriptions) ───────────────────────────────────
// Monthly invoice model: user clicks subscribe → server creates a hosted
// NowPayments invoice → user redirects to nowpayments.io to pay any crypto →
// IPN webhook flips profile.subscription_status to 'active' for 30 days.
// Renewals require a fresh invoice (no custodial auto-recurring on the
// standard NowPayments tier — they only offer that for white-label).
const NOWPAY_API = 'https://api.nowpayments.io/v1';
const NOWPAY_PRICE_USD = parseFloat(process.env.NOWPAYMENTS_PRICE_USD) || 500;

async function nowpayFetch(method, path, body = null) {
  if (!process.env.NOWPAYMENTS_API_KEY) throw new Error('NOWPAYMENTS_API_KEY not set');
  const r = await fetch(`${NOWPAY_API}${path}`, {
    method,
    headers: {
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// NowPayments IPN signature: HMAC-SHA512 of the JSON body with keys sorted
// alphabetically (recursively for nested objects). The header is
// `x-nowpayments-sig`. Without this verification, anyone could mark a
// subscription active by POSTing arbitrary JSON to the webhook URL.
function _sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(_sortJsonKeys);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(k => { out[k] = _sortJsonKeys(value[k]); });
    return out;
  }
  return value;
}
function verifyNowPaySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  try {
    const parsed = JSON.parse(rawBody);
    const sortedJson = JSON.stringify(_sortJsonKeys(parsed));
    const expected = createHmac('sha512', secret).update(sortedJson).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(signatureHeader), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

// Public config — tells the subscribe page whether crypto checkout is enabled.
app.get('/api/nowpayments/config', (_req, res) => {
  res.json({
    enabled: !!process.env.NOWPAYMENTS_API_KEY,
    priceUsd: NOWPAY_PRICE_USD,
  });
});

// Create a hosted invoice for the authenticated user. Returns { invoiceUrl }
// which the browser redirects to — user then pays in any crypto on nowpayments.io.
app.post('/api/nowpayments/create-invoice', requireSession, async (req, res) => {
  if (!process.env.NOWPAYMENTS_API_KEY) {
    return res.status(503).json({ error: 'nowpayments_not_configured' });
  }
  try {
    const email = (req.user.email || '').toLowerCase();
    const uid = req.user.id;
    // order_id encodes uid + ms so we can correlate the IPN back to a user
    // even if NowPayments swallows our customData. order_description shows
    // on the invoice page so the user sees what they're paying for.
    const orderId = `henry_${uid}_${Date.now()}`;
    const siteUrl = process.env.SITE_URL || `https://${req.headers.host || 'henrythehoover.com'}`;
    const invoice = await nowpayFetch('POST', '/invoice', {
      price_amount: NOWPAY_PRICE_USD,
      price_currency: 'usd',
      order_id: orderId,
      order_description: 'Henry The Hoover — 30 days access',
      ipn_callback_url: `${siteUrl}/api/nowpayments/webhook`,
      success_url: `${siteUrl}/subscribe/success`,
      cancel_url: `${siteUrl}/subscribe`,
      is_fee_paid_by_user: false,
    });
    if (invoice.error || !invoice.invoice_url) {
      console.error('[nowpay/create-invoice] failed:', JSON.stringify(invoice).slice(0, 400));
      return res.status(502).json({ error: 'invoice_failed', detail: invoice.message || 'NowPayments rejected the invoice request' });
    }
    // Stash the orderId on the user's profile so we can find them when the
    // IPN lands (uid is encoded in order_id but storing it here is cheaper).
    await supaAdmin.from('profiles').update({
      nowpay_last_order_id: orderId,
      updated_at: new Date().toISOString(),
    }).eq('email', email).then(() => {}, () => {});
    console.log('[nowpay/create-invoice]', email, '$' + NOWPAY_PRICE_USD, '→', invoice.id);
    res.json({ invoiceUrl: invoice.invoice_url, invoiceId: invoice.id, orderId });
  } catch (err) {
    console.error('[nowpay/create-invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook (IPN) — raw body required for signature verification.
// NowPayments sends a payment_status field; we only act on 'finished' and
// 'partially_paid' (close enough — credits the user, logs the underpay).
app.post('/api/nowpayments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const sig = req.headers['x-nowpayments-sig'];
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!verifyNowPaySignature(rawBody, sig, secret)) {
    console.error('[nowpay webhook] bad signature');
    return res.status(400).send('Bad signature');
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).send('Bad JSON'); }

  const orderId = event.order_id || '';
  const status = event.payment_status; // waiting | confirming | confirmed | sending | partially_paid | finished | failed | refunded | expired
  console.log('[nowpay webhook]', orderId, status, 'pay=' + event.actually_paid + ' ' + event.pay_currency);

  // Only credit the user when payment is fully received
  if (status !== 'finished' && status !== 'partially_paid') {
    return res.json({ received: true });
  }

  // Extract uid from order_id (format: henry_<uid>_<ts>)
  const m = orderId.match(/^henry_([^_]+(?:-[^_]+)*)_\d+$/);
  const uid = m ? m[1] : null;
  if (!uid) {
    console.warn('[nowpay webhook] could not parse uid from order_id:', orderId);
    return res.json({ received: true });
  }

  // Stack 30 days from whichever is later: NOW or the existing period_end.
  // So a user who renews 5 days early gets 35 days total from today, not 30.
  // Without this, early renewers would lose the time they paid for.
  const { data: existing } = await supaAdmin.from('profiles')
    .select('current_period_end')
    .eq('user_id', uid).maybeSingle();
  const now = Date.now();
  const existingEnd = existing && existing.current_period_end ? new Date(existing.current_period_end).getTime() : 0;
  const baseline = (existingEnd > now) ? existingEnd : now;
  const periodEnd = new Date(baseline + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supaAdmin.from('profiles').update({
    subscription_status: 'active',
    plan: 'monthly_crypto',
    current_period_end: periodEnd,
    updated_at: new Date().toISOString(),
  }).eq('user_id', uid);
  if (error) {
    console.error('[nowpay webhook] supabase update failed:', error.message);
  } else {
    const stacked = existingEnd > now ? ` (stacked on existing ${new Date(existingEnd).toISOString()})` : '';
    console.log('[nowpay webhook] activated', uid, 'until', periodEnd, stacked);
  }
  res.json({ received: true });
});

// ── Whop (recurring subscriptions, no KYC required for sellers) ──────────
// Flow: user clicks Subscribe → server hands back a Whop checkout URL with
// supabase_uid encoded as metadata → user pays card/crypto/Apple Pay on
// Whop's hosted checkout → Whop webhooks membership_activated back here →
// we set subscription_status='active' + current_period_end = membership's
// renewal_period_end. Whop handles all recurring billing automatically.
const WHOP_API = 'https://api.whop.com/api/v5';
const WHOP_CHECKOUT_URL = process.env.WHOP_CHECKOUT_URL || ''; // e.g. https://whop.com/checkout/plan_xxxxx/

async function whopFetch(method, path, body = null) {
  if (!process.env.WHOP_API_KEY) throw new Error('WHOP_API_KEY not set');
  const r = await fetch(`${WHOP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// Whop signs webhook payloads with HMAC-SHA256 on the raw body using the
// store's webhook secret. Header: `x-whop-signature` formatted as `sha256=<hex>`.
function verifyWhopSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sig = String(signatureHeader).replace(/^sha256=/i, '');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

// Public config — subscribe page checks `enabled` to know whether to show
// the Whop button.
app.get('/api/whop/config', (_req, res) => {
  res.json({
    enabled: !!WHOP_CHECKOUT_URL,
    checkoutBase: WHOP_CHECKOUT_URL || null,
  });
});

// Build the checkout URL with our Supabase user_id baked in as metadata so
// the webhook can route the payment back to the right profile. Returns the
// URL; the browser redirects to it.
app.post('/api/whop/checkout', requireSession, async (req, res) => {
  if (!WHOP_CHECKOUT_URL) {
    return res.status(503).json({ error: 'whop_not_configured' });
  }
  try {
    const uid = req.user.id;
    const email = (req.user.email || '').toLowerCase();
    const siteUrl = process.env.SITE_URL || `https://${req.headers.host || 'henrythehoover.com'}`;

    // Append metadata + redirect to the checkout URL. Whop preserves the
    // metadata fields through to the membership webhook payload.
    const u = new URL(WHOP_CHECKOUT_URL);
    u.searchParams.set('metadata[supabase_uid]', uid);
    u.searchParams.set('metadata[email]', email);
    u.searchParams.set('email', email); // pre-fills the checkout
    u.searchParams.set('redirect_url', `${siteUrl}/subscribe/success`);

    // Stash a marker on the profile so we can correlate even if Whop loses metadata
    await supaAdmin.from('profiles').update({
      whop_pending_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('email', email).then(() => {}, () => {});

    console.log('[whop/checkout]', email, '→', u.toString().slice(0, 120));
    res.json({ checkoutUrl: u.toString() });
  } catch (err) {
    console.error('[whop/checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook (raw body required for signature verification). Whop V1 events we subscribe to:
//   • membership_activated   → grant access, set period_end (new sub OR reactivation)
//   • membership_deactivated → revoke access (expired/cancelled/refunded/chargeback)
//   • invoice_paid           → extend period_end on each successful renewal charge
// Note: V1 uses underscored event names. The `action` field on the envelope carries the event type.
app.post('/api/whop/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body.toString('utf8');
  const sig = req.headers['x-whop-signature'];
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!verifyWhopSignature(rawBody, sig, secret)) {
    console.error('[whop webhook] bad signature');
    return res.status(400).send('Bad signature');
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).send('Bad JSON'); }

  const type = event.action || event.type || '';
  const data = event.data || {};
  const metadata = data.metadata || {};
  const uid = metadata.supabase_uid || null;
  const email = (metadata.email || data.email || data.user_email || '').toLowerCase();
  // Whop sends unix seconds for renewal_period_end / expires_at; invoice_paid uses period_end_at
  const periodEndSec = data.renewal_period_end || data.expires_at || data.period_end_at || null;
  const periodEndISO = periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null;
  // For invoice_paid, the membership reference lives on the invoice
  const membershipId = data.membership_id || data.membership || data.id || null;

  console.log('[whop webhook]', type, 'uid=' + uid, 'email=' + email, 'membership=' + membershipId, 'periodEnd=' + periodEndISO);

  // Find the target profile: prefer metadata uid, then email, then whop_membership_id
  let filterCol = null, filterVal = null;
  if (uid) { filterCol = 'user_id'; filterVal = uid; }
  else if (email) { filterCol = 'email'; filterVal = email; }
  else if (membershipId) { filterCol = 'whop_membership_id'; filterVal = membershipId; }

  if (!filterVal) {
    console.warn('[whop webhook] no uid/email/membership — dropping event');
    return res.json({ received: true });
  }

  // membership_activated fires on first activation and reactivation.
  // invoice_paid fires on every successful charge (initial + renewals) — treat as activation/extension.
  if (type === 'membership_activated' || type === 'invoice_paid'
      || type === 'membership.went_valid' || type === 'membership.renewed'
      || type === 'membership_went_valid') {
    const updates = {
      subscription_status: 'active',
      plan: 'monthly_whop',
      updated_at: new Date().toISOString(),
    };
    if (membershipId && type !== 'invoice_paid') updates.whop_membership_id = membershipId;
    if (data.user_id) updates.whop_user_id = data.user_id;
    if (periodEndISO) updates.current_period_end = periodEndISO;
    const { error } = await supaAdmin.from('profiles').update(updates).eq(filterCol, filterVal);
    if (error) console.error('[whop webhook] supabase update failed:', error.message);
    else console.log('[whop webhook] activated/extended', filterCol + '=' + filterVal, 'until', periodEndISO);
    return res.json({ received: true });
  }

  if (type === 'membership_deactivated'
      || type === 'membership.went_invalid' || type === 'membership_went_invalid') {
    const { error } = await supaAdmin.from('profiles').update({
      subscription_status: 'inactive',
      updated_at: new Date().toISOString(),
    }).eq(filterCol, filterVal);
    if (error) console.error('[whop webhook] supabase revoke failed:', error.message);
    else console.log('[whop webhook] revoked access for', filterCol + '=' + filterVal);
    return res.json({ received: true });
  }

  // Other event types — log but don't act
  console.log('[whop webhook] unhandled event type:', type);
  res.json({ received: true });
});

// ── Discord proxies (server holds the webhook URLs) ────────────────────────
async function forwardToDiscord(envKey, req, res) {
  const url = process.env[envKey];
  if (!url) return res.status(500).json({ error: `${envKey}_not_configured` });
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    console.error('[discord proxy]', err);
    res.status(502).json({ error: 'discord_upstream', detail: String(err?.message || err) });
  }
}

// Discord posting is admin-only — share-signal and auto-scan alerts both gated.
app.post('/api/discord', requireAdmin, (req, res) => forwardToDiscord('DISCORD_WEBHOOK', req, res));
app.post('/api/discord/auto', requireAdmin, (req, res) => forwardToDiscord('DISCORD_AUTO_WEBHOOK', req, res));

// ── WEEX auto-trade kill switch (admin) ────────────────────────────────────
// Wallet + positions cache: WEEX REST is slow and the dashboard polls every 5s.
const _weexCache = { wallet: null, positions: null, fetchedAt: 0 };
const WEEX_CACHE_MS = 15000;

// Normalize a raw WEEX position row into the shape the dashboard expects.
// Confirmed field shape from /capi/v2/account/position/allPosition on
// 2026-05-21: symbol="cmt_<lower>", side="LONG|SHORT", size="<qty>",
// open_value="<entry_notional>", unrealizePnl="<float>" (note: no "d" at
// end, singular Pnl), leverage="<int>", liquidatePrice="<float>". markPrice
// is NOT returned — derive it from avgPrice + uPnL/(size * sign).
function normalizeWeexPosition(p) {
  if (!p) return null;
  const rawSymbol = String(p.symbol || '').toUpperCase();
  const symbol = rawSymbol.replace(/^CMT_/, '');
  const side = String(p.side ?? p.holdSide ?? p.posSide ?? p.positionSide ?? '').toLowerCase();
  const size = parseFloat(p.size ?? p.total ?? p.qty ?? p.quantity ?? 0) || 0;
  if (size <= 0) return null;
  const openValue = parseFloat(p.open_value ?? p.openValue ?? 0) || 0;
  // WEEX doesn't include avgPrice as a field; derive it from open_value / size.
  let avgPrice = parseFloat(
    p.averagePrice ?? p.openPrice ?? p.avgEntryPrice ?? p.entryPrice ?? 0
  ) || 0;
  if (!avgPrice && openValue && size) avgPrice = openValue / size;
  let uPnl = parseFloat(
    p.unrealizePnl ?? p.unrealizedPnl ?? p.unrealizedPL ?? p.upl ?? p.uPL ?? NaN
  );
  if (!isFinite(uPnl)) uPnl = 0;
  // markPrice not returned by WEEX — derive from current PnL relative to entry.
  let markPrice = parseFloat(p.markPrice ?? p.indexPrice ?? 0) || 0;
  if (!markPrice && avgPrice && size) {
    const sign = side === 'long' ? 1 : -1;
    markPrice = avgPrice + (uPnl / (size * sign));
  }
  return {
    symbol, side, size, avgPrice, markPrice,
    uPnl,
    leverage: parseInt(p.leverage || 0) || null,
  };
}

// One-time debug helper: log the raw WEEX position shape on first observation
// after each deploy so we can discover field names.
let _weexPositionSampleLogged = false;

// Stats anchor — fix 2026-05-21 (today as the user wants) so the dashboard
// only shows trades from this date forward. Override via HENRY_STATS_START_MS
// env var (Unix ms). Used to filter both WEEX income events and the
// persisted weex_trades fallback so historical data before this date is
// excluded from today/month/total aggregates.
const STATS_START_MS = process.env.HENRY_STATS_START_MS
  ? parseInt(process.env.HENRY_STATS_START_MS, 10)
  : Date.UTC(2026, 4, 21); // May 21, 2026 UTC midnight

// Cache for WEEX income aggregation. The endpoint paginates 100 events per
// call so we re-fetch sparingly. 30s TTL — trades don't close that fast.
const _incomeCache = { events: null, fetchedAt: 0 };
const INCOME_CACHE_MS = 30_000;

// Pair WEEX income events into round-trip closed trades. Each round-trip is
// (sym, side) -> queue<open_event>; close_event pops and pairs FIFO. Realized
// PnL on a paired round-trip = open_income + close_income (fees already
// deducted by WEEX). Trades closed with no matching open within the fetched
// window are kept as `unmatched` with the close income as an approximation.
//
// Liquidations get special handling: `start_liquidate` / `finish_liquidate`
// events don't follow the position_open_X / position_close_X naming, so
// without intervention the liquidated position's open stays in the FIFO
// queue and gets popped by an unrelated later close on the same symbol+side,
// producing wildly wrong PnL ($6731 + $354 bugs from 2026-05-21). When we
// see a liquidation event for a symbol, drain both long and short queues
// for it so later regular closes pair with their actual opens.
function pairIncomeEvents(events) {
  const queues = new Map();
  const trades = [];
  const sorted = [...events].sort((a, b) => (parseInt(a.time) || 0) - (parseInt(b.time) || 0));
  for (const ev of sorted) {
    const t = String(ev.incomeType || '');
    const ts = parseInt(ev.time) || 0;
    const income = parseFloat(ev.income) || 0;
    const sym = ev.symbol;
    if (t === 'finish_liquidate' || t === 'start_liquidate' || t.includes('liquidate')) {
      // Drain any opens on this symbol — they're orphans now.
      if (sym) {
        queues.delete(`${sym}|long`);
        queues.delete(`${sym}|short`);
      }
      continue;
    }
    let side = null;
    if (t.includes('long')) side = 'long';
    else if (t.includes('short')) side = 'short';
    if (!side) continue;
    const key = `${sym}|${side}`;
    if (t.startsWith('position_open_')) {
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push({ income, ts });
    } else if (t.startsWith('position_close_')) {
      const queue = queues.get(key) || [];
      const entry = queue.shift();
      if (entry) {
        trades.push({ symbol: sym, side, ts, pnl: entry.income + income });
      } else {
        trades.push({ symbol: sym, side, ts, pnl: income, unmatched: true });
      }
    }
  }
  return trades;
}

// WEEX-sourced PnL aggregation. Anchored at STATS_START_MS for the AGGREGATE
// filter (close-time >= anchor) but fetches 30 days further back so we can
// pair opens-before-anchor with closes-after-anchor. Without the lookback,
// unmatched closes would surface their full cash-flow value (the cost to
// exit the position) as if it were realized PnL — produced the -$365 bug.
//
// Unmatched closes that remain even with the 30-day lookback (position opened
// >30 days ago) are skipped — we can't compute real PnL without the open.
async function aggregateWeexIncomePnl() {
  if (!weexClient) return null;
  const now = Date.now();
  const cacheStale = now - _incomeCache.fetchedAt > INCOME_CACHE_MS;
  if (cacheStale) {
    const fetchFromMs = STATS_START_MS - 30 * 24 * 60 * 60 * 1000;
    const events = await weexClient.getAllIncomeSince(fetchFromMs, 30).catch(err => {
      console.warn('[weex income]', err.message || err); return null;
    });
    if (events) {
      _incomeCache.events = events;
      _incomeCache.fetchedAt = now;
    } else if (!_incomeCache.events) {
      return null;
    }
  }
  const events = _incomeCache.events || [];
  const trades = pairIncomeEvents(events);
  const d = new Date(now);
  const startOfTodayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const startOfMonthUtc = Math.max(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    STATS_START_MS,
  );
  // Sanity threshold — at $10 risk per trade, real wins/losses cap around
  // $20–30. 25× the risk ($250 default) is generous headroom while still
  // catching mispairings the liquidation-drain logic somehow missed.
  // Override via HENRY_MAX_TRADE_PNL env var.
  const SANE_PNL = parseFloat(process.env.HENRY_MAX_TRADE_PNL) || (HENRY_RISK_USD * 25);
  let today = 0, month = 0, total = 0;
  let unmatchedSkipped = 0, suspectSkipped = 0;
  const dailyMap = new Map();
  for (const tr of trades) {
    if (tr.ts < STATS_START_MS) continue;
    if (tr.unmatched) { unmatchedSkipped++; continue; }
    if (Math.abs(tr.pnl) > SANE_PNL) {
      suspectSkipped++;
      console.warn(`[weex income] dropping suspect pairing ${tr.symbol} ${tr.side} pnl=${tr.pnl.toFixed(2)} (>${SANE_PNL})`);
      continue;
    }
    total += tr.pnl;
    if (tr.ts >= startOfMonthUtc) {
      month += tr.pnl;
      const day = new Date(tr.ts).getUTCDate();
      dailyMap.set(day, (dailyMap.get(day) || 0) + tr.pnl);
    }
    if (tr.ts >= startOfTodayUtc) today += tr.pnl;
  }
  if (unmatchedSkipped > 0) {
    console.log(`[weex income] skipped ${unmatchedSkipped} unmatched close(s)`);
  }
  if (suspectSkipped > 0) {
    console.warn(`[weex income] dropped ${suspectSkipped} suspect pairing(s) — likely from prior liquidation orphans`);
  }
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const daily = [];
  for (let day = 1; day <= dim; day++) daily.push({ day, pnl: dailyMap.get(day) || 0 });
  return { today, month, total, daily, closedCount: trades.length - unmatchedSkipped, source: 'weex_income' };
}

async function getWeexStatusCached() {
  if (!weexClient) return { wallet: null, positions: [] };
  const now = Date.now();
  if (now - _weexCache.fetchedAt < WEEX_CACHE_MS) {
    return { wallet: _weexCache.wallet, positions: _weexCache.positions || [] };
  }
  const [wallet, rawPositions] = await Promise.all([
    weexClient.getWallet().catch(err => { console.warn('[weex wallet]', err.message || err); return _weexCache.wallet; }),
    weexClient.getAllPositions().catch(err => { console.warn('[weex positions]', err.message || err); return null; }),
  ]);
  if (!_weexPositionSampleLogged && Array.isArray(rawPositions) && rawPositions.length > 0) {
    _weexPositionSampleLogged = true;
    console.log('[weex raw position sample]', JSON.stringify(rawPositions[0]));
    if (!_weexCache.wallet) console.log('[weex raw wallet sample] null');
  }
  // Also log wallet shape once so we can verify equity/available field names.
  if (wallet && !_weexCache.wallet) {
    console.log('[weex raw wallet shape]', Object.keys(wallet).join(','), '=', JSON.stringify(wallet));
  }
  const positions = Array.isArray(rawPositions)
    ? rawPositions.map(normalizeWeexPosition).filter(Boolean)
    : (_weexCache.positions || []);
  _weexCache.wallet = wallet;
  _weexCache.positions = positions;
  _weexCache.fetchedAt = now;
  return { wallet, positions };
}
// PnL aggregation from Supabase's persistent `weex_trades` table. Falls back
// to the executor's in-memory snapshot if the table is missing or the query
// fails. Replaces the old in-memory-only aggregator which zeroed out on
// every Railway redeploy.
async function aggregatePersistedPnl(fallbackTrades) {
  const now = new Date();
  const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfMonthUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const emptyDaily = () => { const a = []; for (let d = 1; d <= dim; d++) a.push({ day: d, pnl: 0 }); return a; };

  // Try persisted source first. Filter to >= STATS_START_MS so the
  // dashboard only shows trades from the anchor date forward.
  try {
    const startIso = new Date(STATS_START_MS).toISOString();
    const { data, error } = await supaAdmin
      .from('weex_trades')
      .select('closed_pnl, closed_at, state')
      .eq('state', 'CLOSED')
      .gte('closed_at', startIso);
    if (!error && Array.isArray(data)) {
      let today = 0, month = 0, total = 0;
      const dailyMap = new Map();
      for (const r of data) {
        const pnl = parseFloat(r.closed_pnl) || 0;
        total += pnl;
        const ts = r.closed_at ? new Date(r.closed_at).getTime() : 0;
        if (ts < STATS_START_MS) continue;
        if (ts >= startOfMonthUtc) {
          month += pnl;
          const d = new Date(ts).getUTCDate();
          dailyMap.set(d, (dailyMap.get(d) || 0) + pnl);
        }
        if (ts >= startOfTodayUtc) today += pnl;
      }
      const daily = []; for (let d = 1; d <= dim; d++) daily.push({ day: d, pnl: dailyMap.get(d) || 0 });
      return { today, month, total, daily, closedCount: data.length, source: 'supabase' };
    }
    if (error) console.warn('[weex_trades aggregate]', error.message);
  } catch (err) {
    console.warn('[weex_trades aggregate]', err.message || err);
  }

  // Fallback: in-memory executor snapshot (resets on deploy).
  const closed = (fallbackTrades || []).filter(t => t.state === 'CLOSED' && t.closedPnl != null);
  let today = 0, month = 0, total = 0;
  const dailyMap = new Map();
  for (const t of closed) {
    const pnl = parseFloat(t.closedPnl) || 0;
    total += pnl;
    const ts = t.updatedAt || 0;
    if (ts >= startOfMonthUtc) {
      month += pnl;
      const d = new Date(ts).getUTCDate();
      dailyMap.set(d, (dailyMap.get(d) || 0) + pnl);
    }
    if (ts >= startOfTodayUtc) today += pnl;
  }
  const daily = []; for (let d = 1; d <= dim; d++) daily.push({ day: d, pnl: dailyMap.get(d) || 0 });
  return { today, month, total, daily, closedCount: closed.length, source: 'memory' };
}
app.get('/api/bot/state', requireAdmin, async (_req, res) => {
  const trades = weexExecutor ? weexExecutor.snapshot() : [];
  let wallet = null, positions = [];
  if (weexExecutor) {
    try {
      const s = await getWeexStatusCached();
      wallet = s.wallet; positions = s.positions;
    } catch (err) { console.warn('[bot/state]', err.message || err); }
  }
  // Prefer WEEX-sourced PnL (fees included, exact from /capi/v3/account/income)
  // over the locally-computed notional aggregate. Falls back to the persisted
  // Supabase aggregates if the WEEX call fails.
  let pnl = await aggregateWeexIncomePnl().catch(() => null);
  if (!pnl) pnl = await aggregatePersistedPnl(trades);
  // Live additions — sum of unrealized PnL on currently-open WEEX positions.
  // pnl.today is the realized-only figure; pnl.todayLive blends realized +
  // unrealized so the headline number on Kingdom moves with the market.
  const openUPnl = (positions || []).reduce((s, p) => s + (parseFloat(p.uPnl) || 0), 0);
  pnl.openUPnl = openUPnl;
  pnl.todayLive = pnl.today + openUPnl;
  pnl.totalLive = pnl.total + openUPnl;
  res.json({
    available: !!weexExecutor,
    enabled: autoTradeEnabled,
    dryRun: HENRY_DRY_RUN,
    riskUsd: HENRY_RISK_USD,
    leverage: HENRY_LEVERAGE,
    trades,
    wallet,
    positions,
    pnl,
  });
});
app.post('/api/bot/state', requireAdmin, express.json(), (req, res) => {
  if (!weexExecutor) return res.status(409).json({ error: 'WEEX executor not configured (missing env vars)' });
  if (typeof req.body?.enabled === 'boolean') {
    autoTradeEnabled = req.body.enabled;
    console.log('[bot] autoTradeEnabled =', autoTradeEnabled);
  }
  res.json({ ok: true, enabled: autoTradeEnabled });
});

// One-shot reset: clear per-pair pauses + reset the global circuit-breaker
// outcome counter on the admin's scan subscription. Used when the bot has
// auto-paused a pair after consecutive SL and the admin wants to resume
// scanning immediately.
app.post('/api/admin/clear-pauses', requireAdmin, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.json({ ok: true, pairsCleared: 0, recentOutcomes: 0, note: 'no active scan' });
  let pairsCleared = 0;
  const cleared = [];
  if (sub.pairs) {
    for (const [coin, ps] of Object.entries(sub.pairs)) {
      if (ps.pauseUntil) {
        cleared.push(coin);
        ps.pauseUntil = 0;
        ps.pauseReason = null;
        pairsCleared++;
      }
    }
  }
  const recentOutcomes = (sub.recentOutcomes || []).length;
  sub.recentOutcomes = [];
  console.log(`[admin] clear-pauses by ${req.user.email}: pairs=${pairsCleared} (${cleared.join(',')}), recentOutcomes_dropped=${recentOutcomes}`);
  res.json({ ok: true, pairsCleared, cleared, recentOutcomes });
});

// ── Correlation report (admin) ──────────────────────────────────────────────
// Classifies every closed signal by what other crypto signals were open
// concurrently. Mirrors the analyze_stacked.py logic. Use to monitor whether
// the Patch 1 oppdir-veto is doing its job — same_cluster_opp_dir should
// trend toward zero new entries once the veto is enabled.
app.get('/api/admin/correlation-report', requireAdmin, async (_req, res) => {
  try {
    const adminId = await getAdminUserId();
    if (!adminId) return res.status(503).json({ error: 'admin user not resolved' });
    const { data: rows, error } = await supaAdmin
      .from('signals')
      .select('id, pair, direction, outcome, outcome_rr, outcome_at, created_at')
      .eq('user_id', adminId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const CRYPTO_CLUSTERS = new Set(['btc', 'largeCap', 'defi', 'meme', 'layer1']);
    const closed = (rows || []).filter(r => ['TP', 'SL', 'BE', 'EXPIRED'].includes(r.outcome));
    function effR(r) {
      if (r.outcome === 'EXPIRED') return 0;
      const rr = parseFloat(r.outcome_rr);
      if (isFinite(rr)) return rr;
      if (r.outcome === 'SL') return -1;
      if (r.outcome === 'BE') return 0;
      return 0;
    }
    function intervalsOverlap(a, b) {
      const aS = new Date(a.created_at).getTime();
      const aE = a.outcome_at ? new Date(a.outcome_at).getTime() : Date.now();
      const bS = new Date(b.created_at).getTime();
      const bE = b.outcome_at ? new Date(b.outcome_at).getTime() : Date.now();
      return Math.max(aS, bS) < Math.min(aE, bE);
    }
    const buckets = {
      solo: [], cross_cluster_opp_dir: [], cross_cluster_same_dir: [],
      same_cluster_opp_dir: [], same_cluster_same_dir: [],
    };
    for (const s of closed) {
      const sCluster = getClusterFor(s.pair);
      let worst = 'solo'; // priority: same_cluster_same > same_cluster_opp > cross_cluster_same > cross_cluster_opp > solo
      const rank = { same_cluster_same_dir: 4, same_cluster_opp_dir: 3, cross_cluster_same_dir: 2, cross_cluster_opp_dir: 1, solo: 0 };
      for (const o of closed) {
        if (o.id === s.id) continue;
        if (!intervalsOverlap(s, o)) continue;
        const oCluster = getClusterFor(o.pair);
        if (!CRYPTO_CLUSTERS.has(sCluster) || !CRYPTO_CLUSTERS.has(oCluster)) continue;
        const sameCluster = sCluster === oCluster;
        const sameDir = s.direction === o.direction;
        let cat;
        if (sameCluster && sameDir) cat = 'same_cluster_same_dir';
        else if (sameCluster && !sameDir) cat = 'same_cluster_opp_dir';
        else if (!sameCluster && sameDir) cat = 'cross_cluster_same_dir';
        else cat = 'cross_cluster_opp_dir';
        if (rank[cat] > rank[worst]) worst = cat;
      }
      buckets[worst].push(s);
    }

    const summary = {};
    for (const [cat, sigs] of Object.entries(buckets)) {
      const n = sigs.length;
      const totalR = sigs.reduce((a, b) => a + effR(b), 0);
      const tp = sigs.filter(s => s.outcome === 'TP').length;
      const sl = sigs.filter(s => s.outcome === 'SL').length;
      const be = sigs.filter(s => s.outcome === 'BE').length;
      const exp = sigs.filter(s => s.outcome === 'EXPIRED').length;
      const closedN = tp + sl + be;
      const wr = closedN ? (tp + be * 0.5) / closedN : 0;
      summary[cat] = {
        n, tp, sl, be, expired: exp,
        winRate: +(wr * 100).toFixed(1),
        totalR: +totalR.toFixed(2),
        avgR: n ? +(totalR / n).toFixed(3) : 0,
      };
    }

    // Per-pair stacked-vs-solo split
    const perPair = {};
    for (const [cat, sigs] of Object.entries(buckets)) {
      for (const s of sigs) {
        if (!perPair[s.pair]) perPair[s.pair] = { total: 0, solo: 0, stacked: 0, soloR: 0, stackedR: 0 };
        perPair[s.pair].total++;
        const r = effR(s);
        if (cat === 'solo') { perPair[s.pair].solo++; perPair[s.pair].soloR += r; }
        else { perPair[s.pair].stacked++; perPair[s.pair].stackedR += r; }
      }
    }
    for (const k of Object.keys(perPair)) {
      perPair[k].soloR = +perPair[k].soloR.toFixed(2);
      perPair[k].stackedR = +perPair[k].stackedR.toFixed(2);
    }

    res.json({
      totalClosed: closed.length,
      summary,
      perPair,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[correlation-report]', err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE 1 REDESIGN ENDPOINTS
// Four additive endpoints serving the new tab-based UI mockup. Existing UI
// untouched — these run alongside until the v2 cutover.
// ════════════════════════════════════════════════════════════════════════════

// ── /api/admin/stats ── All 6 stat cards from the mockup, computed live.
// Mirror of analyze_stacked.py + rank_pairs.py + analyze_ny_sweep.py + the
// trigger/veto/executor sections. Cached 30s so the dashboard can poll
// without slamming Supabase.
// Cache keyed by source (auto | manual | all) so the same dashboard can
// hold both filtered views without trashing one with the other.
const _statsCache = new Map();
const STATS_CACHE_MS = 30_000;

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const source = (() => {
      const raw = String(req.query.source || 'all').toLowerCase();
      return (raw === 'auto' || raw === 'manual') ? raw : 'all';
    })();
    const cached = _statsCache.get(source);
    if (cached && now - cached.ts < STATS_CACHE_MS) {
      return res.json(cached.payload);
    }

    const adminId = await getAdminUserId();
    if (!adminId) return res.status(503).json({ error: 'admin user not resolved' });

    const { data: rows, error } = await supaAdmin
      .from('signals')
      .select('id, pair, direction, outcome, outcome_rr, outcome_at, created_at, trigger_type, session_name, confidence')
      .eq('user_id', adminId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Source filter — autoscan signals carry a non-null trigger_type;
    // manual ANALYSE calls store NULL (see insertSignal: trigger?.type || null).
    const filtered = (rows || []).filter(r => {
      if (source === 'auto') return !!r.trigger_type;
      if (source === 'manual') return !r.trigger_type;
      return true;
    });
    const closed = filtered.filter(r => ['TP', 'SL', 'BE', 'EXPIRED'].includes(r.outcome));
    const SUPER_CRYPTO = new Set(['btc', 'largeCap', 'defi', 'meme', 'layer1']);

    function effR(r) {
      if (r.outcome === 'EXPIRED') return 0;
      const rr = parseFloat(r.outcome_rr);
      if (isFinite(rr)) return rr;
      if (r.outcome === 'SL') return -1;
      if (r.outcome === 'BE') return 0;
      return 0;
    }
    function intervalsOverlap(a, b) {
      const aS = new Date(a.created_at).getTime();
      const aE = a.outcome_at ? new Date(a.outcome_at).getTime() : Date.now();
      const bS = new Date(b.created_at).getTime();
      const bE = b.outcome_at ? new Date(b.outcome_at).getTime() : Date.now();
      return Math.max(aS, bS) < Math.min(aE, bE);
    }

    // 1. Stacking categories
    const buckets = {
      solo: [], cross_cluster_opp_dir: [], cross_cluster_same_dir: [],
      same_cluster_opp_dir: [], same_cluster_same_dir: [],
    };
    const rank = { same_cluster_same_dir: 4, same_cluster_opp_dir: 3, cross_cluster_same_dir: 2, cross_cluster_opp_dir: 1, solo: 0 };
    for (const s of closed) {
      const sCluster = getClusterFor(s.pair);
      let worst = 'solo';
      for (const o of closed) {
        if (o.id === s.id) continue;
        if (!intervalsOverlap(s, o)) continue;
        const oCluster = getClusterFor(o.pair);
        if (!SUPER_CRYPTO.has(sCluster) || !SUPER_CRYPTO.has(oCluster)) continue;
        const sameCluster = sCluster === oCluster;
        const sameDir = s.direction === o.direction;
        let cat;
        if (sameCluster && sameDir) cat = 'same_cluster_same_dir';
        else if (sameCluster && !sameDir) cat = 'same_cluster_opp_dir';
        else if (!sameCluster && sameDir) cat = 'cross_cluster_same_dir';
        else cat = 'cross_cluster_opp_dir';
        if (rank[cat] > rank[worst]) worst = cat;
      }
      buckets[worst].push(s);
    }
    const stackingCategories = {};
    for (const [cat, sigs] of Object.entries(buckets)) {
      const n = sigs.length;
      const totalR = sigs.reduce((a, b) => a + effR(b), 0);
      const tp = sigs.filter(s => s.outcome === 'TP').length;
      const sl = sigs.filter(s => s.outcome === 'SL').length;
      const be = sigs.filter(s => s.outcome === 'BE').length;
      const closedN = tp + sl + be;
      stackingCategories[cat] = {
        n, tp, sl, be,
        winRate: closedN ? +((tp + be * 0.5) / closedN * 100).toFixed(1) : 0,
        totalR: +totalR.toFixed(2),
        avgR: n ? +(totalR / n).toFixed(3) : 0,
      };
    }

    // 2. Pair rankings (last 30 days)
    const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = closed.filter(r => new Date(r.created_at).getTime() >= cutoff30d);
    const byPair = {};
    for (const s of recent) {
      const p = s.pair;
      if (!byPair[p]) byPair[p] = { n: 0, tp: 0, sl: 0, be: 0, totalR: 0, lastTen: [] };
      byPair[p].n++;
      byPair[p].totalR += effR(s);
      if (s.outcome === 'TP') byPair[p].tp++;
      else if (s.outcome === 'SL') byPair[p].sl++;
      else if (s.outcome === 'BE') byPair[p].be++;
    }
    // Last-10 R per pair
    for (const pair of Object.keys(byPair)) {
      const last10 = recent.filter(r => r.pair === pair)
        .sort((a, b) => new Date(b.outcome_at || b.created_at) - new Date(a.outcome_at || a.created_at))
        .slice(0, 10);
      byPair[pair].lastTenR = +last10.reduce((a, b) => a + effR(b), 0).toFixed(2);
    }
    const pairRankings = Object.entries(byPair).map(([pair, st]) => {
      const closedN = st.tp + st.sl + st.be;
      return {
        pair, n: st.n,
        winRate: closedN ? +((st.tp + st.be * 0.5) / closedN * 100).toFixed(1) : 0,
        totalR: +st.totalR.toFixed(2),
        lastTenR: st.lastTenR,
      };
    }).sort((a, b) => b.totalR - a.totalR);

    // 3. NY-sweep recovery — count of SL hits inside the active block window
    //    so the dashboard mirrors whatever the live gate actually blocks.
    const nyStart = NY_OPEN_BLOCK_START_MIN;
    const nyEnd = NY_OPEN_BLOCK_END_MIN;
    const inNyWindow = (r) => {
      if (r.outcome !== 'SL' || !r.outcome_at) return false;
      const t = new Date(r.outcome_at);
      const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
      return mins >= nyStart && mins < nyEnd;
    };
    const nyWindow = closed.filter(inNyWindow);
    const otherWindow = closed.filter(r => r.outcome === 'SL' && r.outcome_at && !inNyWindow(r));
    const nyLabel = `${String(Math.floor(nyStart/60)).padStart(2,'0')}:${String(nyStart%60).padStart(2,'0')}-${String(Math.floor(nyEnd/60)).padStart(2,'0')}:${String(nyEnd%60).padStart(2,'0')} UTC`;
    const nyRecovery = {
      nyWindow: { n: nyWindow.length, label: nyLabel },
      otherWindow: { n: otherWindow.length, label: 'baseline' },
      note: 'Recovery rate ~45-48% from analyze_ny_sweep.py — patches address it.',
    };

    // 4. Trigger performance
    const byTrigger = {};
    for (const s of closed) {
      const t = s.trigger_type || 'unknown';
      if (!byTrigger[t]) byTrigger[t] = { n: 0, tp: 0, sl: 0, be: 0, totalR: 0 };
      byTrigger[t].n++;
      byTrigger[t].totalR += effR(s);
      if (s.outcome === 'TP') byTrigger[t].tp++;
      else if (s.outcome === 'SL') byTrigger[t].sl++;
      else if (s.outcome === 'BE') byTrigger[t].be++;
    }
    const triggerPerformance = Object.entries(byTrigger).map(([trigger, st]) => {
      const closedN = st.tp + st.sl + st.be;
      return {
        trigger, n: st.n,
        winRate: closedN ? +((st.tp + st.be * 0.5) / closedN * 100).toFixed(1) : 0,
        totalR: +st.totalR.toFixed(2),
      };
    }).sort((a, b) => b.totalR - a.totalR);

    // 5. Live executor state
    const executorState = {
      activeTrades: weexExecutor ? weexExecutor.snapshot().filter(t => t.state === 'ACTIVE').length : 0,
      pendingLimits: weexExecutor ? weexExecutor.snapshot().filter(t => t.state === 'PENDING').length : 0,
      autoTradeEnabled,
      dryRun: HENRY_DRY_RUN,
      riskUsd: HENRY_RISK_USD,
      leverage: HENRY_LEVERAGE,
      autoscanModel: AUTOSCAN_AI_MODEL,
      manualModel: AI_MODEL,
    };

    // 6. Veto report — last 7 days (placeholder until we wire a veto-log table)
    const vetoReport = {
      note: 'Veto counts will populate once /api/admin/veto-log is wired (next phase).',
    };

    const payload = {
      source, // 'auto' | 'manual' | 'all'
      stackingCategories,
      pairRankings,
      nyRecovery,
      triggerPerformance,
      executorState,
      vetoReport,
      totalClosed: closed.length,
      generatedAt: new Date().toISOString(),
    };
    _statsCache.set(source, { ts: now, payload });
    res.json(payload);
  } catch (err) {
    console.error('[stats]', err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── /api/performance/me ── Per-user track record. Same shape for everyone;
// data scoped by req.user.id. Powers the Performance tab.
// `?source=manual` (default for v2) restricts to manual ANALYSE signals
// (trigger_type IS NULL); `?source=auto` to autoscan; `?source=all` keeps
// the legacy behavior for the old /performance.html page.
app.get('/api/performance/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const source = (() => {
      const raw = String(req.query.source || 'all').toLowerCase();
      return (raw === 'auto' || raw === 'manual') ? raw : 'all';
    })();
    const { data: rows, error } = await supaAdmin
      .from('signals')
      .select('id, pair, direction, outcome, outcome_rr, outcome_at, created_at, trigger_type, session_name, confidence, broker, reasoning, entry_reason')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const allUnfiltered = rows || [];
    const all = allUnfiltered.filter(r => {
      if (source === 'auto') return !!r.trigger_type;
      if (source === 'manual') return !r.trigger_type;
      return true;
    });
    const closed = all.filter(r => ['TP', 'SL', 'BE', 'EXPIRED'].includes(r.outcome));

    function effR(r) {
      if (r.outcome === 'EXPIRED') return 0;
      const rr = parseFloat(r.outcome_rr);
      if (isFinite(rr)) return rr;
      if (r.outcome === 'SL') return -1;
      if (r.outcome === 'BE') return 0;
      return 0;
    }

    // Overall stats
    const tp = closed.filter(r => r.outcome === 'TP').length;
    const sl = closed.filter(r => r.outcome === 'SL').length;
    const be = closed.filter(r => r.outcome === 'BE').length;
    const expired = closed.filter(r => r.outcome === 'EXPIRED').length;
    const closedN = tp + sl + be;
    const totalR = closed.reduce((a, b) => a + effR(b), 0);
    const winRate = closedN ? +((tp + be * 0.5) / closedN * 100).toFixed(1) : 0;
    const expectancy = closed.length ? +(totalR / closed.length).toFixed(3) : 0;

    // Last week trend
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const lastWeek = closed.filter(r => new Date(r.outcome_at || r.created_at).getTime() >= oneWeekAgo);
    const lastWeekR = +lastWeek.reduce((a, b) => a + effR(b), 0).toFixed(2);

    // By pair
    const byPair = {};
    for (const s of closed) {
      const p = s.pair;
      if (!byPair[p]) byPair[p] = { n: 0, tp: 0, sl: 0, be: 0, totalR: 0 };
      byPair[p].n++;
      byPair[p].totalR += effR(s);
      if (s.outcome === 'TP') byPair[p].tp++;
      else if (s.outcome === 'SL') byPair[p].sl++;
      else if (s.outcome === 'BE') byPair[p].be++;
    }
    const pairBreakdown = Object.entries(byPair).map(([pair, st]) => {
      const cN = st.tp + st.sl + st.be;
      return {
        pair, n: st.n,
        winRate: cN ? +((st.tp + st.be * 0.5) / cN * 100).toFixed(1) : 0,
        totalR: +st.totalR.toFixed(2),
      };
    }).sort((a, b) => b.totalR - a.totalR);

    // By trigger
    const byTrig = {};
    for (const s of closed) {
      const t = s.trigger_type || 'unknown';
      if (!byTrig[t]) byTrig[t] = { n: 0, tp: 0, sl: 0, be: 0, totalR: 0 };
      byTrig[t].n++;
      byTrig[t].totalR += effR(s);
      if (s.outcome === 'TP') byTrig[t].tp++;
      else if (s.outcome === 'SL') byTrig[t].sl++;
      else if (s.outcome === 'BE') byTrig[t].be++;
    }
    const triggerBreakdown = Object.entries(byTrig).map(([trigger, st]) => {
      const cN = st.tp + st.sl + st.be;
      return {
        trigger, n: st.n,
        winRate: cN ? +((st.tp + st.be * 0.5) / cN * 100).toFixed(1) : 0,
        totalR: +st.totalR.toFixed(2),
      };
    }).sort((a, b) => b.totalR - a.totalR);

    // Best / worst trades — top 10 each side
    const sorted = [...closed].sort((a, b) => effR(b) - effR(a));
    const bestTrades = sorted.slice(0, 10).map(s => ({
      pair: s.pair, direction: s.direction, r: +effR(s).toFixed(2),
      when: s.outcome_at, trigger: s.trigger_type,
    }));
    const worstTrades = sorted.slice(-10).reverse().map(s => ({
      pair: s.pair, direction: s.direction, r: +effR(s).toFixed(2),
      when: s.outcome_at, trigger: s.trigger_type,
    }));

    // By session — splits trades by ASIA / LONDON / NY / etc.
    const bySession = {};
    for (const s of closed) {
      const k = s.session_name || 'unknown';
      if (!bySession[k]) bySession[k] = { n: 0, tp: 0, sl: 0, be: 0, totalR: 0 };
      bySession[k].n++;
      bySession[k].totalR += effR(s);
      if (s.outcome === 'TP') bySession[k].tp++;
      else if (s.outcome === 'SL') bySession[k].sl++;
      else if (s.outcome === 'BE') bySession[k].be++;
    }
    const sessionBreakdown = Object.entries(bySession).map(([session, st]) => {
      const cN = st.tp + st.sl + st.be;
      return {
        session, n: st.n,
        winRate: cN ? +((st.tp + st.be * 0.5) / cN * 100).toFixed(1) : 0,
        totalR: +st.totalR.toFixed(2),
      };
    }).sort((a, b) => b.totalR - a.totalR);

    // By hour of day (UTC) — net R per hour 0..23 for the chart
    const hourBuckets = new Array(24).fill(0).map(() => ({ n: 0, totalR: 0 }));
    for (const s of closed) {
      const t = s.outcome_at || s.created_at;
      if (!t) continue;
      const h = new Date(t).getUTCHours();
      hourBuckets[h].n++;
      hourBuckets[h].totalR += effR(s);
    }
    const hourBreakdown = hourBuckets.map((b, h) => ({ hour: h, n: b.n, totalR: +b.totalR.toFixed(2) }));

    // Cumulative R timeline (for chart)
    let cum = 0;
    const cumulativeR = closed
      .sort((a, b) => new Date(a.outcome_at || a.created_at) - new Date(b.outcome_at || b.created_at))
      .map(s => {
        cum += effR(s);
        return { when: s.outcome_at || s.created_at, r: +cum.toFixed(2) };
      });

    // By setup tag — regex-extracted from the AI `reasoning` text plus the
    // shorter `entry_reason` field (see module-level extractSetupTags). No
    // schema column for setup yet; this works on every historical row. A
    // signal can belong to multiple buckets (e.g. "FVG + Sweep retest") and
    // counts as 1 trade in each.
    const bySetup = {};
    for (const s of closed) {
      const tags = extractSetupTags(s);
      for (const tag of tags) {
        if (!bySetup[tag]) bySetup[tag] = { n: 0, tp: 0, sl: 0, be: 0, totalR: 0 };
        bySetup[tag].n++;
        bySetup[tag].totalR += effR(s);
        if (s.outcome === 'TP') bySetup[tag].tp++;
        else if (s.outcome === 'SL') bySetup[tag].sl++;
        else if (s.outcome === 'BE') bySetup[tag].be++;
      }
    }
    const setupBreakdown = Object.entries(bySetup).map(([setup, st]) => {
      const cN = st.tp + st.sl + st.be;
      return {
        setup, n: st.n,
        winRate: cN ? +((st.tp + st.be * 0.5) / cN * 100).toFixed(1) : 0,
        expectancy: st.n ? +(st.totalR / st.n).toFixed(3) : 0,
        totalR: +st.totalR.toFixed(2),
      };
    }).sort((a, b) => b.totalR - a.totalR);

    // Confidence calibration — buckets the AI's stated 0-100 confidence and
    // shows the actual win-rate per bucket. If "85+" trades win at the same
    // rate as "50-69" trades, the model is overconfident and the buckets
    // make that visible at a glance.
    const CONF_BUCKETS = [
      { label: '0-49',   lo: 0,  hi: 49  },
      { label: '50-69',  lo: 50, hi: 69  },
      { label: '70-84',  lo: 70, hi: 84  },
      { label: '85-100', lo: 85, hi: 100 },
    ];
    const confBuckets = CONF_BUCKETS.map(b => ({ ...b, n: 0, tp: 0, sl: 0, be: 0, totalR: 0, confSum: 0 }));
    for (const s of closed) {
      const c = parseFloat(s.confidence);
      if (!isFinite(c)) continue;
      const bucket = confBuckets.find(b => c >= b.lo && c <= b.hi);
      if (!bucket) continue;
      bucket.n++;
      bucket.confSum += c;
      bucket.totalR += effR(s);
      if (s.outcome === 'TP') bucket.tp++;
      else if (s.outcome === 'SL') bucket.sl++;
      else if (s.outcome === 'BE') bucket.be++;
    }
    const confidenceBreakdown = confBuckets.map(b => {
      const cN = b.tp + b.sl + b.be;
      return {
        bucket: b.label,
        n: b.n,
        avgConfidence: b.n ? +(b.confSum / b.n).toFixed(1) : null,
        winRate: cN ? +((b.tp + b.be * 0.5) / cN * 100).toFixed(1) : 0,
        expectancy: b.n ? +(b.totalR / b.n).toFixed(3) : 0,
        totalR: +b.totalR.toFixed(2),
      };
    });

    res.json({
      user: { id: userId, email: req.user.email },
      source, // 'auto' | 'manual' | 'all'
      overall: {
        totalSignals: all.length,
        closedN: closed.length,
        tp, sl, be, expired,
        winRate, totalR: +totalR.toFixed(2), expectancy,
        lastWeekR,
      },
      pairBreakdown,
      triggerBreakdown,
      sessionBreakdown,
      hourBreakdown,
      setupBreakdown,
      confidenceBreakdown,
      bestTrades,
      worstTrades,
      cumulativeR,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[performance/me]', err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── /api/news/feed ── RSS news items + calendar events. Wraps existing
// fetchNewsContext (which already has RSS plumbing and a 5-min cache) and
// fetchCalendarContext. Returns structured JSON for the redesigned News tab.
app.get('/api/news/feed', requireAuth, async (_req, res) => {
  try {
    // Warm both caches in parallel; ignore their text output, we read the
    // raw _newsCache and _calendarCache below.
    await Promise.all([fetchNewsContext().catch(() => ''), fetchCalendarContext().catch(() => '')]);
    const newsItems = (_newsCache.items || []).slice(0, 20).map(n => ({
      title: n.title || n.text || '',
      source: n.source || 'feed',
      time: n.dt || n.time || null,
      impact: n.impact || null,
      url: n.url || null,
    }));
    const calendarEvents = (_calendarCache.items || []).filter(e => {
      const d = e.dt - Date.now();
      return d > -3600000 && d < 36 * 60 * 60 * 1000; // past 1h to next 36h
    }).map(e => ({
      time: e.dt,
      zone: e.zone || '',
      name: e.name || '',
      impact: e.imp || 'low',
      forecast: e.forecast || null,
      previous: e.prev || null,
      actual: e.actual || null,
    }));
    res.json({
      news: newsItems,
      calendar: calendarEvents,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[news/feed]', err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── /api/news/macro-summary ── Daily AI macro narrative. Cached 6h so we make
// ~4 Anthropic calls per day max. Falls back to a static safe message if
// Anthropic fails. Used by the "Henry's Daily Macro Take" card on the News
// tab.
let _macroSummaryCache = { ts: 0, payload: null };
const MACRO_SUMMARY_CACHE_MS = 6 * 60 * 60 * 1000;

app.get('/api/news/macro-summary', requireAuth, async (_req, res) => {
  try {
    const now = Date.now();
    if (_macroSummaryCache.payload && now - _macroSummaryCache.ts < MACRO_SUMMARY_CACHE_MS) {
      return res.json(_macroSummaryCache.payload);
    }

    // Fetch fresh context inputs
    const [dxyData, newsCtx, calCtx] = await Promise.all([
      fetchDXYContextServer().catch(() => null),
      fetchNewsContext().catch(() => ''),
      fetchCalendarContext().catch(() => ''),
    ]);

    const ctxLines = [];
    if (dxyData) {
      ctxLines.push(`DXY: ${dxyData.dxy?.toFixed(2)} (${dxyData.dxyChange >= 0 ? '+' : ''}${dxyData.dxyChange?.toFixed(2)}% today)`);
      if (dxyData.xau) ctxLines.push(`Gold: $${dxyData.xau.toFixed(2)} (${dxyData.xauChange >= 0 ? '+' : ''}${dxyData.xauChange?.toFixed(2)}% today)`);
    }
    if (newsCtx) ctxLines.push(newsCtx.slice(0, 1200));
    if (calCtx) ctxLines.push(calCtx.slice(0, 800));

    const systemPrompt =
      'You are Henry, an institutional macro analyst writing a brief daily market take for retail traders. ' +
      'Read the provided DXY/gold prints, news items, and calendar, and output a single short paragraph (60-90 words) capturing: ' +
      '(1) the dollar / gold setup, (2) one key event in the next 12 hours, (3) one tactical bias for crypto. ' +
      'Tone: confident, plain English, no emojis, no markdown. Reference real numbers from the inputs. ' +
      'End with a single sentence on what would invalidate the bias.';
    const userMessage = 'Today\'s inputs:\n\n' + ctxLines.join('\n\n') + '\n\nWrite the daily take now.';

    let summary;
    try {
      summary = await callAnthropicServer(systemPrompt, userMessage, 350);
    } catch (err) {
      console.warn('[macro-summary] Anthropic call failed:', err.message);
      summary = null;
    }

    const payload = {
      summary: summary || 'Daily macro take temporarily unavailable. Check DXY and the calendar for major releases — patient setups beat over-trading on quiet sessions.',
      generatedAt: new Date(now).toISOString(),
      cachedFor: '6h',
      source: summary ? 'anthropic' : 'fallback',
    };
    _macroSummaryCache = { ts: now, payload };
    res.json(payload);
  } catch (err) {
    console.error('[macro-summary]', err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── /api/v2/analyse ── Manual AI analysis. FULL PARITY with the autoscan
// engine context + gates: same MTF, BTC correlation, funding, OI, news,
// calendar, DXY, cross-broker, ORDER FLOW / FOOTPRINT, CVD, LIQUIDITY, and
// regime indicators. Same per-pair TF override (gold → 5m). Same NY-open
// block window (configurable via HENRY_BLOCK_NY_OPEN). Returns the signal
// PLUS the diagnostic indicators (regime, ADX, ATR, volRatio, divergence)
// so the v2 modal can surface what autoscan would see.
app.post('/api/v2/analyse', requireAuth, express.json(), async (req, res) => {
  const { coin, tf: reqTf = '15m', broker = 'weex', notes, mode, force } = req.body || {};
  if (!coin) return res.status(400).json({ error: 'missing coin' });
  try {
    // Per-pair TF override via tfForCoin (gold is back on 15m as of 2026-06-06;
    // HENRY_TF_OVERRIDES env var can still remap any pair without a redeploy).
    // ?force=true skips the override so the exact requested TF is used.
    const tf = (force ? reqTf : tfForCoin(coin, reqTf));
    const tfOverridden = (tf !== reqTf);
    const isMetalOrOilPair = /^(GOLD|XAU|XAG|XTI|XBR)/.test(coin);
    const pairBroker = brokerForPair(coin, broker);
    const useMulti = String(mode || 'single').toLowerCase() === 'multi' && !isMetalOrOilPair;

    // NY-open block (13:00-14:30 UTC) — autoscan skips the window; manual
    // returns a blocked response unless ?force=true is sent. Existing in-trade
    // monitoring keeps running regardless (this gate only stops *new* calls).
    if (HENRY_BLOCK_NY_OPEN && !force) {
      const utcMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      if (utcMin >= NY_OPEN_BLOCK_START_MIN && utcMin < NY_OPEN_BLOCK_END_MIN) {
        const endH = String(Math.floor(NY_OPEN_BLOCK_END_MIN / 60)).padStart(2, '0');
        const endM = String(NY_OPEN_BLOCK_END_MIN % 60).padStart(2, '0');
        return res.status(409).json({
          blocked: 'ny_open',
          reason: `NY-open sweep window — autoscan blocks new signals until ${endH}:${endM} UTC. Re-send with force=true to override.`,
        });
      }
    }

    const baseCandles = await fetchCandlesServer(coin, tf, 100, pairBroker);
    if (!baseCandles || baseCandles.length < 20) {
      return res.status(503).json({ error: `Insufficient candle data for ${coin} on ${tf} (${pairBroker})` });
    }
    const btcBroker = (pairBroker === 'massive') ? 'binance' : pairBroker;
    const [mtfH1, mtfH4, btcCandles, funding, trades, newsCtx, calCtx, dxyData, crossBrokerCtx,
           oiDeltaCtx, fundingTrendCtx, lsRatioCtx, perfFeedbackCtx] = await Promise.all([
      fetchCandlesServer(coin, '1h', 50, pairBroker).catch(() => []),
      fetchCandlesServer(coin, '4h', 30, pairBroker).catch(() => []),
      (!isMetalOrOilPair && coin !== 'BTCUSDT') ? fetchCandlesServer('BTCUSDT', tf, 30, btcBroker).catch(() => []) : Promise.resolve([]),
      fetchFundingRateServer(coin).catch(() => null),
      // ORDER FLOW — recent trades for the footprint + CVD context strings
      fetchTradesServer(coin, pairBroker).catch(() => []),
      fetchNewsContext().catch(() => ''),
      fetchCalendarContext().catch(() => ''),
      isMetalOrOilPair ? fetchDXYContextServer().catch(() => null) : Promise.resolve(null),
      useMulti ? buildCrossBrokerContextServer(coin, tf, pairBroker).catch(() => '') : Promise.resolve(''),
      // Positioning / OI / funding-trend / self-performance — all graceful-empty on failure
      buildOIDeltaContextServer(coin, tf, baseCandles).catch(() => ''),
      buildFundingTrendContextServer(coin).catch(() => ''),
      buildLongShortRatioContextServer(coin, tf).catch(() => ''),
      buildPerfFeedbackContextServer(coin).catch(() => ''),
    ]);

    // Full indicator set — matches autoscan exactly so the diagnostic readouts
    // (regime, ADX, ATR, volRatio, divergence) reflect identical computations.
    const last = baseCandles[baseCandles.length - 1];
    const avgVol20 = baseCandles.slice(-21, -1).reduce((s, c) => s + (c.v || 0), 0) / 20;
    const indicators = {
      atr14: computeATR(baseCandles, 14),
      adx:   computeADX(baseCandles, 14),
      volRatio: avgVol20 > 0 ? (last.v || 0) / avgVol20 : null,
      divergence: detectDivergence(baseCandles, 30),
    };
    const regime = (mtfH4 && mtfH4.length >= 20) ? detectRegimeFromCandles(mtfH4) : null;

    const trigger = { type: 'MANUAL', desc: 'User-initiated analysis from v2 Terminal' };

    // Derived context strings — order-flow / footprint and CVD are the big
    // ones manual used to miss. Liquidity context too.
    const liquidityCtx = buildLiquidityContextServer(baseCandles, tf);
    const footprintCtx = buildFootprintContextServer(trades, baseCandles);
    const cvdCtx       = buildCVDContextServer(trades);
    const liqCtx       = buildLiquidationContextServer(coin, baseCandles);
    const dxyCtx       = isMetalOrOilPair && dxyData ? buildDXYContextString(dxyData) : '';

    const baseCtx = buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, trigger, indicators });
    const contextStr = [baseCtx, dxyCtx, oiDeltaCtx, fundingTrendCtx, lsRatioCtx, liquidityCtx, footprintCtx, cvdCtx, liqCtx, crossBrokerCtx, newsCtx, calCtx, perfFeedbackCtx]
      .filter(s => s && s.length).join('\n');

    const lastClose = last.c;
    const systemPrompt = buildServerSystemPrompt(coin, tf, pairBroker, contextStr, lastClose);
    const userMessage = `Analyse ${coin} on ${tf} (${pairBroker}) right now.` +
      (notes ? `\n\nUser notes: ${notes}` : '') +
      `\n\nLast close: ${lastClose}. Output the JSON signal only.`;
    // Manual ANALYSE explicitly uses AI_MODEL (typically Sonnet 4.6) — faster
    // than the autoscan model (Opus 4.8) because the user is actively waiting
    // on the response. The callAnthropicServer default is AUTOSCAN_AI_MODEL so
    // autoscan continues to use the stronger model with no change there.
    const text = await callAnthropicServer(systemPrompt, userMessage, 2000, AI_MODEL);
    const signal = parseSignalJSONServer(text);
    if (!signal) {
      return res.status(500).json({ error: 'JSON parse failed', rawText: text ? text.slice(0, 500) : '' });
    }
    // Apply RR floor and BE validation same as autoscan
    if (signal.direction !== 'NO TRADE' && signal.entry && signal.sl && signal.tp) {
      const e = parseFloat(signal.entry), sl = parseFloat(signal.sl), tp = parseFloat(signal.tp);
      const rr = signal.direction === 'LONG' ? (tp - e) / (e - sl) : (e - tp) / (sl - e);
      if (isFinite(rr) && rr < 1.3) {
        signal.direction = 'NO TRADE';
        signal.reasoning = `Auto-downgraded: computed RR ${rr.toFixed(2)} below 1.3R minimum. ` + (signal.reasoning || '');
      }
    }
    res.json({
      signal,
      generatedAt: new Date().toISOString(),
      model: AI_MODEL,
      lastClose,
      // Diagnostics — same indicators autoscan computes. Modal surfaces these
      // so the user can see the regime/ADX/ATR/Vol/Div context the AI just saw.
      diagnostics: {
        tfUsed: tf,
        tfRequested: reqTf,
        tfOverridden,
        regime: regime ? { regime: regime.regime, confidence: regime.confidence } : null,
        adx:    indicators.adx != null ? +indicators.adx.toFixed(2) : null,
        atr14:  indicators.atr14 != null ? +indicators.atr14.toFixed(6) : null,
        volRatio: indicators.volRatio != null ? +indicators.volRatio.toFixed(2) : null,
        divergence: indicators.divergence || null,
        contextSources: {
          mtf: !!(mtfH1.length && mtfH4.length),
          btcCorrelation: !!btcCandles.length,
          orderFlow: !!(trades && trades.length),
          cvd: !!(cvdCtx && cvdCtx.length),
          liquidity: !!(liquidityCtx && liquidityCtx.length),
          news: !!newsCtx,
          calendar: !!calCtx,
          dxy: !!dxyCtx,
          crossBroker: !!crossBrokerCtx,
        },
      },
    });
  } catch (err) {
    console.error('[v2/analyse]', err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── /api/v2/watchlist ── Per-pair state + mini candle series for Kingdom's
// 6 chart panels in the v2 UI. Returns one entry per admin-watchlist pair
// with: state (scanning/in-trade/waiting/cooldown), last price, % change,
// recent candle preview, signal info if any. Single roundtrip → 6 panels.
app.get('/api/v2/watchlist', requireAuth, async (_req, res) => {
  try {
    const adminId = await getAdminUserId();
    if (!adminId) return res.json({ pairs: [] });
    const sub = scanSubscriptions.get(adminId);
    if (!sub) return res.json({ pairs: [], active: false });

    const watchlist = (sub.watchlist && sub.watchlist.length) ? sub.watchlist : [sub.coin].filter(Boolean);
    const broker = sub.broker || 'weex';
    const tf = sub.tf || '15m';

    // Fetch candles for each pair in parallel. 80 bars gives the Kingdom
    // mini-charts enough history to look like real charts with a usable
    // time axis. Still well under broker rate limits.
    const candleArrays = await Promise.all(watchlist.map(coin => {
      const pairBroker = brokerForPair(coin, broker);
      // Use displayTfForCoin (not tfForCoin) — for XAUT the strategy runs 5m
      // but the Kingdom panel renders on 15m for readability. Strategy state
      // below still flows from the 5m engine via the subscription object.
      const pairTf = (typeof displayTfForCoin === 'function') ? displayTfForCoin(coin, tf) : tf;
      return fetchCandlesServer(coin, pairTf, 80, pairBroker).catch(() => []);
    }));

    // Map each pair into a panel-ready shape
    const now = Date.now();
    const pairs = watchlist.map((coin, i) => {
      const candles = candleArrays[i] || [];
      const ps = sub.pairs && sub.pairs[coin];
      const lastPrice = candles.length ? candles[candles.length - 1].c : (ps?.lastPrice || null);
      const firstPrice = candles.length ? candles[0].c : null;
      const pctChange = (firstPrice && lastPrice) ? ((lastPrice - firstPrice) / firstPrice) * 100 : null;
      // State derivation
      let state = 'scanning';
      if (ps?.pendSignal) {
        if (ps._entryAlerted) state = 'in-trade';
        else if (ps._confirmationPending) state = 'waiting-confirm';
        else state = 'waiting';
      }
      if (ps?.cooldownUntil && ps.cooldownUntil > now && !ps?.pendSignal) state = 'cooldown';
      if (ps?.pauseUntil && ps.pauseUntil > now) state = 'paused';
      return {
        coin,
        broker: brokerForPair(coin, broker),
        // Report the DISPLAY tf so the panel header label matches the candles
        // the user is actually looking at. Strategy TF stays internal.
        tf: (typeof displayTfForCoin === 'function') ? displayTfForCoin(coin, tf) : tf,
        state,
        lastPrice,
        pctChange: pctChange != null ? +pctChange.toFixed(2) : null,
        // Keep `t` so the client can render a real time axis. Volume stripped to keep payload small.
        candles: candles.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
        signal: ps?.pendSignal ? {
          direction: ps.pendSignal.direction,
          entry: ps.pendSignal.entry,
          sl: ps.pendSignal.sl,
          tp: ps.pendSignal.tp,
          rr: ps.pendSignal.rr,
          confidence: ps.pendSignal.confidence,
        } : null,
        // BE-moved is genuine new info — `state` only encodes scanning/waiting/
        // in-trade/cooldown/paused but not whether SL was already shifted to BE.
        // Needed for the "BE MOVED" badge that flips the in-trade state tag.
        beAlerted: !!(ps && ps._beAlerted),
      };
    });
    res.json({ active: !!sub.active, pairs, broker, tf, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[v2/watchlist]', err.message || err);
    res.status(500).json({ error: err.message || String(err), pairs: [] });
  }
});

// ── /api/v2/candles ── Browser chart fetch with server-side broker dispatch ─
// Browser can't talk to Binance directly when Railway's egress IP is geo-
// blocked, and the http-proxy-middleware path (/binance-futures) hits the same
// wall. Route through fetchCandlesServer which has the Binance → WEEX
// fallback built in. Lightweight schema: {time, open, high, low, close} per
// candle. Same shape Lightweight Charts expects.
app.get('/api/v2/candles', requireAuth, async (req, res) => {
  const coin = String(req.query.coin || '').toUpperCase();
  const tf = String(req.query.tf || '15m');
  const broker = String(req.query.broker || 'weex').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  if (!coin) return res.status(400).json({ error: 'missing_coin', candles: [] });
  try {
    const raw = await fetchCandlesServer(coin, tf, limit, brokerForPair(coin, broker));
    const candles = (raw || []).map(c => ({
      time: c.t > 1e12 ? Math.floor(c.t / 1000) : c.t,
      open: c.o, high: c.h, low: c.l, close: c.c,
    }));
    res.json({ candles, broker: brokerForPair(coin, broker) });
  } catch (err) {
    console.error('[v2/candles]', coin, tf, broker, err.message || err);
    res.status(500).json({ error: err.message || String(err), candles: [] });
  }
});

// ── /api/v2/events ── SSE event stream of scan-state transitions ───────────
// Pushes signal/entry/be/tp/sl/expired events to the browser the instant the
// scan loop flips a pair-state flag, instead of waiting up to 5s for the
// next /api/scan/all-pairs poll. Replaces the legacy /api/events SSE.
//
// Multiple tabs OK: each open EventSource gets its own res registered in
// _scanEventBus[userId]. Sends a heartbeat every 25s so corporate proxies
// don't time the connection out.
const _scanEventBus = new Map(); // userId → Set<res>

function emitScanEvent(userId, payload){
  const bag = _scanEventBus.get(userId);
  if (!bag || !bag.size) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of bag) {
    try { res.write(line); } catch { /* dead connection — sweeper removes */ }
  }
}

app.get('/api/v2/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (Railway/Nginx)
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  let bag = _scanEventBus.get(req.user.id);
  if (!bag) { bag = new Set(); _scanEventBus.set(req.user.id, bag); }
  bag.add(res);
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    bag.delete(res);
    if (!bag.size) _scanEventBus.delete(req.user.id);
  });
});

// ── Futures proxies ─────────────────────────────────────────────────────────
const proxyOpts = (target, prefix) => ({
  target,
  changeOrigin: true,
  pathRewrite: { [`^${prefix}`]: '' },
  xfwd: false,
});

app.use('/weex-futures', requireAuth, createProxyMiddleware(proxyOpts('https://api-contract.weex.com', '/weex-futures')));
app.use('/binance-futures', requireAuth, createProxyMiddleware(proxyOpts('https://fapi.binance.com', '/binance-futures')));

// ── Claude API proxy ────────────────────────────────────────────────────────
// Uses _anthropicFetchWithRetry under the hood: transient 529/503/429/overloaded_error
// auto-retry with exponential backoff (2s → 5s → 12s) so manual AI Analyse doesn't
// fail when Anthropic is saturated. Streaming is NOT supported here (we buffer the
// full response to make retries safe) — the browser doesn't depend on streaming.
app.post('/api/claude', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'anthropic_not_configured' });
  }
  try {
    // Normalize model: ALWAYS use the server-side AI_MODEL regardless of what the
    // browser sends. This prevents stale cached values in old browser tabs from
    // hitting the API with deprecated/incorrect model IDs after a model bump.
    const body = { ...req.body, model: AI_MODEL };
    // Force non-streaming so the retry helper can buffer the response
    delete body.stream;
    const d = await _anthropicFetchWithRetry(body);
    res.status(200).json(d);
  } catch (err) {
    console.error('[claude proxy]', err.message);
    const status = err.status || 502;
    if (!res.headersSent) {
      res.status(status).json({
        error: err.anthropicError ? err.anthropicError.type : 'upstream',
        detail: String(err.message || err),
      });
    } else res.end();
  }
});

// ── Health & public assets ──────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Public legal & pricing pages (no auth — Paddle/Stripe must crawl these) ──
app.get('/pricing', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pricing.html')));
app.get('/terms',   (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/refund',  (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'refund.html')));
app.get('/manifest.json', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'manifest.json')));
app.get('/login.html', (_req, res) => res.redirect('/login'));

// ── Landing (public) + Terminal (auth-gated) ────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
// Phase 5 cutover: /terminal and /app both serve v2 by default. Every
// internal redirect (login → /terminal, subscribe → /terminal, etc.)
// now lands on v2 without touching any other HTML file.
//
// Rollback: set HENRY_V2_LEGACY=true on Railway. /terminal and /app
// will serve the legacy index.html instead. /terminal-legacy always
// serves legacy regardless so admin can A/B compare any time.
const HENRY_V2_LEGACY = (process.env.HENRY_V2_LEGACY || '').toLowerCase() === 'true';
app.get('/app', requireAuth, (_req, res) =>
  res.redirect(HENRY_V2_LEGACY ? '/terminal-legacy' : '/v2'));
app.get('/terminal', requireAuth, (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, HENRY_V2_LEGACY ? 'index.html' : 'v2.html')));
app.get('/terminal-legacy', requireAuth, (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/v2', requireAuth, (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'v2.html')));

// Catch-all static — serves terminal assets (js, css, sw.js, etc.) to authenticated users only.
app.use(requireAuth, express.static(PUBLIC_DIR, { index: false, extensions: ['html'] }));

// ── Helpers ─────────────────────────────────────────────────────────────────
async function notifyAdminOfRequest(email) {
  const url = process.env.DISCORD_AUTO_WEBHOOK || process.env.DISCORD_WEBHOOK;
  if (!url) return;
  const adminLink = `${SITE_URL}/admin`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Henry Access',
        content: `🟡 Access requested: \`${email}\`\nApprove or deny: ${adminLink}`,
      }),
    });
  } catch (err) {
    console.error('[notify admin]', err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — POLYGON / MASSIVE MARKET DATA (DXY, Gold)
// ════════════════════════════════════════════════════════════════════════════

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';
const POLYGON_BASE = 'https://api.polygon.io';

async function polyFetch(pathPart, params = {}) {
  if (!POLYGON_API_KEY) throw new Error('POLYGON_API_KEY not configured');
  const url = new URL(POLYGON_BASE + pathPart);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apiKey', POLYGON_API_KEY);
  const r = await fetch(url.toString());
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`polygon ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

function calcDxy(c) {
  // c is { EUR, JPY, GBP, CAD, SEK, CHF } where each value is USD/<currency> close
  if (!c.EUR || !c.JPY || !c.GBP || !c.CAD || !c.SEK || !c.CHF) return null;
  return 50.14348112
    * Math.pow(c.EUR, 0.576)
    * Math.pow(c.JPY, 0.136)
    * Math.pow(c.GBP, 0.119)
    * Math.pow(c.CAD, 0.091)
    * Math.pow(c.SEK, 0.042)
    * Math.pow(c.CHF, 0.036);
}

app.get('/api/dxy', requireAuth, async (_req, res) => {
  try {
    const tickers = ['C:USDEUR', 'C:USDJPY', 'C:USDGBP', 'C:USDCAD', 'C:USDSEK', 'C:USDCHF', 'C:XAUUSD'].join(',');
    const data = await polyFetch('/v2/snapshot/locale/global/markets/forex/tickers', { tickers });
    const today = {}, prev = {};
    for (const t of (data.tickers || [])) {
      const code = (t.ticker || '').replace('C:USD', '').replace('C:', '');
      const cur = t.lastQuote?.a || t.day?.c || t.prevDay?.c;
      const pre = t.prevDay?.c;
      if (cur) today[code] = cur;
      if (pre) prev[code] = pre;
    }
    const dxy = calcDxy(today);
    const dxyPrev = calcDxy(prev);
    const dxyChange = dxy && dxyPrev ? ((dxy - dxyPrev) / dxyPrev) * 100 : 0;
    const xau = today['XAUUSD'] || null;
    const xauPrev = prev['XAUUSD'] || null;
    const xauChange = xau && xauPrev ? ((xau - xauPrev) / xauPrev) * 100 : 0;
    res.json({ dxy, dxyChange, xau, xauChange, ts: Date.now() });
  } catch (err) {
    console.error('[dxy]', err);
    res.status(502).json({ error: 'dxy_failed', detail: String(err.message || err) });
  }
});

const POLY_TF = {
  '1m':  { multiplier: 1,  timespan: 'minute', ms: 60000 },
  '5m':  { multiplier: 5,  timespan: 'minute', ms: 300000 },
  '15m': { multiplier: 15, timespan: 'minute', ms: 900000 },
  '1h':  { multiplier: 1,  timespan: 'hour',   ms: 3600000 },
  '4h':  { multiplier: 4,  timespan: 'hour',   ms: 14400000 },
  '1d':  { multiplier: 1,  timespan: 'day',    ms: 86400000 },
};

app.get('/api/gold/candles', requireAuth, async (req, res) => {
  try {
    const interval = String(req.query.interval || '15m');
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    // Binance spot PAXG/USDT — see getGoldSpot() for the rationale.
    const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };
    const ival = tfMap[interval] || '15m';
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${ival}&limit=${limit}`);
    if (!r.ok) {
      console.warn('[gold/candles] PAXG fetch failed:', interval, r.status);
      return res.json({ candles: [], reason: 'paxg_unavailable' });
    }
    const arr = await r.json();
    if (!Array.isArray(arr)) return res.json({ candles: [], reason: 'paxg_empty' });
    const candles = arr.map(c => ({
      time: Math.floor(+c[0] / 1000),
      o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5],
    }));
    console.log('[gold/candles]', interval, 'returned', candles.length, 'PAXG bars');
    res.json({ candles });
  } catch (err) {
    console.error('[gold/candles]', err);
    res.status(502).json({ error: 'gold_candles_failed', detail: String(err.message || err) });
  }
});

// Gold spot price — uses Binance PAXG/USDT spot.
// Polygon's /v2/snapshot/locale/global/markets/forex/tickers was returning
// stale data (e.g. 4764 when real gold was 4683 — $80 off) on the user's
// plan. Pax Gold (PAXG) is a 1:1 tokenised gold contract trading on
// Binance with real-time ticker and full intraday data, tracks XAUUSD
// within ~$5. Falls back to Polygon only if Binance is unreachable.
async function getGoldSpot() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT');
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d.price);
      if (isFinite(p) && p > 0) return p;
    }
  } catch (e) {
    console.warn('[getGoldSpot] PAXG fetch failed, falling back to Polygon:', e.message);
  }
  // Fallback: Polygon snapshot. Less accurate on the user's tier but better
  // than nothing if Binance is down.
  try {
    const data = await polyFetch('/v2/snapshot/locale/global/markets/forex/tickers', { tickers: 'C:XAUUSD' });
    const t = data.tickers && data.tickers[0];
    if (!t) return null;
    const ask = t.lastQuote?.a;
    const bid = t.lastQuote?.b;
    if (ask && bid) return (ask + bid) / 2;
    return ask || bid || t.day?.c || t.prevDay?.c || null;
  } catch { return null; }
}

app.get('/api/gold/price', requireAuth, async (_req, res) => {
  try {
    const price = await getGoldSpot();
    res.json({ price, ts: Date.now() });
  } catch (err) {
    console.error('[gold/price]', err);
    res.status(502).json({ error: 'gold_price_failed', detail: String(err.message || err) });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART 4C — WEB PUSH SETUP
// ════════════════════════════════════════════════════════════════════════════

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:noreply@henrythehoover.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function sendPushTo(userId, payload) {
  const { data } = await supaAdmin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth_key, id')
    .eq('user_id', userId);
  if (!data || !data.length) return;
  for (const sub of data) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription gone — clean up dead endpoint
        try {
          await supaAdmin.from('push_subscriptions').delete().eq('id', sub.id);
        } catch (delErr) {
          console.warn('[push cleanup]', delErr.message);
        }
      } else {
        console.error('[push]', e.message);
      }
    }
  }
}

app.get('/api/push/vapid-key', requireAuth, (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, express.json(), async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  // Upsert (one row per endpoint)
  const { error } = await supaAdmin
    .from('push_subscriptions')
    .upsert({
      user_id: req.user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth_key: sub.keys.auth,
    }, { onConflict: 'endpoint' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, express.json(), async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'missing_endpoint' });
  await supaAdmin.from('push_subscriptions').delete().eq('endpoint', endpoint);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 5 — SIGNAL HISTORY (Supabase)
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/signals', requireAuth, express.json({ limit: '512kb' }), async (req, res) => {
  const { signal, trigger, broker, tf } = req.body || {};
  if (!signal?.pair || !signal?.direction) return res.status(400).json({ error: 'invalid_signal' });
  const row = {
    user_id: req.user.id,
    pair: signal.pair,
    direction: signal.direction,
    entry: signal.entry || null,
    sl: signal.sl || null,
    tp: signal.tp || null,
    rr: signal.rr || null,
    confidence: signal.confidence || null,
    session_name: signal.session || null,
    broker: broker || null,
    timeframe: tf || null,
    trigger_type: trigger?.type || null,
    trigger_desc: trigger?.desc || null,
    entry_reason: signal.entry_reason || null,
    reasoning: signal.reasoning || null,
    be_note: signal.be_note || null,
    key_risk: signal.key_risk || null,
    invalidation: signal.invalidation || null,
    expiry_candles: signal.expiry_candles || null,
  };
  const { data, error } = await supaAdmin.from('signals').insert(row).select('id').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, id: data.id });
});

app.patch('/api/signals/:id/outcome', requireAuth, express.json(), async (req, res) => {
  const { outcome, outcomeRr } = req.body || {};
  await logSignalOutcomeAndJournal(req.user.id, req.params.id, outcome, outcomeRr);
  // Mark the pair-state so the server-side monitor doesn't fire it again.
  const sub = scanSubscriptions.get(req.user.id);
  if (sub && sub.pairs) {
    for (const ps of Object.values(sub.pairs)) {
      if (ps.signalId === req.params.id) {
        ps._outcomeLogged = true;
        // Browser logged the outcome — clear the trade so this pair returns to scanning.
        clearPairState(ps);
        break;
      }
    }
  }
  res.json({ ok: true });
});

// ── Shared outcome logger — used by browser PATCH endpoint AND server-side monitor.
//    Resilient: if the DB row is missing OR signalId is null (saveServerSignal might
//    have failed earlier, or browser synced before _lastSignalId resolved), still
//    post the Discord journal using `fallbackSignal` so the user is never silently
//    dropped. Idempotency guarded by ps._outcomeLogged at the call site.
async function logSignalOutcomeAndJournal(userId, signalId, outcome, outcomeRr, fallbackSignal, fallbackBroker, fallbackTf) {
  let existing = null;
  if (signalId) {
    try {
      const { data } = await supaAdmin
        .from('signals')
        .select('*')
        .eq('id', signalId)
        .eq('user_id', userId)
        .maybeSingle();
      existing = data;
    } catch (e) { console.error('[outcome fetch]', e.message); }
  }

  const wasUnset = !existing || existing.outcome == null;
  let signalForJournal = null;

  if (existing) {
    // Normal path — update DB
    const { error } = await supaAdmin
      .from('signals')
      .update({ outcome, outcome_rr: outcomeRr ?? null, outcome_at: new Date().toISOString() })
      .eq('id', signalId)
      .eq('user_id', userId);
    if (error) console.error('[outcome update]', error.message);
    signalForJournal = { ...existing, outcome, outcome_rr: outcomeRr ?? null };
  } else if (!signalId && fallbackSignal) {
    // Legitimately new signal that was never persisted — insert a row now so
    // /api/signals/history and the browser jrn[] sync see it. (Common cause:
    // saveServerSignal failed earlier, OR browser race set ps.signalId=null.)
    console.warn('[outcome] no signalId — inserting backfill row for', fallbackSignal.pair);
    try {
      const { data: inserted, error: insErr } = await supaAdmin.from('signals').insert({
        user_id: userId,
        pair: fallbackSignal.pair,
        direction: fallbackSignal.direction,
        entry: fallbackSignal.entry || null,
        sl: fallbackSignal.sl || null,
        tp: fallbackSignal.tp || null,
        rr: fallbackSignal.rr || null,
        confidence: fallbackSignal.confidence || null,
        session_name: fallbackSignal.session || null,
        broker: fallbackBroker || null,
        timeframe: fallbackTf || null,
        entry_reason: fallbackSignal.entry_reason || null,
        reasoning: fallbackSignal.reasoning || null,
        be_note: fallbackSignal.be_note || null,
        key_risk: fallbackSignal.key_risk || null,
        invalidation: fallbackSignal.invalidation || null,
        expiry_candles: fallbackSignal.expiry_candles || null,
        outcome,
        outcome_rr: outcomeRr ?? null,
        outcome_at: new Date().toISOString(),
      }).select('*').single();
      if (insErr) console.error('[outcome backfill insert]', insErr.message);
      signalForJournal = inserted || { ...fallbackSignal, outcome, outcome_rr: outcomeRr ?? null, broker: fallbackBroker, timeframe: fallbackTf };
    } catch (e) {
      console.error('[outcome backfill]', e.message);
      signalForJournal = { ...fallbackSignal, outcome, outcome_rr: outcomeRr ?? null, broker: fallbackBroker, timeframe: fallbackTf };
    }
  } else if (signalId && !existing && fallbackSignal) {
    // Orphan: signalId was claimed but DB row gone (deleted, or insert silently failed).
    // Don't insert (would risk duplicate on race). Just post journal from in-memory data.
    console.error('[outcome] orphan signalId', signalId, '— posting journal without DB row');
    signalForJournal = { ...fallbackSignal, outcome, outcome_rr: outcomeRr ?? null, broker: fallbackBroker, timeframe: fallbackTf };
  } else {
    // No DB row AND no fallback — nothing to journal
    console.warn('[outcome] no signalId, no fallback — skipping journal for', outcome);
    return;
  }

  // Post journal on first outcome assignment OR when we just backfilled.
  // EXPIRED is intentionally EXCLUDED here — an unfilled/expired signal is not
  // a P/L event, so it must NOT post an outcome card to the journal / outcome
  // (mirror) Discord channels. The DB outcome is still written above so
  // /performance and history reflect it; circuit-breaker stays TP/SL/BE only.
  if (wasUnset && (outcome === 'TP' || outcome === 'SL' || outcome === 'BE')) {
    // Manual ANALYSE outcomes must NOT post to the Discord journal — that
    // channel is Henry's own autoscan track record only. Manual signals carry
    // a NULL trigger_type and are logged from the browser PATCH with no
    // fallbackSignal; the server-side autoscan monitor ALWAYS passes a
    // fallbackSignal (and autoscan rows carry a non-null trigger_type), so both
    // autoscan paths still post. Same manual-vs-auto rule used by
    // /api/performance/me (autoscan ⇔ trigger_type set).
    const isManual = !fallbackSignal && !(existing && existing.trigger_type);
    if (!isManual) {
      const stats = await getUserStats(userId).catch(() => null);
      postJournalToDiscord(signalForJournal, outcome, outcomeRr, stats)
        .catch(e => console.error('[journal post]', e.message));
    }
    // Record into circuit breaker history (only on first outcome) so losing
    // streaks pause future scans automatically.
    if (signalForJournal && signalForJournal.pair && outcome !== 'EXPIRED') {
      recordOutcomeForCircuitBreaker(userId, signalForJournal.pair, outcome);
    }
  }
}

// ── Stats helper used by journal posts ──
async function getUserStats(userId) {
  try {
    const { data } = await supaAdmin
      .from('signals')
      .select('outcome, outcome_rr')
      .eq('user_id', userId)
      .not('outcome', 'is', null);
    if (!data || !data.length) return null;
    const tp = data.filter(s => s.outcome === 'TP').length;
    const sl = data.filter(s => s.outcome === 'SL').length;
    const be = data.filter(s => s.outcome === 'BE').length;
    const totalRr = data.reduce((sum, s) => sum + (parseFloat(s.outcome_rr) || 0), 0);
    const closed = tp + sl + be;
    const winRate = closed ? +(((tp + be * 0.5) / closed) * 100).toFixed(1) : 0;
    return { tp, sl, be, totalRr: totalRr.toFixed(2), winRate, total: data.length };
  } catch { return null; }
}

// ── Discord webhook fan-out ──────────────────────────────────────────────
// Post the SAME JSON payload to one or more webhook URLs. Per-URL failures are
// swallowed so one dead / rate-limited webhook never blocks the others. Used
// to MIRROR autoscan signals + signal outcomes to two Discords each.
async function postJsonToWebhooks(urls, payload, label = 'discord') {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(list.map(u =>
    fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      .then(async r => { if (!r.ok) console.error(`[${label}]`, r.status, (await r.text().catch(() => '')).slice(0, 200)); })
      .catch(e => console.error(`[${label}]`, e.message || e))
  ));
}
// Autoscan SIGNAL posts mirror to the auto channel + the dedicated signals
// Discord. Signal OUTCOMES mirror to the journal channel + the outcome Discord.
// (WEEX execution alerts have their own webhook — see the executor notifier.)
function signalWebhooks()  { return [process.env.DISCORD_AUTO_WEBHOOK, process.env.DISCORD_SIGNALS_WEBHOOK]; }
function outcomeWebhooks() { return [process.env.DISCORD_JOURNAL_WEBHOOK, process.env.DISCORD_OUTCOME_WEBHOOK]; }

// ── Journal Discord posting ──
async function postJournalToDiscord(signal, outcome, outcomeRr, stats) {
  const urls = outcomeWebhooks().filter(Boolean);
  if (!urls.length) {
    console.warn('[journal] no outcome webhook configured (DISCORD_JOURNAL_WEBHOOK / DISCORD_OUTCOME_WEBHOOK) — skipping post');
    return;
  }
  if (!signal) {
    console.warn('[journal] no signal data passed — skipping post');
    return;
  }
  const isWin     = outcome === 'TP';
  const isBE      = outcome === 'BE';
  const isExpired = outcome === 'EXPIRED';
  const outcomeEmoji = isWin ? '🟢' : isBE ? '🟡' : isExpired ? '⚪' : '🔴';
  const outcomeLabel = isWin ? 'TAKE PROFIT' : isBE ? 'BREAKEVEN' : isExpired ? 'EXPIRED (no entry)' : 'STOP LOSS';
  const rrDisplay = isWin ? `+${outcomeRr ?? signal.rr ?? '—'}R` : isBE ? '0R' : isExpired ? '0R (unfilled)' : '-1R';
  const fields = [
    { name: 'Pair',       value: `\`${signal.pair || '—'}\``,                  inline: true },
    { name: 'Direction',  value: `\`${signal.direction || '—'}\``,             inline: true },
    { name: 'Outcome',    value: `\`${outcomeLabel}\``,                        inline: true },
    { name: 'Entry',      value: `\`${signal.entry ?? '—'}\``,                 inline: true },
    { name: 'SL',         value: `\`${signal.sl ?? '—'}\``,                    inline: true },
    { name: 'TP',         value: `\`${signal.tp ?? '—'}\``,                    inline: true },
    { name: 'Target RR',  value: `\`${signal.rr ?? '—'}R\``,                   inline: true },
    { name: 'Result',     value: `\`${rrDisplay}\``,                           inline: true },
    { name: 'Confidence', value: `\`${signal.confidence ?? '—'}%\``,           inline: true },
  ];
  let statsText = '';
  if (stats) {
    statsText = `\n\n**Running Stats (${stats.total} trades)**\n`
      + `Win: ${stats.tp} | Loss: ${stats.sl} | BE: ${stats.be} | Win rate: ${stats.winRate}%\n`
      + `Total P&L: ${parseFloat(stats.totalRr) >= 0 ? '+' : ''}${parseFloat(stats.totalRr).toFixed(2)}R`;
  }
  const reasoning = signal.reasoning ? String(signal.reasoning).slice(0, 200) : '';
  const embed = {
    title: `${outcomeEmoji} ${outcomeLabel}: ${signal.pair || ''} ${signal.direction || ''}`.trim(),
    description: (signal.entry_reason ? `**Entry:** ${signal.entry_reason}\n` : '')
      + (reasoning ? `${reasoning}${reasoning.length === 200 ? '...' : ''}\n` : '')
      + statsText,
    color: isWin ? 3066993 : isBE ? 16776960 : isExpired ? 8421504 : 15548997,
    fields,
    footer: {
      text: `Henry Journal | ${signal.broker || ''}${signal.timeframe ? ' | ' + signal.timeframe : ''} | ${new Date().toUTCString()}`,
    },
    timestamp: new Date().toISOString(),
  };
  await postJsonToWebhooks(urls, { embeds: [embed], username: 'Henry Journal' }, 'journal webhook');
  console.log('[journal] posted', outcome, signal.pair, signal.direction, '→', urls.length, 'webhook(s)');
}

app.get('/api/signals/history', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { data, error } = await supaAdmin
    .from('signals')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ signals: data || [] });
});

app.get('/api/signals/stats', requireAuth, async (req, res) => {
  const { data, error } = await supaAdmin
    .from('signals')
    .select('outcome, outcome_rr')
    .eq('user_id', req.user.id)
    .not('outcome', 'is', null);
  if (error) return res.status(500).json({ error: error.message });
  const tp = data.filter(s => s.outcome === 'TP').length;
  const sl = data.filter(s => s.outcome === 'SL').length;
  const be = data.filter(s => s.outcome === 'BE').length;
  const totalRr = data.reduce((s, x) => s + (parseFloat(x.outcome_rr) || 0), 0);
  const closed = tp + sl + be;
  const winRate = closed ? +(((tp + be * 0.5) / closed) * 100).toFixed(1) : 0;
  res.json({ tp, sl, be, totalRr: +totalRr.toFixed(2), winRate, total: data.length });
});

// Kingdom dashboard summary — single payload powering the top band of
// /kingdom. RR-based (Henry risks 1R per trade by convention).
// Cached 5s to keep DB load light if the page polls aggressively.
const _kingdomCache = new Map(); // userId → { ts, payload }
app.get('/api/kingdom/summary', requireAuth, async (req, res) => {
  try {
    // Kingdom is the public "Henry's record" dashboard — always show admin's
    // signals + scan state regardless of who's viewing. Fall back to caller
    // userId if admin lookup failed (e.g. fresh deploy, no profile row yet).
    const userId = (await getAdminUserId()) || req.user.id;
    const cached = _kingdomCache.get(userId);
    if (cached && Date.now() - cached.ts < 5000) {
      return res.json(cached.payload);
    }

    // Pull all signals (any outcome state) ordered by created_at
    const { data, error } = await supaAdmin
      .from('signals')
      .select('id, pair, direction, outcome, outcome_rr, outcome_at, created_at, rr, confidence')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[kingdom summary]', error.message);
      return res.status(500).json({ error: error.message });
    }
    const rows = data || [];

    // ── Time anchors (all UTC) ──
    const now = new Date();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const inToday = (s) => s.outcome_at && new Date(s.outcome_at).getTime() >= todayStart;
    const inMonth = (s) => s.outcome_at && new Date(s.outcome_at).getTime() >= monthStart;

    // ── Aggregators ──
    const closedRows = rows.filter(r => r.outcome === 'TP' || r.outcome === 'SL' || r.outcome === 'BE');
    const expiredRows = rows.filter(r => r.outcome === 'EXPIRED');

    function aggBucket(filter) {
      const matched = rows.filter(filter);
      const tp = matched.filter(r => r.outcome === 'TP').length;
      const sl = matched.filter(r => r.outcome === 'SL').length;
      const be = matched.filter(r => r.outcome === 'BE').length;
      const exp = matched.filter(r => r.outcome === 'EXPIRED').length;
      const closed = tp + sl + be;
      const totalR = matched.reduce((s, r) => s + (parseFloat(r.outcome_rr) || 0), 0);
      const winRate = closed ? +(((tp + be * 0.5) / closed) * 100).toFixed(1) : 0;
      return { tp, sl, be, expired: exp, closed, totalR: +totalR.toFixed(2), winRate };
    }

    const today    = aggBucket(inToday);
    const month    = aggBucket(inMonth);
    const allTime  = aggBucket(() => true);

    // AI calls today = signals created today (regardless of outcome)
    const aiCallsToday = rows.filter(r => new Date(r.created_at).getTime() >= todayStart).length;

    // ── Daily R bars for current month ──
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
    const dailyR = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d);
      const dayEnd   = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d + 1);
      const dayR = rows
        .filter(r => r.outcome_at && new Date(r.outcome_at).getTime() >= dayStart && new Date(r.outcome_at).getTime() < dayEnd)
        .reduce((s, r) => s + (parseFloat(r.outcome_rr) || 0), 0);
      dailyR.push({ day: d, r: +dayR.toFixed(2) });
    }

    // ── Streak (most recent consecutive same-direction outcomes) ──
    let streakCount = 0, streakType = null;
    for (let i = closedRows.length - 1; i >= 0; i--) {
      const isWin = closedRows[i].outcome === 'TP';
      const isLoss = closedRows[i].outcome === 'SL';
      if (streakType === null) {
        if (isWin) streakType = 'W';
        else if (isLoss) streakType = 'L';
        else break;
        streakCount = 1;
      } else if ((streakType === 'W' && isWin) || (streakType === 'L' && isLoss)) {
        streakCount++;
      } else {
        break;
      }
    }
    const streak = streakCount > 0 ? { type: streakType, count: streakCount } : null;

    // ── Best / worst trade today + all-time ──
    const todayClosed = closedRows.filter(inToday);
    const bestToday = todayClosed.reduce((best, r) => (!best || (parseFloat(r.outcome_rr) || 0) > (parseFloat(best.outcome_rr) || 0)) ? r : best, null);
    const worstToday = todayClosed.reduce((worst, r) => (!worst || (parseFloat(r.outcome_rr) || 0) < (parseFloat(worst.outcome_rr) || 0)) ? r : worst, null);

    // Expectancy = totalR / closed (only for closed trades, not EXPIRED)
    const expectancy = allTime.closed ? +(allTime.totalR / allTime.closed).toFixed(2) : 0;
    const todayExpectancy = today.closed ? +(today.totalR / today.closed).toFixed(2) : 0;

    // ── Open positions from in-memory scan state ──
    const sub = scanSubscriptions.get(userId);
    const openPositions = { long: [], short: [], totalCount: 0 };
    if (sub && sub.pairs) {
      for (const [coin, ps] of Object.entries(sub.pairs)) {
        if (!ps.pendSignal) continue;
        const dir = ps.pendSignal.direction;
        if (dir !== 'LONG' && dir !== 'SHORT') continue;
        const entry = parseFloat(ps.pendSignal.entry);
        const tp = parseFloat(ps.pendSignal.tp);
        const sl = parseFloat(ps.pendSignal.sl);
        const cp = ps.lastPrice;
        let pctToTp = null;
        if (cp != null && entry && tp && entry !== tp) {
          pctToTp = +(Math.abs(cp - entry) / Math.abs(tp - entry) * 100).toFixed(1);
        }
        const pos = {
          coin,
          direction: dir,
          entry, sl, tp,
          rr: parseFloat(ps.pendSignal.rr) || null,
          confidence: parseFloat(ps.pendSignal.confidence) || null,
          entered: !!ps._entryAlerted,
          beAlerted: !!ps._beAlerted,
          lastPrice: cp,
          pctToTp,
          signalId: ps.signalId,
          signalTimestamp: ps.signalTimestamp,
        };
        if (dir === 'LONG') openPositions.long.push(pos);
        else openPositions.short.push(pos);
        openPositions.totalCount++;
      }
    }

    // Aggregates for open positions
    function openAgg(list) {
      const count = list.length;
      const entered = list.filter(p => p.entered).length;
      const plannedR = list.reduce((s, p) => s + (p.rr || 0), 0);
      const avgConf = count ? +(list.reduce((s, p) => s + (p.confidence || 0), 0) / count).toFixed(0) : 0;
      const pairs = list.map(p => p.coin.replace('USDT', ''));
      // R at risk: 1R per active position (Henry convention). Use list.length; once-entered is at full risk.
      const rAtRisk = +(entered * -1).toFixed(1);
      return { count, entered, plannedR: +plannedR.toFixed(2), avgConf, pairs, rAtRisk };
    }

    // Next high-impact calendar event (re-uses /api/calendar/events cache)
    let nextEvent = null;
    try {
      await fetchCalendarContext();
      const items = (_calendarCache.items || [])
        .filter(e => e.imp === 'high' && e.dt > Date.now())
        .sort((a, b) => a.dt - b.dt);
      if (items.length) {
        const e = items[0];
        const diffMin = Math.round((e.dt - Date.now()) / 60000);
        nextEvent = { name: e.name, zone: e.zone, dt: e.dt, inMinutes: diffMin };
      }
    } catch {}

    const payload = {
      now: Date.now(),
      today: { ...today, expectancy: todayExpectancy, aiCalls: aiCallsToday },
      month,
      allTime: { ...allTime, expectancy, startedAt: rows[0]?.created_at || null },
      dailyR, // [{day, r}] for current month
      streak,
      bestToday: bestToday ? { pair: bestToday.pair, direction: bestToday.direction, r: parseFloat(bestToday.outcome_rr) || 0 } : null,
      worstToday: worstToday ? { pair: worstToday.pair, direction: worstToday.direction, r: parseFloat(worstToday.outcome_rr) || 0 } : null,
      openPositions: {
        long: openAgg(openPositions.long),
        short: openAgg(openPositions.short),
        totalCount: openPositions.totalCount,
        details: { long: openPositions.long, short: openPositions.short },
      },
      nextEvent,
      scanState: {
        active: !!sub?.active,
        watchlistSize: sub?.watchlist?.length || 0,
        pairsTracked: sub?.pairs ? Object.keys(sub.pairs).length : 0,
        tf: sub?.tf || '15m',
        broker: sub?.broker || null,
      },
    };

    _kingdomCache.set(userId, { ts: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    console.error('[kingdom summary]', err.message);
    res.status(500).json({ error: 'kingdom_failed' });
  }
});

// Performance dashboard data — aggregated breakdowns across all signals.
// Used by /performance.html. Returns rich grouped data (by pair, trigger,
// session, hour) plus cumulative R timeline + best/worst trades.
// Debug helper: returns raw counts to diagnose why dashboard might be empty.
// Hit /api/performance/debug from a browser tab while authenticated.
app.get('/api/performance/debug', requireAuth, async (req, res) => {
  try {
    // 1) Count ALL signals in the table (any user) — sanity check that table has rows
    const { count: globalCount, error: globalErr } = await supaAdmin
      .from('signals')
      .select('id', { count: 'exact', head: true });

    // 2) Count for THIS user
    const { count: myCount, error: myErr } = await supaAdmin
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);

    // 3) Last 5 rows GLOBALLY — to see what user_ids actually exist
    const { data: globalSample, error: gsErr } = await supaAdmin
      .from('signals')
      .select('id, pair, direction, outcome, outcome_at, created_at, user_id')
      .order('created_at', { ascending: false })
      .limit(5);

    // 4) Last 20 rows for THIS user
    const { data: mine, error: mineErr } = await supaAdmin
      .from('signals')
      .select('id, pair, direction, outcome, outcome_rr, outcome_at, created_at, user_id')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    // 5) Distinct user_ids in signals (sample)
    const distinctUsers = new Set();
    if (globalSample) for (const r of globalSample) distinctUsers.add(r.user_id);

    res.json({
      authenticatedUserId: req.user.id,
      authenticatedEmail: req.user.email,
      counts: {
        totalSignalsGlobally: globalCount ?? null,
        totalSignalsForMe: myCount ?? null,
      },
      errors: {
        globalCountErr: globalErr?.message || null,
        myCountErr:     myErr?.message     || null,
        globalSampleErr:gsErr?.message     || null,
        mineErr:        mineErr?.message   || null,
      },
      distinctUserIdsInRecent5: Array.from(distinctUsers),
      latest5GlobalSignals: (globalSample || []).map(s => ({
        id: s.id,
        pair: s.pair,
        outcome: s.outcome,
        created_at: s.created_at,
        user_id: s.user_id,
        user_id_matches_me: s.user_id === req.user.id,
      })),
      latest20MySignals: (mine || []).map(s => ({
        id: s.id,
        pair: s.pair,
        direction: s.direction,
        outcome: s.outcome,
        outcome_rr: s.outcome_rr,
        outcome_at: s.outcome_at,
        created_at: s.created_at,
      })),
      mySignalsWithOutcome: (mine || []).filter(s => s.outcome != null).length,
    });
  } catch (err) {
    console.error('[performance debug]', err.message);
    res.status(500).json({ error: 'debug_failed', detail: err.message });
  }
});

app.get('/api/performance/dashboard', requireAuth, async (req, res) => {
  try {
    // First, count ALL rows for this user (no filter) so we can debug missing outcomes
    const { count: totalAllSignals } = await supaAdmin
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);
    const { data, error } = await supaAdmin
      .from('signals')
      .select('pair, direction, outcome, outcome_rr, outcome_at, created_at, trigger_type, session_name, broker, timeframe, rr, confidence')
      .eq('user_id', req.user.id)
      .not('outcome', 'is', null)
      .order('outcome_at', { ascending: true });
    if (error) {
      console.error('[dashboard query]', error.message);
      return res.status(500).json({ error: error.message });
    }
    const rows = data || [];
    console.log('[dashboard]', req.user.email, 'total signals=' + (totalAllSignals || 0), 'with outcome=' + rows.length);

    // ── Helper: aggregate a row group into { tp, sl, be, expired, total, winRate, totalR, expectancy } ──
    // `total` = filled outcomes (tp+sl+be). EXPIRED is tracked separately so
    // win-rate/expectancy stay clean while unfilled signals still appear on
    // the dashboard and don't silently vanish.
    function agg(group) {
      const tp = group.filter(s => s.outcome === 'TP').length;
      const sl = group.filter(s => s.outcome === 'SL').length;
      const be = group.filter(s => s.outcome === 'BE').length;
      const expired = group.filter(s => s.outcome === 'EXPIRED').length;
      const total = tp + sl + be;
      const totalR = group.reduce((s, x) => s + (parseFloat(x.outcome_rr) || 0), 0);
      const winRate = total ? +(((tp + be * 0.5) / total) * 100).toFixed(1) : 0;
      const expectancy = total ? +(totalR / total).toFixed(2) : 0;
      return { tp, sl, be, expired, total, totalR: +totalR.toFixed(2), winRate, expectancy };
    }

    // ── Group helpers ──
    function groupBy(arr, keyFn) {
      const out = {};
      for (const r of arr) {
        const k = keyFn(r);
        if (k == null) continue;
        if (!out[k]) out[k] = [];
        out[k].push(r);
      }
      return out;
    }

    const byPairRaw = groupBy(rows, r => r.pair);
    const byPair = {};
    for (const [k, v] of Object.entries(byPairRaw)) byPair[k] = agg(v);

    const byTriggerRaw = groupBy(rows, r => r.trigger_type || 'manual');
    const byTrigger = {};
    for (const [k, v] of Object.entries(byTriggerRaw)) byTrigger[k] = agg(v);

    const bySessionRaw = groupBy(rows, r => r.session_name || 'unknown');
    const bySession = {};
    for (const [k, v] of Object.entries(bySessionRaw)) bySession[k] = agg(v);

    const byBrokerRaw = groupBy(rows, r => r.broker || 'unknown');
    const byBroker = {};
    for (const [k, v] of Object.entries(byBrokerRaw)) byBroker[k] = agg(v);

    // By hour of day (UTC) — based on outcome_at
    const byHourRaw = groupBy(rows, r => {
      if (!r.outcome_at) return null;
      return String(new Date(r.outcome_at).getUTCHours()).padStart(2, '0');
    });
    const byHour = {};
    for (let h = 0; h < 24; h++) {
      const key = String(h).padStart(2, '0');
      byHour[key] = byHourRaw[key] ? agg(byHourRaw[key]) : { tp: 0, sl: 0, be: 0, expired: 0, total: 0, totalR: 0, winRate: 0, expectancy: 0 };
    }

    // Cumulative R over time
    let cum = 0;
    const cumRR = rows.map(r => {
      cum += parseFloat(r.outcome_rr) || 0;
      return { ts: r.outcome_at || r.created_at, cumR: +cum.toFixed(2), pair: r.pair, outcome: r.outcome };
    });

    // Best/worst 10 by outcome_rr
    const sortedByR = rows.slice().sort((a, b) => (parseFloat(b.outcome_rr) || 0) - (parseFloat(a.outcome_rr) || 0));
    const best10 = sortedByR.slice(0, 10);
    const worst10 = sortedByR.slice(-10).reverse();

    res.json({
      total: agg(rows),
      byPair,
      byTrigger,
      bySession,
      byBroker,
      byHour,
      cumRR,
      best10,
      worst10,
    });
  } catch (err) {
    console.error('[performance dashboard]', err.message);
    res.status(500).json({ error: 'dashboard_failed' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART 4A/B/F — SERVER-SIDE SCAN LOOP + TRADE MONITOR
// ════════════════════════════════════════════════════════════════════════════

const scanSubscriptions = new Map(); // userId → { active, coin, tf, broker, isAdmin, ... }
const SCAN_INTERVAL_MS = 30000;

// ════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — used by hard vetoes + AI context
// ════════════════════════════════════════════════════════════════════════════

// True Range Average — measures volatility. Used for stop placement.
function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  if (trs.length < period) return null;
  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// Average Directional Index — trend strength (0-100). <20 = chop, >25 = trending.
function computeADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const upMove = c.h - p.h;
    const downMove = p.l - c.l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Wilder's smoothing
  function wilder(arr) {
    if (arr.length < period) return null;
    let val = arr.slice(0, period).reduce((s, x) => s + x, 0);
    const out = [val];
    for (let i = period; i < arr.length; i++) val = val - val / period + arr[i], out.push(val);
    return out;
  }
  const trS = wilder(tr), pS = wilder(plusDM), mS = wilder(minusDM);
  if (!trS || !pS || !mS) return null;
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) { dx.push(0); continue; }
    const plusDI = (pS[i] / trS[i]) * 100;
    const minusDI = (mS[i] / trS[i]) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

// Relative Strength Index — momentum. Used for divergence detection.
function computeRSI(candles, period = 14, endIdx) {
  if (!candles) return null;
  const slice = endIdx != null ? candles.slice(0, endIdx + 1) : candles;
  if (slice.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = slice[i].c - slice[i - 1].c;
    if (ch > 0) gains += ch; else losses -= ch;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < slice.length; i++) {
    const ch = slice[i].c - slice[i - 1].c;
    if (ch > 0) {
      avgG = (avgG * (period - 1) + ch) / period;
      avgL = (avgL * (period - 1)) / period;
    } else {
      avgG = (avgG * (period - 1)) / period;
      avgL = (avgL * (period - 1) - ch) / period;
    }
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// Detect bearish/bullish divergence on last `lookback` candles.
//   • 'bearish' → price made higher high but RSI made lower high → BLOCK LONGS
//   • 'bullish' → price made lower low  but RSI made higher low  → BLOCK SHORTS
function detectDivergence(candles, lookback = 30) {
  if (!candles || candles.length < lookback + 14) return null;
  const startIdx = candles.length - lookback;
  // For each candle in the window, compute RSI up-to-that-candle
  const series = [];
  for (let i = startIdx; i < candles.length; i++) {
    const rsi = computeRSI(candles, 14, i);
    series.push({ i, h: candles[i].h, l: candles[i].l, rsi });
  }
  // Find swing pivots (5-bar fractal)
  function swings(arr, type) {
    const out = [];
    for (let i = 2; i < arr.length - 2; i++) {
      const v = type === 'high' ? arr[i].h : arr[i].l;
      const cmp = type === 'high'
        ? (a, b) => a > b
        : (a, b) => a < b;
      if (cmp(v, arr[i - 1][type === 'high' ? 'h' : 'l']) && cmp(v, arr[i - 2][type === 'high' ? 'h' : 'l'])
          && cmp(v, arr[i + 1][type === 'high' ? 'h' : 'l']) && cmp(v, arr[i + 2][type === 'high' ? 'h' : 'l'])) {
        out.push(arr[i]);
      }
    }
    return out;
  }
  const highs = swings(series, 'high').slice(-2);
  const lows  = swings(series, 'low').slice(-2);
  if (highs.length === 2) {
    const [a, b] = highs;
    if (b.h > a.h && b.rsi != null && a.rsi != null && b.rsi < a.rsi) return 'bearish';
  }
  if (lows.length === 2) {
    const [a, b] = lows;
    if (b.l < a.l && b.rsi != null && a.rsi != null && b.rsi > a.rsi) return 'bullish';
  }
  return null;
}

// Exponential Moving Average — used for regime detection.
function computeEMA(candles, period) {
  if (!candles || candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].c * k + ema * (1 - k);
  }
  return ema;
}

// Market regime detector — operates on 4H candles. Returns:
//   { regime: 'up' | 'down' | 'range', confidence: 'strong' | 'medium' | 'weak', ema20, ema50, adx, slope }
//
// Logic:
//   • Price above both 20-EMA and 50-EMA + 50-EMA slope rising  → 'up'
//   • Price below both EMAs + 50-EMA slope falling               → 'down'
//   • Anything mixed                                              → 'range'
//   • Confidence boosted to 'strong' when ADX >= 25 (trending market)
function detectRegimeFromCandles(h4Candles) {
  if (!h4Candles || h4Candles.length < 50) return { regime: 'range', confidence: 'weak' };
  const last = h4Candles[h4Candles.length - 1];
  const ema20 = computeEMA(h4Candles, 20);
  const ema50 = computeEMA(h4Candles, 50);
  if (ema20 == null || ema50 == null) return { regime: 'range', confidence: 'weak' };
  // 50-EMA slope: compare current vs 5-bar-ago value
  const ema50Past = computeEMA(h4Candles.slice(0, -5), 50);
  const slopePct = ema50Past ? (ema50 - ema50Past) / ema50Past : 0;
  const slopeUp = slopePct > 0.003;    // 0.3% rise over 5 bars
  const slopeDown = slopePct < -0.003;
  const aboveBoth = last.c > ema20 && last.c > ema50;
  const belowBoth = last.c < ema20 && last.c < ema50;
  const adx = computeADX(h4Candles, 14);

  let regime = 'range', confidence = 'medium';
  if (aboveBoth && slopeUp) {
    regime = 'up';
    confidence = (adx != null && adx >= 25) ? 'strong' : 'medium';
  } else if (belowBoth && slopeDown) {
    regime = 'down';
    confidence = (adx != null && adx >= 25) ? 'strong' : 'medium';
  } else {
    regime = 'range';
    // Range confidence depends on ADX — low ADX = stronger range conviction
    confidence = (adx != null && adx < 20) ? 'strong' : 'medium';
  }
  return {
    regime, confidence,
    ema20: +ema20.toFixed(4),
    ema50: +ema50.toFixed(4),
    adx: adx != null ? +adx.toFixed(1) : null,
    slopePct: +(slopePct * 100).toFixed(2),
  };
}

// Live regime detector — fetches 4H candles itself, with per-pair caching.
const _regimeCache = new Map(); // coin → { ts, data }
async function detectMarketRegime(coin, broker) {
  const cached = _regimeCache.get(coin);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.data; // 1-hour cache
  try {
    const h4 = await fetchCandlesServer(coin, '4h', 100, broker);
    const data = detectRegimeFromCandles(h4);
    _regimeCache.set(coin, { ts: Date.now(), data });
    return data;
  } catch (e) {
    console.error('[regime]', coin, e.message);
    return { regime: 'range', confidence: 'weak' };
  }
}

// Should the trigger direction be allowed in the current regime?
//   'up'   → only LONG triggers
//   'down' → only SHORT triggers
//   'range'→ both allowed
// Returns { allowed: bool, reason: string }
function regimeAllowsDirection(regime, trigDir) {
  if (!regime || regime === 'range') return { allowed: true };
  if (regime === 'up' && trigDir === 'bear')   return { allowed: false, reason: 'Uptrend regime — short-side trigger blocked' };
  if (regime === 'down' && trigDir === 'bull') return { allowed: false, reason: 'Downtrend regime — long-side trigger blocked' };
  return { allowed: true };
}

const REGIME_FILTER_ENABLED = (process.env.HENRY_REGIME_FILTER || 'on').toLowerCase() !== 'off';

// Asset-class ATR multiplier for stop placement (per user's table).
function atrMultiplierForAsset(coin) {
  const u = coin.toUpperCase();
  if (/^(GOLD|XAUUSD)/.test(u))    return { multiplier: 2.0, klass: 'gold spot',   tf: '1d' };
  if (/^(BTC|ETH)/.test(u))        return { multiplier: 2.0, klass: 'major',       tf: '4h' };
  if (/^(SOL|AVAX|BNB|LINK|ADA|NEAR|INJ|XAG)/.test(u)) return { multiplier: 2.5, klass: 'mid-cap',     tf: '4h' };
  if (/^(PEPE|DOGE|SUI|ARB|OP|1000PEPE|XAU(T)?)/.test(u)) return { multiplier: 3.0, klass: 'low-cap',     tf: '4h' };
  if (/^(XTI|XBR)/.test(u))        return { multiplier: 2.5, klass: 'oil',         tf: '1d' };
  return { multiplier: 2.5, klass: 'default', tf: '4h' };
}

// Trigger direction inference from detector output (e.g. "BOS up" → bull)
function inferTriggerDirection(trigger) {
  if (!trigger) return null;
  // Price-action types (legacy)
  if (trigger.type === 'bos')           return /up/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'sweep')         return /high/i.test(trigger.desc) ? 'bear' : 'bull';
  if (trigger.type === 'rejection')     return /Bullish/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'atr')           return /up/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'fvg')           return /Bullish/i.test(trigger.desc) ? 'bull' : 'bear';
  // ICT/S&D types
  if (trigger.type === 'mss_disp')      return /Bullish/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'sweep_disp')    return /Bullish/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'ob_mitigation') return /Bullish/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'sd_zone')       return /Demand/i.test(trigger.desc) ? 'bull' : 'bear';
  if (trigger.type === 'fvg_ote')       return /Bullish/i.test(trigger.desc) ? 'bull' : 'bear';
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// PER-PAIR TIMEFRAME OVERRIDE
// ════════════════════════════════════════════════════════════════════════════
// Gold reverted to the 15-minute chart on 2026-06-06. The 5m experiment
// (fbbf3e9, 2026-05-24) ~2.3x'd signal volume but win-rate fell 75% -> 48.5%
// and avg R/trade dropped +0.82 -> +0.18 over the trial window — too many
// low-quality fills, and at $30/trade those stops hurt. Other pairs keep the
// scan subscription's default TF. Env var HENRY_TF_OVERRIDES still tunes
// per-pair without a code change (e.g. back to 5m if we ever retry the test).
const HENRY_TF_OVERRIDES = (() => {
  const raw = process.env.HENRY_TF_OVERRIDES;
  if (!raw) return { XAUTUSDT: '15m', GOLD: '15m', XAUUSD: '15m' };
  try { return JSON.parse(raw); } catch (err) {
    console.warn('[scan] HENRY_TF_OVERRIDES not valid JSON:', err.message);
    return { XAUTUSDT: '15m', GOLD: '15m', XAUUSD: '15m' };
  }
})();
function tfForCoin(coin, defaultTf) {
  const sym = String(coin || '').toUpperCase();
  return HENRY_TF_OVERRIDES[sym] || defaultTf;
}
// Display-only TF overrides — used purely for the Kingdom mini-chart candles.
// The strategy / autoscan engine continues to use tfForCoin() for its actual
// signal generation. XAUT runs a 5m strategy but reads better on 15m candles
// in the cramped Kingdom panel, so we render the chart on 15m here without
// touching the entry/SL/TP logic.
const HENRY_DISPLAY_TF_OVERRIDES = (() => {
  const raw = process.env.HENRY_DISPLAY_TF_OVERRIDES;
  if (!raw) return { XAUTUSDT: '15m', GOLD: '15m', XAUUSD: '15m' };
  try { return JSON.parse(raw); } catch (err) {
    console.warn('[scan] HENRY_DISPLAY_TF_OVERRIDES not valid JSON:', err.message);
    return { XAUTUSDT: '15m', GOLD: '15m', XAUUSD: '15m' };
  }
})();
function displayTfForCoin(coin, defaultTf) {
  const sym = String(coin || '').toUpperCase();
  return HENRY_DISPLAY_TF_OVERRIDES[sym] || tfForCoin(coin, defaultTf);
}

// ════════════════════════════════════════════════════════════════════════════
// CORRELATION CLUSTERS — portfolio heat caps
// ════════════════════════════════════════════════════════════════════════════
function getClusterFor(coin) {
  const u = coin.toUpperCase();
  if (/^BTC/.test(u))                                            return 'btc';
  if (/^MSTR/.test(u))                                           return 'btc';      // MSTR = leveraged-BTC proxy stock perp
  if (/^(OPENAI|ANTHROPIC)/.test(u))                             return 'preipo';   // pre-IPO valuation perps, decorrelated
  if (/^(ETH|BNB|SOL|XRP)/.test(u))                              return 'largeCap';
  if (/^(AAVE|LINK|UNI)/.test(u))                                return 'defi';
  if (/^(DOGE|PEPE|1000PEPE)/.test(u))                           return 'meme';
  if (/^(AVAX|NEAR|SUI|ARB|OP|INJ|ADA|DOT)/.test(u))             return 'layer1';
  if (/^(GOLD|XAU|XAG|XTI|XBR)/.test(u))                         return 'commodities';
  return 'other';
}

// Returns { active: [{coin, cluster}], byCluster: {cluster: [coins]}, total }
function getActivePortfolio(sub) {
  const active = [], byCluster = {};
  if (!sub.pairs) return { active, byCluster, total: 0 };
  for (const [coin, ps] of Object.entries(sub.pairs)) {
    if (!ps.pendSignal || ps.pendSignal.direction === 'NO TRADE') continue;
    // Treat both "waiting entry" and "in trade" as portfolio heat — both have risk
    const cluster = getClusterFor(coin);
    active.push({ coin, cluster });
    if (!byCluster[cluster]) byCluster[cluster] = [];
    byCluster[cluster].push(coin);
  }
  return { active, byCluster, total: active.length };
}

// Portfolio heat veto rules (correlation-adjusted):
//   • Max 5 concurrent positions total
//   • Max 2 per cluster (BTC=1, since BTC moves the whole crypto market)
//   • Returns { blocked, reason } or { blocked: false }
function checkPortfolioHeat(sub, coin) {
  const { active, byCluster, total } = getActivePortfolio(sub);
  const MAX_TOTAL = 5;
  if (total >= MAX_TOTAL) {
    return { blocked: true, code: 'heat-total', reason: `Portfolio heat cap: ${total}/${MAX_TOTAL} positions active across ${Object.keys(byCluster).length} clusters` };
  }
  const target = getClusterFor(coin);
  const targetMax = target === 'btc' ? 1 : 2;
  const inCluster = (byCluster[target] || []).length;
  if (inCluster >= targetMax) {
    return { blocked: true, code: 'heat-cluster', reason: `Cluster ${target} already at cap (${inCluster}/${targetMax}: ${(byCluster[target] || []).join(', ')})` };
  }
  return { blocked: false };
}

// Patch 1 — opposite-direction veto within the same cluster.
// Pre-AI heat check is count-only (can't know direction before AI runs). This
// veto fires AFTER the AI returns a direction, before the signal is staged
// as pending. Historical analysis (2026-05-23, 154 trades): the
// same_cluster_opp_dir category was 18 trades, 25% WR, -4.86R total — clearly
// trading correlated noise. Blocking it recovers that drag without touching
// same-direction stacking (which is profitable, +23.25R, 56% WR).
// Patch 3 (2026-05-31) — crypto super-cluster opposite-direction veto.
// All non-commodity clusters share BTC's primary direction (corr 0.55-0.95),
// so BTC SHORT + ETH LONG + AAVE LONG is the same losing pattern as ETH SHORT
// + SOL LONG (already blocked by Patch 1). Re-run of analyze_stacked.py on
// 2026-05-31 (268 trades) confirmed cross-cluster opp-dir behaves identically
// to same-cluster opp-dir: 10 trades, 30% WR, -0.224R/trade vs the blocked
// bucket's 20 trades, 27.8% WR, -0.239R/trade. Commodities (gold) excluded
// because XAUT is genuinely decorrelated with crypto.
const CRYPTO_CLUSTERS = new Set(['btc', 'largeCap', 'defi', 'meme', 'layer1']);
const HENRY_CRYPTO_SUPERCLUSTER_VETO = (process.env.HENRY_CRYPTO_SUPERCLUSTER_VETO ?? 'true').toLowerCase() === 'true';

function checkOppositeDirectionConflict(sub, coin, newDirection) {
  if (!newDirection || newDirection === 'NO TRADE') return { blocked: false };
  const target = getClusterFor(coin);
  const { byCluster } = getActivePortfolio(sub);

  // Patch 1 — same-cluster opposite-direction veto (shipped 2026-05-23).
  const inCluster = byCluster[target] || [];
  for (const c of inCluster) {
    if (c === coin) continue;
    const otherPs = sub.pairs?.[c];
    const existingDir = otherPs?.pendSignal?.direction;
    if (existingDir && existingDir !== 'NO TRADE' && existingDir !== newDirection) {
      return {
        blocked: true,
        code: 'oppdir-veto',
        reason: `Cluster ${target} already has ${existingDir} on ${c} — refusing ${newDirection} on ${coin} (correlated noise)`,
        conflictCoin: c,
        conflictDirection: existingDir,
      };
    }
  }

  // Patch 3 — cross-cluster opposite-direction within the crypto super-cluster.
  // Skipped if target isn't crypto (e.g. gold trades don't trigger this check).
  // Skipped via env var HENRY_CRYPTO_SUPERCLUSTER_VETO=false for fast rollback.
  if (HENRY_CRYPTO_SUPERCLUSTER_VETO && CRYPTO_CLUSTERS.has(target)) {
    for (const [otherCluster, coins] of Object.entries(byCluster)) {
      if (otherCluster === target) continue;
      if (!CRYPTO_CLUSTERS.has(otherCluster)) continue;
      for (const c of coins) {
        if (c === coin) continue;
        const otherPs = sub.pairs?.[c];
        const existingDir = otherPs?.pendSignal?.direction;
        if (existingDir && existingDir !== 'NO TRADE' && existingDir !== newDirection) {
          return {
            blocked: true,
            code: 'oppdir-veto-crypto',
            reason: `Crypto super-cluster: ${otherCluster} already has ${existingDir} on ${c} — refusing ${newDirection} on ${coin} (${target}). BTC direction drives all crypto.`,
            conflictCoin: c,
            conflictDirection: existingDir,
          };
        }
      }
    }
  }

  return { blocked: false };
}

// Patch 2 — canonical session names. The AI returns slightly inconsistent
// labels ("Asia/Early London" vs "Asian/Early London" vs "asian early lon")
// which fragments performance analytics by session. Normalise to a fixed
// whitelist so /performance bucket-by-session is reliable.
const SESSION_PATTERNS = [
  // Order matters — more specific patterns first.
  { re: /asia[n]?[\s/]*london[\s/]*overlap/, canon: 'Asia/London Overlap' },
  { re: /asia[n]?[\s/]*early[\s/]*london[\s/]*overlap/, canon: 'Asia/Early London Overlap' },
  { re: /asia[n]?[\s/]*early[\s/]*london/, canon: 'Asia/Early London' },
  { re: /asia[n]?[\s/]*early[\s/]*eu[\s/]*overlap/, canon: 'Asia/Early EU Overlap' },
  { re: /asia[n]?[\s/]*early[\s/]*eu/, canon: 'Asia/Early EU' },
  { re: /london[\s/]*ny[\s/]*overlap|ldn[\s/]*ny[\s/]*overlap/, canon: 'London/NY Overlap' },
  { re: /us[\s-]*pre[\s-]*market|premarket/, canon: 'US Pre-Market' },
  { re: /new\s+york|ny\s+open|^ny$/, canon: 'New York' },
  { re: /^london$/, canon: 'London' },
  { re: /^us$/, canon: 'US' },
  { re: /^asia[n]?$/, canon: 'Asia' },
];
function normalizeSessionName(s) {
  if (!s) return null;
  const lower = String(s).toLowerCase().trim();
  for (const p of SESSION_PATTERNS) {
    if (p.re.test(lower)) return p.canon;
  }
  return s; // unknown — keep original, will surface in analytics as "needs new pattern"
}

// ════════════════════════════════════════════════════════════════════════════
// HARD VETOES — these BLOCK the trigger before any AI call
// ════════════════════════════════════════════════════════════════════════════

// Strategy-aware default veto thresholds.
//   • ICT works in ranging markets — ADX 15 is reasonable (not 20)
//   • Price-action breakouts need trends — keep ADX 20
//   • Volume requirements scale similarly: ICT structures need less vol confirmation
function defaultVetoConfig(strategyMode) {
  const m = (strategyMode || STRATEGY_MODE || 'ict').toLowerCase();
  if (m === 'price-action') {
    return { adxMin: 20, volMin: 2.0, divergenceVeto: true, fundingVeto: true };
  }
  if (m === 'hybrid') {
    return { adxMin: 18, volMin: 1.75, divergenceVeto: true, fundingVeto: true };
  }
  // ict
  return { adxMin: 15, volMin: 1.5, divergenceVeto: true, fundingVeto: true };
}

// Run vetoes. `vetoConfig` is optional — falls back to strategy-mode defaults.
//   adxMin: 0 disables the ADX veto entirely
//   volMin: 0 disables the volume veto
//   divergenceVeto: false disables RSI divergence block
//   fundingVeto: false disables crowded-funding block
function runHardVetoes(opts) {
  const { coin, sub, candles, trigger, trigDir, adx, volRatio, divergence, funding, strategyMode } = opts;
  const cfg = Object.assign({}, defaultVetoConfig(strategyMode), opts.vetoConfig || {});

  // Portfolio heat (concurrency caps) — always on, prevents overexposure
  const heat = checkPortfolioHeat(sub, coin);
  if (heat.blocked) return heat;

  // ADX → trend strength gate. Disabled when adxMin is 0.
  if (cfg.adxMin > 0 && adx != null && adx < cfg.adxMin) {
    return { blocked: true, code: 'adx', reason: `ADX=${adx.toFixed(1)} < ${cfg.adxMin} (chop)` };
  }

  // Volume → confirmation gate. Disabled when volMin is 0.
  if (cfg.volMin > 0 && volRatio != null && volRatio < cfg.volMin) {
    return { blocked: true, code: 'volume', reason: `Trigger volume ${volRatio.toFixed(2)}× < ${cfg.volMin}× required` };
  }

  // Divergence opposing trigger direction
  if (cfg.divergenceVeto !== false) {
    if (divergence === 'bearish' && trigDir === 'bull') {
      return { blocked: true, code: 'divergence', reason: 'Bearish RSI divergence — blocks long-side trigger' };
    }
    if (divergence === 'bullish' && trigDir === 'bear') {
      return { blocked: true, code: 'divergence', reason: 'Bullish RSI divergence — blocks short-side trigger' };
    }
  }

  // Extreme funding + trigger trades WITH crowd → block
  if (cfg.fundingVeto !== false && funding != null && Math.abs(funding) > 0.01 && trigDir) {
    const crowdDir = funding > 0 ? 'bull' : 'bear';
    if (trigDir === crowdDir) {
      return { blocked: true, code: 'funding', reason: `Funding ${(funding * 100).toFixed(3)}% extreme + crowd-aligned ${crowdDir}` };
    }
  }

  return { blocked: false };
}

// ── Pre-AI confluence pre-filter ───────────────────────────────────────────
// Cheap (≤1 extra fetch: 1H candles + funding rate cache) score from data we
// either already have or can grab quickly. If score < threshold, skip the
// expensive AI call. Cuts Anthropic spend ~40% on noisy chop without dropping
// good setups (high-quality triggers easily clear the bar).
async function preAiConfluenceScore(coin, tf, broker, baseCandles, trigger) {
  const reasons = [];
  let score = 0;

  // 1) Kill zone (0-20)
  const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  let kzScore = 0, kzName = 'OFF';
  if (m >= 420 && m < 600)       { kzScore = 20; kzName = 'LDN-OPEN'; }
  else if (m >= 720 && m < 900)  { kzScore = 20; kzName = 'NY-OPEN';  }
  else if (m >= 900 && m < 1020) { kzScore = 12; kzName = 'LDN-CLOSE';}
  else if (m >= 0   && m < 300)  { kzScore =  5; kzName = 'ASIA';     }
  score += kzScore;
  reasons.push(`KZ=${kzName}+${kzScore}`);

  // 2) Trigger strength (0-20) — bigger reward for vol-confirmed triggers.
  // For synthetic-volume pairs (Polygon spot gold/forex/oil), volume is always
  // 0, so we use range-displacement as the strength proxy instead.
  const last = baseCandles[baseCandles.length - 1];
  const histAvgVol = baseCandles.slice(-21, -1).reduce((s, c) => s + (c.v || 0), 0) / Math.max(baseCandles.length - 1, 1);
  let volSpike;
  if (histAvgVol > 0) {
    volSpike = last.v > histAvgVol * 1.5;
  } else {
    const histAvgRange = baseCandles.slice(-21, -1).reduce((s, c) => s + Math.max(c.h - c.l, 0), 0) / Math.max(baseCandles.length - 1, 1);
    const lastRange = Math.max(last.h - last.l, 0);
    volSpike = histAvgRange > 0 && lastRange >= histAvgRange * 1.4;
  }
  let tScore = 0;
  // Price-action types (legacy)
  if (trigger.type === 'bos')             tScore = volSpike ? 20 : 12;
  else if (trigger.type === 'sweep')      tScore = volSpike ? 15 : 8;
  else if (trigger.type === 'rejection')  tScore = volSpike ? 18 : 12;
  else if (trigger.type === 'atr')        tScore = 14;
  else if (trigger.type === 'fvg')        tScore = volSpike ? 12 : 8;
  // ICT/S&D types — higher base scores (built-in confirmation)
  else if (trigger.type === 'mss_disp')      tScore = 22; // 70% body + 1.5x vol baked in
  else if (trigger.type === 'sweep_disp')    tScore = 18; // 60% close-position baked in
  else if (trigger.type === 'ob_mitigation') tScore = 22; // first OB touch is high-conviction
  else if (trigger.type === 'sd_zone')       tScore = 20; // first S&D zone touch
  else if (trigger.type === 'fvg_ote')       tScore = 20; // FVG + 62-79% retrace confluence
  else                                       tScore = 8;
  score += tScore;
  reasons.push(`Trig=${trigger.type}${volSpike ? '✓vol' : ''}+${tScore}`);

  // 3) Trigger direction inferred from desc (BOS up=bull, BOS down=bear, sweep high=bear, sweep low=bull)
  let trigDir = null;
  if (trigger.type === 'bos')        trigDir = /up/i.test(trigger.desc) ? 'bull' : 'bear';
  else if (trigger.type === 'sweep') trigDir = /high/i.test(trigger.desc) ? 'bear' : 'bull';

  // 4) HTF alignment (-15 to +20) — fetch 10 1H candles, check direction
  let htfScore = 5;
  if (trigDir) {
    try {
      const h1 = await fetchCandlesServer(coin, '1h', 10, broker);
      if (h1 && h1.length >= 5) {
        const htfDir = h1[h1.length - 1].c > h1[0].c ? 'bull' : 'bear';
        if (trigDir === htfDir) { htfScore = 20; reasons.push('HTF-aligned+20'); }
        else                    { htfScore = -15; reasons.push('HTF-conflict-15'); }
      }
    } catch {}
  }
  score += htfScore;

  // 5) Funding bias support (-5 to +15) — extreme funding = good fade signal
  let fScore = 3;
  try {
    const funding = await fetchFundingRateServer(coin);
    if (funding != null && !Number.isNaN(funding) && trigDir) {
      // Positive funding → crowded longs → bear bias is good fade
      // Negative funding → crowded shorts → bull bias is good fade
      const fadeDir = funding > 0.005 ? 'bear' : funding < -0.005 ? 'bull' : null;
      if (fadeDir && fadeDir === trigDir) {
        fScore = Math.abs(funding) > 0.01 ? 15 : 8;
        reasons.push(`Fund-fade+${fScore}`);
      } else if (fadeDir && fadeDir !== trigDir) {
        fScore = -5;
        reasons.push('Fund-against-5');
      }
    }
  } catch {}
  score += fScore;

  // 6) Recent volume momentum (0-10)
  if (baseCandles.length >= 10) {
    const last3 = baseCandles.slice(-3).reduce((s, c) => s + (c.v || 0), 0) / 3;
    const prev = baseCandles.slice(-23, -3);
    const prevAvg = prev.reduce((s, c) => s + (c.v || 0), 0) / Math.max(prev.length, 1);
    if (prevAvg > 0) {
      const ratio = last3 / prevAvg;
      const vmScore = ratio > 1.5 ? 10 : ratio > 1 ? 5 : 0;
      score += vmScore;
      if (vmScore) reasons.push(`Vol-x${ratio.toFixed(1)}+${vmScore}`);
    }
  }

  return { score, reasons: reasons.join(' ') };
}

const PRE_AI_THRESHOLD = 65; // out of ~85 max — tightened from 45 to filter ~30-40% more noise

// ── Risk circuit breaker ───────────────────────────────────────────────────
// Tracks recent SL outcomes per user → pauses scanning when losing streaks form.
//   • Per-pair: 3 SLs on the same pair within 24h → pause that pair for 6h
//   • Global: 3 SLs across any pairs within 4h → pause ALL pairs for 2h
// Backs the auto-scan against the worst-case scenario: bot revenge-trading a
// chop session into a 5+ loss streak overnight.
async function loadRecentOutcomes(userId) {
  // Pull last 24h of recorded outcomes from DB so circuit breaker survives
  // server restarts / scan re-toggles.
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supaAdmin
      .from('signals')
      .select('pair, outcome, outcome_at')
      .eq('user_id', userId)
      .not('outcome', 'is', null)
      .gte('outcome_at', since)
      .order('outcome_at', { ascending: true });
    return (data || []).map(s => ({
      coin: s.pair,
      outcome: s.outcome,
      ts: new Date(s.outcome_at).getTime(),
    }));
  } catch (e) {
    console.error('[circuit breaker load]', e.message);
    return [];
  }
}

function recordOutcomeForCircuitBreaker(userId, coin, outcome) {
  const sub = scanSubscriptions.get(userId);
  if (!sub) return;
  if (!sub.recentOutcomes) sub.recentOutcomes = [];
  sub.recentOutcomes.push({ coin, outcome, ts: Date.now() });
  // Trim to last 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  sub.recentOutcomes = sub.recentOutcomes.filter(o => o.ts >= cutoff);
}

function circuitBreakerStatus(sub, coin) {
  if (!sub.recentOutcomes || !sub.recentOutcomes.length) return { paused: false };
  const now = Date.now();

  // Per-pair: 3 SLs on this coin in 24h → pause for 6h from oldest
  const day24 = now - 24 * 60 * 60 * 1000;
  const pairSLs = sub.recentOutcomes.filter(o => o.coin === coin && o.outcome === 'SL' && o.ts >= day24);
  if (pairSLs.length >= 3) {
    const oldest = pairSLs[pairSLs.length - 3].ts; // 3rd from end (chronological order)
    const pauseUntil = oldest + 6 * 60 * 60 * 1000;
    if (pauseUntil > now) {
      return { paused: true, pauseUntil, scope: 'pair', reason: `${pairSLs.length} SLs in 24h` };
    }
  }

  // Global: 3 SLs across any pair in last 4h → pause everything for 2h from oldest
  const hour4 = now - 4 * 60 * 60 * 1000;
  const recentSLs = sub.recentOutcomes.filter(o => o.outcome === 'SL' && o.ts >= hour4);
  if (recentSLs.length >= 3) {
    const oldest = recentSLs[recentSLs.length - 3].ts;
    const pauseUntil = oldest + 2 * 60 * 60 * 1000;
    if (pauseUntil > now) {
      return { paused: true, pauseUntil, scope: 'global', reason: `${recentSLs.length} SLs across pairs in 4h` };
    }
  }

  return { paused: false };
}

// ── Smart broker routing ───────────────────────────────────────────────────
// Each pair gets routed to the right exchange. Crypto USDT-perps use the user's
// selected broker (Weex/Binance/Hyperliquid). GOLD spot only exists on Polygon
// ('massive'), so it's hard-routed regardless of user's broker choice.
function brokerForPair(coin, defaultBroker) {
  if (coin === 'GOLD' || coin === 'XAUUSD') return 'massive';
  // XAUTUSDT is listed on both WEEX and Binance Futures, but BF trades at
  // a persistent $1-2 discount vs spot/WEEX due to thin volume + basis.
  // User wants XAUT prices to match WEEX UI, so pin it regardless of
  // whichever broker Kingdom or the user is otherwise set to.
  if (coin === 'XAUTUSDT') return 'weex';
  return defaultBroker;
}

// ── Dead-zone cooldown ─────────────────────────────────────────────────────
// Between NY close (22:00 UTC) and London open (08:00 UTC) markets are slow.
// Override the user's cooldown to a 1-hour minimum so we don't burn AI calls
// scanning every 3 minutes during a dead window. Keeps user's setting in
// active sessions.
function effectiveCooldownMs(sub) {
  const hour = new Date().getUTCHours();
  const inDeadZone = hour >= 22 || hour < 8;
  if (inDeadZone) return Math.max(sub.cooldownMs || 0, 60 * 60 * 1000);
  return sub.cooldownMs;
}

// ── Per-pair state helpers ─────────────────────────────────────────────────
// Each scan subscription tracks state PER PAIR so multiple pairs can be in
// monitoring concurrently. Pairs with no active signal keep scanning while
// pairs with active signals are monitored independently.
function getPairState(sub, coin) {
  if (!sub.pairs) sub.pairs = {};
  if (!sub.pairs[coin]) {
    sub.pairs[coin] = {
      cooldownUntil: 0,
      pendSignal: null, signalId: null, signalTimestamp: null,
      _entryAlerted: false, _beAlerted: false, _tpAlerted: false, _expiryAlerted: false,
      _outcomeLogged: false,
      // Silent-pending state — auto-scan generates a signal but holds the
      // notification (push + Discord embed) until the entry-confirmation
      // gate confirms a real LTF pattern. Matches manual analyse behavior.
      _confirmationPending: false,
      _trigger: null,
      _broker: null,
      // Entry-confirmation state (ICT/S&D candle-pattern gate before ENTRY HIT)
      _zoneFirstTouchAt: 0,    // ms when price first entered ±0.3% entry zone
      _confirmFailedAt: 0,     // ms last time confirmation check ran without firing
      _confirmAttempts: 0,
      // Synchronous in-flight lock — set TRUE the moment a scan tick enters
      // the analysis branch (before any await). Prevents a second 30s tick
      // from racing into AI on the same trigger while the first is mid-flight.
      _scanInFlight: false,
      // Diagnostics — populated by processPair every tick so /api/scan/debug
      // can show "is the scan loop alive? how many ticks since last trigger?"
      lastTickAt: 0,        // ms timestamp of most recent processPair call
      tickCount: 0,         // total processPair ticks for this pair this session
      ticksSinceTrigger: 0, // counter reset to 0 when a trigger fires
      _scanLockAt: 0,
      lastPrice: null,
      lastTrigger: null,
      lastStatus: 'idle', // 'idle' | 'scanning' | 'cooldown' | 'waiting' | 'in-trade'
    };
  }
  return sub.pairs[coin];
}
function clearPairState(ps) {
  ps.pendSignal = null;
  ps.signalId = null;
  ps.signalTimestamp = null;
  ps._entryAlerted = false;
  ps._beAlerted = false;
  ps._tpAlerted = false;
  ps._expiryAlerted = false;
  ps._outcomeLogged = false;
  ps._confirmationPending = false;
  ps._autoExec = false;
  ps._trigger = null;
  ps._broker = null;
  ps._zoneFirstTouchAt = 0;
  ps._confirmFailedAt = 0;
  ps._confirmAttempts = 0;
  ps._scanInFlight = false;
  ps._scanLockAt = 0;
  ps.lastStatus = 'idle';
}

app.post('/api/scan/start', requireAuth, express.json(), async (req, res) => {
  const { coin, tf, broker, cooldownMs, watchlist } = req.body || {};
  if (!coin || !tf) return res.status(400).json({ error: 'missing_coin_or_tf' });
  // Preserve existing per-pair state if scan is restarted (e.g. user toggled AUTO off and on)
  const prev = scanSubscriptions.get(req.user.id);
  // Bootstrap circuit-breaker history from DB so it survives restarts / re-toggles
  const recentOutcomes = prev?.recentOutcomes && prev.recentOutcomes.length
    ? prev.recentOutcomes
    : await loadRecentOutcomes(req.user.id);
  // isAdmin: trust either the profile flag OR an exact email match against
  // ADMIN_EMAIL. Also stash the email itself in the sub so subsequent gate
  // checks can re-verify against ADMIN_EMAIL without depending on the cached
  // boolean (which would otherwise stay stale across deploys if ADMIN_EMAIL
  // changes or if the profile gets its is_admin flag updated post-scan-start).
  const userEmail = (req.user.email || '').toLowerCase();
  const isAdminSub = !!req.profile?.is_admin || userEmail === ADMIN_EMAIL;
  scanSubscriptions.set(req.user.id, {
    active: true, coin, tf, broker: broker || 'weex',
    cooldownMs: cooldownMs || 180000,
    watchlist: Array.isArray(watchlist) ? watchlist : [],
    isAdmin: isAdminSub,
    email: userEmail,
    pairs: prev?.pairs || {},
    recentOutcomes,
  });
  res.json({ ok: true });
});

// Update watchlist on the fly without restarting the scan.
// Also prunes leftover sub.pairs[] entries for coins no longer in the
// watchlist so the LIVE PAIR STATUS grid doesn't keep showing them with
// stale "SCANNING" badges. Pairs with an active pending signal are
// preserved — we don't drop monitoring of an open trade just because the
// user unticked the pair from the watchlist (the trade plays out to
// TP/SL/BE/expiry naturally, then state clears).
app.post('/api/scan/update-watchlist', requireAuth, express.json(), (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.status(404).json({ error: 'no_scan_session' });
  sub.watchlist = Array.isArray(req.body?.watchlist) ? req.body.watchlist : [];
  // Prune stale per-pair state for coins that were removed.
  let pruned = 0;
  if (sub.pairs) {
    const keep = new Set(sub.watchlist);
    for (const coin of Object.keys(sub.pairs)) {
      if (keep.has(coin)) continue;
      const ps = sub.pairs[coin];
      // Preserve pairs with an in-flight signal so the monitor still
      // resolves entry/BE/TP/SL/expiry. Once cleared, the next call to
      // this endpoint (or a stop/start cycle) will drop them.
      if (ps && ps.pendSignal) continue;
      delete sub.pairs[coin];
      pruned++;
    }
  }
  if (pruned) console.log('[update-watchlist]', req.user.email || req.user.id, 'pruned', pruned, 'stale pair(s)');
  res.json({ ok: true, count: sub.watchlist.length, pruned });
});

// Returns the focused pair's pending signal if the server-side AI generated one.
// Browser polls this on page load / AUTO toggle to sync UI with server state.
app.get('/api/scan/current-signal', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub || !sub.pairs) return res.json({ signal: null });
  const ps = sub.pairs[sub.coin];
  if (!ps || !ps.pendSignal) {
    // Also check ANY pair with a pending signal — if user is viewing BTC but server
    // generated a signal on ETH, browser should pick it up too.
    for (const [k, v] of Object.entries(sub.pairs)) {
      if (v.pendSignal) {
        return res.json({
          signal: v.pendSignal,
          signalId: v.signalId,
          signalTimestamp: v.signalTimestamp,
          coin: k,
          tf: sub.tf,
          broker: sub.broker,
          state: {
            entryAlerted: !!v._entryAlerted, beAlerted: !!v._beAlerted,
            tpAlerted: !!v._tpAlerted, outcomeLogged: !!v._outcomeLogged,
          },
        });
      }
    }
    return res.json({ signal: null });
  }
  res.json({
    signal: ps.pendSignal,
    signalId: ps.signalId,
    signalTimestamp: ps.signalTimestamp,
    coin: sub.coin,
    tf: sub.tf,
    broker: sub.broker,
    state: {
      entryAlerted: !!ps._entryAlerted, beAlerted: !!ps._beAlerted,
      tpAlerted: !!ps._tpAlerted, outcomeLogged: !!ps._outcomeLogged,
    },
  });
});

// ── Per-pair stats cache for mini-card footers ─────────────────────────────
// 5-minute cache shared across all scan ticks — stats change slowly.
const _pairStatsCache = new Map(); // userId → { ts, byPair: { coin: {tp,sl,be,total,winRate,totalR} } }

async function getUserPairStats(userId) {
  const cached = _pairStatsCache.get(userId);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.byPair;
  try {
    const { data } = await supaAdmin
      .from('signals')
      .select('pair, outcome, outcome_rr')
      .eq('user_id', userId)
      .not('outcome', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);
    const byPair = {};
    for (const s of (data || [])) {
      if (!byPair[s.pair]) byPair[s.pair] = { tp: 0, sl: 0, be: 0, totalR: 0, total: 0, winRate: 0 };
      const p = byPair[s.pair];
      p.total++;
      if (s.outcome === 'TP') p.tp++;
      if (s.outcome === 'SL') p.sl++;
      if (s.outcome === 'BE') p.be++;
      p.totalR += parseFloat(s.outcome_rr) || 0;
    }
    for (const p of Object.values(byPair)) {
      const closed = p.tp + p.sl + p.be;
      p.winRate = closed ? Math.round(((p.tp + p.be * 0.5) / closed) * 100) : 0;
      p.totalR = +p.totalR.toFixed(2);
    }
    _pairStatsCache.set(userId, { ts: Date.now(), byPair });
    return byPair;
  } catch (e) {
    console.error('[pair stats]', e.message);
    return cached ? cached.byPair : {};
  }
}

// Returns state for ALL pairs in the watchlist — used by mini-cards UI.
// Debug endpoint — shows raw scan state for the authenticated user.
// Hit this in your browser to verify the scan loop is alive: lastTickAt
// should be < 60s old per pair, tickCount should be growing, and
// ticksSinceTrigger tells you how long a pair has gone without a trigger.
app.get('/api/scan/debug', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.json({ active: false, error: 'No scan subscription. Click AUTO to start.' });
  const now = Date.now();
  const pairs = {};
  for (const [coin, ps] of Object.entries(sub.pairs || {})) {
    pairs[coin] = {
      lastStatus: ps.lastStatus,
      lastPrice: ps.lastPrice,
      lastTrigger: ps.lastTrigger,
      tickCount: ps.tickCount || 0,
      ticksSinceTrigger: ps.ticksSinceTrigger || 0,
      lastTickAt: ps.lastTickAt || 0,
      lastTickAgoSec: ps.lastTickAt ? Math.round((now - ps.lastTickAt) / 1000) : null,
      cooldownUntil: ps.cooldownUntil,
      cooldownRemainingSec: ps.cooldownUntil ? Math.max(0, Math.round((ps.cooldownUntil - now) / 1000)) : 0,
      hasSignal: !!ps.pendSignal,
      entryAlerted: !!ps._entryAlerted,
      scanInFlight: !!ps._scanInFlight,
      pauseUntil: ps.pauseUntil || 0,
      pauseReason: ps.pauseReason || null,
    };
  }
  res.json({
    active: !!sub.active,
    isAdmin: !!sub.isAdmin,
    email: sub.email || null,
    adminEmailMatch: sub.email === ADMIN_EMAIL,
    coin: sub.coin,
    tf: sub.tf,
    broker: sub.broker,
    cooldownMs: sub.cooldownMs,
    watchlist: sub.watchlist || [],
    pairsTracked: Object.keys(sub.pairs || {}).length,
    now: now,
    serverUptimeSec: Math.round(process.uptime()),
    pairs,
  });
});

app.get('/api/scan/all-pairs', requireAuth, async (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.json({ active: false, pairs: [] });
  // Pairs to report on: every watchlist coin, plus any non-watchlist coin
  // that has an in-flight signal (so an open trade on a just-untiked pair
  // still surfaces until it resolves). Idle leftover state on dropped pairs
  // is filtered out so the grid stays in sync with the user's selection.
  const watchSet = new Set(sub.watchlist || []);
  const pairCoins = new Set(watchSet);
  if (sub.pairs) {
    for (const [coin, ps] of Object.entries(sub.pairs)) {
      if (watchSet.has(coin)) continue;
      if (ps && ps.pendSignal) pairCoins.add(coin);
    }
  }
  if (!pairCoins.size && sub.coin) pairCoins.add(sub.coin);

  // Pre-fetch the cached pair stats once for all pairs in this response
  const stats = await getUserPairStats(req.user.id).catch(() => ({}));

  const pairs = [];
  for (const coin of pairCoins) {
    const ps = sub.pairs && sub.pairs[coin];
    pairs.push({
      coin,
      hasSignal:    !!(ps && ps.pendSignal),
      signal:       ps && ps.pendSignal ? ps.pendSignal : null,
      signalId:     ps && ps.signalId   ? ps.signalId   : null,
      lastPrice:    ps && ps.lastPrice  != null ? ps.lastPrice : null,
      lastTrigger:  ps && ps.lastTrigger ? ps.lastTrigger : null,
      lastPreScore: ps ? (ps.lastPreScore != null ? ps.lastPreScore : null) : null,
      lastVetoReason: ps ? (ps.lastVetoReason || null) : null,
      regime: ps && ps.regime ? { regime: ps.regime.regime, confidence: ps.regime.confidence } : null,
      lastIndicators: ps && ps.lastIndicators ? {
        adx: ps.lastIndicators.adx != null ? +ps.lastIndicators.adx.toFixed(1) : null,
        atr14: ps.lastIndicators.atr14 != null ? +ps.lastIndicators.atr14.toFixed(4) : null,
        volRatio: ps.lastIndicators.volRatio != null ? +ps.lastIndicators.volRatio.toFixed(2) : null,
        divergence: ps.lastIndicators.divergence || null,
      } : null,
      cooldownUntil: ps ? ps.cooldownUntil : 0,
      cooldownRemaining: ps ? Math.max(0, ps.cooldownUntil - Date.now()) : 0,
      pauseUntil: ps && ps.pauseUntil ? ps.pauseUntil : 0,
      pauseRemaining: ps && ps.pauseUntil ? Math.max(0, ps.pauseUntil - Date.now()) : 0,
      pauseReason: ps ? (ps.pauseReason || null) : null,
      status: ps ? ps.lastStatus : 'idle',
      entryAlerted: !!(ps && ps._entryAlerted),
      beAlerted:    !!(ps && ps._beAlerted),
      tpAlerted:    !!(ps && ps._tpAlerted),
      // True while AI has produced a signal but the LTF confirmation gate
      // hasn't fired yet — drives the new "WAITING CONFIRMATION" UI state.
      awaitingConfirmation: !!(ps && ps._confirmationPending),
      stats: stats[coin] || null, // { tp, sl, be, totalR, total, winRate }
    });
  }
  res.json({
    active: !!sub.active,
    tf: sub.tf,
    broker: sub.broker,
    pairs,
  });
});

app.post('/api/scan/stop', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (sub) sub.active = false;
  // Also stop periodic status updates when the user stops auto-scanning
  stopUserStatusUpdates(req.user.id);
  res.json({ ok: true });
});

// Admin-scoped pair states for the Kingdom chart grid. Mirrors
// /api/scan/all-pairs but always resolves to Mansoor's scan so non-admin
// subscribers see Henry's live auto-scan charts instead of their own empty
// scan state. Also surfaces executor-recovered trades (from reconcile) for
// pairs where the scan-loop pendSignal is empty but WEEX has an open
// position, so the chart panel renders "in-trade" with SL/TP overlays.
app.get('/api/kingdom/pairs', requireAuth, async (_req, res) => {
  const adminId = await getAdminUserId();
  if (!adminId) return res.json({ active: false, pairs: [], reason: 'admin_unresolved' });
  const sub = scanSubscriptions.get(adminId);
  if (!sub) return res.json({ active: false, pairs: [] });
  const watchSet = new Set(sub.watchlist || []);
  const pairCoins = new Set(watchSet);
  if (sub.pairs) {
    for (const [coin, ps] of Object.entries(sub.pairs)) {
      if (watchSet.has(coin)) continue;
      if (ps && ps.pendSignal) pairCoins.add(coin);
    }
  }
  if (!pairCoins.size && sub.coin) pairCoins.add(sub.coin);

  // Index executor trades by website pair symbol for merge below. Reconciled
  // trades have synthetic signal IDs prefixed `recovered-`.
  const executorByPair = new Map();
  if (weexExecutor) {
    for (const t of weexExecutor.snapshot()) {
      if (t.state !== 'PENDING' && t.state !== 'ACTIVE') continue;
      // Map executor symbol back to the website pair (XAUTUSDT → GOLD, etc.)
      const websitePair = t.symbol === 'XAUTUSDT' ? 'GOLD' : t.symbol;
      executorByPair.set(websitePair, t);
      // Also include the WEEX symbol form in case the watchlist uses it directly.
      executorByPair.set(t.symbol, t);
    }
  }

  const stats = await getUserPairStats(adminId).catch(() => ({}));
  const pairs = [];
  for (const coin of pairCoins) {
    const ps = sub.pairs && sub.pairs[coin];
    const execTrade = executorByPair.get(coin);
    // If the scan loop has no pendSignal but the executor knows about an
    // active trade for this pair, fall back to the executor's view so the
    // chart panel shows in-trade with SL/TP overlays.
    const hasScanSignal = !!(ps && ps.pendSignal);
    const useExecutorFallback = !hasScanSignal && !!execTrade;
    pairs.push({
      coin,
      hasSignal: hasScanSignal || useExecutorFallback,
      signal: hasScanSignal
        ? ps.pendSignal
        : (useExecutorFallback ? {
            direction: execTrade.side === 'long' ? 'LONG' : 'SHORT',
            entry: execTrade.entryPrice,
            sl: execTrade.slPrice,
            tp: execTrade.tpPrice,
            rr: null,
            confidence: null,
            recovered: !!execTrade.recovered,
          } : null),
      signalId: hasScanSignal ? ps.signalId : (useExecutorFallback ? execTrade.signalId : null),
      lastPrice: ps && ps.lastPrice != null ? ps.lastPrice : null,
      cooldownUntil: ps ? ps.cooldownUntil : 0,
      cooldownRemaining: ps ? Math.max(0, ps.cooldownUntil - Date.now()) : 0,
      pauseUntil: ps && ps.pauseUntil ? ps.pauseUntil : 0,
      pauseRemaining: ps && ps.pauseUntil ? Math.max(0, ps.pauseUntil - Date.now()) : 0,
      pauseReason: ps ? (ps.pauseReason || null) : null,
      status: hasScanSignal ? ps.lastStatus : (useExecutorFallback ? 'in-trade' : (ps ? ps.lastStatus : 'idle')),
      entryAlerted: hasScanSignal ? !!ps._entryAlerted : (useExecutorFallback && execTrade.state === 'ACTIVE'),
      beAlerted: !!(ps && ps._beAlerted),
      tpAlerted: !!(ps && ps._tpAlerted),
      awaitingConfirmation: !!(ps && ps._confirmationPending),
      stats: stats[coin] || null,
    });
  }
  res.json({ active: !!sub.active, tf: sub.tf, broker: sub.broker, pairs });
});

app.post('/api/scan/signal', requireAuth, express.json({ limit: '512kb' }), (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.status(404).json({ error: 'no_scan_session' });
  // Use signal.pair as the pair key, fall back to focused coin
  const targetCoin = (req.body?.signal?.pair) || sub.coin;
  const ps = getPairState(sub, targetCoin);
  ps.pendSignal = req.body?.signal || null;
  ps.signalId = req.body?.signalId || null;
  ps.signalTimestamp = Date.now();
  // Browser-registered (manual ANALYSE / track-on-chart) — NEVER WEEX-eligible.
  // Only the autoscan staging path (runServerAIForPair) sets _autoExec = true.
  ps._autoExec = false;
  ps._entryAlerted = false;
  ps._beAlerted = false;
  ps._tpAlerted = false;
  ps._expiryAlerted = false;
  ps._outcomeLogged = false;
  ps.lastStatus = 'waiting';
  res.json({ ok: true });
});

app.post('/api/scan/clear', requireAuth, express.json(), (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.json({ ok: true });
  const targetCoin = req.body?.coin || sub.coin;
  if (sub.pairs && sub.pairs[targetCoin]) clearPairState(sub.pairs[targetCoin]);
  res.json({ ok: true });
});

// ── helpers used by the scan loop ──
const FUTURES_SYM_SERVER = {
  BTCUSDT: 'cmt_btcusdt', ETHUSDT: 'cmt_ethusdt', SOLUSDT: 'cmt_solusdt',
};
async function getCurrentPriceServer(coin, broker) {
  try {
    if (broker === 'massive' || coin === 'GOLD' || coin === 'XAUUSD') {
      return await getGoldSpot();
    }
    if (broker === 'binance') {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${coin}`);
      const d = await r.json();
      return parseFloat(d.price) || null;
    }
    if (broker === 'hyperliquid') {
      const sym = coin.replace('USDT', '');
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      const d = await r.json();
      return parseFloat(d[sym]) || null;
    }
    // weex (default)
    const fsym = FUTURES_SYM_SERVER[coin] || ('cmt_' + coin.toLowerCase());
    const r = await fetch(`https://api-contract.weex.com/capi/v2/market/ticker?symbol=${fsym}`);
    const d = await r.json();
    return parseFloat(d.last) || null;
  } catch (e) {
    console.error('[getCurrentPrice]', e.message);
    return null;
  }
}

async function postAlertToDiscord(title, msg, color, isAdmin) {
  if (!isAdmin) return; // user requirement: only admin sessions post to Discord
  const urls = signalWebhooks().filter(Boolean); // auto channel + signals mirror
  if (!urls.length) return;
  const colorMap = { gr: 3066993, re: 15548997, am: 16750848, cy: 6535167, pu: 9699539 };
  await postJsonToWebhooks(urls, {
    username: 'Henry Auto Monitor',
    embeds: [{
      title, description: msg, color: colorMap[color] || colorMap.cy,
      footer: { text: 'Henry server-side monitor' },
      timestamp: new Date().toISOString(),
    }],
  }, 'discord auto');
}

async function notifyUser(userId, isAdmin, { title, body, color, data }) {
  await sendPushTo(userId, { title, body, icon: '/manifest.json', data: data || {} });
  // Self-heal isAdmin by checking the sub's stored email against ADMIN_EMAIL.
  // Catches the stale-sub case where sub.isAdmin was captured as false before
  // today's email-fallback patch landed.
  let effective = isAdmin;
  if (!effective) {
    const sub = scanSubscriptions.get(userId);
    if (sub && sub.email && sub.email === ADMIN_EMAIL) effective = true;
  }
  await postAlertToDiscord(title, body, color || 'cy', effective);
}

// ICT + S/D entry confirmation detector — mirror of public/index.html's
// detectICTSDConfirmation. Operates on a slice of LTF candles (1m or 5m).
// Returns { confirmed, score, hits[], summary, sideOk }.
//
// Patterns + weights (one primary 3-4 OR two secondaries weight ≥2 → confirm):
//   • LTF MSS + Displacement     primary  4
//   • FVG retest in last 6 bars  primary  3
//   • Sweep + reclaim            primary  3
//   • Engulfing                  primary  2
//   • Pin bar / hammer           primary  2
//   • Micro BOS w/ volume        secondary 2  (skipped if MSS already fired)
//   • OTE 62-79% confluence      confluence 1
//
// Side gate: last close must be on the trade-correct side of prior close.
// MIN_SCORE: 4. Confirmed = sideOk && score >= 4.
function detectICTSDConfirmationServer(candles, isLong) {
  const EMPTY = { confirmed: false, score: 0, hits: [], summary: 'no pattern', sideOk: false };
  if (!candles || candles.length < 6) return EMPTY;
  const n = candles.length;
  const last = candles[n - 1], prev = candles[n - 2];
  const lastBull = last.c > last.o, prevBull = prev.c > prev.o;
  const lastBody = Math.abs(last.c - last.o);
  const prevBody = Math.abs(prev.c - prev.o);
  const lastRange = Math.max(last.h - last.l, 1e-9);
  const upWick = last.h - Math.max(last.c, last.o);
  const dnWick = Math.min(last.c, last.o) - last.l;
  const recent = candles.slice(-Math.min(20, n));
  const ranges = recent.map(c => c.h - c.l).sort((a, b) => a - b);
  const medRange = ranges[Math.floor(ranges.length / 2)] || lastRange;
  const avgVol5 = candles.slice(-5).reduce((s, c) => s + (c.v || 0), 0) / 5 || 1;
  const hits = [];
  const add = (name, weight) => hits.push({ name, weight });

  const sideOk = isLong ? last.c >= prev.c : last.c <= prev.c;

  // 1. LTF MSS + Displacement
  const prev5 = candles.slice(-6, -1);
  const swingHi = Math.max(...prev5.map(c => c.h));
  const swingLo = Math.min(...prev5.map(c => c.l));
  const bodyPct = lastBody / lastRange;
  const rangeMul = lastRange / medRange;
  if (isLong && last.c > swingHi && bodyPct >= 0.6 && rangeMul >= 1.3) add('LTF MSS+disp', 4);
  else if (!isLong && last.c < swingLo && bodyPct >= 0.6 && rangeMul >= 1.3) add('LTF MSS+disp', 4);

  // 2. FVG retest in last 6 bars
  for (let i = n - 1; i >= Math.max(2, n - 6); i--) {
    const a = candles[i - 2], b = candles[i];
    if (isLong && a.h < b.l) {
      if (last.l <= b.l && lastBull) { add('FVG retest', 3); break; }
    } else if (!isLong && a.l > b.h) {
      if (last.h >= b.h && !lastBull) { add('FVG retest', 3); break; }
    }
  }

  // 3. Liquidity sweep + reclaim
  const prev8 = candles.slice(-9, -1);
  if (prev8.length) {
    const sLo = Math.min(...prev8.map(c => c.l));
    const sHi = Math.max(...prev8.map(c => c.h));
    if (isLong && last.l < sLo && last.c > sLo && lastBull) add('Sweep+reclaim', 3);
    else if (!isLong && last.h > sHi && last.c < sHi && !lastBull) add('Sweep+reclaim', 3);
  }

  // 4. Engulfing
  if (isLong && lastBull && !prevBull && last.c > prev.o && last.o < prev.c && lastBody > prevBody) add('Bullish engulfing', 2);
  else if (!isLong && !lastBull && prevBull && last.c < prev.o && last.o > prev.c && lastBody > prevBody) add('Bearish engulfing', 2);

  // 5. Pin bar / hammer
  if (isLong && dnWick >= 2 * lastBody && upWick < lastBody && dnWick >= 0.5 * lastRange) add('Hammer/pin', 2);
  else if (!isLong && upWick >= 2 * lastBody && dnWick < lastBody && upWick >= 0.5 * lastRange) add('Shooting star', 2);

  // 6. Micro BOS w/ volume (skip if MSS already fired)
  const hasMSS = hits.some(h => h.name === 'LTF MSS+disp');
  if (!hasMSS) {
    if (isLong && last.c > prev.h && (last.v || 0) > avgVol5 * 1.2) add('Micro BOS', 2);
    else if (!isLong && last.c < prev.l && (last.v || 0) > avgVol5 * 1.2) add('Micro BOS', 2);
  }

  // 7. OTE confluence (last 20-bar dealing range)
  const win = candles.slice(-20);
  if (win.length >= 10) {
    const hi = Math.max(...win.map(c => c.h));
    const lo = Math.min(...win.map(c => c.l));
    if (hi > lo) {
      const pos = (last.c - lo) / (hi - lo); // 0 at low, 1 at high
      if (isLong && pos >= 0.21 && pos <= 0.38) add('OTE 62-79%', 1);
      else if (!isLong && pos >= 0.62 && pos <= 0.79) add('OTE 62-79%', 1);
    }
  }

  const score = hits.reduce((s, h) => s + h.weight, 0);
  const MIN_SCORE = 4;
  const confirmed = sideOk && score >= MIN_SCORE;
  const summary = hits.length ? hits.map(h => h.name).join(' + ') : 'no pattern';
  return { confirmed, score, hits, summary, sideOk };
}

// 2-hour fallback for confirmation watch — after this, server fires ENTRY HIT
// even without a confirming pattern (so the trade isn't lost forever if the
// micro-pattern never appears). Marked as UNCONFIRMED in the alert.
const ENTRY_CONFIRM_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// Zone width ±0.3% of entry — must match browser watcher.
const ENTRY_CONFIRM_ZONE_PCT = 0.003;

// Fire the deferred signal embed + entry-hit alert. Called by the monitor
// when LTF confirmation lands (or 2h timeout) to flip a silent
// _confirmationPending signal into the user's notification stream.
async function firePendingSignalAlerts(userId, sub, coin, ps, signal, price, confirmLabel, isTimeout) {
  const isAdmin = sub.isAdmin || (sub.email && sub.email === ADMIN_EMAIL);
  const broker = ps._broker || sub.broker;
  const trigger = ps._trigger || { type: 'auto', desc: 'auto-scan trigger' };
  const tf = sub.tf;

  // 1) Rich push — same shape as the original at-AI-output push, plus the
  //    confirmation label so the user knows what fired the entry.
  const dirEmoji = signal.direction === 'LONG' ? '🟢' : '🔴';
  const tag = isTimeout ? ' (UNCONFIRMED)' : '';
  await sendPushTo(userId, {
    title: `⚡ ${dirEmoji} ${coin.replace('USDT', '')} ${signal.direction}${tag}`,
    body: `Entry ${signal.entry} hit @ ${price} | SL ${signal.sl} | TP ${signal.tp} | ${signal.rr || '—'}R · ${confirmLabel}`,
    icon: '/manifest.json',
    data: { coin, tf, broker, signalId: ps.signalId, signal },
  });

  // 2) Full Discord signal embed (the one that was suppressed at AI-output)
  if (isAdmin) {
    const annotatedSignal = isTimeout
      ? Object.assign({}, signal, { entry_reason: (signal.entry_reason || '') + ' | UNCONFIRMED — fired on 2h timeout, no LTF pattern' })
      : Object.assign({}, signal, { entry_reason: (signal.entry_reason || '') + ' | CONFIRMED: ' + confirmLabel });
    await postServerSignalToDiscord(annotatedSignal, trigger, broker, tf)
      .catch(e => console.error('[discord auto deferred]', e.message));
  }

  // 3) Plain ENTRY HIT alert (push + Discord auto-monitor embed) so the
  //    journal channel and phone get the explicit "trade is now active" line.
  await notifyUser(userId, isAdmin, {
    title: `🎯 ENTRY HIT${tag}: ${coin.replace('USDT', '')} ${signal.direction}`,
    body: isTimeout
      ? `Entry @ ${price}. 2h watch elapsed without LTF pattern — trade ACTIVE as unconfirmed.`
      : `Entry filled @ ${price} — confirmed by ${confirmLabel}. Trade is now ACTIVE.`,
    color: isTimeout ? 'am' : 'cy',
  });

  // Clear the pending flag so we don't double-fire on subsequent monitor ticks
  ps._confirmationPending = false;
}

async function runServerTradeMonitorForPair(userId, sub, coin, ps, brokerOverride) {
  const { tf, isAdmin } = sub;
  // Route to the pair's appropriate broker (GOLD → massive, others → user choice)
  const broker = brokerOverride || brokerForPair(coin, sub.broker);
  const { pendSignal } = ps;
  const price = await getCurrentPriceServer(coin, broker);
  if (!price) return;
  ps.lastPrice = price;
  const e = parseFloat(pendSignal.entry), slP = parseFloat(pendSignal.sl), tpP = parseFloat(pendSignal.tp);
  const isLong = pendSignal.direction === 'LONG';

  // ── Wick-aware extremes since the last monitor tick ──
  // Point-in-time price polling misses brief wicks that touch TP/SL/BE and
  // revert before the next 30s poll. We pull the most recent 1m candles
  // (cheap) and use their high/low alongside the current price so a wick
  // that closes the trade in real time still registers server-side.
  // recentHigh = effective high since ~2 minutes ago including current tick.
  // recentLow  = effective low  since ~2 minutes ago including current tick.
  let recentHigh = price, recentLow = price;
  if (ps._entryAlerted) {
    try {
      const recent = await fetchCandlesServer(coin, '1m', 3, broker);
      if (Array.isArray(recent) && recent.length) {
        for (const c of recent) {
          if (c.h > recentHigh) recentHigh = c.h;
          if (c.l < recentLow)  recentLow  = c.l;
        }
      }
    } catch { /* fall back to point-in-time price */ }
  }

  // ── Entry confirmation gate (ICT/S&D micro-patterns on 1m+5m) ──
  // Gold (Polygon/massive) goes through the same gate as crypto — Polygon's
  // aggregates API exposes 1m + 5m for C:XAUUSD natively (see POLY_TF), and
  // fetchCandlesServer routes that through transparently.
  // Bypassed only when pendSignal._confirmed === true (browser already
  // ran the watcher before POSTing the signal).
  // Otherwise: wait until price enters ±0.3% of entry, then on each tick
  // pull 1m+5m candles and only fire ENTRY HIT when detector confirms.
  // After ENTRY_CONFIRM_TIMEOUT_MS (2h) inside zone, fire as UNCONFIRMED so
  // we never miss the trade if the pattern doesn't print.
  if (!ps._entryAlerted) {
    const zoneTop = e * (1 + ENTRY_CONFIRM_ZONE_PCT);
    const zoneBot = e * (1 - ENTRY_CONFIRM_ZONE_PCT);
    const inZone = price >= zoneBot && price <= zoneTop;
    const browserConfirmed = pendSignal && pendSignal._confirmed === true;

    // Touched-entry without zone (price overshot directly).
    const touchedEntry = isLong ? price <= e : price >= e;

    if (browserConfirmed) {
      // Bypass path — browser already confirmed; just wait for price-touch.
      if (touchedEntry) {
        await _confirmAndExecuteSignal(userId, sub, ps, coin, price, 'browser-confirmed');
      }
    } else if (inZone || touchedEntry) {
      if (!ps._zoneFirstTouchAt) ps._zoneFirstTouchAt = Date.now();
      const elapsed = Date.now() - ps._zoneFirstTouchAt;

      // Throttle confirmation checks: at most once per 60s per pair, since
      // 1m candles only update every 60s anyway.
      const now = Date.now();
      const okToCheck = now - (ps._confirmFailedAt || 0) >= 60_000;

      if (okToCheck) {
        ps._confirmAttempts = (ps._confirmAttempts || 0) + 1;
        const [c1m, c5m] = await Promise.all([
          fetchCandlesServer(coin, '1m', 30, broker).catch(() => []),
          fetchCandlesServer(coin, '5m', 30, broker).catch(() => []),
        ]);
        const r1m = detectICTSDConfirmationServer(c1m, isLong);
        const r5m = detectICTSDConfirmationServer(c5m, isLong);
        const picked = r1m.confirmed ? { r: r1m, tf: '1m' } : (r5m.confirmed ? { r: r5m, tf: '5m' } : null);

        if (picked) {
          const label = `${picked.r.summary} (score ${picked.r.score}, ${picked.tf})`;
          console.log('[entry-confirm]', coin, 'CONFIRMED:', label, 'price=' + price);
          await _confirmAndExecuteSignal(userId, sub, ps, coin, price, label);
        } else if (elapsed >= ENTRY_CONFIRM_TIMEOUT_MS) {
          // 2h timeout — confirm-then-execute flow drops the signal (no order
          // ever placed, so nothing to manage). Avoids forcing an unconfirmed
          // entry at a price that may have drifted past the AI's planned RR.
          ps._expiryAlerted = true;
          console.log('[entry-confirm]', coin, 'TIMEOUT — dropping signal', 'attempts=' + ps._confirmAttempts);
          await notifyUser(userId, isAdmin, {
            title: `⏱ Signal expired: ${coin.replace('USDT', '')}`,
            body: `No LTF confirmation within 2h. Signal dropped (no order placed).`,
            color: 'am',
          });
          clearPairState(ps);
        } else {
          ps._confirmFailedAt = now;
          ps.lastStatus = 'waiting'; // still watching for confirmation
          // Quiet log so we can debug in Railway logs without spamming Discord
          console.log('[entry-confirm]', coin, 'waiting',
            `1m[${r1m.score}]:${r1m.summary} | 5m[${r5m.score}]:${r5m.summary}`,
            'elapsed=' + Math.round(elapsed / 1000) + 's');
        }
      }
    }
  }

  // WEEX auto-trade hook 2/6: legacy entry-hit path. In the confirm-then-execute
  // flow this is a no-op (_confirmAndExecuteSignal sets _weexEntryFired=true
  // before firing handleSetup at MARKET). Kept for safety in case some code
  // path flips _entryAlerted without going through _confirmAndExecuteSignal
  // (e.g. browser-side scan_signal endpoint with a different state machine).
  if (ps._entryAlerted && !ps._weexEntryFired && autoTradeAllowed(isAdmin) && ps._autoExec && ps.signalId) {
    ps._weexEntryFired = true;
    fireExecutor('handleEntryHit', { signalId: ps.signalId, fillPrice: price }, 'entryHit');
  }

  // Pre-NY-open SL→BE protection. If we're in the 5min window before NY equity
  // open (12:55-13:00 UTC) and the trade is currently in profit, force-move
  // SL to BE regardless of the normal BE_TRIGGER_PCT threshold. Trades that
  // get swept at NY open recover ~46% of the time per analyze_ny_sweep.py.
  if (ps._entryAlerted && !ps._beAlerted && !ps._preNyBeFired) {
    const now = new Date();
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inPreNyWindow = utcMin >= PRE_NY_BE_WINDOW_START_MIN && utcMin < PRE_NY_BE_WINDOW_END_MIN;
    const inProfit = isLong ? price > e : price < e;
    if (inPreNyWindow && inProfit) {
      ps._preNyBeFired = true;
      ps._beAlerted = true;
      console.log('[pre-ny BE]', coin, ps.pendSignal.direction, 'in profit at', price, 'before NY open — moving SL to', e);
      await notifyUser(userId, isAdmin, {
        title: '⚡ PRE-NY SL→BE',
        body: `${coin.replace('USDT', '')} in profit before NY open — moving SL to ${e} to survive the sweep window.`,
        color: 'am',
      });
      if (!ps._weexBeFired && autoTradeAllowed(isAdmin) && ps._autoExec && ps.signalId) {
        ps._weexBeFired = true;
        fireExecutor('handleMoveSlBe', { signalId: ps.signalId, newSl: e }, 'moveSlBe-preNY');
      }
    }
  }

  // BE — uses recentHigh (LONG) / recentLow (SHORT) so a wick that briefly
  // tags the BE level between polls still fires the alert.
  if (ps._entryAlerted && !ps._beAlerted) {
    const bePrice = isLong ? e + (tpP - e) * BE_TRIGGER_PCT : e - (e - tpP) * BE_TRIGGER_PCT;
    const beReached = isLong ? recentHigh >= bePrice : recentLow <= bePrice;
    if (beReached) {
      ps._beAlerted = true;
      await notifyUser(userId, isAdmin, {
        title: '⚑ MOVE SL TO BREAKEVEN',
        body: `${coin.replace('USDT', '')} reached BE @ ${(isLong ? recentHigh : recentLow).toFixed(2)}. Move SL to ${e}.`,
        color: 'am',
      });
      // WEEX auto-trade hook 3/6: move SL on WEEX to entry, fee-buffered.
      if (!ps._weexBeFired && autoTradeAllowed(isAdmin) && ps._autoExec && ps.signalId) {
        ps._weexBeFired = true;
        fireExecutor('handleMoveSlBe', { signalId: ps.signalId, newSl: e }, 'moveSlBe');
      }
    }
  }

  // TP — wick-aware: triggers on either current price OR any recent 1m
  // candle high/low crossing TP. Fixes the "browser saw TP, server didn't"
  // race where price wicks through TP between 30s polls.
  if (ps._entryAlerted && !ps._tpAlerted) {
    const tpHit = isLong ? recentHigh >= tpP : recentLow <= tpP;
    if (tpHit) {
      ps._tpAlerted = true;
      const tpPrice = isLong ? Math.max(price, recentHigh) : Math.min(price, recentLow);
      console.log('[monitor]', coin, 'TP hit at', tpPrice, '(price=' + price + ', wickExt=' + (isLong ? recentHigh : recentLow) + ')', 'signalId=' + ps.signalId);
      await notifyUser(userId, isAdmin, {
        title: `🎯 TP REACHED: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
        body: `Take profit hit @ ${tpPrice.toFixed(2)}. Logged.`,
        color: 'gr',
      });
      if (!ps._outcomeLogged) {
        ps._outcomeLogged = true;
        // Pass in-memory signal as fallback so journal still posts if DB row is missing
        await logSignalOutcomeAndJournal(userId, ps.signalId, 'TP', parseFloat(pendSignal.rr) || 2, pendSignal, broker, tf)
          .catch(e => console.error('[server TP outcome]', e.message));
      }
      // WEEX auto-trade hook 4/6: record TP closure (WEEX TP plan already closed the position).
      if (!ps._weexClosed && autoTradeAllowed(isAdmin) && ps._autoExec && ps.signalId) {
        ps._weexClosed = true;
        fireExecutor('handleTpHit', { signalId: ps.signalId, exitPrice: tpPrice }, 'tpHit');
      }
      clearPairState(ps);
      return;
    }
  }

  // SL hit — original stop-loss breached.
  // GATED on _entryAlerted (matching the TP/BE blocks above): a signal that
  // never confirmed entry must NEVER log a realized SL loss. Before entry the
  // "SL" level is just a planned marker, not a stop on a live position — so we
  // do nothing here when unconfirmed. Whether a never-entered setup is still
  // valid is left to the LTF confirmation gate; if it never confirms it drops
  // via the 2h confirm-timeout or the expiry path below, not a mechanical
  // price-touched-SL rule.
  if (ps._entryAlerted) {
    // SL — wick-aware. Uses recentLow (LONG) / recentHigh (SHORT) so a wick
    // through SL between polls still closes the trade.
    const slHit = isLong ? recentLow <= slP : recentHigh >= slP;
    // BE-stop hit — fires when:
    //   • BE alert already fired (user should have moved SL to entry)
    //   • Price returned to entry (LONG: cp <= e; SHORT: cp >= e)
    //   • Price hasn't yet reached original SL (otherwise slHit handles it)
    // Wick-aware so a fast revisit of entry between polls still closes BE.
    const beStopHit = ps._beAlerted && (isLong
      ? (recentLow <= e && recentLow > slP)
      : (recentHigh >= e && recentHigh < slP));
    if (slHit || beStopHit) {
      const wasBE = ps._beAlerted; // true if BE-stop OR (slHit while _beAlerted is set)
      const reason = beStopHit ? 'BE-stop' : (wasBE ? 'SL-after-BE' : 'SL');
      const slPrice = beStopHit
        ? (isLong ? Math.min(price, recentLow) : Math.max(price, recentHigh))
        : (isLong ? Math.min(price, recentLow) : Math.max(price, recentHigh));
      console.log('[monitor]', coin, reason, 'hit at', slPrice, '(price=' + price + ', wickExt=' + (isLong ? recentLow : recentHigh) + ')', 'signalId=' + ps.signalId);
      if (!ps._outcomeLogged) {
        ps._outcomeLogged = true;
        await logSignalOutcomeAndJournal(userId, ps.signalId, wasBE ? 'BE' : 'SL', wasBE ? 0 : -1, pendSignal, broker, tf)
          .catch(e => console.error('[server SL outcome]', e.message));
      }
      await notifyUser(userId, isAdmin, {
        title: `${wasBE ? '⚑ STOPPED AT BE' : '🛑 SL HIT'}: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
        body: `${wasBE ? 'Closed at breakeven' : 'Stop loss breached'} @ ${slPrice.toFixed(2)}. Logged automatically.`,
        color: wasBE ? 'am' : 're',
      });
      // WEEX auto-trade hook 5/6: record SL/BE closure (WEEX plan already closed it).
      if (!ps._weexClosed && autoTradeAllowed(isAdmin) && ps._autoExec && ps.signalId) {
        ps._weexClosed = true;
        fireExecutor('handleSlHit', { signalId: ps.signalId, exitPrice: slPrice }, 'slHit');
      }
      clearPairState(ps);
      return;
    }
  }

  // Expiry — only if entry never hit, fires once, clears the trade.
  // Also logs the signal as outcome='EXPIRED' (rr=0) so /performance and the
  // journal show the full picture. Without this, signals that fire but never
  // pull back to entry stay as outcome=NULL in the DB and silently vanish
  // from stats — common on BTC when AI gives pullback-limit entries that
  // don't fill within the expiry window.
  if (!ps._entryAlerted && !ps._expiryAlerted && pendSignal.expiry_candles) {
    const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
    const maxMs = pendSignal.expiry_candles * (tfMs[tf] || 900000);
    if (Date.now() - ps.signalTimestamp > maxMs) {
      ps._expiryAlerted = true;
      console.log('[monitor]', coin, 'EXPIRED (never entered)', 'signalId=' + ps.signalId);
      await notifyUser(userId, isAdmin, {
        title: '⏱ SIGNAL EXPIRED',
        body: `Cancel limit order — ${coin.replace('USDT', '')} signal expired after ${pendSignal.expiry_candles} candles (no entry).`,
        color: 'am',
      });
      if (!ps._outcomeLogged) {
        ps._outcomeLogged = true;
        // Record EXPIRED outcome so /performance reflects it and the journal
        // posts a per-pair stat update. rr=0 (no entry → no P/L).
        await logSignalOutcomeAndJournal(userId, ps.signalId, 'EXPIRED', 0, pendSignal, broker, tf)
          .catch(e => console.error('[server EXPIRED outcome]', e.message));
      }
      // WEEX auto-trade hook 6/6: cancel the unfilled entry + SL/TP plans.
      if (!ps._weexClosed && autoTradeAllowed(isAdmin) && ps._autoExec && ps.signalId) {
        ps._weexClosed = true;
        fireExecutor('handleExpired', { signalId: ps.signalId }, 'expired');
      }
      clearPairState(ps);
    }
  }
}

// Lightweight server-side trigger detection — close-vs-prev-high/low scan.
// Browser does the heavy multi-source analysis; server only flags candidates worth investigating.
async function fetchCandlesServer(coin, tf, limit, broker) {
  try {
    if (broker === 'massive' || coin === 'GOLD' || coin === 'XAUUSD') {
      // Use Binance spot PAXG/USDT — Polygon's gold aggregates were both
      // sparse (only 24 bars vs the requested 80) and stale (last bar 14h
      // behind real-time). PAXG is tokenised gold trading on Binance with
      // full intraday depth and real-time bars. Tracks XAUUSD within ~$5.
      const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };
      const interval = tfMap[tf] || '15m';
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${limit}`);
      if (!r.ok) {
        console.warn('[fetchCandlesServer] PAXG fetch failed:', coin, tf, r.status);
        return [];
      }
      const arr = await r.json();
      if (!Array.isArray(arr)) return [];
      return arr.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
    }
    if (broker === 'binance') {
      // Binance intermittently 451-geo-blocks Railway egress IPs. If the direct
      // fetch returns empty or non-array, fall back to WEEX with the same symbol
      // so the chart and heatmap still render. Same coin format on both
      // (USDT-perp) so price tracks within ~1 bps.
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin}&interval=${tf}&limit=${limit}`);
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length) {
            return arr.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
          }
          console.warn('[fetchCandlesServer] binance empty/non-array → weex fallback', coin, tf);
        } else {
          console.warn('[fetchCandlesServer] binance', r.status, '→ weex fallback', coin, tf);
        }
      } catch (e) {
        console.warn('[fetchCandlesServer] binance threw → weex fallback', coin, e.message);
      }
      // Fall through to WEEX path below (same code as broker === 'weex')
    }
    // WEEX path — they changed the API: granularity takes string suffixes
    // ("15m" instead of "900") and timestamps come back in MILLISECONDS.
    // Two endpoints exist: `historyCandles` is the modern path and returns
    // data for the most pairs; `candles` is the legacy fallback that has
    // started returning empty/non-array for some symbols. Try modern first,
    // fall through to legacy, then to Hyperliquid as last resort so the
    // chart never goes blank when Binance is geo-blocked.
    const fsym = FUTURES_SYM_SERVER[coin] || ('cmt_' + coin.toLowerCase());
    const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '12h': '12h', '1d': '1d', '1w': '1w' };
    const gran = tfMap[tf] || '15m';
    const weexUrls = [
      `https://api-contract.weex.com/capi/v2/market/historyCandles?symbol=${fsym}&granularity=${gran}&limit=${limit}`,
      `https://api-contract.weex.com/capi/v2/market/candles?symbol=${fsym}&granularity=${gran}&limit=${limit}`,
    ];
    for (const u of weexUrls) {
      try {
        const r = await fetch(u);
        if (!r.ok) {
          console.warn('[fetchCandlesServer] weex', r.status, u.split('?')[0].split('/').pop(), coin);
          continue;
        }
        const raw = await r.json();
        if (Array.isArray(raw) && raw.length) {
          return raw.map(c => {
            const t = +c[0];
            return { t: t > 1e12 ? t : t * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] };
          });
        }
        console.warn('[fetchCandlesServer] weex non-array/empty:', coin, gran, u.split('?')[0].split('/').pop(), Array.isArray(raw) ? `len=${raw.length}` : JSON.stringify(raw).slice(0, 120));
      } catch (e) {
        console.warn('[fetchCandlesServer] weex threw:', coin, u.split('?')[0].split('/').pop(), e.message);
      }
    }
    // Last-resort fallback: Hyperliquid public API. Works from any IP. Coin
    // format is the bare symbol (BTC, ETH, SOL …) without USDT.
    try {
      const hlSym = coin.replace('USDT', '').replace(/^1000/, 'k'); // kPEPE etc.
      const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
      const ms = tfMs[tf] || 900000;
      const start = Date.now() - ms * limit * 1.1;
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin: hlSym, interval: tf, startTime: start, endTime: Date.now() } }),
      });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) {
          console.log('[fetchCandlesServer] hl rescue', coin, tf, `len=${arr.length}`);
          return arr.map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
        }
      }
    } catch (e) {
      console.warn('[fetchCandlesServer] hl rescue threw:', coin, e.message);
    }
    console.error('[fetchCandlesServer] all sources failed for', coin, tf, 'original broker:', broker);
    return [];
  } catch (e) {
    console.error('[fetchCandlesServer]', e.message);
    return [];
  }
}

// ── Individual trigger detectors (all return null if condition not met) ──

// 1. BOS — Break of Structure (close exceeds recent 10-bar range)
function _detectBOS(candles) {
  const last = candles[candles.length - 1];
  const recent = candles.slice(-11, -1);
  const maxH = Math.max(...recent.map(c => c.h));
  const minL = Math.min(...recent.map(c => c.l));
  if (last.c > maxH) return { type: 'bos', desc: `BOS up — close ${last.c} > prev high ${maxH.toFixed(2)}` };
  if (last.c < minL) return { type: 'bos', desc: `BOS down — close ${last.c} < prev low ${minL.toFixed(2)}` };
  return null;
}

// 2. Sweep — wick beyond range but close back inside (liquidity grab)
function _detectSweep(candles) {
  const last = candles[candles.length - 1];
  const recent = candles.slice(-11, -1);
  const maxH = Math.max(...recent.map(c => c.h));
  const minL = Math.min(...recent.map(c => c.l));
  if (last.h > maxH && last.c < maxH) return { type: 'sweep', desc: `Sweep high — wick ${last.h.toFixed(2)} swept ${maxH.toFixed(2)}, closed back inside` };
  if (last.l < minL && last.c > minL) return { type: 'sweep', desc: `Sweep low — wick ${last.l.toFixed(2)} swept ${minL.toFixed(2)}, closed back inside` };
  return null;
}

// 3. Rejection — long wick (>65% of range) + close opposite + 1.2× volume
function _detectRejection(candles) {
  if (candles.length < 11) return null;
  const last = candles[candles.length - 1];
  const range = last.h - last.l;
  if (range <= 0) return null;
  const bodyTop = Math.max(last.o, last.c);
  const bodyBot = Math.min(last.o, last.c);
  const upperWick = last.h - bodyTop;
  const lowerWick = bodyBot - last.l;
  const avgVol = candles.slice(-11, -1).reduce((s, c) => s + (c.v || 0), 0) / 10;
  if (avgVol > 0 && (last.v || 0) < avgVol * 1.2) return null; // volume confirmation

  // Bullish rejection: long lower wick (sellers rejected), close higher
  if (lowerWick / range > 0.65 && last.c > last.o) {
    const wickPct = Math.round(lowerWick / range * 100);
    return { type: 'rejection', desc: `Bullish rejection wick @ ${last.l.toFixed(4)} (${wickPct}% wick)` };
  }
  // Bearish rejection: long upper wick (buyers rejected), close lower
  if (upperWick / range > 0.65 && last.c < last.o) {
    const wickPct = Math.round(upperWick / range * 100);
    return { type: 'rejection', desc: `Bearish rejection wick @ ${last.h.toFixed(4)} (${wickPct}% wick)` };
  }
  return null;
}

// 4. ATR Expansion — recent volatility >1.5× prior. Direction inferred from trend.
function _detectATRExpansion(candles) {
  if (candles.length < 30) return null;
  const recentATR = computeATR(candles.slice(-15), 14);
  const priorATR = computeATR(candles.slice(-30, -15), 14);
  if (!recentATR || !priorATR) return null;
  const ratio = recentATR / priorATR;
  if (ratio < 1.5) return null;
  // Direction from recent 10-candle close trend
  const slice = candles.slice(-10);
  const first = slice[0].c, last = slice[slice.length - 1].c;
  const dir = last > first ? 'up' : 'down';
  return { type: 'atr', desc: `ATR expansion ${ratio.toFixed(2)}x — momentum ${dir}` };
}

// 5. FVG — current price has entered an unfilled fair value gap
function _detectFVG(candles) {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const cp = last.c;
  // Walk backwards from candle[i-2] looking for 3-candle FVG patterns
  // up to 20 candles back. FVG = gap between candle[i-2].h/l and candle[i].l/h
  const lookback = Math.min(candles.length - 2, 20);
  for (let i = candles.length - 2; i >= candles.length - lookback - 1; i--) {
    if (i < 1) break;
    const c0 = candles[i - 1];
    const c2 = candles[i + 1];
    if (!c0 || !c2) continue;
    // Bullish FVG: c2.l > c0.h (gap upward); price re-enters from above
    if (c2.l > c0.h) {
      const top = c2.l, bot = c0.h;
      if (cp >= bot && cp <= top) {
        return { type: 'fvg', desc: `Bullish FVG entry zone ${bot.toFixed(4)}-${top.toFixed(4)}` };
      }
    }
    // Bearish FVG: c2.h < c0.l (gap downward); price re-enters from below
    if (c2.h < c0.l) {
      const top = c0.l, bot = c2.h;
      if (cp >= bot && cp <= top) {
        return { type: 'fvg', desc: `Bearish FVG entry zone ${bot.toFixed(4)}-${top.toFixed(4)}` };
      }
    }
  }
  return null;
}

// Main trigger dispatcher — tries detectors in priority order
//   bos > sweep > rejection > atr > fvg
// ── ICT / SUPPLY-DEMAND DETECTORS ─────────────────────────────────────────
// Higher-conviction patterns. Fire less often than BOS/sweep but with much
// stronger institutional setups (order blocks, S&D zones, displacement, OTE).

// 1. MSS + Displacement — refined BOS. Requires:
//   • Close exceeds 10-bar range (break of structure)
//   • Strong displacement: candle body >= 60% of range, in direction of break
//   • Volume >= 1.5× the 10-bar avg (institutional confirmation)
function _detectMSSDisplacement(candles) {
  if (candles.length < 12) return null;
  const last = candles[candles.length - 1];
  const recent = candles.slice(-11, -1);
  const maxH = Math.max(...recent.map(c => c.h));
  const minL = Math.min(...recent.map(c => c.l));
  const range = last.h - last.l;
  if (range <= 0) return null;
  const body = Math.abs(last.c - last.o);
  const bodyPct = body / range;
  const avgVol = recent.reduce((s, c) => s + (c.v || 0), 0) / 10;
  // Volume gating only applies when volume data is real (exchange-traded).
  // Polygon's spot-gold/forex/oil aggregates return v=0 — for those pairs we
  // fall back to range-displacement as the strength proxy: the last candle's
  // range must be >= 1.4× the 10-bar average range to qualify as displacement.
  let strengthOk;
  if (avgVol > 0) {
    strengthOk = (last.v || 0) > avgVol * 1.5;
  } else {
    const avgRange = recent.reduce((s, c) => s + Math.max(c.h - c.l, 0), 0) / 10;
    strengthOk = avgRange > 0 && range >= avgRange * 1.4;
  }
  if (!strengthOk || bodyPct < 0.6) return null;

  const volTag = avgVol > 0 ? `, vol ${(last.v / avgVol).toFixed(1)}x` : ', range-disp';
  if (last.c > maxH && last.c > last.o) {
    return { type: 'mss_disp', desc: `Bullish MSS+displacement — close ${last.c.toFixed(4)} > prev high ${maxH.toFixed(4)} (body ${Math.round(bodyPct * 100)}%${volTag})` };
  }
  if (last.c < minL && last.c < last.o) {
    return { type: 'mss_disp', desc: `Bearish MSS+displacement — close ${last.c.toFixed(4)} < prev low ${minL.toFixed(4)} (body ${Math.round(bodyPct * 100)}%${volTag})` };
  }
  return null;
}

// 2. Liquidity Sweep + Displacement — refined sweep. Requires:
//   • Wick beyond 10-bar high/low (liquidity grab)
//   • Close back inside the range
//   • Body sits in upper/lower 40% (strong rejection back)
//   • Volume >= 1.2× avg
function _detectSweepDisplacement(candles) {
  if (candles.length < 12) return null;
  const last = candles[candles.length - 1];
  const recent = candles.slice(-11, -1);
  const maxH = Math.max(...recent.map(c => c.h));
  const minL = Math.min(...recent.map(c => c.l));
  const range = last.h - last.l;
  if (range <= 0) return null;
  const avgVol = recent.reduce((s, c) => s + (c.v || 0), 0) / 10;
  // Volume gating only when volume is real. For synthetic-volume pairs
  // (Polygon spot gold/forex/oil → v=0), use range-displacement as the proxy.
  let volOk;
  if (avgVol > 0) {
    volOk = (last.v || 0) > avgVol * 1.2;
  } else {
    const avgRange = recent.reduce((s, c) => s + Math.max(c.h - c.l, 0), 0) / 10;
    volOk = avgRange > 0 && range >= avgRange * 1.2;
  }
  if (!volOk) return null;

  // Bullish: wick below range, close in upper 60% of bar
  if (last.l < minL && last.c > minL) {
    const closePosition = (last.c - last.l) / range;
    if (closePosition >= 0.6) {
      return { type: 'sweep_disp', desc: `Bullish sweep+displacement — wick ${last.l.toFixed(4)} swept ${minL.toFixed(4)}, close in upper ${Math.round(closePosition * 100)}%` };
    }
  }
  // Bearish: wick above range, close in lower 60% of bar
  if (last.h > maxH && last.c < maxH) {
    const closePosition = (last.h - last.c) / range;
    if (closePosition >= 0.6) {
      return { type: 'sweep_disp', desc: `Bearish sweep+displacement — wick ${last.h.toFixed(4)} swept ${maxH.toFixed(4)}, close in lower ${Math.round(closePosition * 100)}%` };
    }
  }
  return null;
}

// 3. Order Block Mitigation — institutional pattern.
//   • Find last opposite-color candle before strong displacement (3+ candles in trend dir, total move ≥ 1.5× OB range)
//   • OB must NOT have been mitigated by intervening candles
//   • Current candle must be retesting the OB's range
function _detectOrderBlock(candles) {
  if (candles.length < 30) return null;
  const last = candles[candles.length - 1];
  // Search candles 5-25 bars back for OBs
  for (let i = candles.length - 25; i <= candles.length - 5; i++) {
    if (i < 0) continue;
    const ob = candles[i];
    const next = candles.slice(i + 1, Math.min(i + 5, candles.length));
    if (next.length < 3) continue;
    const obRange = ob.h - ob.l;
    if (obRange <= 0) continue;

    const isRed = ob.c < ob.o;
    const isGreen = ob.c > ob.o;

    // Bullish OB: red candle followed by strong up move
    if (isRed) {
      const moveUp = Math.max(...next.map(c => c.h)) - ob.l;
      if (moveUp > obRange * 1.5) {
        const obTop = ob.h;
        const obBot = ob.l;
        // Check OB hasn't been mitigated yet (price hasn't dipped into OB range since formation, excluding current candle)
        const intervening = candles.slice(i + 1, candles.length - 1);
        const wasMitigated = intervening.some(c => c.l <= obTop && c.l > obBot && c.h > obTop);
        if (wasMitigated) continue;
        // Current candle testing the OB
        if (last.l <= obTop && last.l >= obBot) {
          return {
            type: 'ob_mitigation',
            desc: `Bullish OB mitigation @ ${obBot.toFixed(4)}-${obTop.toFixed(4)} (formed ${candles.length - 1 - i} bars ago)`,
          };
        }
      }
    }
    // Bearish OB: green candle followed by strong down move
    if (isGreen) {
      const moveDown = ob.h - Math.min(...next.map(c => c.l));
      if (moveDown > obRange * 1.5) {
        const obTop = ob.h;
        const obBot = ob.l;
        const intervening = candles.slice(i + 1, candles.length - 1);
        const wasMitigated = intervening.some(c => c.h >= obBot && c.h < obTop && c.l < obBot);
        if (wasMitigated) continue;
        if (last.h >= obBot && last.h <= obTop) {
          return {
            type: 'ob_mitigation',
            desc: `Bearish OB mitigation @ ${obBot.toFixed(4)}-${obTop.toFixed(4)} (formed ${candles.length - 1 - i} bars ago)`,
          };
        }
      }
    }
  }
  return null;
}

// 4. Supply/Demand Zone Retest — classic pattern.
//   • Base: 3-5 tight candles within a small range (≤1.5× the prior candle avg range)
//   • Followed by strong move out (≥ 1.5× base range, in 3-4 candles)
//   • Has not been retested yet (first touch)
//   • Current candle is testing the base
function _detectSDZone(candles) {
  if (candles.length < 30) return null;
  const last = candles[candles.length - 1];
  for (let i = candles.length - 25; i <= candles.length - 8; i++) {
    if (i < 5) continue;
    for (let baseSize = 3; baseSize <= 5; baseSize++) {
      const baseEnd = i + baseSize;
      if (baseEnd >= candles.length - 3) break;
      const base = candles.slice(i, baseEnd);
      const baseHigh = Math.max(...base.map(c => c.h));
      const baseLow = Math.min(...base.map(c => c.l));
      const baseRange = baseHigh - baseLow;
      if (baseRange <= 0) continue;
      const surroundingAvg = candles.slice(Math.max(0, i - 5), i).reduce((s, c) => s + (c.h - c.l), 0) / 5;
      if (surroundingAvg > 0 && baseRange > surroundingAvg * 1.5) continue; // base must be tighter than surroundings

      const afterBase = candles.slice(baseEnd, Math.min(baseEnd + 4, candles.length - 1));
      if (afterBase.length < 3) continue;
      const moveUp = Math.max(...afterBase.map(c => c.h)) - baseHigh;
      const moveDown = baseLow - Math.min(...afterBase.map(c => c.l));

      // Demand zone (rally out of base)
      if (moveUp > baseRange * 1.5 && moveUp > moveDown) {
        const intervening = candles.slice(baseEnd + 4, candles.length - 1);
        const wasRetested = intervening.some(c => c.l <= baseHigh && c.l >= baseLow);
        if (wasRetested) continue;
        if (last.l <= baseHigh && last.l >= baseLow * 0.998) {
          return { type: 'sd_zone', desc: `Demand zone retest @ ${baseLow.toFixed(4)}-${baseHigh.toFixed(4)} (${baseSize}-candle base)` };
        }
      }
      // Supply zone (drop out of base)
      if (moveDown > baseRange * 1.5 && moveDown > moveUp) {
        const intervening = candles.slice(baseEnd + 4, candles.length - 1);
        const wasRetested = intervening.some(c => c.h >= baseLow && c.h <= baseHigh);
        if (wasRetested) continue;
        if (last.h >= baseLow && last.h <= baseHigh * 1.002) {
          return { type: 'sd_zone', desc: `Supply zone retest @ ${baseLow.toFixed(4)}-${baseHigh.toFixed(4)} (${baseSize}-candle base)` };
        }
      }
    }
  }
  return null;
}

// 5. FVG in OTE Zone — Optimal Trade Entry confluence.
//   • Find unfilled FVGs in last 20 candles
//   • Compute swing high/low of last 30 candles
//   • OTE zone for LONG = 62-79% retracement from swing high (in discount)
//   • OTE zone for SHORT = 62-79% retracement from swing low (in premium)
//   • FVG midpoint must sit in the OTE zone, AND current price must be in the FVG
function _detectFVGInOTE(candles) {
  if (candles.length < 30) return null;
  const last = candles[candles.length - 1];
  const cp = last.c;
  const window = candles.slice(-30);
  const swingHigh = Math.max(...window.map(c => c.h));
  const swingLow = Math.min(...window.map(c => c.l));
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  // OTE zones (62-79% retracement of the leg)
  const oteBotLong = swingHigh - range * 0.79;
  const oteTopLong = swingHigh - range * 0.62;
  const oteBotShort = swingLow + range * 0.62;
  const oteTopShort = swingLow + range * 0.79;

  for (let i = candles.length - 22; i < candles.length - 1; i++) {
    if (i < 1) continue;
    const c0 = candles[i - 1];
    const c2 = candles[i + 1];
    if (!c0 || !c2) continue;

    // Bullish FVG (gap up): c2.l > c0.h
    if (c2.l > c0.h) {
      const fvgTop = c2.l, fvgBot = c0.h;
      const fvgMid = (fvgTop + fvgBot) / 2;
      // Must be in long OTE zone (discount)
      if (fvgMid >= oteBotLong && fvgMid <= oteTopLong) {
        // Check current price is in the FVG
        if (cp >= fvgBot && cp <= fvgTop) {
          // Check FVG hasn't been filled yet (no candle between i+1 and now closed below fvgBot)
          const intervening = candles.slice(i + 2, candles.length - 1);
          const filled = intervening.some(c => c.l < fvgBot);
          if (filled) continue;
          return { type: 'fvg_ote', desc: `Bullish FVG-in-OTE @ ${fvgBot.toFixed(4)}-${fvgTop.toFixed(4)} (62-79% retrace zone)` };
        }
      }
    }
    // Bearish FVG (gap down): c2.h < c0.l
    if (c2.h < c0.l) {
      const fvgTop = c0.l, fvgBot = c2.h;
      const fvgMid = (fvgTop + fvgBot) / 2;
      if (fvgMid >= oteBotShort && fvgMid <= oteTopShort) {
        if (cp >= fvgBot && cp <= fvgTop) {
          const intervening = candles.slice(i + 2, candles.length - 1);
          const filled = intervening.some(c => c.h > fvgTop);
          if (filled) continue;
          return { type: 'fvg_ote', desc: `Bearish FVG-in-OTE @ ${fvgBot.toFixed(4)}-${fvgTop.toFixed(4)} (62-79% retrace zone)` };
        }
      }
    }
  }
  return null;
}

// ── Strategy mode dispatcher ──────────────────────────────────────────────
// Three modes:
//   'ict'         — only ICT/S&D detectors (default, higher conviction, fewer signals)
//   'price-action'— only original BOS/sweep/rejection/atr/fvg (legacy, more signals)
//   'hybrid'      — ICT first, fall back to price-action when ICT misses
const STRATEGY_MODE = (process.env.HENRY_STRATEGY_MODE || 'ict').toLowerCase();

function detectTrigger(candles, mode) {
  if (!candles || candles.length < 10) return null;
  const m = mode || STRATEGY_MODE;

  if (m === 'price-action') {
    return _detectBOS(candles)
        || _detectSweep(candles)
        || _detectRejection(candles)
        || _detectATRExpansion(candles)
        || _detectFVG(candles);
  }

  // ICT detectors (priority: MSS > sweep+disp > OB > S&D > FVG-OTE)
  const ictTrigger = _detectMSSDisplacement(candles)
      || _detectSweepDisplacement(candles)
      || _detectOrderBlock(candles)
      || _detectSDZone(candles)
      || _detectFVGInOTE(candles);

  if (m === 'hybrid' && !ictTrigger) {
    // Fall through to price-action detectors
    return _detectBOS(candles)
        || _detectSweep(candles)
        || _detectRejection(candles)
        || _detectATRExpansion(candles)
        || _detectFVG(candles);
  }
  return ictTrigger; // 'ict' mode or hybrid-with-match
}

// ════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE AI SIGNAL GENERATION
// When a trigger fires, the server runs the full AI flow autonomously so the
// phone push has the complete signal even if no browser is open.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// CONTEXT SOURCES FOR SERVER-SIDE AI
// Server has no CORS limits — can fetch RSS, calendar APIs, and multi-broker
// data directly. Each helper returns a context string ready to inject into the
// system prompt, or '' if the data couldn't be fetched (graceful degradation).
// ════════════════════════════════════════════════════════════════════════════

// ── 1. NEWS CONTEXT — RSS feeds, sentiment-tagged ──
const NEWS_FEEDS_SERVER = [
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss',                cat: 'CRYPTO' },
  { name: 'CoinDesk',      url: 'https://feeds.feedburner.com/CoinDesk',         cat: 'CRYPTO' },
  { name: 'Kitco',         url: 'https://www.kitco.com/rss/kitconews.xml',       cat: 'XAU' },
  { name: 'CryptoSlate',   url: 'https://cryptoslate.com/feed/',                 cat: 'CRYPTO' },
  { name: 'Decrypt',       url: 'https://decrypt.co/feed',                       cat: 'CRYPTO' },
  { name: 'Reuters',       url: 'https://feeds.reuters.com/reuters/businessNews',cat: 'MACRO' },
];
let _newsCache = { ts: 0, items: [] }; // 5-min cache shared across all scans

function newsImpact(t) {
  const u = t.toUpperCase();
  if (/BREAKING|FOMC|CPI|NFP|RATE DECISION|ALL.TIME|RECORD/.test(u)) return 'high';
  if (/SURGES|CRASHES|SPIKE|RALLY|DUMP|MASSIVE/.test(u)) return 'high';
  if (/RISES|FALLS|GAINS|DROPS|GROWS|HITS/.test(u)) return 'med';
  return 'low';
}
function newsSentiment(t) {
  const u = t.toUpperCase();
  if (/BULL|SURGE|RALLY|RECORD|HIGH|GAIN|INFLOW|ACCUMUL|WIN|GROWTH|BID/.test(u)) return 'bull';
  if (/BEAR|CRASH|DUMP|SELL.OFF|DECLINE|RISK|FEAR|DROP|LOSS|WARN/.test(u)) return 'bear';
  return 'neut';
}
function parseRSSItems(xml, source, cat) {
  const out = [];
  // Simple regex parse — same approach as browser's parseRSS
  const re = /<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi;
  const items = xml.match(re) || [];
  for (const item of items.slice(0, 8)) {
    const titleMatch = item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch  = item.match(/<(?:pubDate|published|updated)[^>]*>(.*?)<\//i);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
    if (!title) continue;
    const t = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();
    out.push({ t, title, source, cat, imp: newsImpact(title), sent: newsSentiment(title) });
  }
  return out;
}

async function fetchNewsContext() {
  const now = Date.now();
  // 5-min cache to avoid hammering RSS providers on every scan tick
  if (now - _newsCache.ts < 5 * 60 * 1000 && _newsCache.items.length) {
    // use cached
  } else {
    const all = [];
    await Promise.all(NEWS_FEEDS_SERVER.map(async f => {
      try {
        const r = await fetch(f.url, { headers: { 'user-agent': 'HenryHoover/1.0' } });
        if (!r.ok) return;
        const xml = await r.text();
        const items = parseRSSItems(xml, f.name, f.cat);
        all.push(...items);
      } catch {}
    }));
    all.sort((a, b) => b.t - a.t);
    _newsCache = { ts: now, items: all.slice(0, 25) };
  }
  if (!_newsCache.items.length) return '';
  const lines = ['NEWS HEADLINES (most recent, with sentiment + impact):'];
  for (const n of _newsCache.items.slice(0, 8)) {
    const imp = n.imp === 'high' ? '[HIGH]' : n.imp === 'med' ? '[MED]' : '[LOW]';
    const sent = n.sent === 'bull' ? 'bullish' : n.sent === 'bear' ? 'bearish' : 'neutral';
    lines.push(`${imp} ${sent} ${n.cat}: ${n.title.slice(0, 110)}`);
  }
  return '\n' + lines.join('\n');
}

// ── 2. ECONOMIC CALENDAR CONTEXT — high/medium impact next 4h ──
// Times stored as wall-clock LOCAL time in the event's home tz. UTC is
// derived at runtime so daylight-saving boundaries don't shift things by
// an hour twice a year. This list is the LAST-RESORT fallback only —
// the live FF feed at faireconomy.media is the primary source.
const CALENDAR_EVENTS_SERVER = [
  { day: 'Mon', local: '10:00', tz: 'America/New_York', zone: 'USD', name: 'ISM Manufacturing PMI',          imp: 'high' },
  { day: 'Tue', local: '10:00', tz: 'America/New_York', zone: 'USD', name: 'JOLTS Job Openings',             imp: 'high' },
  { day: 'Wed', local: '08:15', tz: 'America/New_York', zone: 'USD', name: 'ADP Employment Change',          imp: 'high' },
  { day: 'Wed', local: '08:30', tz: 'America/New_York', zone: 'USD', name: 'US CPI m/m',                     imp: 'high' },
  { day: 'Wed', local: '14:00', tz: 'America/New_York', zone: 'USD', name: 'FOMC Statement / Rate Decision', imp: 'high' },
  { day: 'Thu', local: '08:30', tz: 'America/New_York', zone: 'USD', name: 'Initial Jobless Claims',         imp: 'med'  },
  { day: 'Thu', local: '08:30', tz: 'America/New_York', zone: 'USD', name: 'US PPI m/m',                     imp: 'med'  },
  { day: 'Fri', local: '08:30', tz: 'America/New_York', zone: 'USD', name: 'Non-Farm Payrolls',              imp: 'high' },
  { day: 'Fri', local: '08:30', tz: 'America/New_York', zone: 'USD', name: 'Unemployment Rate',              imp: 'high' },
  { day: 'Tue', local: '07:00', tz: 'Europe/London',    zone: 'GBP', name: 'UK CPI y/y',                     imp: 'high' },
  { day: 'Wed', local: '11:00', tz: 'Europe/Berlin',    zone: 'EUR', name: 'Eurozone CPI Flash',             imp: 'high' },
  { day: 'Thu', local: '14:15', tz: 'Europe/Berlin',    zone: 'EUR', name: 'ECB Rate Decision',              imp: 'high' },
  { day: 'Fri', local: '07:00', tz: 'Europe/London',    zone: 'GBP', name: 'UK GDP m/m',                     imp: 'high' },
];

// Reads the wall-clock weekday + HH:MM in a given IANA tz for a UTC Date.
function _wallClockInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const w = parts.find(p => p.type === 'weekday').value;
  const hh = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
  const mm = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { dow: days.indexOf(w), hh, mm };
}

// Converts "dayName HH:MM in tz" to the UTC millisecond timestamp of the
// upcoming occurrence (within ±1 day of the target wall-clock day).
// Handles DST automatically via Intl.DateTimeFormat.
function _tzDayTimeToUTC(dayName, hhmm, tz) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetDow = days.indexOf(dayName);
  if (targetDow < 0) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = Date.now();
  for (let d = -1; d < 9; d++) {
    const candidate = new Date(now);
    candidate.setUTCDate(candidate.getUTCDate() + d);
    candidate.setUTCHours(hh, mm, 0, 0);
    const wall = _wallClockInTz(candidate, tz);
    // Adjust by the wall-clock delta (handles DST + tz offset in one shot)
    const deltaMin = (hh - wall.hh) * 60 + (mm - wall.mm);
    const adjusted = candidate.getTime() + deltaMin * 60_000;
    const verify = _wallClockInTz(new Date(adjusted), tz);
    if (verify.dow === targetDow && verify.hh === hh && verify.mm === mm
        && adjusted >= now - 3_600_000) {
      return adjusted;
    }
  }
  return null;
}
let _calendarCache = { ts: 0, items: [] };

// Public endpoint so the browser can pull the calendar through Henry's own
// server (which can reach FF reliably) instead of depending on the flaky
// allorigins CORS proxy. Returns the full week's high/med events plus the
// raw FF date strings so the browser can render in any tz.
app.get('/api/calendar/events', requireAuth, async (req, res) => {
  try {
    // Reuse the same cache fetchCalendarContext warms up
    await fetchCalendarContext();
    res.json({ events: _calendarCache.items || [] });
  } catch (e) {
    console.error('[calendar endpoint]', e.message);
    res.status(500).json({ error: 'calendar_failed', events: [] });
  }
});

async function fetchCalendarContext() {
  const now = Date.now();
  if (now - _calendarCache.ts < 60 * 60 * 1000 && _calendarCache.items.length) {
    // 1-hour cache — calendar rarely changes within a day
  } else {
    let live = [];
    try {
      const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
        headers: { 'user-agent': 'HenryHoover/1.0' },
      });
      if (!r.ok) {
        console.warn('[calendar] FF feed returned', r.status);
      } else {
        const raw = await r.json();
        if (!Array.isArray(raw)) {
          console.warn('[calendar] FF feed not an array');
        } else {
          live = raw
            .filter(e => e.impact === 'High' || e.impact === 'Medium')
            .map(e => ({
              dt: new Date(e.date).getTime(),
              zone: e.country, name: e.title,
              imp: e.impact === 'High' ? 'high' : 'med',
              forecast: e.forecast, prev: e.previous, actual: e.actual,
            }));
          console.log('[calendar] fetched', live.length, 'high/med events from FF');
        }
      }
    } catch (e) {
      console.error('[calendar] FF fetch failed:', e.message);
    }
    if (!live.length) {
      // Fallback: build static events using IANA tz so DST is handled
      // correctly (event-local wall-clock → real UTC, not naive UTC).
      console.warn('[calendar] using static fallback — live FF feed unavailable');
      live = CALENDAR_EVENTS_SERVER.map(e => {
        const dt = _tzDayTimeToUTC(e.day, e.local, e.tz);
        if (dt == null) return null;
        return { dt, zone: e.zone, name: e.name, imp: e.imp };
      }).filter(Boolean);
    }
    _calendarCache = { ts: now, items: live };
  }
  // Filter to next 4 hours / past 1 hour
  const events = _calendarCache.items.filter(e => {
    const d = e.dt - Date.now();
    return d > -3600000 && d < 14400000;
  }).slice(0, 6);
  if (!events.length) {
    return '\nECONOMIC CALENDAR: No high-impact events in next 4 hours. Safe trading window.';
  }
  const lines = ['ECONOMIC CALENDAR (next 4 hours):'];
  for (const e of events) {
    const d = e.dt - Date.now();
    let when;
    if (d < 0) when = 'JUST RELEASED';
    else {
      const h = Math.floor(d / 3600000);
      const m = Math.floor((d % 3600000) / 60000);
      when = (h > 0 ? h + 'h ' : '') + m + 'min';
    }
    const imp = e.imp === 'high' ? '[HIGH IMPACT]' : '[MED IMPACT]';
    let line = `${imp} ${when} — ${e.zone || ''} ${e.name || ''}`;
    if (e.forecast) line += ` | Fcst: ${e.forecast}${e.prev ? ' Prev: ' + e.prev : ''}`;
    if (e.actual) line += ` | Actual: ${e.actual}`;
    lines.push(line);
  }
  // Warn on imminent high-impact
  const nextHigh = events.find(e => e.imp === 'high' && e.dt > Date.now());
  if (nextHigh && (nextHigh.dt - Date.now()) < 7200000) {
    const mins = Math.floor((nextHigh.dt - Date.now()) / 60000);
    lines.push(`WARNING: HIGH IMPACT event in ${mins}min — ${nextHigh.name}. Confidence should be MAX 45% or NO TRADE.`);
  }
  return '\n' + lines.join('\n');
}

// ── 3. LIQUIDITY HEATMAP CONTEXT — swing levels, equal highs/lows, round numbers ──
function buildLiquidityContextServer(candles, tf) {
  if (!candles || candles.length < 20) return '';
  const cp = candles[candles.length - 1].c;
  const highs = candles.map(c => c.h), lows = candles.map(c => c.l);
  const pMax = Math.max(...highs), pMin = Math.min(...lows);
  const pR = (pMax - pMin) || 1;
  const levels = [];
  // Swing highs/lows (5-bar pivots)
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].h > candles[i-1].h && candles[i].h > candles[i-2].h && candles[i].h > candles[i+1].h && candles[i].h > candles[i+2].h)
      levels.push({ price: candles[i].h, label: 'SH (swing high)', strength: 1 });
    if (candles[i].l < candles[i-1].l && candles[i].l < candles[i-2].l && candles[i].l < candles[i+1].l && candles[i].l < candles[i+2].l)
      levels.push({ price: candles[i].l, label: 'SL (swing low)',  strength: 1 });
  }
  // Equal highs (rest liquidity)
  const sortedH = candles.slice().sort((a, b) => b.h - a.h);
  for (let i = 0; i < Math.min(sortedH.length - 1, 20); i++) {
    if (Math.abs(sortedH[i].h - sortedH[i+1].h) < pR * 0.002)
      levels.push({ price: (sortedH[i].h + sortedH[i+1].h) / 2, label: 'EQH', strength: 2 });
  }
  const sortedL = candles.slice().sort((a, b) => a.l - b.l);
  for (let i = 0; i < Math.min(sortedL.length - 1, 20); i++) {
    if (Math.abs(sortedL[i].l - sortedL[i+1].l) < pR * 0.002)
      levels.push({ price: (sortedL[i].l + sortedL[i+1].l) / 2, label: 'EQL', strength: 2 });
  }
  // Dedup nearby levels (keep stronger)
  levels.sort((a, b) => a.price - b.price);
  const dedup = [];
  for (const l of levels) {
    if (!dedup.length || Math.abs(l.price - dedup[dedup.length - 1].price) > pR * 0.004) dedup.push(l);
    else if (l.strength > dedup[dedup.length - 1].strength) dedup[dedup.length - 1] = l;
  }
  const above = dedup.filter(l => l.price > cp).sort((a, b) => a.price - b.price).slice(0, 4);
  const below = dedup.filter(l => l.price < cp).sort((a, b) => b.price - a.price).slice(0, 4);
  if (!above.length && !below.length) return '';
  const fmt = (p) => p >= 1000 ? p.toFixed(2) : p >= 10 ? p.toFixed(4) : p.toFixed(6);
  const lines = [`LIQUIDITY HEATMAP (${tf}):`];
  if (above.length) lines.push('Buy-side pools above price: ' + above.map(l => `${l.label}@${fmt(l.price)}${l.strength > 1 ? ' (x' + l.strength + ')' : ''}`).join(', '));
  if (below.length) lines.push('Sell-side pools below price: ' + below.map(l => `${l.label}@${fmt(l.price)}${l.strength > 1 ? ' (x' + l.strength + ')' : ''}`).join(', '));
  lines.push(`Nearest above: ${above.length ? fmt(above[0].price) : 'none'} | Nearest below: ${below.length ? fmt(below[0].price) : 'none'}`);
  lines.push('Note: price tends to sweep nearest pool before reversing — factor into entry + SL placement.');
  return '\n' + lines.join('\n');
}

// ── HEATMAP LEVELS (server-side computation for the browser canvas) ────────
// Mirrors the browser's renderHeatmap level-computation pass so the browser
// can draw without making per-candle fetches. Necessary because Binance
// geo-blocks Railway's egress IPs intermittently — server-side fetch works
// (server uses direct https://fapi.binance.com calls) but the browser proxy
// path through /binance-futures returns nothing in those windows.
function computeHeatmapLevels(candles) {
  if (!candles || candles.length < 10) {
    return { levels: [], cp: null, pMin: null, pMax: null };
  }
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const pMax = Math.max(...highs);
  const pMin = Math.min(...lows);
  const pR = (pMax - pMin) || 1;
  const cp = closes[closes.length - 1];
  const levels = [];
  // Swing highs/lows (5-bar pivots)
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].h > candles[i-1].h && candles[i].h > candles[i-2].h
        && candles[i].h > candles[i+1].h && candles[i].h > candles[i+2].h) {
      levels.push({ price: candles[i].h, label: 'SH', color: 'rgba(255,68,102,0.7)', strength: 1 });
    }
    if (candles[i].l < candles[i-1].l && candles[i].l < candles[i-2].l
        && candles[i].l < candles[i+1].l && candles[i].l < candles[i+2].l) {
      levels.push({ price: candles[i].l, label: 'SL', color: 'rgba(0,229,160,0.7)', strength: 1 });
    }
  }
  // Equal highs / lows (rest liquidity)
  const srtH = candles.slice().sort((a, b) => b.h - a.h);
  for (let i = 0; i < Math.min(srtH.length - 1, 20); i++) {
    if (Math.abs(srtH[i].h - srtH[i+1].h) < pR * 0.002) {
      levels.push({ price: (srtH[i].h + srtH[i+1].h) / 2, label: 'EQH', color: 'rgba(255,68,102,0.9)', strength: 2 });
    }
  }
  const srtL = candles.slice().sort((a, b) => a.l - b.l);
  for (let i = 0; i < Math.min(srtL.length - 1, 20); i++) {
    if (Math.abs(srtL[i].l - srtL[i+1].l) < pR * 0.002) {
      levels.push({ price: (srtL[i].l + srtL[i+1].l) / 2, label: 'EQL', color: 'rgba(0,229,160,0.9)', strength: 2 });
    }
  }
  // Round numbers — retail stop magnets
  const step = cp >= 1000 ? 100 : cp >= 100 ? 10 : cp >= 10 ? 1 : 0.1;
  const rndStart = Math.floor(pMin / step) * step;
  for (let r = rndStart; r <= pMax + step; r += step) {
    if (r >= pMin && r <= pMax) {
      levels.push({ price: r, label: 'R', color: 'rgba(255,184,48,0.4)', strength: 1 });
    }
  }
  // Dedup nearby levels — keep the stronger one
  levels.sort((a, b) => a.price - b.price);
  const dedup = [];
  for (const l of levels) {
    if (!dedup.length || Math.abs(l.price - dedup[dedup.length - 1].price) > pR * 0.004) {
      dedup.push(l);
    } else if (l.strength > dedup[dedup.length - 1].strength) {
      dedup[dedup.length - 1] = l;
    }
  }
  return { levels: dedup, cp, pMin, pMax };
}

// 5-second cache per (coin, tf, broker) — heatmap doesn't need to rebuild on
// every refresh-button click during a single user session.
const _heatmapCache = new Map(); // key → { ts, payload }
const HEATMAP_CACHE_MS = 5_000;

app.get('/api/heatmap', requireAuth, async (req, res) => {
  const coin = String(req.query.coin || '').toUpperCase();
  const tf = String(req.query.tf || '15m');
  const broker = String(req.query.broker || 'weex').toLowerCase();
  if (!coin) return res.status(400).json({ error: 'missing_coin', levels: [] });
  const cacheKey = `${coin}|${tf}|${broker}`;
  const cached = _heatmapCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HEATMAP_CACHE_MS) {
    return res.json(cached.payload);
  }
  try {
    const candles = await fetchCandlesServer(coin, tf, 100, broker);
    if (!candles || candles.length < 10) {
      const payload = { levels: [], cp: null, pMin: null, pMax: null, note: `Insufficient ${broker} candles for ${coin} (got ${candles ? candles.length : 0})` };
      _heatmapCache.set(cacheKey, { ts: Date.now(), payload });
      return res.json(payload);
    }
    const payload = computeHeatmapLevels(candles);
    _heatmapCache.set(cacheKey, { ts: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    console.error('[heatmap]', coin, tf, broker, err.message || err);
    res.status(500).json({ error: err.message || String(err), levels: [] });
  }
});

// ── 4. ORDER FLOW / FOOTPRINT CONTEXT — recent trades from Binance ──
async function fetchTradesServer(coin, broker) {
  try {
    if (broker === 'hyperliquid') {
      const sym = coin.replace('USDT', '');
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'recentTrades', coin: sym }),
      });
      const d = await r.json();
      return Array.isArray(d) ? d.map(t => ({
        price: parseFloat(t.px), size: parseFloat(t.sz),
        isBuyerMaker: t.side === 'A', // A=ask hit (buyer aggressive); we want maker-buyer
      })).slice(0, 1000) : [];
    }
    // Default: Binance aggTrades — works for most USDT-perp symbols
    const r = await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${coin}&limit=1000`);
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.map(t => ({
      price: parseFloat(t.p),
      size: parseFloat(t.q),
      isBuyerMaker: !!t.m, // m=true → maker is buyer → trade was sell aggression
    }));
  } catch { return []; }
}

function buildFootprintContextServer(trades, candles) {
  if (!trades || trades.length < 50 || !candles || !candles.length) return '';
  const cp = candles[candles.length - 1].c;
  let totalBuy = 0, totalSell = 0;
  for (const t of trades) {
    if (t.isBuyerMaker) totalSell += t.size; else totalBuy += t.size;
  }
  const totalVol = totalBuy + totalSell;
  if (!totalVol) return '';
  const delta = totalBuy - totalSell;
  const deltaDir = delta > 0 ? 'BULLISH' : 'BEARISH';
  const deltaPct = Math.abs(delta / totalVol * 100).toFixed(1);
  // Recent momentum: last 100 trades
  let recentBuy = 0, recentSell = 0;
  for (const t of trades.slice(0, 100)) {
    if (t.isBuyerMaker) recentSell += t.size; else recentBuy += t.size;
  }
  const recentDelta = recentBuy - recentSell;
  const momentum = recentDelta > 0 ? `Recent momentum BULLISH (+${recentDelta.toFixed(3)})` : `Recent momentum BEARISH (${recentDelta.toFixed(3)})`;
  // POC via 0.1% buckets
  const bucketSize = cp * 0.001;
  const buckets = new Map();
  for (const t of trades) {
    const bkt = Math.round(t.price / bucketSize) * bucketSize;
    const key = bkt.toFixed(bkt >= 100 ? 1 : bkt >= 10 ? 2 : 4);
    let b = buckets.get(key);
    if (!b) { b = { price: bkt, buy: 0, sell: 0, total: 0 }; buckets.set(key, b); }
    b.total += t.size;
    if (t.isBuyerMaker) b.sell += t.size; else b.buy += t.size;
  }
  const bucketArr = Array.from(buckets.values()).sort((a, b) => b.total - a.total);
  const poc = bucketArr[0];
  // Imbalances
  const imbalances = bucketArr.filter(b => b.total >= totalVol * 0.005)
    .filter(b => {
      const r = b.buy > b.sell ? b.buy / (b.sell || 0.001) : b.sell / (b.buy || 0.001);
      return r >= 3;
    }).slice(0, 4);
  // Absorption
  let absorption = '';
  const lastOpen = candles[candles.length - 1].o;
  if (delta < 0 && cp >= lastOpen) {
    absorption = `BULLISH ABSORPTION — heavy selling (delta ${delta.toFixed(3)}) but price held = buyers absorbing`;
  } else if (delta > 0 && cp <= lastOpen) {
    absorption = `BEARISH ABSORPTION — heavy buying (delta +${delta.toFixed(3)}) but price held/fell = sellers absorbing`;
  }
  const fmt = (p) => p >= 1000 ? p.toFixed(2) : p >= 10 ? p.toFixed(4) : p.toFixed(6);
  const lines = [`ORDER FLOW / FOOTPRINT (${trades.length} recent trades):`];
  lines.push(`Buy vol: ${totalBuy.toFixed(3)} | Sell vol: ${totalSell.toFixed(3)}`);
  lines.push(`Net delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} (${deltaDir}, ${deltaPct}% imbalance)`);
  lines.push(momentum);
  if (poc) lines.push(`Point of Control: $${fmt(poc.price)} (vol: ${poc.total.toFixed(3)})`);
  if (imbalances.length) {
    lines.push('Volume imbalances (institutional zones):');
    for (const b of imbalances) {
      const dom = b.buy > b.sell ? 'BUY' : 'SELL';
      const rat = b.buy > b.sell ? (b.buy / (b.sell || 0.001)).toFixed(1) : (b.sell / (b.buy || 0.001)).toFixed(1);
      lines.push(`  ${dom} imbalance @ $${fmt(b.price)} (${rat}:1 ratio)`);
    }
  }
  if (absorption) lines.push(absorption);
  return '\n' + lines.join('\n');
}

// ── 4b. CVD CONTEXT — same-trades 5-window momentum ──
function buildCVDContextServer(trades) {
  if (!trades || trades.length < 50) return '';
  const chunkSize = Math.floor(trades.length / 5);
  const chunkDeltas = [];
  for (let i = 0; i < 5; i++) {
    let buy = 0, sell = 0;
    const slice = trades.slice(i * chunkSize, (i + 1) * chunkSize);
    for (const t of slice) {
      if (t.isBuyerMaker) sell += t.size; else buy += t.size;
    }
    chunkDeltas.push(buy - sell);
  }
  // Note: trades come ordered from newest to oldest in Binance aggTrades, so reverse for chronological
  chunkDeltas.reverse();
  const trend = chunkDeltas.reduce((a, b) => a + b, 0);
  const earlyDelta = chunkDeltas[0] + chunkDeltas[1];
  const lateDelta = chunkDeltas[3] + chunkDeltas[4];
  let bias = 'neutral';
  if (lateDelta > 0 && earlyDelta < 0)        bias = 'potential bullish reversal — late buyers absorbing earlier sellers';
  else if (lateDelta < 0 && earlyDelta > 0)   bias = 'weakening rally — distribution into strength';
  else if (trend > 0 && lateDelta > earlyDelta) bias = 'strong bullish momentum — accelerating buy pressure';
  else if (trend < 0 && lateDelta < earlyDelta) bias = 'strong bearish momentum — accelerating sell pressure';
  return `\nCVD TREND (5-window delta): cumulative ${trend >= 0 ? '+' : ''}${trend.toFixed(3)} — ${bias}.`;
}

// ── 5. CROSS-BROKER CONTEXT — fetch candles from all 3 brokers, compare ──
async function buildCrossBrokerContextServer(coin, tf, primaryBroker) {
  const brokers = ['weex', 'binance', 'hyperliquid'];
  const sets = await Promise.all(brokers.map(b => fetchCandlesServer(coin, tf, 30, b).catch(() => [])));
  const data = brokers.map((b, i) => {
    const c = sets[i];
    if (!c || c.length < 5) return { broker: b, valid: false };
    const last = c[c.length - 1].c;
    const first = c[Math.max(0, c.length - 10)].c;
    const dir = last > first ? 'bullish' : last < first ? 'bearish' : 'flat';
    const slice = c.slice(-15);
    const ema = slice.reduce((s, k) => s + k.c, 0) / slice.length;
    const stack = last > ema ? 'above-mean' : 'below-mean';
    return { broker: b, valid: true, last, dir, stack };
  });
  const valid = data.filter(d => d.valid);
  if (valid.length < 2) return '';
  const allBullish = valid.every(d => d.dir === 'bullish' && d.stack === 'above-mean');
  const allBearish = valid.every(d => d.dir === 'bearish' && d.stack === 'below-mean');
  const allAgree   = allBullish || allBearish;
  const lines = [`CROSS-BROKER CHECK (${valid.length} brokers):`];
  for (const d of valid) {
    lines.push(`  ${d.broker}: last ${d.last.toFixed(4)}, recent ${d.dir}, ${d.stack}`);
  }
  if (allAgree) {
    lines.push(`AGREEMENT: all ${valid.length} brokers ${allBullish ? 'BULLISH' : 'BEARISH'} — high-conviction signal.`);
  } else {
    lines.push('DIVERGENCE: brokers disagree — reduce confidence by 10pts or NO TRADE.');
  }
  return '\n' + lines.join('\n');
}

// ── DXY / Gold macro context — used INSTEAD of BTC correlation when scanning gold ──
// Gold's primary macro driver is the dollar (inverse correlation); BTC is irrelevant.
let _dxyCache = { ts: 0, data: null };

async function fetchDXYContextServer() {
  // 5-min cache so multiple gold scans don't hammer Polygon
  if (Date.now() - _dxyCache.ts < 5 * 60 * 1000 && _dxyCache.data) return _dxyCache.data;
  try {
    const tickers = ['C:USDEUR', 'C:USDJPY', 'C:USDGBP', 'C:USDCAD', 'C:USDSEK', 'C:USDCHF', 'C:XAUUSD'].join(',');
    const data = await polyFetch('/v2/snapshot/locale/global/markets/forex/tickers', { tickers });
    const today = {}, prev = {};
    for (const t of (data.tickers || [])) {
      const code = (t.ticker || '').replace('C:USD', '').replace('C:', '');
      const cur = t.lastQuote?.a || t.day?.c || t.prevDay?.c;
      const pre = t.prevDay?.c;
      if (cur) today[code] = cur;
      if (pre) prev[code] = pre;
    }
    const dxy = calcDxy(today);
    const dxyPrev = calcDxy(prev);
    const dxyChange = dxy && dxyPrev ? ((dxy - dxyPrev) / dxyPrev) * 100 : 0;
    const xau = today['XAUUSD'] || null;
    const xauPrev = prev['XAUUSD'] || null;
    const xauChange = xau && xauPrev ? ((xau - xauPrev) / xauPrev) * 100 : 0;
    _dxyCache = { ts: Date.now(), data: { dxy, dxyChange, xau, xauChange } };
    return _dxyCache.data;
  } catch (e) {
    console.error('[dxy context]', e.message);
    return null;
  }
}

// DXY divergence detector — produces a trigger-like object when DXY and gold
// move in incongruous directions (signalling strong-demand or weak-demand
// imbalance). Only applies to gold/metals/oil pairs since those are dollar-
// denominated. Called as a fallback in processPair when the base trigger
// detector returns nothing — gives gold an extra signal source.
async function detectDxyDivergence(coin, candles) {
  if (!/^(GOLD|XAU|XAG|XTI|XBR)/i.test(coin)) return null;
  if (!candles || candles.length < 10) return null;
  const d = await fetchDXYContextServer().catch(() => null);
  if (!d || d.dxyChange == null) return null;
  const dxyChange = parseFloat(d.dxyChange);
  if (!isFinite(dxyChange)) return null;
  // Gold's intraday change from the last ~6 candles (≈30min on 5m, ≈90min on 15m)
  const startC = candles[candles.length - 6];
  const endC = candles[candles.length - 1];
  if (!startC || !endC) return null;
  const goldChange = ((endC.c - startC.c) / startC.c) * 100;
  // STRONG GOLD: dollar rallies but gold doesn't fall (or rallies anyway).
  // Classic high-conviction LONG setup — heavy institutional demand absorbing
  // the dollar-strength headwind.
  if (dxyChange > 0.30 && goldChange > -0.05) {
    return {
      type: 'DXY_DIVERGENCE',
      desc: `DXY +${dxyChange.toFixed(2)}% but gold ${goldChange >= 0 ? '+' : ''}${goldChange.toFixed(2)}% — strong demand absorbing dollar strength`,
      direction: 'LONG',
    };
  }
  // WEAK GOLD: dollar falls sharply but gold can't catch a bid. Lack of
  // demand even with macro tailwind — bearish reversal setup.
  if (dxyChange < -0.30 && goldChange < 0.05) {
    return {
      type: 'DXY_DIVERGENCE',
      desc: `DXY ${dxyChange.toFixed(2)}% but gold only ${goldChange >= 0 ? '+' : ''}${goldChange.toFixed(2)}% — demand absent despite dollar weakness`,
      direction: 'SHORT',
    };
  }
  return null;
}

// Imminent high-impact news event check — used to skip new gold entries 30
// min before / 5 min after major USD/EUR/GBP releases (NFP, CPI, FOMC,
// rate decisions). Re-uses the existing _calendarCache populated by
// fetchCalendarContext, so callers must ensure the cache is warm.
function imminentGoldNewsEvent(now = Date.now(), minutesAhead = 30) {
  const events = (_calendarCache && _calendarCache.items) || [];
  const aheadMs = minutesAhead * 60 * 1000;
  const behindMs = 5 * 60 * 1000;
  for (const e of events) {
    if (e.imp !== 'high') continue;
    if (!['USD', 'EUR', 'GBP'].includes(e.zone)) continue;
    const dt = e.dt - now;
    if (dt > -behindMs && dt < aheadMs) return e;
  }
  return null;
}

function buildDXYContextString(d) {
  if (!d || !d.dxy) return '';
  const lines = ['DXY / DOLLAR MACRO (primary correlation for metals & oil — replaces BTC):'];
  lines.push(`DXY Index: ${d.dxy.toFixed(3)} (${d.dxyChange >= 0 ? '+' : ''}${d.dxyChange.toFixed(2)}% today)`);
  if (d.xau) lines.push(`XAU/USD reference: $${d.xau.toFixed(2)} (${d.xauChange >= 0 ? '+' : ''}${d.xauChange.toFixed(2)}% today)`);
  lines.push('General rule: dollar strong → metals & commodities weaken (and vice versa). This pair is dollar-denominated and tracks the same correlation.');
  // Correlation interpretation (uses gold as a proxy for "metals/oil sentiment")
  if (d.dxyChange !== 0 && d.xauChange !== 0) {
    if (d.dxyChange < 0 && d.xauChange > 0) {
      lines.push('Correlation bias: METALS/OIL BULLISH — DXY weakness supports longs. Favour LONG setups.');
    } else if (d.dxyChange > 0 && d.xauChange < 0) {
      lines.push('Correlation bias: METALS/OIL BEARISH — DXY strength is a headwind. Favour SHORT or NO TRADE.');
    } else if (d.dxyChange > 0 && d.xauChange > 0) {
      lines.push('Correlation bias: METALS/OIL VERY BULLISH — rising despite dollar strength = strong demand. High-conviction LONG bias.');
    } else if (d.dxyChange < 0 && d.xauChange < 0) {
      lines.push('Correlation bias: METALS/OIL WEAK — not following DXY weakness = lack of conviction. Reduce size or NO TRADE.');
    }
  }
  return '\n' + lines.join('\n');
}

async function fetchFundingRateServer(coin) {
  // Binance gives funding for almost every USDT-perp; use it regardless of broker.
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}`);
    const d = await r.json();
    return parseFloat(d.lastFundingRate);
  } catch { return null; }
}

async function fetchOpenInterestServer(coin) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin}`);
    const d = await r.json();
    return parseFloat(d.openInterest) || null;
  } catch { return null; }
}

// Binance futures/data endpoints (openInterestHist, long/short ratio) only
// accept a fixed set of periods. Map the trigger TF to the nearest valid one.
function binanceStatsPeriod(tf) {
  const valid = { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h', '1d': '1d' };
  if (valid[tf]) return tf;
  if (tf === '1m') return '5m';
  return '15m';
}
const _STATS_TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000, '1d': 86400000 };

// ── OI DELTA — open-interest CHANGE paired with price change. A static OI
// number is meaningless; what matters is whether a move is fueled by NEW
// positions (trend has gas) or by POSITION UNWIND (short-covering / long
// capitulation = weak move). Replaces the old dead OI snapshot line.
async function buildOIDeltaContextServer(coin, tf, baseCandles) {
  try {
    const period = binanceStatsPeriod(tf);
    const r = await fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}&period=${period}&limit=16`);
    if (!r.ok) return '';
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length < 4) return '';
    const first = parseFloat(arr[0].sumOpenInterest);
    const last = parseFloat(arr[arr.length - 1].sumOpenInterest);
    const lastUsd = parseFloat(arr[arr.length - 1].sumOpenInterestValue);
    if (!(first > 0) || !(last > 0)) return '';
    const oiChangePct = (last - first) / first * 100;
    // Align price change to the SAME wall-clock window via the OI timestamps.
    const windowMs = (+arr[arr.length - 1].timestamp) - (+arr[0].timestamp);
    const tfMs = _STATS_TF_MS[tf] || 900000;
    let priceChangePct = null;
    if (baseCandles && baseCandles.length >= 3 && windowMs > 0) {
      const nBack = Math.max(1, Math.min(baseCandles.length - 1, Math.round(windowMs / tfMs)));
      const startC = baseCandles[baseCandles.length - 1 - nBack].c;
      const endC = baseCandles[baseCandles.length - 1].c;
      if (startC > 0) priceChangePct = (endC - startC) / startC * 100;
    }
    const oiUp = oiChangePct > 0.5, oiDown = oiChangePct < -0.5;
    let interp;
    if (priceChangePct != null) {
      const pUp = priceChangePct > 0.1, pDown = priceChangePct < -0.1;
      if (pUp && oiUp)        interp = 'price UP + OI UP = new longs opening — uptrend has fuel (continuation favoured)';
      else if (pUp && oiDown) interp = 'price UP + OI DOWN = short covering — rally lacks new conviction (fade risk on exhaustion)';
      else if (pDown && oiUp) interp = 'price DOWN + OI UP = new shorts opening — downtrend has fuel (continuation favoured)';
      else if (pDown && oiDown) interp = 'price DOWN + OI DOWN = longs unwinding/capitulating — selloff may be exhausting (reversal watch)';
      else interp = 'price flat — OI ' + (oiUp ? 'rising (positions building, expansion likely)' : oiDown ? 'falling (positions closing)' : 'flat (no conviction)');
    } else {
      interp = oiUp ? 'OI rising (positions building)' : oiDown ? 'OI falling (positions closing)' : 'OI flat';
    }
    const usdLbl = lastUsd ? ` ($${(lastUsd / 1e6).toFixed(1)}M notional)` : '';
    return `\nOPEN INTEREST (${period}×${arr.length}): ${oiChangePct >= 0 ? '+' : ''}${oiChangePct.toFixed(1)}% over window${usdLbl}` +
      (priceChangePct != null ? `, price ${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%` : '') +
      ` — ${interp}.`;
  } catch { return ''; }
}

// ── FUNDING TREND — the live pipeline already shows the current snapshot;
// this adds the recent trajectory (rising / falling / sign-flip) so the model
// can see crowding BUILDING vs EASING, not just the instantaneous value.
async function buildFundingTrendContextServer(coin) {
  try {
    const hist = await fetchHistoricalFunding(coin, 4 * 24 * 3600 * 1000); // ~4d → up to ~12 settlements
    if (!hist || hist.length < 3) return '';
    const recent = hist.slice(-9);
    const rates = recent.map(h => h.rate);
    const cur = rates[rates.length - 1];
    const half = Math.floor(rates.length / 2);
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const older = avg(rates.slice(0, half || 1));
    const newer = avg(rates.slice(half));
    const delta = newer - older;
    const pct = v => (v * 100).toFixed(4) + '%';
    const flipped = (older < 0 && newer > 0) || (older > 0 && newer < 0);
    let trend;
    if (flipped) trend = older < 0
      ? 'FLIPPED negative→positive (shorts→longs paying; sentiment turning bullish-crowded)'
      : 'FLIPPED positive→negative (longs→shorts paying; sentiment turning bearish-crowded)';
    else if (Math.abs(delta) < 0.00003) trend = 'flat (stable positioning)';
    else if (delta > 0) trend = cur > 0 ? 'rising & positive (longs increasingly crowded — fade-short bias strengthening)' : 'rising toward zero (short crowding easing)';
    else trend = cur < 0 ? 'falling & negative (shorts increasingly crowded — fade-long bias strengthening)' : 'falling toward zero (long crowding easing)';
    return `\nFUNDING TREND (last ${recent.length} settlements): ${pct(older)} → ${pct(cur)} — ${trend}.`;
  } catch { return ''; }
}

// ── LONG/SHORT RATIO — retail accounts vs top traders by position. The edge
// is the DIVERGENCE: when retail is crowded long but the top cohort is net
// short, smart money is fading the crowd. Distinct from funding (positioning
// split, not cost of carry).
async function buildLongShortRatioContextServer(coin, tf) {
  try {
    const period = binanceStatsPeriod(tf);
    const [globalR, topR] = await Promise.all([
      fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin}&period=${period}&limit=3`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${coin}&period=${period}&limit=3`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    const lines = [];
    let retailRatio = null, topRatio = null;
    if (Array.isArray(globalR) && globalR.length) {
      const c = globalR[globalR.length - 1];
      retailRatio = parseFloat(c.longShortRatio);
      const prev = globalR.length > 1 ? parseFloat(globalR[0].longShortRatio) : null;
      const dir = (prev != null && isFinite(prev)) ? (retailRatio > prev + 0.02 ? 'rising' : retailRatio < prev - 0.02 ? 'falling' : 'flat') : '';
      if (isFinite(retailRatio)) lines.push(`retail accounts ${retailRatio.toFixed(2)}:1 ${retailRatio > 1 ? 'long' : 'short'}${dir ? ' (' + dir + ')' : ''}`);
    }
    if (Array.isArray(topR) && topR.length) {
      const c = topR[topR.length - 1];
      topRatio = parseFloat(c.longShortRatio);
      if (isFinite(topRatio)) lines.push(`top traders ${topRatio.toFixed(2)}:1 ${topRatio > 1 ? 'long' : 'short'}`);
    }
    if (!lines.length) return '';
    let interp = '';
    if (retailRatio != null && topRatio != null && isFinite(retailRatio) && isFinite(topRatio)) {
      const rL = retailRatio > 1, tL = topRatio > 1;
      if (rL && !tL) interp = ' — smart money SHORT vs crowd LONG (bearish divergence — favour shorts / fade longs)';
      else if (!rL && tL) interp = ' — smart money LONG vs crowd SHORT (bullish divergence — favour longs / fade shorts)';
      else if (rL && tL) interp = ' — both long (consensus long; watch for crowded-long flush)';
      else interp = ' — both short (consensus short; watch for short squeeze)';
      if (retailRatio >= 2.5) interp += '. Retail extremely long (>2.5:1) — contrarian short tilt';
      else if (retailRatio <= 0.5) interp += '. Retail extremely short (<0.5:1) — contrarian long tilt';
    }
    return `\nLONG/SHORT RATIO (${period}): ${lines.join('; ')}${interp}.`;
  } catch { return ''; }
}

// ── SELF-PERFORMANCE FEEDBACK — Henry's own realized track record on THIS
// pair, summarized so the model can lean into setups with proven edge and be
// selective on ones that have lost money. Cached per-coin (15 min) to avoid
// hammering the DB on every scan. Queries the admin/bot's signal history.
const _perfFeedbackCache = new Map(); // coin → { ts, str }
const PERF_FEEDBACK_TTL_MS = 15 * 60 * 1000;
async function buildPerfFeedbackContextServer(coin) {
  try {
    const cached = _perfFeedbackCache.get(coin);
    if (cached && Date.now() - cached.ts < PERF_FEEDBACK_TTL_MS) return cached.str;
    const adminId = await getAdminUserId();
    if (!adminId) return '';
    const since = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await supaAdmin
      .from('signals')
      .select('outcome, outcome_rr, confidence, reasoning, entry_reason')
      .eq('user_id', adminId)
      .eq('pair', coin)
      .gte('created_at', since)
      .in('outcome', ['TP', 'SL', 'BE', 'EXPIRED'])
      .order('created_at', { ascending: false })
      .limit(120);
    if (error || !rows || rows.length < 8) {
      _perfFeedbackCache.set(coin, { ts: Date.now(), str: '' });
      return '';
    }
    const closed = rows;
    const effR = r => {
      if (r.outcome === 'EXPIRED') return 0;
      const rr = parseFloat(r.outcome_rr);
      if (isFinite(rr)) return rr;
      if (r.outcome === 'SL') return -1;
      return 0;
    };
    const tp = closed.filter(r => r.outcome === 'TP').length;
    const be = closed.filter(r => r.outcome === 'BE').length;
    const sl = closed.filter(r => r.outcome === 'SL').length;
    const cN = tp + sl + be;
    const totalR = closed.reduce((a, b) => a + effR(b), 0);
    const winRate = cN ? ((tp + be * 0.5) / cN * 100) : 0;
    const bySetup = {};
    for (const s of closed) {
      for (const tag of extractSetupTags(s)) {
        const b = bySetup[tag] || (bySetup[tag] = { n: 0, tp: 0, sl: 0, be: 0, r: 0 });
        b.n++; b.r += effR(s);
        if (s.outcome === 'TP') b.tp++; else if (s.outcome === 'SL') b.sl++; else if (s.outcome === 'BE') b.be++;
      }
    }
    const setups = Object.entries(bySetup)
      .map(([k, v]) => { const c = v.tp + v.sl + v.be; return { k, n: v.n, wr: c ? (v.tp + v.be * 0.5) / c * 100 : 0, r: v.r }; })
      .filter(s => s.n >= 5)
      .sort((a, b) => b.r - a.r);
    const best = setups.slice(0, 2);
    const worst = setups.filter(s => s.wr < 45).slice(-2);
    const bucket = (lo, hi) => {
      const sub = closed.filter(r => { const c = parseFloat(r.confidence); return isFinite(c) && c >= lo && c <= hi; });
      const c = sub.filter(r => ['TP', 'SL', 'BE'].includes(r.outcome)).length;
      const w = sub.filter(r => r.outcome === 'TP').length + sub.filter(r => r.outcome === 'BE').length * 0.5;
      return { n: sub.length, wr: c ? w / c * 100 : null };
    };
    const hi = bucket(85, 100), mid = bucket(50, 84);
    const parts = [`HENRY TRACK RECORD on ${coin} (last ${closed.length} closed): ${winRate.toFixed(0)}% win, ${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R.`];
    if (best.length) parts.push('Strong setups: ' + best.map(s => `${s.k} ${s.wr.toFixed(0)}% (n${s.n}, ${s.r >= 0 ? '+' : ''}${s.r.toFixed(1)}R)`).join(', ') + '.');
    if (worst.length) parts.push('Weak setups (demand extra confluence): ' + worst.map(s => `${s.k} ${s.wr.toFixed(0)}% (n${s.n}, ${s.r >= 0 ? '+' : ''}${s.r.toFixed(1)}R)`).join(', ') + '.');
    if (hi.wr != null && mid.wr != null && hi.n >= 4 && mid.n >= 4) {
      const cal = hi.wr >= mid.wr + 5 ? 'well-calibrated' : hi.wr <= mid.wr - 5 ? 'OVERCONFIDENT (high-conf calls underperform — discount your confidence)' : 'flat (confidence not predictive — rely on setup quality not conviction)';
      parts.push(`Confidence: 85+ win ${hi.wr.toFixed(0)}% (n${hi.n}) vs 50-84 win ${mid.wr.toFixed(0)}% (n${mid.n}) — ${cal}.`);
    }
    const str = '\n' + parts.join(' ');
    _perfFeedbackCache.set(coin, { ts: Date.now(), str });
    return str;
  } catch { return ''; }
}

// ── LIQUIDATIONS — real market-wide liquidation prints from Binance's
// !forceOrder@arr stream. One global socket buffers the last 30 min per
// symbol. forceOrder side semantics: SELL = a LONG was force-closed (forced
// selling); BUY = a SHORT was force-closed (forced buying / squeeze).
const _liqBuffer = new Map(); // symbol → [{ ts, side:'LONG'|'SHORT', notional, price }]
const LIQ_WINDOW_MS = 30 * 60 * 1000;
let _liqWs = null;
function _liqBoot() {
  const open = () => {
    try {
      const ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      _liqWs = ws;
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const o = msg.o; if (!o || !o.s) return;
          const price = parseFloat(o.ap || o.p) || 0;
          const qty = parseFloat(o.q) || 0;
          const notional = price * qty;
          if (!notional) return;
          const side = o.S === 'SELL' ? 'LONG' : 'SHORT';
          let arr = _liqBuffer.get(o.s);
          if (!arr) { arr = []; _liqBuffer.set(o.s, arr); }
          arr.push({ ts: Date.now(), side, notional, price });
        } catch {}
      });
      ws.on('close', () => setTimeout(open, 5000));
      ws.on('error', () => { try { ws.close(); } catch {} });
    } catch { setTimeout(open, 5000); }
  };
  open();
  setInterval(() => {
    const cutoff = Date.now() - LIQ_WINDOW_MS;
    for (const [sym, arr] of _liqBuffer) {
      const kept = arr.filter(e => e.ts >= cutoff);
      if (kept.length) _liqBuffer.set(sym, kept); else _liqBuffer.delete(sym);
    }
  }, 2 * 60 * 1000);
}

function buildLiquidationContextServer(coin, baseCandles) {
  const arr = _liqBuffer.get(coin);
  if (!arr || !arr.length) return '';
  const cutoff = Date.now() - LIQ_WINDOW_MS;
  const recent = arr.filter(e => e.ts >= cutoff);
  if (recent.length < 2) return '';
  let longLiq = 0, shortLiq = 0, biggest = null;
  for (const e of recent) {
    if (e.side === 'LONG') longLiq += e.notional; else shortLiq += e.notional;
    if (!biggest || e.notional > biggest.notional) biggest = e;
  }
  const total = longLiq + shortLiq;
  if (total < 1000) return '';
  const fmt = v => v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : '$' + (v / 1e3).toFixed(0) + 'K';
  const dom = longLiq > shortLiq * 1.3 ? 'LONG' : shortLiq > longLiq * 1.3 ? 'SHORT' : 'BALANCED';
  let interp;
  if (dom === 'LONG') interp = 'longs being liquidated = forced selling / cascade lower; watch for a capitulation low + reversal once it dries up';
  else if (dom === 'SHORT') interp = 'shorts being liquidated = forced buying / short squeeze fuelling the move up';
  else interp = 'two-sided liquidations = volatile chop, no clean cascade';
  const cp = baseCandles && baseCandles.length ? baseCandles[baseCandles.length - 1].c : null;
  let near = '';
  if (biggest && cp) {
    const dp = cp >= 1000 ? 1 : 4;
    near = ` Largest: ${fmt(biggest.notional)} ${biggest.side} @ ${biggest.price.toFixed(dp)} (${((biggest.price - cp) / cp * 100).toFixed(2)}% from price).`;
  }
  return `\nLIQUIDATIONS (last 30m): longs ${fmt(longLiq)} vs shorts ${fmt(shortLiq)} across ${recent.length} events — ${dom}-dominant: ${interp}.${near}`;
}

// Setup-tag extraction — regex over the AI `reasoning` + `entry_reason` text.
// Lifted to module scope so /api/performance/me and the signal-generation
// feedback loop (buildPerfFeedbackContextServer) share one definition.
function extractSetupTags(s) {
  const text = String((s.reasoning || '') + ' ' + (s.entry_reason || '')).toUpperCase();
  if (!text.trim()) return [];
  const tags = [];
  if (/\bFVG\b|FAIR VALUE GAP/.test(text)) tags.push('FVG');
  if (/\bOB\b|ORDER BLOCK|ORDER-BLOCK/.test(text)) tags.push('OB');
  if (/\bBOS\b|BREAK OF STRUCTURE/.test(text)) tags.push('BOS');
  if (/\bCHOCH\b|CHANGE OF CHARACTER/.test(text)) tags.push('CHoCH');
  if (/SWEEP|LIQUIDITY GRAB|STOP HUNT|LIQ GRAB/.test(text)) tags.push('Sweep');
  if (/\bEQH\b|EQUAL HIGH/.test(text)) tags.push('EQH');
  if (/\bEQL\b|EQUAL LOW/.test(text)) tags.push('EQL');
  if (/RETEST/.test(text)) tags.push('Retest');
  if (/DISPLACEMENT|IMPULSE LEG/.test(text)) tags.push('Displacement');
  if (/SUPPORT|RESISTANCE|\bS\/R\b/.test(text)) tags.push('S/R');
  if (/PREMIUM|DISCOUNT/.test(text)) tags.push('Premium/Discount');
  if (/TRENDLINE|TREND LINE/.test(text)) tags.push('Trendline');
  if (/\bRANGE\b/.test(text)) tags.push('Range');
  if (/\bMSS\b|MARKET STRUCTURE SHIFT/.test(text)) tags.push('MSS');
  return tags;
}

// Anthropic returns HTTP 529 + {"error":{"type":"overloaded_error"}} when their
// infra is saturated. It's transient — retry with backoff. Also covers 503 and
// rate-limit 429. Non-transient errors (4xx other than 429) fail immediately.
function _isAnthropicOverload(status, body) {
  if (status === 529 || status === 503 || status === 429) return true;
  const t = body && body.error && body.error.type;
  return t === 'overloaded_error' || t === 'rate_limit_error' || t === 'api_error';
}
// Overload events on Anthropic can last 5-15+ minutes. Extended retry sequence
// (~3 min total wait) catches the vast majority. Auto-scan pairs are independent
// so a stuck pair doesn't block others. ±20% jitter prevents thundering-herd
// behaviour when many concurrent pair-scans all retry on the same tick.
const ANTHROPIC_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 45000, 60000];
function _jittered(ms) { return Math.round(ms * (0.8 + Math.random() * 0.4)); }
async function _anthropicFetchWithRetry(payload) {
  let lastErr = null;
  const totalAttempts = ANTHROPIC_RETRY_DELAYS_MS.length + 1; // initial + retries
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    let r, d;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      d = await r.json();
    } catch (netErr) {
      lastErr = netErr;
      if (attempt < ANTHROPIC_RETRY_DELAYS_MS.length) {
        const delay = _jittered(ANTHROPIC_RETRY_DELAYS_MS[attempt]);
        console.warn(`[anthropic] network error (attempt ${attempt + 1}/${totalAttempts}), retrying in ${delay}ms:`, netErr.message);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw netErr;
    }
    if (r.ok && !d.error) {
      if (attempt > 0) console.log(`[anthropic] recovered after ${attempt + 1} attempts`);
      return d;
    }
    // Retryable?
    if (_isAnthropicOverload(r.status, d) && attempt < ANTHROPIC_RETRY_DELAYS_MS.length) {
      const delay = _jittered(ANTHROPIC_RETRY_DELAYS_MS[attempt]);
      const errType = (d && d.error && d.error.type) || ('http_' + r.status);
      console.warn(`[anthropic] ${errType} (attempt ${attempt + 1}/${totalAttempts}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    // Non-retryable or out of retries
    const msg = (d && d.error && d.error.message) || `HTTP ${r.status}`;
    if (_isAnthropicOverload(r.status, d)) {
      console.error(`[anthropic] gave up after ${totalAttempts} attempts (~3min) — still overloaded`);
    }
    const err = new Error(msg);
    err.status = r.status;
    err.anthropicError = d && d.error;
    throw err;
  }
  throw lastErr || new Error('Anthropic retry loop exhausted');
}

// Direct Anthropic API call (bypasses /api/claude proxy — no cookie auth needed server-side).
// Defaults to AUTOSCAN_AI_MODEL (typically Opus 4.8) for autonomous scan
// decisions. Pass `model` explicitly to use a different model — manual ANALYSE
// passes AI_MODEL (typically Sonnet 4.6) for speed.
async function callAnthropicServer(systemPrompt, userMessage, maxTokens = 1500, model = AUTOSCAN_AI_MODEL) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const d = await _anthropicFetchWithRetry({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  // Find the text block explicitly — newer models (Fable 5 / Opus 4.7+) can put a
  // thinking block first in `content`, so content[0].text is not safe. Also note
  // Fable 5 400s on temperature/top_p/thinking:{disabled} — this body (model +
  // max_tokens + system + messages only) is the compatible shape; don't add
  // sampling params here. max_tokens default raised 800→1500: Fable without
  // thinking writes more visible reasoning before the JSON, and the cap is a
  // ceiling, not a spend — unused headroom costs nothing.
  const textBlock = (d.content || []).find(b => b && b.type === 'text');
  return (textBlock && textBlock.text) || '';
}

// Robust JSON parser: strips markdown fences and tries to repair truncated JSON.
function parseSignalJSONServer(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Strip markdown code fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Quick path
  try { return JSON.parse(s); } catch {}
  // Extract first {...} block
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  // Truncation repair
  const open = s.indexOf('{');
  if (open < 0) return null;
  s = s.slice(open);
  let lastQuote = -1, esc = false, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; if (!inStr) lastQuote = i; }
  }
  if (inStr && lastQuote >= 0) {
    s = s.slice(0, lastQuote + 1);
    s = s.replace(/[,]\s*"[^"]*$/, '');
    s = s.replace(/[,]\s*"[^"]*"\s*:\s*"[^"]*$/, '');
  }
  let bO = 0, kO = 0;
  esc = false; inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') bO++; else if (c === '}') bO--;
    else if (c === '[') kO++; else if (c === ']') kO--;
  }
  s = s.replace(/,\s*$/, '');
  while (kO > 0) { s += ']'; kO--; }
  while (bO > 0) { s += '}'; bO--; }
  try { return JSON.parse(s); } catch { return null; }
}

function _legacy_parseSignalJSONServer_unused(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : JSON.parse(text);
  } catch { return null; }
}

function validateSignalLevelsServer(sig) {
  if (!sig || !sig.direction) return false;
  if (sig.direction === 'NO TRADE') return true;
  if (sig.entry == null || sig.sl == null || sig.tp == null) return false;
  const e = parseFloat(sig.entry), sl = parseFloat(sig.sl), tp = parseFloat(sig.tp);
  if (Number.isNaN(e) || Number.isNaN(sl) || Number.isNaN(tp)) return false;
  if (sig.direction === 'LONG')  return sl < e && tp > e;
  if (sig.direction === 'SHORT') return sl > e && tp < e;
  return false;
}

function validateAndFixBEServer(sig) {
  if (!sig || !sig.be_note || sig.direction === 'NO TRADE') return sig;
  const isLong = sig.direction === 'LONG';
  const e = parseFloat(sig.entry), tp = parseFloat(sig.tp);
  const m = String(sig.be_note).match(/(?:at|@)\s*\$?([\d,]+(?:\.\d+)?)/i);
  const bePrice = m ? parseFloat(m[1].replace(/,/g, '')) : null;
  const validSide = bePrice != null && (isLong ? (bePrice > e && bePrice < tp) : (bePrice < e && bePrice > tp));
  if (!validSide) {
    const correctBE = isLong ? e + (tp - e) * BE_TRIGGER_PCT : e - (e - tp) * BE_TRIGGER_PCT;
    const decimals = e >= 1000 ? 2 : e >= 100 ? 2 : e >= 1 ? 4 : 6;
    sig.be_note = `Move SL to BE at ${correctBE.toFixed(decimals)} (50% to TP)`;
  }
  return sig;
}

function buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, trigger, indicators }) {
  const lines = [];
  lines.push(`AUTO TRIGGER: ${trigger.type.toUpperCase()} — ${trigger.desc}`);

  // ── ATR-based stop guidance (asset-class specific) ──
  if (indicators && indicators.atr14 != null) {
    const am = atrMultiplierForAsset(coin);
    const atrStopDist = indicators.atr14 * am.multiplier;
    const buffer = indicators.atr14 * SL_ATR_BUFFER;
    lines.push(
      `\nVOLATILITY (ATR-based stops — REPLACES fixed/round-number stops):` +
      `\n  ATR(14) on ${tf} = ${indicators.atr14.toFixed(4)}` +
      `\n  Asset class: ${am.klass} → multiplier ${am.multiplier}× ATR = ${atrStopDist.toFixed(4)} stop distance from entry` +
      `\n  STOP PLACEMENT RULE: place SL BEYOND structure (swing low for LONG, swing high for SHORT) + ${buffer.toFixed(4)} (${SL_ATR_BUFFER.toFixed(1)}×ATR) buffer.` +
      `\n  NEVER place SL on a round number — algos hunt those. Offset by at least 0.5×ATR.`
    );
  }
  if (indicators && indicators.adx != null) {
    lines.push(`ADX(14): ${indicators.adx.toFixed(1)}`);
  }
  if (indicators && indicators.volRatio != null) {
    lines.push(`Trigger volume: ${indicators.volRatio.toFixed(2)}× the 20-bar average`);
  }
  if (indicators && indicators.divergence) {
    lines.push(`RSI divergence: ${indicators.divergence === 'bearish' ? 'bearish (price HH, RSI LH)' : 'bullish (price LL, RSI HL)'}`);
  }
  if (indicators && indicators.regime && indicators.regime.regime) {
    const r = indicators.regime;
    lines.push(`4H regime: ${r.regime}, confidence ${r.confidence}${r.adx != null ? ', ADX ' + r.adx : ''}, 50-EMA slope ${r.slopePct >= 0 ? '+' : ''}${r.slopePct}%`);
  }
  if (indicators && indicators.confluenceScore != null) {
    lines.push(`PRE-AI CONFLUENCE SCORE: ${indicators.confluenceScore}/85`);
  }

  if (baseCandles && baseCandles.length >= 5) {
    const recent = baseCandles.slice(-15);
    const closes = recent.map(c => c.c);
    const highs = recent.map(c => c.h);
    const lows  = recent.map(c => c.l);
    const high = Math.max(...highs), low = Math.min(...lows);
    const lastClose = closes[closes.length - 1];
    const dir = closes[0] < lastClose ? 'rising' : 'falling';
    lines.push(`\n${tf} STRUCTURE (last 15 candles, trigger TF): range ${low.toFixed(4)} — ${high.toFixed(4)}, last close ${lastClose}, recent ${dir}.`);
  }

  if (mtfH1 && mtfH1.length >= 10) {
    const last = mtfH1[mtfH1.length - 1];
    const slice = mtfH1.slice(-20);
    const ema = slice.reduce((s, c) => s + c.c, 0) / slice.length;
    const high = Math.max(...slice.map(c => c.h));
    const low  = Math.min(...slice.map(c => c.l));
    lines.push(`1H CONTEXT: last ${last.c.toFixed(4)} | 20-EMA ${ema.toFixed(4)} (${last.c > ema ? 'above' : 'below'}) | range ${low.toFixed(4)} — ${high.toFixed(4)}.`);
  }

  if (mtfH4 && mtfH4.length >= 5) {
    const last = mtfH4[mtfH4.length - 1];
    const slice = mtfH4.slice(-10);
    const ema = slice.reduce((s, c) => s + c.c, 0) / slice.length;
    lines.push(`4H CONTEXT (HTF bias): last ${last.c.toFixed(4)} | 10-EMA ${ema.toFixed(4)} — ${last.c > ema ? 'above (bullish HTF)' : 'below (bearish HTF)'}.`);
  }

  if (btcCandles && btcCandles.length >= 5 && coin !== 'BTCUSDT') {
    const first = btcCandles[0].c;
    const last = btcCandles[btcCandles.length - 1].c;
    const pct = ((last - first) / first * 100).toFixed(2);
    const bias = parseFloat(pct) > 0.5 ? 'bullish' : parseFloat(pct) < -0.5 ? 'bearish' : 'neutral';
    lines.push(`BTC CORRELATION: BTC moved ${pct}% across recent candles — ${bias} for risk-on alts.`);
  }

  if (funding != null && !Number.isNaN(funding)) {
    const fpct = (funding * 100).toFixed(4);
    let fbias = 'neutral';
    if (funding >  0.01)  fbias = 'extreme positive (overcrowded longs — fade SHORT)';
    else if (funding >  0.005) fbias = 'positive (longs paying)';
    else if (funding < -0.01)  fbias = 'extreme negative (overcrowded shorts — fade LONG)';
    else if (funding < -0.005) fbias = 'negative (shorts paying)';
    lines.push(`FUNDING RATE: ${fpct}% — ${fbias}.`);
  }

  // OPEN INTEREST is no longer a static snapshot here — buildOIDeltaContextServer
  // appends a richer "OI change vs price change" line to the combined context.

  return lines.join('\n');
}

function buildServerSystemPrompt(coin, tf, broker, contextStr, lastClose) {
  const isMetal = /^(XAU|XAG|XTI|XBR)/.test(coin);
  const offset = isMetal ? 8 : (lastClose || 1) * 0.003;
  const slDist = isMetal ? 22 : (lastClose || 1) * 0.008;
  const tpDist = isMetal ? 38 : (lastClose || 1) * 0.012;
  const fmt = (v) => v != null ? v.toFixed(lastClose >= 1000 ? 2 : 4) : '0';
  const exLE = lastClose ? fmt(lastClose - offset) : '0';
  const exLS = lastClose ? fmt(lastClose - offset - slDist) : '0';
  const exLT = lastClose ? fmt(lastClose - offset + tpDist) : '0';
  const exSE = lastClose ? fmt(lastClose + offset) : '0';
  const exSS = lastClose ? fmt(lastClose + offset + slDist) : '0';
  const exST = lastClose ? fmt(lastClose + offset - tpDist) : '0';

  return [
    `You are Henry, an institutional futures trading AI. You are analysing ${coin} on ${tf} timeframe (${broker} broker) AUTONOMOUSLY (no human will retry — your output goes to a phone push and Discord embed directly).`,
    '',
    'You have access to these data sources — REFERENCE THEM in your reasoning field:',
    '1. Trigger detection — what fired the scan. ICT/S&D types: MSS+DISP (market structure shift with displacement), SWEEP+DISP (liquidity grab + close-in-opposite-half), OB MITIGATION (price retesting an unmitigated order block), S/D ZONE (first retest of a base+drop or base+rally pattern), FVG-OTE (fair value gap inside the 62-79% retracement). Legacy fallback: BOS, SWEEP, REJECTION, ATR, FVG.',
    '2. Multi-timeframe (1H, 4H) — HTF bias and structure',
    '3. Macro correlation — BTC for crypto pairs, DXY for gold/metals (gold has INVERSE correlation with DXY — DXY up = gold down). Use whichever is in the context block.',
    '4. Funding rate + FUNDING TREND — positioning and whether crowding is BUILDING or EASING; fade extremes.',
    '5. Open interest DELTA vs price — new-money fuel (price+OI same direction) vs position unwind (short-covering / long capitulation = weak move). Read the OI line, not a raw number.',
    '6. Liquidity heatmap — swing levels, equal highs/lows, sweep targets',
    '7. Order flow / footprint — buy/sell delta, POC, imbalances, absorption',
    '8. CVD trend — cumulative volume delta momentum across 5 windows',
    '9. Long/short ratio — retail accounts vs top traders; the DIVERGENCE (smart money fading the crowd) is the signal.',
    '10. Liquidations — real force-close prints; one-sided cascades mark capitulation/squeeze zones.',
    '11. Cross-broker check — agreement across Weex/Binance/Hyperliquid',
    '12. News headlines — sentiment + impact tagged',
    '13. Economic calendar — high-impact events in next 4 hours',
    '14. HENRY TRACK RECORD (if present) — your OWN realized results on THIS pair. This is the highest-signal block: lean into setups with proven edge, demand extra confluence on setups that have lost money, and respect the confidence-calibration note (if you are flagged OVERCONFIDENT, discount your stated confidence).',
    '',
    'CONTEXT FROM SERVER-SIDE SCAN:',
    contextStr,
    '',
    'CURRENT PRICE: ' + (lastClose != null ? lastClose : 'unknown') + '. DO NOT use current price as entry — choose a structural level (zone/FVG/OB/post-sweep).',
    '',
    'DIRECTION RULES — READ CAREFULLY:',
    `LONG: entry < current_price, SL BELOW entry, TP ABOVE entry. Example: entry=${exLE}, sl=${exLS}, tp=${exLT}`,
    `SHORT: entry > current_price (or at current for market), SL ABOVE entry, TP BELOW entry. Example: entry=${exSE}, sl=${exSS}, tp=${exST}`,
    'rr for LONG = (tp-entry)/(entry-sl). rr for SHORT = (entry-tp)/(sl-entry). BOTH must be positive numbers >= 1.3.',
    'RR FLOOR: if you cannot find a setup where RR >= 1.3, return direction "NO TRADE" — do not stretch TP or tighten SL artificially. A trade with RR < 1.3 will be auto-downgraded to NO TRADE on the server side.',
    '',
    'STOP-LOSS PLACEMENT — ATR-BASED (CRITICAL):',
    '• Use the ATR value provided in the context block. The asset-class multiplier is also given.',
    `• Place SL BEYOND the structural invalidation level (swing low for LONG, swing high for SHORT) PLUS a ${SL_ATR_BUFFER.toFixed(1)}×ATR buffer.`,
    `• For example, if structure low = 80,100 and ATR = 50, LONG SL should be near 80,100 - (${SL_ATR_BUFFER.toFixed(1)} × 50) = ${(80100 - SL_ATR_BUFFER * 50).toFixed(0)} — NOT at 80,100 itself.`,
    '• Distance from entry to SL should approximate the asset-class multiplier × ATR (e.g. 2.5×ATR for BTC/ETH, 3.0×ATR for SOL/AVAX/oil, 3.5×ATR for PEPE/DOGE).',
    '• NEVER place SL exactly on a round number (80,000, 2,300, 100, etc). 80% of retail stops cluster there and get hunted by algos. Offset by at least 0.5×ATR.',
    `• Tighter stops than ${SL_ATR_BUFFER.toFixed(1)}×ATR will fail more often. Wider than 4×ATR will tank your RR.`,
    '',
    'BE_NOTE RULES:',
    'be_note is the price at which the user moves SL to entry (breakeven).',
    `For LONG: BE price MUST be ABOVE entry, BELOW TP. Recommended: ${Math.round(BE_TRIGGER_PCT * 100)}% of the way from entry to TP.`,
    `For SHORT: BE price MUST be BELOW entry, ABOVE TP. Recommended: ${Math.round(BE_TRIGGER_PCT * 100)}% of the way from entry to TP.`,
    'Format: "Move SL to BE at <PRICE>".',
    '',
    'TRADE-OR-SKIP: every trigger reaches you with full filter context. Use your judgment to take or return "NO TRADE". A NO TRADE costs nothing; a bad signal costs 1R.',
    'IF YOU RETURN NO TRADE: the `reasoning` field must explain your judgment — which specific data points (ADX/volume/divergence/regime/confluence/HTF/news/etc) made you skip and how they weighed against the trigger. Be concrete (cite numbers), not generic ("low confluence" is not enough — say WHICH metric and WHY).',
    '',
    'CRITICAL OUTPUT FORMAT — READ TWICE:',
    '• Output ONLY raw JSON. Start with { and end with }. Nothing else.',
    '• DO NOT wrap in ```json ... ``` code fences.',
    '• DO NOT prefix with "Here is..." or any preamble.',
    '• DO NOT append commentary after the closing }.',
    '• Keep `reasoning` field UNDER 600 characters — concise, not essays.',
    '• If you run long, the response gets truncated and parsing fails — be terse.',
    '',
    'Schema:',
    `{"pair":"${coin}","direction":"LONG or SHORT or NO TRADE","entry":${exLE},"sl":${exLS},"tp":${exLT},"rr":2.1,"confidence":72,"session":"","entry_reason":"Level and why","reasoning":"Concise refs to data sources","be_note":"Move SL to BE at X","key_risk":"Main risk","expiry_candles":3,"invalidation":"Price action that cancels trade"}`,
    '',
    'VERIFY BEFORE OUTPUT: if SHORT then tp < entry < sl AND be_note price between tp and entry. If LONG then sl < entry < tp AND be_note price between entry and tp.',
  ].join('\n');
}

async function saveServerSignal(userId, signal, trigger, broker, tf) {
  try {
    const { data, error } = await supaAdmin.from('signals').insert({
      user_id: userId,
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry || null,
      sl: signal.sl || null,
      tp: signal.tp || null,
      rr: signal.rr || null,
      confidence: signal.confidence || null,
      session_name: signal.session || null,
      broker: broker || null,
      timeframe: tf || null,
      trigger_type: trigger?.type || null,
      trigger_desc: trigger?.desc || null,
      entry_reason: signal.entry_reason || null,
      reasoning: signal.reasoning || null,
      be_note: signal.be_note || null,
      key_risk: signal.key_risk || null,
      invalidation: signal.invalidation || null,
      expiry_candles: signal.expiry_candles || null,
    }).select('id').single();
    if (error) { console.error('[saveServerSignal]', signal.pair, error.message); return null; }
    console.log('[saveServerSignal] saved', signal.pair, signal.direction, 'id=' + data.id);
    return data.id;
  } catch (e) { console.error('[saveServerSignal]', signal.pair, e.message); return null; }
}

async function postServerSignalToDiscord(signal, trigger, broker, tf) {
  const urls = signalWebhooks().filter(Boolean); // auto channel + signals mirror
  if (!urls.length || !signal || signal.direction === 'NO TRADE') return;
  const isLong = signal.direction === 'LONG';
  const triggerLabel = trigger ? `[AUTO ${trigger.type.toUpperCase()}] ${trigger.desc}` : 'Auto-generated';
  const fields = [
    { name: 'Entry',      value: '`' + (signal.entry ?? '—') + '`',          inline: true },
    { name: 'Stop Loss',  value: '`' + (signal.sl    ?? '—') + '`',          inline: true },
    { name: 'Take Profit',value: '`' + (signal.tp    ?? '—') + '`',          inline: true },
    { name: 'RR',         value: '`' + (signal.rr    ?? '—') + 'R`',         inline: true },
    { name: 'Confidence', value: '`' + (signal.confidence ?? '—') + '%`',    inline: true },
    { name: 'Broker / TF',value: '`' + (broker || '—') + ' / ' + (tf || '—') + '`', inline: true },
  ];
  const embed = {
    title: `⚡ ${isLong ? '🟢' : '🔴'} SERVER AUTO: ${signal.pair} ${signal.direction}`,
    color: isLong ? 3066993 : 15548997,
    description: `**Trigger:** ${triggerLabel}\n`
      + (signal.entry_reason ? `**Entry:** ${signal.entry_reason}\n` : '')
      + (signal.reasoning ? String(signal.reasoning).slice(0, 600) : '')
      + (signal.be_note ? `\n⚑ **${signal.be_note}**` : '')
      + (signal.key_risk ? `\n⚠ ${signal.key_risk}` : '')
      + (signal.invalidation ? `\n✕ Invalidated if: ${signal.invalidation}` : '')
      + (signal.expiry_candles ? `\n⏱ Expires: ${signal.expiry_candles} candles on ${tf}` : ''),
    fields,
    footer: { text: 'Henry Server Auto-Scan | ' + new Date().toUTCString() },
    timestamp: new Date().toISOString(),
  };
  await postJsonToWebhooks(urls, { embeds: [embed], username: 'Henry Auto' }, 'server signal discord');
}

// Light "setup pending" Discord alert — fires at signal generation, BEFORE
// LTF confirmation. Single-line content, no rich embed. The full embed
// posts later via postServerSignalToDiscord() once confirmation arrives
// and the entry price is locked in.
async function postPendingSetupToDiscord(signal, trigger, broker, tf) {
  const urls = signalWebhooks().filter(Boolean); // auto channel + signals mirror
  if (!urls.length || !signal || signal.direction === 'NO TRADE') return;
  const dir = signal.direction;
  const emoji = dir === 'LONG' ? '🟢' : '🔴';
  const coin = String(signal.pair || '').replace('USDT', '');
  const content = `🔍 ${emoji} **${coin} ${dir} SETUP** — waiting LTF confirmation\n`
    + `Planned entry \`${signal.entry}\` · SL \`${signal.sl}\` · TP \`${signal.tp}\` · ${signal.rr || '—'}R @ ${signal.confidence || '—'}% · ${broker || '—'}/${tf || '—'}`;
  await postJsonToWebhooks(urls, { content, username: 'Henry Auto' }, 'server pending discord');
}

// Light "signal skipped — drift" Discord alert. Fires when LTF confirmation
// arrives but the market has drifted further than HENRY_MAX_CONFIRM_DRIFT_PCT
// from the planned entry, so we refuse to take the trade.
async function postSkippedToDiscord(signal, confirmPrice, driftPct, broker, tf) {
  const urls = signalWebhooks().filter(Boolean); // auto channel + signals mirror
  if (!urls.length || !signal) return;
  const dir = signal.direction;
  const coin = String(signal.pair || '').replace('USDT', '');
  const content = `❌ **${coin} ${dir} SKIPPED** — confirmation arrived at \`${confirmPrice}\` but planned entry was \`${signal.entry}\` (drift ${(driftPct * 100).toFixed(2)}%)`;
  await postJsonToWebhooks(urls, { content, username: 'Henry Auto' }, 'server skipped discord');
}

// Main entry — runs the full AI flow on the server when a trigger fires for a pair.
async function runServerAIForPair(userId, sub, coin, ps, trigger, baseCandles, brokerOverride, tfOverride) {
  const { isAdmin } = sub;
  // tfOverride lets per-pair scanners (e.g. gold on 5m) use a different TF
  // than the subscription default. Falls back to sub.tf for everything else.
  const tf = tfOverride || sub.tf;
  // Route to the pair's appropriate broker (GOLD → massive, etc.)
  const broker = brokerOverride || brokerForPair(coin, sub.broker);
  const lastClose = baseCandles && baseCandles.length ? baseCandles[baseCandles.length - 1].c : null;

  // Macro reference depends on the asset class:
  //   • Gold spot, gold-tokens, silver, oil (XAU*/XAG*/XTI*/XBR*/GOLD) → DXY
  //     (these track the dollar / commodities, not crypto risk-appetite)
  //   • Crypto (BTC, ETH, SOL, etc.) → BTC correlation (risk-on/risk-off)
  const isMetalOrOilPair = coin === 'GOLD' || coin === 'XAUUSD' || /^(XAU|XAG|XTI|XBR)/.test(coin);
  const btcBroker = (broker === 'massive') ? 'binance' : broker;

  // Fetch all extra context in parallel — failures are isolated, AI gets whatever lands.
  const [
    mtfH1, mtfH4, btcCandles, funding,
    trades, newsCtx, calCtx, crossBrokerCtx, dxyData,
    oiDeltaCtx, fundingTrendCtx, lsRatioCtx, perfFeedbackCtx,
  ] = await Promise.all([
    fetchCandlesServer(coin, '1h', 50, broker).catch(() => []),
    fetchCandlesServer(coin, '4h', 30, broker).catch(() => []),
    // BTC correlation only for non-gold + non-BTC pairs
    (!isMetalOrOilPair && coin !== 'BTCUSDT') ? fetchCandlesServer('BTCUSDT', tf, 30, btcBroker).catch(() => []) : Promise.resolve([]),
    fetchFundingRateServer(coin).catch(() => null),
    fetchTradesServer(coin, broker).catch(() => []),
    fetchNewsContext().catch(() => ''),
    fetchCalendarContext().catch(() => ''),
    buildCrossBrokerContextServer(coin, tf, broker).catch(() => ''),
    // DXY context for gold pairs only — replaces BTC correlation
    isMetalOrOilPair ? fetchDXYContextServer().catch(() => null) : Promise.resolve(null),
    // Positioning / OI-delta / funding-trend / self-performance — graceful-empty on failure
    buildOIDeltaContextServer(coin, tf, baseCandles).catch(() => ''),
    buildFundingTrendContextServer(coin).catch(() => ''),
    buildLongShortRatioContextServer(coin, tf).catch(() => ''),
    buildPerfFeedbackContextServer(coin).catch(() => ''),
  ]);

  // Derived contexts from data we already fetched (synchronous, no extra fetches)
  const liquidityCtx = buildLiquidityContextServer(baseCandles, tf);
  const footprintCtx = buildFootprintContextServer(trades, baseCandles);
  const cvdCtx       = buildCVDContextServer(trades);
  const liqCtx       = buildLiquidationContextServer(coin, baseCandles);

  // Combine everything into one context block
  // For gold: DXY context replaces the BTC correlation block (which is empty for gold anyway)
  // Use cached indicators from processPair if available (computed for the hard vetoes)
  const indicators = ps && ps.lastIndicators ? ps.lastIndicators : {
    atr14: computeATR(baseCandles, 14),
    adx: computeADX(baseCandles, 14),
    volRatio: (() => {
      const last = baseCandles[baseCandles.length - 1];
      const avg = baseCandles.slice(-21, -1).reduce((s, c) => s + (c.v || 0), 0) / 20;
      return avg > 0 ? (last.v || 0) / avg : null;
    })(),
    divergence: detectDivergence(baseCandles, 30),
  };
  const baseCtx = buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, trigger, indicators });
  const dxyCtx = isMetalOrOilPair ? buildDXYContextString(dxyData) : '';
  const contextStr = [baseCtx, dxyCtx, oiDeltaCtx, fundingTrendCtx, lsRatioCtx, liquidityCtx, footprintCtx, cvdCtx, liqCtx, crossBrokerCtx, newsCtx, calCtx, perfFeedbackCtx]
    .filter(s => s && s.length).join('\n');

  const systemPrompt = buildServerSystemPrompt(coin, tf, broker, contextStr, lastClose);
  const userMessage = `Analyse ${coin} on ${tf}. Auto trigger fired: ${trigger.type.toUpperCase()} — ${trigger.desc}. Output the signal JSON.`;

  const preScore = indicators && indicators.confluenceScore != null ? indicators.confluenceScore : '?';
  console.log(`[autoscan→AI] ${coin} ${tf} trigger=${trigger.type} preConf=${preScore}/85 — calling Claude...`);

  let signal = null;
  try {
    // 2000 max tokens — Sonnet 4.6 is more verbose than 4.0; truncation kills JSON parsing
    const text = await callAnthropicServer(systemPrompt, userMessage, 2000);
    signal = parseSignalJSONServer(text);
  } catch (e) {
    console.error(`[autoscan→AI] ${coin} call failed: ${e.message}`);
    return null;
  }
  if (!signal) { console.error(`[autoscan→AI] ${coin} no JSON parsed from Claude response`); return null; }

  // Validate levels — auto-retry once with explicit correction
  if (signal.direction !== 'NO TRADE' && !validateSignalLevelsServer(signal)) {
    console.warn(`[autoscan→AI] ${coin} invalid levels (dir=${signal.direction} entry=${signal.entry} SL=${signal.sl} TP=${signal.tp}), retrying once`);
    const correction = `Your previous output had invalid levels. Direction was ${signal.direction} but: entry=${signal.entry} SL=${signal.sl} TP=${signal.tp}. ` +
      (signal.direction === 'LONG' ? 'For LONG: SL must be BELOW entry, TP must be ABOVE entry.' : 'For SHORT: SL must be ABOVE entry, TP must be BELOW entry.') +
      ' Recalculate and output corrected JSON only.';
    try {
      const retryText = await callAnthropicServer(systemPrompt, userMessage + '\n\n' + correction, 1500);
      const retried = parseSignalJSONServer(retryText);
      if (retried && validateSignalLevelsServer(retried)) signal = retried;
    } catch (e) { console.error(`[autoscan→AI] ${coin} retry call failed: ${e.message}`); }
  }
  if (signal.direction !== 'NO TRADE' && !validateSignalLevelsServer(signal)) {
    console.error(`[autoscan→AI] ${coin} still invalid after retry, aborting`);
    return null;
  }

  // ── fvg_ote exit normalization ──────────────────────────────────────────────
  // TP-vs-SL autopsy on the 28 resolved fvg_ote trades (May 11 – Jun 3): 10 of
  // 16 SLs reached their planned TP within 48h of stopping out — the stop sat
  // inside the OTE zone's probe range. And all 8 trades that aimed ≥2R lost;
  // no loser ever ran past 1.52R favorable. Entering inside a 62-79% retrace
  // needs room for the sweep, and the setup's natural reach is ~1.5R.
  // Floor the stop distance, then pull the target to maxRR of the (possibly
  // widened) stop — never extending the AI's TP. Runs BEFORE the RR floor on
  // purpose: if widening the stop leaves <1.3R to the target, the trade isn't
  // worth taking and the floor below downgrades it. Set a var to 0 to disable.
  if (signal.direction !== 'NO TRADE' && trigger.type === 'fvg_ote' && signal.entry && signal.sl && signal.tp) {
    const envNum = (n, d) => { const v = parseFloat(process.env[n]); return Number.isFinite(v) ? v : d; };
    const minSlPct = isGoldCoin(coin) ? envNum('HENRY_FVG_OTE_MIN_SL_PCT_GOLD', 0.25)
                                      : envNum('HENRY_FVG_OTE_MIN_SL_PCT', 0.6);
    const maxRR = envNum('HENRY_FVG_OTE_MAX_RR', 1.5);
    const e = parseFloat(signal.entry);
    const dirSign = signal.direction === 'LONG' ? 1 : -1;
    let sl = parseFloat(signal.sl), tp = parseFloat(signal.tp);
    if (minSlPct > 0 && e > 0 && Math.abs(e - sl) < e * minSlPct / 100) {
      const widened = Number((e - dirSign * e * minSlPct / 100).toPrecision(8));
      console.log(`[fvg_ote exits] ${coin} ${signal.direction} SL ${sl} → ${widened} (floor ${minSlPct}%)`);
      sl = widened; signal.sl = widened;
    }
    const risk = Math.abs(e - sl);
    if (maxRR > 0 && risk > 0 && Math.abs(tp - e) > maxRR * risk) {
      const capped = Number((e + dirSign * maxRR * risk).toPrecision(8));
      console.log(`[fvg_ote exits] ${coin} ${signal.direction} TP ${tp} → ${capped} (cap ${maxRR}R)`);
      tp = capped; signal.tp = capped;
    }
    if (risk > 0) signal.rr = +(Math.abs(tp - e) / risk).toFixed(2);
  }

  // ── RR floor: any signal with computed RR < 1.3 is downgraded to NO TRADE ──
  // Lowered from 1.5 → 1.3 (May 2026) so borderline-OK setups still surface to the
  // user — they were previously being silently auto-downgraded. 1.3 is still a
  // sane minimum (you're risking 1R to gain 1.3R, ~57% win rate breakeven).
  const RR_FLOOR = 1.3;
  if (signal.direction !== 'NO TRADE' && signal.entry && signal.sl && signal.tp) {
    const e = parseFloat(signal.entry), sl = parseFloat(signal.sl), tp = parseFloat(signal.tp);
    const rr = signal.direction === 'LONG' ? (tp - e) / (e - sl) : (e - tp) / (sl - e);
    if (isFinite(rr) && rr < RR_FLOOR) {
      console.log(`[autoscan→AI] ${coin} ${signal.direction} RR ${rr.toFixed(2)} < ${RR_FLOOR} → downgrading to NO TRADE`);
      const origDir = signal.direction;
      signal.direction = 'NO TRADE';
      signal.reasoning = `Auto-downgraded from ${origDir}: computed RR ${rr.toFixed(2)} below ${RR_FLOOR}R minimum. ` + (signal.reasoning || '');
    } else if (isFinite(rr)) {
      console.log(`[autoscan→AI] ${coin} ${signal.direction} SIGNAL accepted: entry=${signal.entry} SL=${signal.sl} TP=${signal.tp} RR=${rr.toFixed(2)} conf=${signal.confidence || '?'}`);
    }
  } else if (signal.direction === 'NO TRADE') {
    console.log(`[autoscan→AI] ${coin} AI returned NO TRADE: ${(signal.reasoning || '').slice(0, 140)}`);
  }

  // NO TRADE — just push a notification, don't activate the monitor
  if (signal.direction === 'NO TRADE') {
    await sendPushTo(userId, {
      title: `${coin.replace('USDT', '')}: NO TRADE`,
      body: signal.reasoning ? String(signal.reasoning).slice(0, 120) : 'AI suggests no trade right now.',
      icon: '/manifest.json',
    });
    return signal;
  }

  // Patch 1 — opposite-direction veto. If another pair in the same correlation
  // cluster already has a pending or in-trade position in the OPPOSITE
  // direction, refuse this new signal. We're not adding edge by stacking
  // LONG+SHORT on highly-correlated pairs — we're paying double fees and
  // trading noise. Same-direction stacking stays allowed (it's profitable
  // historically, see analyze_stacked.py results).
  {
    const conflict = checkOppositeDirectionConflict(sub, coin, signal.direction);
    if (conflict.blocked) {
      console.log(`[oppdir veto] ${coin} ${signal.direction}: ${conflict.reason}`);
      await sendPushTo(userId, {
        title: `${coin.replace('USDT', '')}: setup rejected`,
        body: conflict.reason,
        icon: '/manifest.json',
      });
      // Discord veto card removed 2026-06-07 — too noisy. The veto still fires:
      // it's logged server-side (above) and pushed to the user. Re-add a
      // postJsonToWebhooks(signalWebhooks(), {content: …}) call here if the audit
      // card is ever wanted back.
      // Cooldown so we don't immediately retrigger on the next scan tick
      ps.cooldownUntil = Date.now() + Math.min(effectiveCooldownMs(sub), 5 * 60 * 1000);
      ps.lastVetoReason = conflict.reason;
      return signal;
    }
  }

  signal = validateAndFixBEServer(signal);
  signal.session = normalizeSessionName(signal.session);
  if (signal.confidence != null) signal.confidence = Math.max(0, Math.min(100, parseFloat(signal.confidence) || 0));

  // Confirm-then-execute flow: at signal generation we DON'T persist the
  // signal, post the full Discord embed, or place the WEEX order. We only
  // stash it as pending and send a light "setup detected, waiting confirm"
  // alert. The real signal record + Discord embed + WEEX MARKET order all
  // fire later in processPair → _confirmAndExecuteSignal once the LTF gate
  // (or browser-confirmed flag) trips. This makes the posted entry price
  // match the actual fill price — no more market-rescue divergence.

  // Light push: "Setup pending"
  await sendPushTo(userId, {
    title: `🔍 ${coin.replace('USDT', '')} ${signal.direction} setup`,
    body: `Waiting LTF confirmation · planned ${signal.entry} (SL ${signal.sl}, TP ${signal.tp}, ${signal.rr || '—'}R)`,
    icon: '/manifest.json',
    data: { coin, tf, broker, trigger, signal, pending: true },
  });

  // Light Discord "setup pending" alert (admin only)
  if (isAdmin || (sub.email && sub.email === ADMIN_EMAIL)) {
    await postPendingSetupToDiscord(signal, trigger, broker, tf).catch(e => console.error('[discord pending]', e.message));
  }

  // Stage the pending signal — no signalId yet, will be assigned at confirmation
  ps.pendSignal = signal;
  ps.signalId = null;
  ps.signalTimestamp = Date.now();
  ps._entryAlerted = false;
  ps._beAlerted = false;
  ps._tpAlerted = false;
  ps._expiryAlerted = false;
  ps._outcomeLogged = false;
  ps._confirmationPending = true;  // gate open, waiting for LTF
  ps._trigger = trigger;
  ps._broker = broker;
  ps.lastStatus = 'waiting-confirm';
  ps._weexEntryFired = false;
  ps._weexBeFired = false;
  ps._weexClosed = false;
  // AUTOSCAN-ONLY WEEX GATE: this staging path is reached ONLY from the scan
  // loop (runServerAIForPair, the sole caller). Mark the pair-state as
  // auto-executable so the WEEX hooks may fire. Manual ANALYSE never sets this,
  // so a hand-taken signal can never open/manage/close a WEEX position — even
  // on the admin account. Auto-trade is exclusively an autoscan feature.
  ps._autoExec = true;

  return signal;
}

// Slippage cap (env-configurable). If the market drifts further than this
// from the planned entry between signal generation and LTF confirmation,
// we refuse the trade rather than enter at a degraded price. Default 0.5%.
const HENRY_MAX_CONFIRM_DRIFT_PCT = parseFloat(process.env.HENRY_MAX_CONFIRM_DRIFT_PCT) || 0.5;

// Called when LTF confirmation fires for a pending signal. Locks the entry
// at the current market price, persists the signal row, posts the full
// Discord embed (NOW the entry matches what WEEX will fill), and triggers
// the executor's MARKET order placement.
async function _confirmAndExecuteSignal(userId, sub, ps, coin, currentPrice, confirmLabel) {
  const pendSignal = ps.pendSignal;
  if (!pendSignal || pendSignal.direction === 'NO TRADE') return;
  const isAdmin = !!(sub.isAdmin || (sub.email && sub.email === ADMIN_EMAIL));
  const tf = sub.tf;
  const broker = ps._broker || sub.broker;
  const trigger = ps._trigger || null;

  // Slippage cap — if market drifted past the cap, skip the trade.
  const plannedEntry = parseFloat(pendSignal.entry);
  const drift = plannedEntry > 0 ? Math.abs(currentPrice - plannedEntry) / plannedEntry : 0;
  const driftCap = HENRY_MAX_CONFIRM_DRIFT_PCT / 100;
  if (drift > driftCap) {
    console.log('[confirm]', coin, 'drift', (drift * 100).toFixed(2), '% > cap', (driftCap * 100).toFixed(2), '% — skipping');
    await notifyUser(userId, isAdmin, {
      title: `❌ Signal skipped: ${coin.replace('USDT', '')} drift`,
      body: `Confirmation @ ${currentPrice}, planned entry was ${plannedEntry} (drift ${(drift * 100).toFixed(2)}%). Skipping.`,
      color: 're',
    });
    if (isAdmin || (sub.email && sub.email === ADMIN_EMAIL)) {
      await postSkippedToDiscord(pendSignal, currentPrice, drift, broker, tf).catch(e => console.error('[discord skipped]', e.message));
    }
    clearPairState(ps);
    return;
  }

  // Build the confirmed signal — entry locked at current price, SL/TP unchanged
  // (the AI's target levels are absolute, not entry-relative). RR recomputes.
  const slP = parseFloat(pendSignal.sl), tpP = parseFloat(pendSignal.tp);
  const rrSafe = (slP && currentPrice && Math.abs(currentPrice - slP) > 0)
    ? +(Math.abs(tpP - currentPrice) / Math.abs(currentPrice - slP)).toFixed(2)
    : (parseFloat(pendSignal.rr) || null);
  const confirmedSignal = {
    ...pendSignal,
    entry: currentPrice,
    rr: rrSafe,
  };

  // ── Re-validate AFTER locking the entry to the fill price ──────────────────
  // During the LTF wait the market can move enough that the refined entry
  // crosses its own SL/TP (wrong-side geometry → instant stop, e.g. the 54R
  // XAUT short) or the RR collapses below the floor (e.g. a 0.3R long) — even
  // while staying inside the drift cap. rrSafe above uses Math.abs so it cannot
  // see broken geometry; recompute SIGNED here and skip rather than enter a
  // degenerate trade. Mirrors the generation-time RR floor.
  {
    const dir = pendSignal.direction;
    const RR_FLOOR = 1.3;
    const MIN_SL_PCT = parseFloat(process.env.HENRY_MIN_SL_PCT) || 0.08; // reject near-zero-risk stops
    const geomOk = (dir === 'LONG') ? (slP < currentPrice && tpP > currentPrice)
                                     : (slP > currentPrice && tpP < currentPrice);
    const signedRR = (dir === 'LONG') ? (tpP - currentPrice) / (currentPrice - slP)
                                       : (currentPrice - tpP) / (slP - currentPrice);
    const slDistPct = currentPrice > 0 ? Math.abs(currentPrice - slP) / currentPrice * 100 : 0;
    let bad = null;
    if (!geomOk) bad = `entry ${currentPrice} crossed its stop/target after the LTF wait (SL ${slP} / TP ${tpP})`;
    else if (slDistPct < MIN_SL_PCT) bad = `stop only ${slDistPct.toFixed(3)}% away (< ${MIN_SL_PCT}%) — degenerate risk`;
    else if (!isFinite(signedRR) || signedRR < RR_FLOOR) bad = `RR collapsed to ${isFinite(signedRR) ? signedRR.toFixed(2) : 'n/a'} (< ${RR_FLOOR}) at the confirmed entry`;
    if (bad) {
      console.log('[confirm]', coin, dir, 'invalid at confirmation —', bad, '— skipping');
      await notifyUser(userId, isAdmin, {
        title: `❌ Signal skipped: ${coin.replace('USDT', '')} ${dir}`,
        body: `${bad}. Planned ${plannedEntry} → confirm ${currentPrice}. Skipping.`,
        color: 're',
      });
      if (isAdmin || (sub.email && sub.email === ADMIN_EMAIL)) {
        await postSkippedToDiscord(pendSignal, currentPrice, drift, broker, tf).catch(e => console.error('[discord skipped]', e.message));
      }
      clearPairState(ps);
      ps.cooldownUntil = Date.now() + Math.min(effectiveCooldownMs(sub), 5 * 60 * 1000);
      return;
    }
    confirmedSignal.rr = +signedRR.toFixed(2); // signed == abs here (geometry validated), keep it honest
  }

  // Persist with the confirmed entry
  const signalId = await saveServerSignal(userId, confirmedSignal, trigger, broker, tf);
  ps.signalId = signalId;
  ps.pendSignal = confirmedSignal;
  ps.signalTimestamp = Date.now();

  // Rich push + full Discord embed — both reflect the actual fill price
  await sendPushTo(userId, {
    title: `⚡ ${confirmedSignal.direction === 'LONG' ? '🟢' : '🔴'} ${coin.replace('USDT', '')} ${confirmedSignal.direction} CONFIRMED`,
    body: `Entry ${currentPrice} | SL ${pendSignal.sl} | TP ${pendSignal.tp} | ${rrSafe ?? '—'}R @ ${confirmedSignal.confidence || '—'}%${confirmLabel ? ' · ' + confirmLabel : ''}`,
    icon: '/manifest.json',
    data: { coin, tf, broker, signalId, trigger, signal: confirmedSignal },
  });
  if (isAdmin || (sub.email && sub.email === ADMIN_EMAIL)) {
    await postServerSignalToDiscord(confirmedSignal, trigger, broker, tf).catch(e => console.error('[discord auto]', e.message));
  }

  // Flip state to active — the trade is committed
  ps._entryAlerted = true;
  ps._expiryAlerted = true;
  ps._confirmationPending = false;
  ps.lastStatus = 'in-trade';

  // Fire the WEEX MARKET order. _weexEntryFired set so the entry-hit hook is a no-op.
  // ps._autoExec guarantees this is an autoscan-originated signal (manual ANALYSE never sets it).
  if (autoTradeAllowed(isAdmin) && ps._autoExec && signalId) {
    ps._weexEntryFired = true;
    fireExecutor('handleSetup', {
      signalId, pair: confirmedSignal.pair,
      side: confirmedSignal.direction === 'LONG' ? 'long' : 'short',
      entry: currentPrice,
      sl: parseFloat(confirmedSignal.sl),
      tp: parseFloat(confirmedSignal.tp),
    }, 'setup');
  }
}

async function runServerScan(userId, sub) {
  if (!sub.active) return;

  // Determine pairs to process: custom watchlist if set, else fall back to current coin
  const pairs = (sub.watchlist && sub.watchlist.length)
    ? sub.watchlist
    : [sub.coin];

  // Process each pair INDEPENDENTLY in parallel.
  // Pairs in active trade are monitored. Pairs idle + past cooldown get scanned + analysed.
  // Pairs in cooldown skip this tick.
  await Promise.all(pairs.map(coin => processPair(userId, sub, coin)));
}

async function processPair(userId, sub, coin) {
  const ps = getPairState(sub, coin);
  // Each pair routes to its appropriate broker (e.g. GOLD → 'massive'/Polygon)
  const broker = brokerForPair(coin, sub.broker);

  // Diagnostic counters — updated every tick regardless of branch taken,
  // so /api/scan/debug can show "scan loop alive? how stale is the data?"
  ps.lastTickAt = Date.now();
  ps.tickCount = (ps.tickCount || 0) + 1;

  // Snapshot state at top of tick. We diff against this at the bottom and
  // push any transitions to subscribed SSE clients so the browser gets
  // entry/BE/TP/SL alerts the instant the scan loop flips them.
  const _pre = {
    hasSignal:     !!ps.pendSignal,
    entryAlerted:  !!ps._entryAlerted,
    beAlerted:     !!ps._beAlerted,
    tpAlerted:     !!ps._tpAlerted,
    expiryAlerted: !!ps._expiryAlerted,
  };
  const _emitDiffs = () => {
    try {
      if (!_pre.hasSignal && ps.pendSignal) {
        emitScanEvent(userId, { type: 'signal', coin, signal: ps.pendSignal, signalId: ps.signalId, ts: Date.now() });
      }
      if (!_pre.entryAlerted && ps._entryAlerted) {
        emitScanEvent(userId, { type: 'entry', coin, signal: ps.pendSignal, signalId: ps.signalId, ts: Date.now() });
      }
      if (!_pre.beAlerted && ps._beAlerted) {
        emitScanEvent(userId, { type: 'be', coin, signal: ps.pendSignal, signalId: ps.signalId, ts: Date.now() });
      }
      if (!_pre.tpAlerted && ps._tpAlerted) {
        emitScanEvent(userId, { type: 'tp', coin, signal: ps.pendSignal, signalId: ps.signalId, ts: Date.now() });
      }
      if (!_pre.expiryAlerted && ps._expiryAlerted && !ps._tpAlerted) {
        emitScanEvent(userId, { type: 'expired', coin, signal: ps.pendSignal, signalId: ps.signalId, ts: Date.now() });
      }
    } catch (e) { console.warn('[sse emit]', coin, e.message); }
  };

  // 1) If pair has an active signal → monitor it (entry/BE/TP/SL/expiry)
  //    Trade monitor still runs even if circuit breaker is on — once you're IN
  //    a trade, you need exit alerts regardless.
  if (ps.pendSignal) {
    try {
      await runServerTradeMonitorForPair(userId, sub, coin, ps, broker);
    } catch (e) { console.error('[monitor]', coin, e.message); }
    _emitDiffs();
    return;
  }

  // 2) Risk circuit breaker — pause new signal generation if losing streak detected
  const cb = circuitBreakerStatus(sub, coin);
  if (cb.paused) {
    ps.lastStatus = 'paused';
    ps.pauseUntil = cb.pauseUntil;
    ps.pauseReason = `${cb.scope === 'global' ? 'GLOBAL' : 'PAIR'}: ${cb.reason}`;
    return;
  }
  // Clear any stale pause flags
  ps.pauseUntil = 0;
  ps.pauseReason = null;

  // 3) Else if past cooldown → scan + (if triggered) run AI
  if (Date.now() < ps.cooldownUntil) {
    ps.lastStatus = 'cooldown';
    return;
  }

  // 3a) RACE GUARD — synchronous in-flight lock.
  //     processPair contains multiple awaits (fetch candles, funding, regime,
  //     pre-AI score, AI call) before cooldownUntil is set. Without this lock,
  //     a second 30s scan tick can race into the same code path while the
  //     first is mid-flight, see pendSignal still null + cooldownUntil still
  //     in the past, and fire the SAME trigger twice → duplicate Discord posts.
  //     The lock is checked + set synchronously here, then released in finally.
  //     Stale-lock fallback: if a tick crashed and somehow left the lock set,
  //     auto-release after 90s so the pair doesn't get stuck forever.
  if (ps._scanInFlight) {
    if (Date.now() - (ps._scanLockAt || 0) < 90_000) {
      ps.lastStatus = 'cooldown';
      return;
    }
    console.warn('[scan] stale lock on', coin, '— releasing');
  }
  ps._scanInFlight = true;
  ps._scanLockAt = Date.now();
  ps.lastStatus = 'scanning';

  // Per-pair timeframe override — gold scans on 5m even when the subscription
  // default is 15m. Threaded into every downstream fetch + the AI prompt so
  // the AI knows which TF it's analysing.
  const effectiveTf = tfForCoin(coin, sub.tf);

  // Gold news gate — skip new gold entries within 30 min of a high-impact
  // USD/EUR/GBP release (NFP/CPI/FOMC/etc). Calendar cache warmed lazily.
  if (/^(GOLD|XAU|XAG|XTI|XBR)/i.test(coin)) {
    try { await fetchCalendarContext(); } catch {}
    const ev = imminentGoldNewsEvent();
    if (ev) {
      const mins = Math.round((ev.dt - Date.now()) / 60000);
      console.log('[gold news gate]', coin, 'skipping —', ev.zone, ev.name, mins >= 0 ? `in ${mins} min` : `${-mins} min ago`);
      ps.lastStatus = 'news-gate';
      ps.lastVetoReason = `News gate: ${ev.zone} ${ev.name} (${mins >= 0 ? mins + 'min ahead' : -mins + 'min ago'})`;
      ps.cooldownUntil = Date.now() + Math.min(effectiveCooldownMs(sub), 5 * 60 * 1000);
      return;
    }
  }

  // NY-open entry block (13:00-14:30 UTC) — skip new signal generation during
  // the NY sweep window. Per analyze_ny_sweep.py (2026-05-30), NY-window
  // entries had elevated SL hit rate; existing trades stay monitored. Toggle
  // via HENRY_BLOCK_NY_OPEN env var. Window narrowed to end 30min after
  // US cash open (was 15:30 → 14:30) so we don't sit out the first hour
  // of post-open momentum trades.
  if (HENRY_BLOCK_NY_OPEN) {
    const now = new Date();
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (utcMin >= NY_OPEN_BLOCK_START_MIN && utcMin < NY_OPEN_BLOCK_END_MIN) {
      ps.lastStatus = 'ny-open-block';
      ps.lastVetoReason = `NY-open entry block (13:00-14:30 UTC, sweep window)`;
      // Long cooldown so we don't spam this check every tick — the gate runs
      // at most once every 5 min while in window.
      ps.cooldownUntil = Date.now() + Math.min(effectiveCooldownMs(sub), 5 * 60 * 1000);
      return;
    }
  }

  // Gold weekend block — the real gold market is shut Fri 21:00 UTC → Sun close,
  // so skip NEW gold autoscan entries in that window (existing trades stay
  // monitored; crypto pairs untouched). Toggle via HENRY_BLOCK_GOLD_WEEKEND.
  if (HENRY_BLOCK_GOLD_WEEKEND && isGoldCoin(coin) && isGoldWeekendBlocked(new Date())) {
    ps.lastStatus = 'gold-weekend-block';
    ps.lastVetoReason = 'Gold weekend block (Fri 21:00 UTC -> Mon, market closed)';
    ps.cooldownUntil = Date.now() + Math.min(effectiveCooldownMs(sub), 5 * 60 * 1000);
    return;
  }

  try {
    // Fetch candles + detect trigger (using the pair's appropriate broker)
    let candles, trigger;
    try {
      candles = await fetchCandlesServer(coin, effectiveTf, 30, broker);
      trigger = (candles && candles.length >= 11) ? detectTrigger(candles) : null;
      // Gold/metals fallback: if no base trigger fired, try the DXY-divergence
      // detector. This gives gold an extra signal source — see analysis showing
      // gold is your highest-edge instrument (~0.82R/trade vs ~0.22R for crypto).
      if (!trigger && /^(GOLD|XAU|XAG|XTI|XBR)/i.test(coin)) {
        trigger = await detectDxyDivergence(coin, candles).catch(() => null);
        if (trigger) console.log('[dxy divergence]', coin, trigger.desc);
      }
    } catch (e) {
      console.error('[scan]', coin, e.message);
      return;
    }
    if (candles && candles.length) ps.lastPrice = candles[candles.length - 1].c;
    if (!trigger) {
      ps.ticksSinceTrigger = (ps.ticksSinceTrigger || 0) + 1;
      return;
    }
    // A trigger fired — reset the counter
    ps.ticksSinceTrigger = 0;

    // 4) HARD VETOES — pre-compute indicators, run defensive filters before AI
    const adx = computeADX(candles, 14);
    const atr14 = computeATR(candles, 14);
    const lastCandle = candles[candles.length - 1];
    const avgVol20 = candles.slice(-21, -1).reduce((s, c) => s + (c.v || 0), 0) / 20;
    const volRatio = avgVol20 > 0 ? (lastCandle.v || 0) / avgVol20 : null;
    const divergence = detectDivergence(candles, 30);
    const trigDir = inferTriggerDirection(trigger);
    const funding = await fetchFundingRateServer(coin).catch(() => null);

    // Compute regime as INFO (passed to AI), no longer a veto.
    let regimeData = null;
    if (trigDir) {
      regimeData = await detectMarketRegime(coin, broker).catch(() => null);
      if (regimeData) ps.regime = regimeData;
    }

    // Compute confluence score as INFO (passed to AI), no longer a hard gate.
    const pre = await preAiConfluenceScore(coin, effectiveTf, broker, candles, trigger).catch(() => null);
    ps.lastPreScore = pre ? pre.score : null;

    // Cache for AI prompt + later use (all filter data — AI decides what to do with it)
    ps.lastIndicators = { adx, atr14, volRatio, divergence, trigDir, funding, confluenceScore: pre ? pre.score : null, regime: regimeData };
    ps.lastVetoReason = null;

    // System-safety vetoes (NOT trade-quality filters):
    //   • Portfolio heat — concurrency cap (5 max active, 2/cluster)
    //   • Circuit breaker — loss-streak pause (handled earlier in this function)
    // Everything else (ADX, volume, divergence, funding, regime) is passed to the
    // AI as data and the AI decides whether to take or skip the trade.
    const heat = checkPortfolioHeat(sub, coin);
    if (heat.blocked) {
      console.log('[heat veto]', coin, heat.reason);
      ps.cooldownUntil = Date.now() + Math.min(effectiveCooldownMs(sub), 5 * 60 * 1000);
      ps.lastTrigger = trigger;
      ps.lastStatus = 'veto:' + heat.code;
      ps.lastVetoReason = heat.reason;
      return;
    }

    // Apply per-pair cooldown — extended automatically during 22:00-08:00 UTC dead zone
    ps.cooldownUntil = Date.now() + effectiveCooldownMs(sub);
    ps.lastTrigger = trigger;

    // 6) Run full AI analysis for this pair (now with ATR + ADX + class context)
    let aiSignal = null;
    try {
      aiSignal = await runServerAIForPair(userId, sub, coin, ps, trigger, candles, broker, effectiveTf);
    } catch (e) { console.error('[runServerAIForPair]', coin, e.message); }

    // Fallback: AI failed → still push a trigger alert
    if (!aiSignal) {
      ps.lastStatus = 'cooldown';
      await sendPushTo(userId, {
        title: `⚡ ${trigger.type.toUpperCase()}: ${coin.replace('USDT', '').replace('1000', '')}`,
        body: `${trigger.desc}. Open Henry to run AI analysis.`,
        icon: '/manifest.json',
        data: { coin, tf: effectiveTf, broker, trigger },
      });
    }
  } finally {
    // Always release the in-flight lock, even on exceptions or early returns.
    ps._scanInFlight = false;
    // Push any state transitions to SSE subscribers (signal/entry/be/tp/expired)
    _emitDiffs();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PERIODIC STATUS UPDATES — server posts a status embed every X minutes per user
// ════════════════════════════════════════════════════════════════════════════

const STATUS_INTERVALS = new Map(); // userId → setInterval handle

function startUserStatusUpdates(userId, intervalMins) {
  // Clear any existing interval first
  if (STATUS_INTERVALS.has(userId)) {
    clearInterval(STATUS_INTERVALS.get(userId));
    STATUS_INTERVALS.delete(userId);
  }
  if (!intervalMins || intervalMins <= 0) return;
  const handle = setInterval(() => {
    postUserStatus(userId).catch(e => console.error('[status loop]', userId, e.message));
  }, intervalMins * 60000);
  STATUS_INTERVALS.set(userId, handle);
}

function stopUserStatusUpdates(userId) {
  if (STATUS_INTERVALS.has(userId)) {
    clearInterval(STATUS_INTERVALS.get(userId));
    STATUS_INTERVALS.delete(userId);
  }
}

async function postUserStatus(userId) {
  if (!process.env.DISCORD_STATUS_WEBHOOK) return;
  const sub = scanSubscriptions.get(userId);
  if (!sub) return;
  const { tf, broker } = sub;
  const lines = [];

  // Iterate all watchlist pairs (or just the focused coin) — show each pair's status
  const pairs = (sub.watchlist && sub.watchlist.length) ? sub.watchlist : [sub.coin];
  let inTradeCount = 0, waitingCount = 0;

  for (const coin of pairs) {
    const ps = (sub.pairs && sub.pairs[coin]) || null;
    const ticker = coin.replace('USDT', '').replace('1000', '');
    if (ps && ps.pendSignal && ps.pendSignal.direction !== 'NO TRADE') {
      const e   = parseFloat(ps.pendSignal.entry);
      const slP = parseFloat(ps.pendSignal.sl);
      const tpP = parseFloat(ps.pendSignal.tp);
      const isLong = ps.pendSignal.direction === 'LONG';
      const cp = ps.lastPrice != null ? ps.lastPrice : null;
      if (ps._entryAlerted) {
        inTradeCount++;
        const pctToTp = (tpP && e && cp) ? Math.round(Math.abs(cp - e) / Math.abs(tpP - e) * 100) : 0;
        const bePrice = isLong ? e + (tpP - e) * BE_TRIGGER_PCT : e - (e - tpP) * BE_TRIGGER_PCT;
        const beReached = cp != null ? (isLong ? cp >= bePrice : cp <= bePrice) : false;
        lines.push(`✅ **IN TRADE — ${ticker} ${ps.pendSignal.direction}** @ \`${e}\``);
        lines.push(`   SL: \`${slP}\` | TP: \`${tpP}\` | ${ps.pendSignal.rr || '—'}R${cp != null ? ` | Current: \`${cp.toFixed(2)}\` (${pctToTp}% to TP)` : ''}`);
        if (beReached && !ps._beAlerted) lines.push(`   ⚑ BE @ \`${bePrice.toFixed(2)}\` REACHED — move SL`);
      } else {
        waitingCount++;
        const distPct = (cp != null && e) ? Math.abs((cp - e) / e * 100).toFixed(2) : null;
        lines.push(`⏳ **WAITING ENTRY — ${ticker} ${ps.pendSignal.direction}** @ \`${e}\``);
        lines.push(`   SL: \`${slP}\` | TP: \`${tpP}\` | ${ps.pendSignal.rr || '—'}R${distPct != null ? ` | Distance: ${distPct}%` : ''}`);
      }
    } else if (ps && ps.cooldownUntil > Date.now()) {
      const secs = Math.ceil((ps.cooldownUntil - Date.now()) / 1000);
      lines.push(`⏸ **${ticker}** — cooldown ${secs}s${ps.lastPrice != null ? ` (price ${ps.lastPrice.toFixed(2)})` : ''}`);
    } else {
      lines.push(`🔍 **${ticker}** — scanning${ps && ps.lastPrice != null ? ` (price ${ps.lastPrice.toFixed(2)})` : ''}`);
    }
  }

  if (!lines.length) lines.push('💤 No active scan.');
  lines.push('');
  lines.push(`⚡ Scan: ${sub.active ? 'ACTIVE' : 'STOPPED'} | ${pairs.length} pair${pairs.length === 1 ? '' : 's'} | Broker: ${broker} | TF: ${tf}`);

  const utcTime = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const embed = {
    title: `📊 Henry Status — ${utcTime} UTC`,
    description: lines.join('\n'),
    color: inTradeCount > 0 ? 3066993 : waitingCount > 0 ? 16750848 : 9699539,
    footer: { text: `Henry The Hoover | ${new Date().toUTCString()}` },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(process.env.DISCORD_STATUS_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], username: 'Henry Status' }),
    });
  } catch (e) {
    console.error('[status webhook]', e.message);
  }
}

// ── API endpoints for browser to control the status loop ──
app.post('/api/status/start', requireAuth, express.json(), (req, res) => {
  const intervalMins = parseInt(req.body?.intervalMins, 10) || 15;
  startUserStatusUpdates(req.user.id, intervalMins);
  res.json({ ok: true, intervalMins });
});

app.post('/api/status/stop', requireAuth, (req, res) => {
  stopUserStatusUpdates(req.user.id);
  res.json({ ok: true });
});

app.post('/api/status/now', requireAuth, async (req, res) => {
  await postUserStatus(req.user.id).catch(e => console.error('[status now]', e.message));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════

const _scanLoopHandle = setInterval(() => {
  for (const [userId, sub] of scanSubscriptions.entries()) {
    if (!sub.active) continue;
    // Self-heal isAdmin every tick. If sub.email matches ADMIN_EMAIL, force
    // isAdmin=true even if the profile flag is stale. This prevents the
    // "Discord posts go silent after a deploy" bug where the cached sub.isAdmin
    // is false but the user is genuinely the admin email.
    if (sub.email && sub.email === ADMIN_EMAIL) sub.isAdmin = true;
    runServerScan(userId, sub).catch(e => console.error('[scan loop]', userId, e.message));
  }
}, SCAN_INTERVAL_MS);

// Clean shutdown — release scan loop, status loops, and exchange WS connections
function _gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} received — cleaning up`);
  clearInterval(_scanLoopHandle);
  for (const handle of STATUS_INTERVALS.values()) clearInterval(handle);
  STATUS_INTERVALS.clear();
  for (const [, stream] of exchangeStreams.entries()) {
    if (stream.ws) try { stream.ws.close(); } catch {}
    if (stream.interval) clearInterval(stream.interval);
  }
  process.exit(0);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// BACKTEST MODE — replays historical candles through the full signal pipeline
// (trigger → pre-AI filter → AI → simulated outcome). Surfaces aggregate stats
// so prompt/threshold changes can be validated against history before going live.
//
// Limitations (caller is warned in UI):
//   • News, calendar, footprint, cross-broker context skipped (point-in-time
//     reconstruction infeasible for free APIs).
//   • Slippage not modeled — limit fill at exact entry.
//   • Sonnet outputs are non-deterministic — same setup ≠ same signal.
//   • When SL & TP both intersect a single candle, conservative SL-first.
// ════════════════════════════════════════════════════════════════════════════

// Fetch a long range of historical candles from a broker (more candles than
// the regular fetchCandlesServer's 30-bar window).
async function fetchHistoricalCandles(coin, tf, broker, totalCount) {
  // Binance allows max 1500 per call; Weex 1000; HL ~5000. Single call usually fits.
  const lim = Math.min(totalCount, 1500);
  try {
    if (broker === 'massive' || coin === 'GOLD' || coin === 'XAUUSD') {
      // Use Binance spot PAXG/USDT instead of Polygon (sparse + stale data)
      const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };
      const interval = tfMap[tf] || '15m';
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${lim}`);
      if (!r.ok) return [];
      const arr = await r.json();
      if (!Array.isArray(arr)) return [];
      return arr.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
    }
    if (broker === 'binance') {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin}&interval=${tf}&limit=${lim}`);
      const arr = await r.json();
      if (!Array.isArray(arr)) return [];
      return arr.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
    }
    if (broker === 'hyperliquid') {
      const sym = coin.replace('USDT', '');
      const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
      const ms = tfMs[tf] || 900000;
      const start = Date.now() - ms * lim * 1.1;
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin: sym, interval: tf, startTime: start, endTime: Date.now() },
        }),
      });
      const arr = await r.json();
      if (!Array.isArray(arr)) return [];
      return arr.map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
    }
    // weex — same fix as fetchCandlesServer: new granularity format + ms timestamps
    const fsym = FUTURES_SYM_SERVER[coin] || ('cmt_' + coin.toLowerCase());
    const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '12h': '12h', '1d': '1d', '1w': '1w' };
    const gran = tfMap[tf] || '15m';
    const r = await fetch(`https://api-contract.weex.com/capi/v2/market/candles?symbol=${fsym}&granularity=${gran}&limit=${lim}`);
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.map(c => {
      const t = +c[0];
      return { t: t > 1e12 ? t : t * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] };
    });
  } catch (e) {
    console.error('[backtest fetch]', e.message);
    return [];
  }
}

// Fetch funding-rate history from Binance — returns array of { fundingTime, fundingRate }
async function fetchHistoricalFunding(coin, lookbackMs) {
  try {
    const startTime = Date.now() - lookbackMs - 24 * 3600 * 1000; // pad a day for first lookup
    const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}&startTime=${startTime}&limit=1000`);
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.map(x => ({ ts: +x.fundingTime, rate: parseFloat(x.fundingRate) }))
              .sort((a, b) => a.ts - b.ts);
  } catch { return []; }
}

// At a given timestamp, find the funding rate that was active.
function fundingAt(fundingHistory, ts) {
  if (!fundingHistory || !fundingHistory.length) return null;
  let last = null;
  for (const f of fundingHistory) {
    if (f.ts <= ts) last = f.rate;
    else break;
  }
  return last;
}

// Find HTF candle (1H or 4H) whose close timestamp is <= candleTs (so we don't
// peek at unfinished future-data during the iteration).
function htfCandleAt(htfCandles, ts) {
  if (!htfCandles || !htfCandles.length) return null;
  let result = null;
  for (const c of htfCandles) {
    if (c.t <= ts) result = c;
    else break;
  }
  return result;
}

// Compute pre-AI confluence score from historical-context only (no live fetches).
function preAiScoreBacktest(coin, tf, baseCandles, trigger, h1Slice, fundingRate) {
  const reasons = [];
  let score = 0;

  // 1) Kill zone — derived from the candle's UTC time (not now())
  const lastCandle = baseCandles[baseCandles.length - 1];
  const m = (() => {
    const d = new Date(lastCandle.t);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  let kzScore = 0, kzName = 'OFF';
  if (m >= 420 && m < 600)       { kzScore = 20; kzName = 'LDN-OPEN'; }
  else if (m >= 720 && m < 900)  { kzScore = 20; kzName = 'NY-OPEN';  }
  else if (m >= 900 && m < 1020) { kzScore = 12; kzName = 'LDN-CLOSE';}
  else if (m >= 0   && m < 300)  { kzScore =  5; kzName = 'ASIA';     }
  score += kzScore;
  reasons.push(`KZ=${kzName}+${kzScore}`);

  // 2) Trigger strength (vol-confirmed bonus)
  const histAvgVol = baseCandles.slice(-21, -1).reduce((s, c) => s + (c.v || 0), 0) / Math.max(baseCandles.length - 1, 1);
  const volSpike = histAvgVol > 0 && lastCandle.v > histAvgVol * 1.5;
  let tScore = 0;
  // Price-action types (legacy)
  if (trigger.type === 'bos')             tScore = volSpike ? 20 : 12;
  else if (trigger.type === 'sweep')      tScore = volSpike ? 15 : 8;
  else if (trigger.type === 'rejection')  tScore = volSpike ? 18 : 12;
  else if (trigger.type === 'atr')        tScore = 14;
  else if (trigger.type === 'fvg')        tScore = volSpike ? 12 : 8;
  // ICT/S&D types — higher base scores (built-in confirmation)
  else if (trigger.type === 'mss_disp')      tScore = 22; // 70% body + 1.5x vol baked in
  else if (trigger.type === 'sweep_disp')    tScore = 18; // 60% close-position baked in
  else if (trigger.type === 'ob_mitigation') tScore = 22; // first OB touch is high-conviction
  else if (trigger.type === 'sd_zone')       tScore = 20; // first S&D zone touch
  else if (trigger.type === 'fvg_ote')       tScore = 20; // FVG + 62-79% retrace confluence
  else                                       tScore = 8;
  score += tScore;
  reasons.push(`Trig=${trigger.type}${volSpike ? '✓vol' : ''}+${tScore}`);

  // 3) Direction inferred from trigger desc
  let trigDir = null;
  if (trigger.type === 'bos')        trigDir = /up/i.test(trigger.desc) ? 'bull' : 'bear';
  else if (trigger.type === 'sweep') trigDir = /high/i.test(trigger.desc) ? 'bear' : 'bull';

  // 4) HTF alignment from h1Slice (last 10 1H candles up to current time)
  let htfScore = 5;
  if (trigDir && h1Slice && h1Slice.length >= 5) {
    const htfDir = h1Slice[h1Slice.length - 1].c > h1Slice[0].c ? 'bull' : 'bear';
    if (trigDir === htfDir) { htfScore = 20; reasons.push('HTF-aligned+20'); }
    else                    { htfScore = -15; reasons.push('HTF-conflict-15'); }
  }
  score += htfScore;

  // 5) Funding bias support
  let fScore = 3;
  if (fundingRate != null && trigDir) {
    const fadeDir = fundingRate > 0.005 ? 'bear' : fundingRate < -0.005 ? 'bull' : null;
    if (fadeDir && fadeDir === trigDir) {
      fScore = Math.abs(fundingRate) > 0.01 ? 15 : 8;
      reasons.push(`Fund-fade+${fScore}`);
    } else if (fadeDir && fadeDir !== trigDir) {
      fScore = -5;
      reasons.push('Fund-against-5');
    }
  }
  score += fScore;

  // 6) Recent volume momentum
  if (baseCandles.length >= 10) {
    const last3 = baseCandles.slice(-3).reduce((s, c) => s + (c.v || 0), 0) / 3;
    const prev = baseCandles.slice(-23, -3);
    const prevAvg = prev.reduce((s, c) => s + (c.v || 0), 0) / Math.max(prev.length, 1);
    if (prevAvg > 0) {
      const ratio = last3 / prevAvg;
      const vmScore = ratio > 1.5 ? 10 : ratio > 1 ? 5 : 0;
      score += vmScore;
      if (vmScore) reasons.push(`Vol-x${ratio.toFixed(1)}+${vmScore}`);
    }
  }

  return { score, reasons: reasons.join(' ') };
}

// Fire AI with REDUCED context (no news/calendar/footprint/cross-broker).
// Backtest pragmatism: those sources can't be reconstructed historically.
// Now mirrors live mode: ATR-based stop guidance + ADX trend strength + volume + divergence in context.
async function runBacktestAI(coin, tf, broker, baseCandles, h1Slice, h4Slice, btcSlice, fundingRate, trigger, indicators) {
  const lastClose = baseCandles[baseCandles.length - 1].c;
  const ctxLines = [];
  ctxLines.push(`AUTO TRIGGER: ${trigger.type.toUpperCase()} — ${trigger.desc}`);

  // ── ATR-based stop guidance (matches live behavior) ──
  if (indicators && indicators.atr14 != null) {
    const am = atrMultiplierForAsset(coin);
    const atrStopDist = indicators.atr14 * am.multiplier;
    const buffer = indicators.atr14 * SL_ATR_BUFFER;
    ctxLines.push(
      `\nVOLATILITY (ATR-based stops — REPLACES fixed/round-number stops):` +
      `\n  ATR(14) on ${tf} = ${indicators.atr14.toFixed(4)}` +
      `\n  Asset class: ${am.klass} → multiplier ${am.multiplier}× ATR = ${atrStopDist.toFixed(4)} stop distance from entry` +
      `\n  STOP PLACEMENT RULE: place SL BEYOND structure (swing low for LONG, swing high for SHORT) + ${buffer.toFixed(4)} (${SL_ATR_BUFFER.toFixed(1)}×ATR) buffer.` +
      `\n  NEVER place SL on a round number. Offset by at least 0.5×ATR.`
    );
  }
  if (indicators && indicators.adx != null) {
    ctxLines.push(`ADX(14): ${indicators.adx.toFixed(1)}`);
  }
  if (indicators && indicators.volRatio != null) {
    ctxLines.push(`Trigger volume: ${indicators.volRatio.toFixed(2)}× the 20-bar avg`);
  }
  if (indicators && indicators.divergence) {
    ctxLines.push(`RSI divergence: ${indicators.divergence === 'bearish' ? 'bearish (price HH, RSI LH)' : 'bullish (price LL, RSI HL)'}`);
  }
  if (indicators && indicators.regime && indicators.regime.regime) {
    const r = indicators.regime;
    ctxLines.push(`4H regime: ${r.regime}, confidence ${r.confidence}`);
  }
  if (indicators && indicators.confluenceScore != null) {
    ctxLines.push(`PRE-AI CONFLUENCE SCORE: ${indicators.confluenceScore}/85`);
  }

  if (baseCandles.length >= 5) {
    const recent = baseCandles.slice(-15);
    const high = Math.max(...recent.map(c => c.h));
    const low  = Math.min(...recent.map(c => c.l));
    ctxLines.push(`\n${tf} STRUCTURE (last 15, trigger TF): range ${low.toFixed(4)} — ${high.toFixed(4)}, last close ${lastClose}.`);
  }
  if (h1Slice && h1Slice.length >= 5) {
    const ema = h1Slice.reduce((s, c) => s + c.c, 0) / h1Slice.length;
    ctxLines.push(`1H bias: last ${h1Slice[h1Slice.length-1].c.toFixed(4)} vs ${h1Slice.length}-EMA ${ema.toFixed(4)} — ${h1Slice[h1Slice.length-1].c > ema ? 'above' : 'below'}.`);
  }
  if (h4Slice && h4Slice.length >= 3) {
    const ema = h4Slice.reduce((s, c) => s + c.c, 0) / h4Slice.length;
    ctxLines.push(`4H bias (HTF): last ${h4Slice[h4Slice.length-1].c.toFixed(4)} vs ${h4Slice.length}-EMA ${ema.toFixed(4)} — ${h4Slice[h4Slice.length-1].c > ema ? 'above (bullish)' : 'below (bearish)'}.`);
  }
  if (btcSlice && btcSlice.length >= 3 && coin !== 'BTCUSDT') {
    const first = btcSlice[0].c, last = btcSlice[btcSlice.length-1].c;
    const pct = ((last - first) / first * 100).toFixed(2);
    ctxLines.push(`BTC moved ${pct}% over recent window — ${parseFloat(pct) > 0.5 ? 'risk-on' : parseFloat(pct) < -0.5 ? 'risk-off' : 'neutral'}.`);
  }
  if (fundingRate != null) {
    const fpct = (fundingRate * 100).toFixed(4);
    ctxLines.push(`Funding rate: ${fpct}%${Math.abs(fundingRate) > 0.01 ? ' (extreme)' : ''}.`);
  }
  // Liquidity (computed from current candle window — same as live)
  const liqCtx = buildLiquidityContextServer(baseCandles, tf);
  if (liqCtx) ctxLines.push(liqCtx.trim());

  const contextStr = ctxLines.join('\n');
  const systemPrompt = buildServerSystemPrompt(coin, tf, broker, contextStr, lastClose);

  const userMessage = `Analyse ${coin} on ${tf}. Auto trigger: ${trigger.type.toUpperCase()} — ${trigger.desc}. Output the signal JSON.`;
  try {
    const text = await callAnthropicServer(systemPrompt, userMessage, 1500);
    let signal = parseSignalJSONServer(text);
    if (!signal) return null;
    // Validate + retry
    if (signal.direction !== 'NO TRADE' && !validateSignalLevelsServer(signal)) {
      const correction = `Your previous output had invalid levels. Direction was ${signal.direction} but: entry=${signal.entry} SL=${signal.sl} TP=${signal.tp}. Recalculate. Output corrected JSON only.`;
      const retryText = await callAnthropicServer(systemPrompt, userMessage + '\n\n' + correction, 1200);
      const retried = parseSignalJSONServer(retryText);
      if (retried && validateSignalLevelsServer(retried)) signal = retried;
    }
    if (signal.direction !== 'NO TRADE' && !validateSignalLevelsServer(signal)) return null;
    if (signal.direction !== 'NO TRADE') {
      // RR floor: <1.5 → NO TRADE
      const e = parseFloat(signal.entry), sl = parseFloat(signal.sl), tp = parseFloat(signal.tp);
      const rr = signal.direction === 'LONG' ? (tp - e) / (e - sl) : (e - tp) / (sl - e);
      if (isFinite(rr) && rr < 1.5) {
        signal.direction = 'NO TRADE';
        signal._rrDowngraded = true;
      } else {
        signal = validateAndFixBEServer(signal);
      }
    }
    return signal;
  } catch (e) {
    console.error('[backtest AI]', e.message);
    return null;
  }
}

// Walk forward through candles AFTER the signal candle to determine outcome.
// Returns { outcome: 'TP'|'SL'|'BE'|'EXPIRED'|'OPEN', outcomeR, exitTs, candlesToOutcome, beReached }
function simulateOutcome(signal, forwardCandles, tfMs, opts = {}) {
  if (!signal || signal.direction === 'NO TRADE') return null;
  const beStopEnabled = opts.beStopEnabled !== false;       // default ON (mirrors live)
  const beTriggerPct = opts.beTriggerPct != null ? opts.beTriggerPct : 0.5; // 0.5 = halfway to TP
  const e = parseFloat(signal.entry);
  const sl = parseFloat(signal.sl);
  const tp = parseFloat(signal.tp);
  const isLong = signal.direction === 'LONG';
  const rr = parseFloat(signal.rr) || (isLong ? (tp - e) / (e - sl) : (e - tp) / (sl - e));
  const expiryCandles = parseInt(signal.expiry_candles, 10) || 4;
  const bePrice = isLong ? e + (tp - e) * beTriggerPct : e - (e - tp) * beTriggerPct;

  let entryHit = false;
  let entryIdx = -1;
  let beReached = false;

  for (let i = 0; i < forwardCandles.length; i++) {
    const c = forwardCandles[i];
    if (!entryHit) {
      // Limit fill: LONG fills if low <= entry; SHORT fills if high >= entry
      if (isLong ? c.l <= e : c.h >= e) {
        entryHit = true;
        entryIdx = i;
      } else {
        // Check expiry — only relevant before entry hit
        if (i + 1 >= expiryCandles) {
          return {
            outcome: 'EXPIRED',
            outcomeR: 0,
            exitTs: c.t,
            candlesToOutcome: i + 1,
            beReached: false,
          };
        }
        continue;
      }
    }

    // Post-entry: check BE level then SL/TP
    if (beStopEnabled && !beReached) {
      if (isLong ? c.h >= bePrice : c.l <= bePrice) beReached = true;
    }

    const slHit = isLong ? c.l <= sl : c.h >= sl;
    const tpHit = isLong ? c.h >= tp : c.l <= tp;
    // BE-stop only fires if the feature is enabled
    const beStopHit = beStopEnabled && beReached && (isLong ? c.l <= e : c.h >= e);

    // Conservative when both SL and TP intersect: assume SL first
    if (slHit) {
      const stoppedAtBE = beStopEnabled && beReached;
      return {
        outcome: stoppedAtBE ? 'BE' : 'SL',
        outcomeR: stoppedAtBE ? 0 : -1,
        exitTs: c.t,
        candlesToOutcome: i + 1,
        beReached,
      };
    }
    if (tpHit) {
      return {
        outcome: 'TP',
        outcomeR: rr,
        exitTs: c.t,
        candlesToOutcome: i + 1,
        beReached,
      };
    }
    if (beStopHit) {
      return {
        outcome: 'BE',
        outcomeR: 0,
        exitTs: c.t,
        candlesToOutcome: i + 1,
        beReached: true,
      };
    }
  }

  // Reached end of forward window without exit
  return entryHit
    ? { outcome: 'OPEN', outcomeR: 0, exitTs: forwardCandles[forwardCandles.length - 1]?.t, candlesToOutcome: forwardCandles.length, beReached }
    : { outcome: 'EXPIRED', outcomeR: 0, exitTs: forwardCandles[forwardCandles.length - 1]?.t, candlesToOutcome: forwardCandles.length, beReached: false };
}

// ── Backtest API endpoints ────────────────────────────────────────────────
app.post('/api/backtest/cost-estimate', requireAuth, express.json(), async (req, res) => {
  // Quick estimate: fetches candles, counts triggers + pre-AI passes, no AI calls.
  try {
    const { pair, broker, tf, days, preAiThreshold, strategy, adxMin, volMin, divergenceVeto, fundingVeto } = req.body || {};
    const strategyMode = (strategy || STRATEGY_MODE).toLowerCase();
    const vetoCfg = Object.assign({}, defaultVetoConfig(strategyMode));
    if (adxMin !== null && adxMin !== undefined)             vetoCfg.adxMin = +adxMin;
    if (volMin !== null && volMin !== undefined)             vetoCfg.volMin = +volMin;
    if (divergenceVeto !== null && divergenceVeto !== undefined) vetoCfg.divergenceVeto = !!divergenceVeto;
    if (fundingVeto !== null && fundingVeto !== undefined)   vetoCfg.fundingVeto = !!fundingVeto;
    const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    const tfMs = TF_MS[tf];
    if (!pair || !broker || !tf || !days || !tfMs) return res.status(400).json({ error: 'invalid_params' });
    const totalCandles = Math.ceil((days * 24 * 3600 * 1000) / tfMs);
    if (totalCandles > 1500) return res.status(400).json({ error: 'too_many_candles', detail: 'Reduce days or use a higher TF.' });

    const candles = await fetchHistoricalCandles(pair, tf, broker, totalCandles);
    if (!candles.length) return res.status(502).json({ error: 'no_candles_returned' });

    // Quick HTF + funding fetch for pre-score accuracy
    const lookbackMs = days * 24 * 3600 * 1000;
    const [h1, funding] = await Promise.all([
      fetchHistoricalCandles(pair, '1h', broker, Math.min(Math.ceil(lookbackMs / 3600000) + 24, 1000)).catch(() => []),
      fetchHistoricalFunding(pair, lookbackMs).catch(() => []),
    ]);

    const threshold = preAiThreshold ?? 65;  // matches live default
    let triggers = 0, passes = 0;
    const vetoCounts = { regime: 0, adx: 0, volume: 0, divergence: 0, funding: 0 };
    const triggerCounts = {
      // ICT/S&D types
      mss_disp: 0, sweep_disp: 0, ob_mitigation: 0, sd_zone: 0, fvg_ote: 0,
      // Price-action fallback types
      bos: 0, sweep: 0, rejection: 0, atr: 0, fvg: 0,
    };
    // Pre-build per-trigger-TF candle-by-time index for funding lookups
    for (let i = 30; i < candles.length; i++) {
      const window = candles.slice(i - 30, i + 1);
      const trig = detectTrigger(window, strategyMode);
      if (!trig) continue;
      triggers++;
      if (triggerCounts[trig.type] != null) triggerCounts[trig.type]++;
      const ts = candles[i].t;
      const h1Window = (() => {
        const idx = h1.findIndex(c => c.t > ts);
        const end = idx < 0 ? h1.length : idx;
        return h1.slice(Math.max(0, end - 10), end);
      })();
      const fr = fundingAt(funding, ts);

      // No hard vetoes — every trigger reaches the AI for decisioning.
      // Each candidate trigger = one AI call (Sonnet decides take/skip).
      passes++;
    }
    const totalVetoed = (vetoCounts.regime || 0) + vetoCounts.adx + vetoCounts.volume + vetoCounts.divergence + vetoCounts.funding;
    const tokensIn  = passes * 2500;
    const tokensOut = passes * 500;
    const inUsd  = tokensIn  / 1_000_000 * 3;
    const outUsd = tokensOut / 1_000_000 * 15;
    const estUsd = +(inUsd + outUsd).toFixed(3);

    res.json({
      candlesFetched: candles.length,
      triggersDetected: triggers,
      triggersByType: triggerCounts,
      hardVetoed: 0,                      // legacy field — vetoes removed
      vetoBreakdown: vetoCounts,
      preAiPasses: passes,
      preAiRejected: 0,                   // legacy field — pre-AI gate removed
      estimatedAiCalls: passes,
      estimatedTokensIn: tokensIn,
      estimatedTokensOut: tokensOut,
      estimatedUsd: estUsd,
      tfMs,
    });
  } catch (e) {
    console.error('[backtest cost]', e.message);
    res.status(500).json({ error: 'cost_estimate_failed', detail: e.message });
  }
});

app.post('/api/backtest/run', requireAuth, express.json(), async (req, res) => {
  if (!req.profile?.is_admin && req.user.email.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'admin_only' });
  }
  try {
    const {
      pair, broker, tf, days,
      preAiThreshold = 65,
      cooldownCandles = 1,
      skipAi = false,
      strategy,
      beStopEnabled = true,
      beTriggerPct = 0.5,
      directionFilter = 'both',  // 'both' | 'longs' | 'shorts'
      adxMin = null,             // null = use strategy-aware default; 0 = disabled
      volMin = null,             // null = use strategy-aware default; 0 = disabled
      divergenceVeto = null,     // null = default, false = disabled
      fundingVeto = null,        // null = default, false = disabled
      regimeFilter = 'auto',     // 'auto' | 'off' | 'longs' | 'shorts'
    } = req.body || {};
    const strategyMode = (strategy || STRATEGY_MODE).toLowerCase();
    // Build veto config — explicit values override strategy defaults
    const vetoCfg = Object.assign({}, defaultVetoConfig(strategyMode));
    if (adxMin !== null && adxMin !== undefined)             vetoCfg.adxMin = +adxMin;
    if (volMin !== null && volMin !== undefined)             vetoCfg.volMin = +volMin;
    if (divergenceVeto !== null && divergenceVeto !== undefined) vetoCfg.divergenceVeto = !!divergenceVeto;
    if (fundingVeto !== null && fundingVeto !== undefined)   vetoCfg.fundingVeto = !!fundingVeto;
    const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    const tfMs = TF_MS[tf];
    if (!pair || !broker || !tf || !days || !tfMs) return res.status(400).json({ error: 'invalid_params' });
    const totalCandles = Math.ceil((days * 24 * 3600 * 1000) / tfMs);
    if (totalCandles > 1500) return res.status(400).json({ error: 'too_many_candles' });

    console.log('[backtest]', pair, tf, days + 'd', 'skipAi=' + skipAi, 'threshold=' + preAiThreshold);

    const lookbackMs = days * 24 * 3600 * 1000;
    const [candles, h1, h4, btcCandles, funding] = await Promise.all([
      fetchHistoricalCandles(pair, tf, broker, totalCandles),
      fetchHistoricalCandles(pair, '1h', broker, Math.min(Math.ceil(lookbackMs / 3600000) + 24, 1000)).catch(() => []),
      fetchHistoricalCandles(pair, '4h', broker, Math.min(Math.ceil(lookbackMs / 14400000) + 12, 500)).catch(() => []),
      pair !== 'BTCUSDT' ? fetchHistoricalCandles('BTCUSDT', tf, 'binance', totalCandles).catch(() => []) : Promise.resolve([]),
      fetchHistoricalFunding(pair, lookbackMs).catch(() => []),
    ]);

    if (!candles.length) return res.status(502).json({ error: 'no_candles' });

    let triggers = 0, preAiPasses = 0, aiCalls = 0;
    const vetoCounts = { regime: 0, adx: 0, volume: 0, divergence: 0, funding: 0 };
    const triggerCounts = {
      // ICT/S&D types
      mss_disp: 0, sweep_disp: 0, ob_mitigation: 0, sd_zone: 0, fvg_ote: 0,
      // Price-action fallback types
      bos: 0, sweep: 0, rejection: 0, atr: 0, fvg: 0,
    };
    const trades = [];
    let cooldownUntilIdx = 0;

    for (let i = 30; i < candles.length; i++) {
      if (i < cooldownUntilIdx) continue;

      const window = candles.slice(i - 30, i + 1);
      const trig = detectTrigger(window, strategyMode);
      if (!trig) continue;
      triggers++;
      if (triggerCounts[trig.type] != null) triggerCounts[trig.type]++;

      const ts = candles[i].t;
      const h1WinEnd = (() => { const idx = h1.findIndex(c => c.t > ts); return idx < 0 ? h1.length : idx; })();
      const h4WinEnd = (() => { const idx = h4.findIndex(c => c.t > ts); return idx < 0 ? h4.length : idx; })();
      const btcEnd  = (() => { const idx = btcCandles.findIndex(c => c.t > ts); return idx < 0 ? btcCandles.length : idx; })();
      const h1Slice = h1.slice(Math.max(0, h1WinEnd - 10), h1WinEnd);
      const h4Slice = h4.slice(Math.max(0, h4WinEnd - 8),  h4WinEnd);
      const btcSlice = btcCandles.slice(Math.max(0, btcEnd - 30), btcEnd);
      const fr = fundingAt(funding, ts);

      // ── COMPUTE FILTER DATA (passed to AI as context, not used as veto) ──
      const trigDir = inferTriggerDirection(trig);
      const adx = computeADX(window, 14);
      const atr14 = computeATR(window, 14);
      const lastC = window[window.length - 1];
      const avgVol = window.slice(-21, -1).reduce((s, c) => s + (c.v || 0), 0) / 20;
      const volRatio = avgVol > 0 ? (lastC.v || 0) / avgVol : null;
      const divergence = detectDivergence(window, Math.min(30, window.length - 14));

      // Compute regime as INFO (passed to AI, not a veto)
      let regimeForTrade = null;
      if (trigDir) {
        const h4UpTo = h4.slice(0, h4WinEnd);
        if (h4UpTo.length >= 50) {
          regimeForTrade = detectRegimeFromCandles(h4UpTo);
        }
      }

      // Pre-AI confluence score — kept as INFO for AI prompt, no longer a hard gate.
      // (AI sees the score and can factor it into the take/skip decision.)
      const pre = preAiScoreBacktest(pair, tf, window, trig, h1Slice, fr);
      preAiPasses++;
      cooldownUntilIdx = i + cooldownCandles;

      let signal = null;
      if (!skipAi) {
        aiCalls++;
        // Pass full filter context so AI can decide on its own whether to take the trade
        const indicators = {
          atr14, adx, volRatio, divergence,
          confluenceScore: pre ? pre.score : null,
          regime: regimeForTrade,
          funding: fr,
        };
        signal = await runBacktestAI(pair, tf, broker, window, h1Slice, h4Slice, btcSlice, fr, trig, indicators);
        if (!signal) continue; // AI failed
      } else {
        // Synthetic signal for dry-run cost preview
        signal = { direction: 'DRY_RUN', _dry: true };
      }

      // ── Direction filter — drop signals in the unwanted direction ──
      // Note: we still count the AI call (already made) but the trade gets tagged as filtered
      // so the user can see how many were skipped without the filter.
      let directionFiltered = false;
      if (signal && (signal.direction === 'LONG' || signal.direction === 'SHORT')) {
        if (directionFilter === 'longs' && signal.direction !== 'LONG')   directionFiltered = true;
        if (directionFilter === 'shorts' && signal.direction !== 'SHORT') directionFiltered = true;
      }

      const forward = candles.slice(i + 1, i + 1 + 100); // up to 100 candles forward for outcome
      let outcome = null;
      if (!directionFiltered && !skipAi && signal && (signal.direction === 'LONG' || signal.direction === 'SHORT')) {
        outcome = simulateOutcome(signal, forward, tfMs, { beStopEnabled, beTriggerPct });
      }
      trades.push({
        idx: i,
        ts,
        trigger: trig,
        preScore: pre.score,
        preReasons: pre.reasons,
        signal: skipAi ? null : signal,
        outcome,
        directionFiltered,
      });
    }

    // Aggregate stats
    const closed = trades.filter(t => t.outcome && (t.outcome.outcome === 'TP' || t.outcome.outcome === 'SL' || t.outcome.outcome === 'BE'));
    const tp = closed.filter(t => t.outcome.outcome === 'TP').length;
    const sl = closed.filter(t => t.outcome.outcome === 'SL').length;
    const be = closed.filter(t => t.outcome.outcome === 'BE').length;
    const expired = trades.filter(t => t.outcome && t.outcome.outcome === 'EXPIRED').length;
    const totalR = closed.reduce((s, t) => s + (t.outcome.outcomeR || 0), 0);
    const winRate = closed.length ? +(((tp + be * 0.5) / closed.length) * 100).toFixed(1) : 0;
    const expectancy = closed.length ? +(totalR / closed.length).toFixed(2) : 0;

    // By trigger type
    function byKey(getKey) {
      const groups = {};
      for (const t of trades) {
        if (!t.outcome || !['TP', 'SL', 'BE'].includes(t.outcome.outcome)) continue;
        const k = getKey(t);
        if (!groups[k]) groups[k] = { tp: 0, sl: 0, be: 0, totalR: 0, total: 0 };
        groups[k].total++;
        if (t.outcome.outcome === 'TP') groups[k].tp++;
        else if (t.outcome.outcome === 'SL') groups[k].sl++;
        else if (t.outcome.outcome === 'BE') groups[k].be++;
        groups[k].totalR += t.outcome.outcomeR || 0;
      }
      for (const g of Object.values(groups)) {
        g.totalR = +g.totalR.toFixed(2);
        g.winRate = g.total ? +(((g.tp + g.be * 0.5) / g.total) * 100).toFixed(1) : 0;
      }
      return groups;
    }

    const byTrigger = byKey(t => t.trigger.type);
    const byHour = byKey(t => String(new Date(t.ts).getUTCHours()).padStart(2, '0'));
    const byDirection = byKey(t => t.signal?.direction || 'unknown');

    const totalVetoed = (vetoCounts.regime || 0) + vetoCounts.adx + vetoCounts.volume + vetoCounts.divergence + vetoCounts.funding;
    const directionFilteredCount = trades.filter(t => t.directionFiltered).length;
    res.json({
      config: { pair, broker, tf, days, preAiThreshold, cooldownCandles, skipAi, strategy: strategyMode, beStopEnabled, beTriggerPct, directionFilter, vetoCfg, regimeFilter },
      directionFilteredCount,
      candlesProcessed: candles.length,
      triggers,
      triggersByType: triggerCounts,
      hardVetoed: totalVetoed,
      vetoBreakdown: vetoCounts,
      preAiPasses,
      preAiRejected: triggers - totalVetoed - preAiPasses,
      aiCalls,
      stats: {
        signalsGenerated: trades.length,
        noTrade: trades.filter(t => t.signal?.direction === 'NO TRADE').length,
        rrDowngraded: trades.filter(t => t.signal?._rrDowngraded).length,
        long: trades.filter(t => t.signal?.direction === 'LONG').length,
        short: trades.filter(t => t.signal?.direction === 'SHORT').length,
        closed: closed.length,
        tp, sl, be, expired,
        totalR: +totalR.toFixed(2),
        winRate,
        expectancy,
      },
      byTrigger,
      byHour,
      byDirection,
      trades, // full list for the UI to render
    });
  } catch (e) {
    console.error('[backtest run]', e.message);
    res.status(500).json({ error: 'backtest_failed', detail: e.message });
  }
});

// PART 6 — SSE LIVE PRICES (server multiplexes one exchange WS per symbol)
// ════════════════════════════════════════════════════════════════════════════

const exchangeStreams = new Map(); // `${broker}:${symbol}` → { ws|interval, clients:Set, currentBar, tfSeconds }

function tfSecondsOf(tf) {
  return ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[tf]) || 900;
}

function updateCurrentBar(stream, price, time, volume) {
  const bs = stream.tfSeconds || 900;
  const barTime = Math.floor(time / bs) * bs;
  if (!stream.currentBar || stream.currentBar.time !== barTime) {
    stream.currentBar = { time: barTime, open: price, high: price, low: price, close: price, volume: volume || 0 };
  } else {
    stream.currentBar.high = Math.max(stream.currentBar.high, price);
    stream.currentBar.low = Math.min(stream.currentBar.low, price);
    stream.currentBar.close = price;
    stream.currentBar.volume += volume || 0;
  }
}

function broadcast(stream, payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of stream.clients) {
    try { c.write(line); } catch (e) { /* dead client */ }
  }
}

function subBinanceLive(symbol) {
  const key = `binance:${symbol}`;
  if (exchangeStreams.has(key)) return exchangeStreams.get(key);
  const stream = { clients: new Set(), currentBar: null, tfSeconds: 900 };
  exchangeStreams.set(key, stream);
  const open = () => {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@aggTrade`);
    stream.ws = ws;
    ws.on('message', (data) => {
      try {
        const tick = JSON.parse(data);
        const price = parseFloat(tick.p), time = Math.floor(tick.T / 1000);
        updateCurrentBar(stream, price, time, parseFloat(tick.q));
        broadcast(stream, { price, time, bar: stream.currentBar });
      } catch (e) {}
    });
    ws.on('close', () => { if (stream.clients.size > 0) setTimeout(open, 3000); });
    ws.on('error', () => {});
  };
  open();
  return stream;
}

function subWeexLive(symbol) {
  const key = `weex:${symbol}`;
  if (exchangeStreams.has(key)) return exchangeStreams.get(key);
  const stream = { clients: new Set(), currentBar: null, tfSeconds: 900 };
  exchangeStreams.set(key, stream);
  const fsym = FUTURES_SYM_SERVER[symbol] || ('cmt_' + symbol.toLowerCase());
  stream.interval = setInterval(async () => {
    try {
      const r = await fetch(`https://api-contract.weex.com/capi/v2/market/ticker?symbol=${fsym}`);
      const d = await r.json();
      const price = parseFloat(d.last);
      if (!price) return;
      const time = Math.floor(Date.now() / 1000);
      updateCurrentBar(stream, price, time, 0);
      broadcast(stream, { price, time, bar: stream.currentBar });
    } catch (e) {}
  }, 3000);
  return stream;
}

function subHLLive(symbol) {
  const key = `hyperliquid:${symbol}`;
  if (exchangeStreams.has(key)) return exchangeStreams.get(key);
  const stream = { clients: new Set(), currentBar: null, tfSeconds: 900 };
  exchangeStreams.set(key, stream);
  const sym = symbol.replace('USDT', '');
  const open = () => {
    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    stream.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: sym } })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (!Array.isArray(msg.data)) return;
        for (const t of msg.data) {
          const price = parseFloat(t.px), time = Math.floor(t.time / 1000);
          updateCurrentBar(stream, price, time, parseFloat(t.sz));
          broadcast(stream, { price, time, bar: stream.currentBar });
        }
      } catch (e) {}
    });
    ws.on('close', () => { if (stream.clients.size > 0) setTimeout(open, 3000); });
    ws.on('error', () => {});
  };
  open();
  return stream;
}

function subMassiveLive(_symbol) {
  // No realtime trades on the polygon REST tier we use — fall back to /api/gold/price polling on the client.
  // Still create a stream so the SSE endpoint behaves consistently; just don't push updates.
  const key = 'massive:GOLD';
  if (exchangeStreams.has(key)) return exchangeStreams.get(key);
  const stream = { clients: new Set(), currentBar: null, tfSeconds: 900, interval: null };
  exchangeStreams.set(key, stream);
  stream.interval = setInterval(async () => {
    try {
      const price = await getGoldSpot();
      if (!price) return;
      const time = Math.floor(Date.now() / 1000);
      updateCurrentBar(stream, price, time, 0);
      broadcast(stream, { price, time, bar: stream.currentBar });
    } catch (e) {}
  }, 5000);
  return stream;
}

app.get('/api/live/:broker/:symbol', requireAuth, (req, res) => {
  const { broker, symbol } = req.params;
  const tf = String(req.query.tf || '15m');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('data: {"connected":true}\n\n');

  let stream;
  if (broker === 'binance') stream = subBinanceLive(symbol);
  else if (broker === 'weex') stream = subWeexLive(symbol);
  else if (broker === 'hyperliquid') stream = subHLLive(symbol);
  else if (broker === 'massive') stream = subMassiveLive(symbol);
  else { res.end(); return; }

  stream.tfSeconds = tfSecondsOf(tf);
  stream.clients.add(res);

  // keepalive ping every 25s so proxies don't kill the connection
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    stream.clients.delete(res);
    if (stream.clients.size === 0) {
      // Tear down after 60s of no clients to avoid leaking exchange connections
      setTimeout(() => {
        if (stream.clients.size === 0) {
          if (stream.ws) try { stream.ws.close(); } catch (e) {}
          if (stream.interval) clearInterval(stream.interval);
          for (const [k, v] of exchangeStreams.entries()) if (v === stream) exchangeStreams.delete(k);
        }
      }, 60000);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WHALE TRACKER — Hyperliquid top-15 by 30d PnL
// ════════════════════════════════════════════════════════════════════════════
// Pure dashboard, not a trading input. Reads the public HL leaderboard once
// an hour, takes top 150 by 30d PnL, queries clearinghouseState on each to
// filter out withdrawn / inactive accounts, keeps top 15 with ≥$50k equity
// AND at least one open position. Then polls those 15 every 30s and emits
// OPEN / CLOSE / INCREASE / DECREASE events into the whale_events table
// when a position appears, disappears, or changes by ≥10% in size.
//
// Anonymous addresses (displayName=null on the HL leaderboard, which is
// nearly all of them) get a 0x393d…2109 short alias. We never auto-execute
// off this data — it's just a watch page.

const WHALE_LEADERBOARD_URL       = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const WHALE_INFO_URL              = 'https://api.hyperliquid.xyz/info';
const WHALE_LIST_SIZE             = 15;
const WHALE_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;   // refresh list hourly
const WHALE_POLL_INTERVAL_MS      = 30 * 1000;        // poll positions every 30s
const WHALE_MIN_ACCOUNT_VALUE     = 50_000;           // filter out withdrawn accounts
const WHALE_DISCOVERY_POOL        = 150;              // candidates to inspect per discovery
const WHALE_SIZE_CHANGE_THRESHOLD = 0.10;             // 10% size delta => INCREASE/DECREASE event

let _whales            = [];        // [{ address, alias, monthPnl, accountValue }]
let _whalePositions    = {};        // address -> { alias, monthPnl, accountValue, positions[], asOf }
let _whaleLastSnapshot = {};        // address -> { coin -> position } for next-tick diff
const _whaleEventCache = [];        // in-memory ring buffer for fast feed
// Tracks when each whale's current position in a coin was first observed by
// the diff loop. Key = "address:coin". null openedAt means the position was
// already open when we started tracking — we mark these "before tracking"
// in the UI so users know not to read the date as a real entry timestamp.
const _whalePositionOpens = new Map();
function _whaleOpenKey(addr, coin) { return addr + ':' + coin; }

function _fmtWhaleAlias(addr) {
  if (!addr || addr.length < 10) return addr || '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

async function _hlClearinghouseState(address) {
  try {
    const r = await fetch(WHALE_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    return null;
  }
}

async function _whaleDiscovery() {
  try {
    const r = await fetch(WHALE_LEADERBOARD_URL);
    if (!r.ok) throw new Error('leaderboard HTTP ' + r.status);
    const data = await r.json();
    const rows = data.leaderboardRows || [];
    const monthPnl = (row) => {
      for (const [w, v] of (row.windowPerformances || [])) {
        if (w === 'month') return parseFloat(v.pnl) || 0;
      }
      return 0;
    };
    rows.sort((a, b) => monthPnl(b) - monthPnl(a));
    const candidates = rows.slice(0, WHALE_DISCOVERY_POOL);
    const states = await Promise.all(candidates.map(c =>
      _hlClearinghouseState(c.ethAddress).catch(() => null)
    ));
    const kept = [];
    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i];
      const state = states[i];
      if (!state || !state.marginSummary) continue;
      const accVal = parseFloat(state.marginSummary.accountValue) || 0;
      const positions = (state.assetPositions || []).filter(p => p && p.position);
      if (accVal < WHALE_MIN_ACCOUNT_VALUE) continue;
      if (positions.length === 0) continue;
      kept.push({
        address: row.ethAddress,
        alias: row.displayName || _fmtWhaleAlias(row.ethAddress),
        monthPnl: monthPnl(row),
        accountValue: accVal,
      });
      if (kept.length >= WHALE_LIST_SIZE) break;
    }
    if (kept.length) {
      _whales = kept;
      console.log(`[whales] discovery: tracking ${kept.length} (top monthPnl $${Math.round(kept[0].monthPnl).toLocaleString()})`);
    } else {
      console.warn('[whales] discovery: no active whales matched filters');
    }
  } catch (err) {
    console.warn('[whales] discovery failed:', err.message || err);
  }
}

function _diffWhaleSnapshot(address, newPositionsArr) {
  const next = {};
  for (const p of newPositionsArr) next[p.coin] = p;
  const prev = _whaleLastSnapshot[address] || {};
  const events = [];
  const now = Date.now();
  for (const [coin, p] of Object.entries(next)) {
    const old = prev[coin];
    if (!old) {
      events.push({ action: 'OPEN', coin, position: p });
      // Stamp first-seen so the UI can show "opened 12m ago" instead of
      // "unknown" once a position actually opens during tracking.
      _whalePositionOpens.set(_whaleOpenKey(address, coin), now);
    } else {
      const oldSize = Math.abs(parseFloat(old.szi)) || 0;
      const newSize = Math.abs(parseFloat(p.szi))   || 0;
      if (oldSize > 0) {
        const changePct = Math.abs((newSize - oldSize) / oldSize);
        if (changePct >= WHALE_SIZE_CHANGE_THRESHOLD) {
          events.push({ action: newSize > oldSize ? 'INCREASE' : 'DECREASE', coin, position: p });
        }
      }
    }
  }
  for (const [coin, p] of Object.entries(prev)) {
    if (!next[coin]) {
      events.push({ action: 'CLOSE', coin, position: p });
      // Drop the openedAt — if the whale reopens this coin later, it gets a
      // fresh tracking timestamp instead of inheriting the previous one.
      _whalePositionOpens.delete(_whaleOpenKey(address, coin));
    }
  }
  _whaleLastSnapshot[address] = next;
  return events;
}

async function _logWhaleEvents(address, alias, events, accountValue) {
  if (!events.length) return;
  const ts = new Date().toISOString();
  const rows = events.map(ev => {
    const p = ev.position;
    const szi = parseFloat(p.szi);
    return {
      address,
      alias,
      coin: ev.coin,
      direction: szi >= 0 ? 'LONG' : 'SHORT',
      action: ev.action,
      size_usd: parseFloat(p.positionValue) || null,
      size_coin: Math.abs(szi),
      entry_px: parseFloat(p.entryPx) || null,
      leverage: parseFloat(p.leverage?.value) || null,
      pnl_usd: parseFloat(p.unrealizedPnl) || null,
      account_value: accountValue,
    };
  });
  // In-memory cache (ring buffer of 200)
  for (const r of rows) _whaleEventCache.unshift({ ...r, ts });
  if (_whaleEventCache.length > 200) _whaleEventCache.length = 200;
  // Best-effort DB persist
  if (supaAdmin) {
    try {
      const { error } = await supaAdmin.from('whale_events').insert(rows);
      if (error) console.warn('[whales] db insert error:', error.message);
    } catch (err) {
      console.warn('[whales] db insert failed:', err.message);
    }
  }
}

async function _whalePollOne(w) {
  const state = await _hlClearinghouseState(w.address);
  if (!state || !state.marginSummary) return;
  const accountValue = parseFloat(state.marginSummary.accountValue) || 0;
  const positions = (state.assetPositions || [])
    .filter(p => p && p.position)
    .map(p => p.position);
  _whalePositions[w.address] = {
    alias: w.alias,
    monthPnl: w.monthPnl,
    accountValue,
    positions,
    asOf: new Date().toISOString(),
  };
  const events = _diffWhaleSnapshot(w.address, positions);
  if (events.length) await _logWhaleEvents(w.address, w.alias, events, accountValue);
}

async function _whalePollAll() {
  if (!_whales.length) return;
  await Promise.all(_whales.map(w => _whalePollOne(w).catch(() => null)));
}

async function _whaleBoot() {
  try {
    await _whaleDiscovery();
    // First poll seeds _whaleLastSnapshot — we suppress events on the first
    // tick so we don't flood the feed with "every current position just
    // opened" on every server restart.
    if (_whales.length) {
      const first = await Promise.all(_whales.map(w => _hlClearinghouseState(w.address)));
      for (let i = 0; i < _whales.length; i++) {
        const w = _whales[i], state = first[i];
        if (!state) continue;
        const positions = (state.assetPositions || []).filter(p => p && p.position).map(p => p.position);
        _whaleLastSnapshot[w.address] = {};
        for (const p of positions) _whaleLastSnapshot[w.address][p.coin] = p;
        _whalePositions[w.address] = {
          alias: w.alias,
          monthPnl: w.monthPnl,
          accountValue: parseFloat(state.marginSummary?.accountValue) || 0,
          positions,
          asOf: new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn('[whales] boot failed:', err.message);
  }
  setInterval(_whaleDiscovery, WHALE_DISCOVERY_INTERVAL_MS);
  setInterval(_whalePollAll,   WHALE_POLL_INTERVAL_MS);
}

// Don't block server startup; warm up after a short delay so other init
// (DB, env, executor) gets to log first.
setTimeout(() => { _whaleBoot(); }, 5000);

// Open the market-wide liquidation socket. It buffers prints so the signal
// engine can read recent long/short liquidation flow at scan time.
setTimeout(() => { try { _liqBoot(); } catch (e) { console.warn('[liq] boot failed:', e.message || e); } }, 6000);

// ── /api/whales/list ── tracked whales + summary
app.get('/api/whales/list', requireAuth, async (_req, res) => {
  res.json({
    whales: _whales.map(w => ({
      address: w.address,
      alias: w.alias,
      monthPnl: +w.monthPnl.toFixed(0),
      accountValue: +w.accountValue.toFixed(0),
      currentPositions: (_whalePositions[w.address]?.positions || []).length,
    })),
    generatedAt: new Date().toISOString(),
  });
});

// ── /api/whales/positions ── current open positions across all tracked
app.get('/api/whales/positions', requireAuth, async (_req, res) => {
  const out = [];
  for (const w of _whales) {
    const data = _whalePositions[w.address];
    if (!data) continue;
    for (const p of data.positions) {
      const szi = parseFloat(p.szi);
      const openedAt = _whalePositionOpens.get(_whaleOpenKey(w.address, p.coin)) || null;
      out.push({
        address: w.address,
        alias: w.alias,
        monthPnl: +w.monthPnl.toFixed(0),
        coin: p.coin,
        direction: szi >= 0 ? 'LONG' : 'SHORT',
        sizeCoin: +Math.abs(szi),
        sizeUsd: +(parseFloat(p.positionValue) || 0).toFixed(0),
        entry: parseFloat(p.entryPx),
        leverage: +(parseFloat(p.leverage?.value) || 1),
        leverageType: p.leverage?.type || 'cross',
        uPnl: +(parseFloat(p.unrealizedPnl) || 0).toFixed(0),
        roe: +(parseFloat(p.returnOnEquity) || 0),
        liquidationPx: parseFloat(p.liquidationPx) || null,
        accountValue: +data.accountValue.toFixed(0),
        openedAt,   // ms since epoch or null if before tracking started
        asOf: data.asOf,
      });
    }
  }
  // Default sort: newest opens first (positions with known openedAt first,
  // then unknowns by sizeUsd desc as a stable fallback). Client can re-sort.
  out.sort((a, b) => {
    if (a.openedAt && b.openedAt) return b.openedAt - a.openedAt;
    if (a.openedAt) return -1;
    if (b.openedAt) return 1;
    return b.sizeUsd - a.sizeUsd;
  });
  res.json({ positions: out, count: out.length, generatedAt: new Date().toISOString() });
});

// ── /api/whales/detail/:address ── full account detail for the click-through page.
// Returns: account stats (equity, total notional, margin used, withdrawable),
// every open position with the full HL position object decoded into our
// shape, recent fills (last 30) from HL's userFills endpoint, and recent
// whale_events rows for that address. Used when the user clicks a whale in
// the list view. Route uses /detail/ prefix so static routes like /list,
// /positions, /events don't get caught by Express's :address param.
app.get('/api/whales/detail/:address', requireAuth, async (req, res) => {
  const addr = String(req.params.address || '').toLowerCase();
  const w = _whales.find(x => x.address.toLowerCase() === addr);
  if (!w) return res.status(404).json({ error: 'whale not tracked' });

  const [state, fills] = await Promise.all([
    _hlClearinghouseState(w.address),
    fetch(WHALE_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userFills', user: w.address }),
    }).then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  if (!state || !state.marginSummary) {
    return res.status(503).json({ error: 'Hyperliquid fetch failed; try again' });
  }

  const positions = (state.assetPositions || [])
    .filter(p => p && p.position)
    .map(p => {
      const pos = p.position;
      const szi = parseFloat(pos.szi);
      const openedAt = _whalePositionOpens.get(_whaleOpenKey(w.address, pos.coin)) || null;
      return {
        coin: pos.coin,
        direction: szi >= 0 ? 'LONG' : 'SHORT',
        sizeCoin: Math.abs(szi),
        sizeUsd: parseFloat(pos.positionValue) || 0,
        entry: parseFloat(pos.entryPx),
        leverage: parseFloat(pos.leverage?.value) || 1,
        leverageType: pos.leverage?.type || 'cross',
        uPnl: parseFloat(pos.unrealizedPnl) || 0,
        roe: parseFloat(pos.returnOnEquity) || 0,
        liquidationPx: parseFloat(pos.liquidationPx) || null,
        marginUsed: parseFloat(pos.marginUsed) || 0,
        cumFundingAllTime: parseFloat(pos.cumFunding?.allTime) || 0,
        openedAt,
      };
    })
    .sort((a, b) => {
      if (a.openedAt && b.openedAt) return b.openedAt - a.openedAt;
      if (a.openedAt) return -1;
      if (b.openedAt) return 1;
      return b.sizeUsd - a.sizeUsd;
    });

  // Recent fills — HL returns most-recent-first already. Trim to 30.
  const recentFills = (Array.isArray(fills) ? fills.slice(0, 30) : []).map(f => ({
    coin: f.coin,
    side: f.side,            // 'B' = buy, 'A' = ask/sell
    direction: f.dir,        // 'Open Long' / 'Close Short' / 'Open Short' / 'Close Long'
    px: parseFloat(f.px) || 0,
    sz: parseFloat(f.sz) || 0,
    usd: (parseFloat(f.px) || 0) * (parseFloat(f.sz) || 0),
    time: f.time,            // ms epoch
    fee: parseFloat(f.fee || 0),
    closedPnl: parseFloat(f.closedPnl || 0),
  }));

  // Recent tracked events for this address (opens / closes detected by our
  // diff loop). Falls back to in-memory ring buffer if DB is unavailable.
  let recentEvents = [];
  if (supaAdmin) {
    try {
      const { data } = await supaAdmin
        .from('whale_events')
        .select('coin, direction, action, size_usd, leverage, pnl_usd, ts')
        .eq('address', w.address)
        .order('ts', { ascending: false })
        .limit(20);
      if (data) recentEvents = data;
    } catch (err) { /* fall through */ }
  }
  if (!recentEvents.length) {
    recentEvents = _whaleEventCache.filter(e => e.address === w.address).slice(0, 20);
  }

  res.json({
    address: w.address,
    alias: w.alias,
    monthPnl: w.monthPnl,
    accountValue: parseFloat(state.marginSummary.accountValue) || 0,
    totalNotional: parseFloat(state.marginSummary.totalNtlPos) || 0,
    totalMarginUsed: parseFloat(state.marginSummary.totalMarginUsed) || 0,
    withdrawable: parseFloat(state.withdrawable) || 0,
    crossMaintenanceMargin: parseFloat(state.crossMaintenanceMarginUsed) || 0,
    positions,
    recentFills,
    recentEvents,
    generatedAt: new Date().toISOString(),
  });
});

// ── /api/whales/events ── recent activity feed (DB-backed)
app.get('/api/whales/events', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    if (supaAdmin) {
      const { data, error } = await supaAdmin
        .from('whale_events')
        .select('address, alias, coin, direction, action, size_usd, size_coin, entry_px, leverage, pnl_usd, account_value, ts')
        .order('ts', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return res.json({ events: data || [], generatedAt: new Date().toISOString() });
    }
    return res.json({ events: _whaleEventCache.slice(0, limit), generatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[whales/events]', err.message);
    return res.json({ events: _whaleEventCache.slice(0, limit), generatedAt: new Date().toISOString() });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// TREASURY WATCH — public on-chain balances of curated institutional wallets
// ════════════════════════════════════════════════════════════════════════════
// Watch-only sentiment layer. Big inflows to exchange wallets often precede
// selling pressure; big outflows often precede holding / withdrawal-to-cold.
// NOT trading signals — caveats in the UI.
//
// Address attribution is the hard part. The defaults here are HIGH-confidence
// publicly-known exchange and stable issuer wallets. The set is extensible
// via HENRY_TREASURY_ADDRESSES env JSON without a redeploy.
//
// BTC balances: blockstream.info free API.
//   GET /address/{addr} → chain_stats.funded_txo_sum − spent_txo_sum (sats)
// ETH balances: blockchair.com free API (30 rpm unauthenticated).
//   GET /ethereum/dashboards/address/{addr}?limit=0 → data.{addr}.address.balance (wei)
// Prices: Binance public ticker for BTCUSDT / ETHUSDT each cycle.

const TREASURY_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 min — slow movers
const TREASURY_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // keep last week

const TREASURY_ADDRESSES = (() => {
  const base = [
    { addr: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',                              name: 'Binance · Cold BTC',          chain: 'btc', entity: 'Binance'   },
    { addr: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h',                      name: 'Binance · Cold BTC 2',        chain: 'btc', entity: 'Binance'   },
    // BlackRock IBIT is custodied at Coinbase Prime. There is no officially
    // disclosed BlackRock-owned BTC address — the IBIT holdings sit inside
    // Coinbase Custody segregated cold wallets. This is the largest
    // publicly-attributed Coinbase Prime cold wallet associated with IBIT
    // in on-chain analyses (Arkham, Lookonchain). Holding 97k+ BTC across
    // 174+ txs at the time of curation. Best-effort attribution, not
    // official disclosure — labeled to make that clear in the UI.
    { addr: 'bc1qjasf9z3h7w3jspkhtgatgpyvvzgpa2wwd2lr0eh5tx44reyn2k7sfc27a4', name: 'BlackRock · IBIT (Coinbase Custody)', chain: 'btc', entity: 'BlackRock' },
    { addr: '0x28C6c06298d514Db089934071355E5743bf21d60',                      name: 'Binance · Hot 14',            chain: 'eth', entity: 'Binance'   },
    { addr: '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549',                      name: 'Binance · Hot 7',             chain: 'eth', entity: 'Binance'   },
    { addr: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3',                      name: 'Coinbase · 1',                chain: 'eth', entity: 'Coinbase'  },
    { addr: '0x503828976D22510aad0201ac7EC88293211D23Da',                      name: 'Coinbase · 2',                chain: 'eth', entity: 'Coinbase'  },
    { addr: '0x5754284f345afc66a98fbB0a0Afe71e0F007B949',                      name: 'Tether · Treasury',           chain: 'eth', entity: 'Tether'    },
    { addr: '0x5041ed759Dd4aFc3a72b8192C143F72f4724081A',                      name: 'OKX · Hot',                   chain: 'eth', entity: 'OKX'       },
  ];
  const raw = process.env.HENRY_TREASURY_ADDRESSES;
  if (raw) {
    try {
      const extra = JSON.parse(raw);
      if (Array.isArray(extra)) return base.concat(extra.filter(e => e.addr && e.chain && e.name));
    } catch (err) {
      console.warn('[treasury] HENRY_TREASURY_ADDRESSES not valid JSON:', err.message);
    }
  }
  return base;
})();

const _treasury = {};  // addr -> { name, entity, chain, balance, balanceUsd, history[], asOf }
const _treasuryPrices = { btc: 0, eth: 0, asOf: 0 };

async function _fetchSpotPrice(symbol) {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + symbol);
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d.price) || null;
  } catch { return null; }
}

async function _fetchBtcBalance(addr) {
  try {
    const r = await fetch('https://blockstream.info/api/address/' + addr);
    if (!r.ok) return null;
    const d = await r.json();
    const cs = d.chain_stats || {};
    const sats = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
    return sats / 1e8;
  } catch { return null; }
}

async function _fetchEthBalance(addr) {
  try {
    const r = await fetch('https://api.blockchair.com/ethereum/dashboards/address/' + addr + '?limit=0');
    if (!r.ok) return null;
    const d = await r.json();
    const key = Object.keys(d.data || {})[0];
    if (!key) return null;
    const weiStr = d.data[key]?.address?.balance;
    if (!weiStr) return null;
    return parseFloat(weiStr) / 1e18;
  } catch { return null; }
}

async function _treasuryPollOne(entry) {
  let balance = null;
  if (entry.chain === 'btc') balance = await _fetchBtcBalance(entry.addr);
  else if (entry.chain === 'eth') balance = await _fetchEthBalance(entry.addr);
  if (balance == null) return;
  const px = entry.chain === 'btc' ? _treasuryPrices.btc : _treasuryPrices.eth;
  const balanceUsd = px ? balance * px : null;
  const slot = _treasury[entry.addr] || {
    addr: entry.addr, name: entry.name, entity: entry.entity, chain: entry.chain, history: []
  };
  slot.balance = balance;
  slot.balanceUsd = balanceUsd;
  slot.asOf = new Date().toISOString();
  slot.history.push({ ts: Date.now(), balance });
  const cutoff = Date.now() - TREASURY_HISTORY_WINDOW_MS;
  slot.history = slot.history.filter(h => h.ts >= cutoff);
  _treasury[entry.addr] = slot;
}

async function _treasuryPollAll() {
  const [btc, eth] = await Promise.all([_fetchSpotPrice('BTCUSDT'), _fetchSpotPrice('ETHUSDT')]);
  if (btc) _treasuryPrices.btc = btc;
  if (eth) _treasuryPrices.eth = eth;
  _treasuryPrices.asOf = Date.now();
  // Sequential with 300ms stagger so we don't hammer blockchair's 30 rpm limit
  for (const e of TREASURY_ADDRESSES) {
    await _treasuryPollOne(e).catch(() => null);
    await new Promise(r => setTimeout(r, 300));
  }
}

async function _treasuryBoot() {
  try { await _treasuryPollAll(); }
  catch (err) { console.warn('[treasury] boot failed:', err.message); }
  setInterval(_treasuryPollAll, TREASURY_POLL_INTERVAL_MS);
}
setTimeout(() => { _treasuryBoot(); }, 10000); // 10s after server boot

// ── /api/whales/treasury ── current balances + 24h net flow
app.get('/api/whales/treasury', requireAuth, async (_req, res) => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const rows = Object.values(_treasury).map(s => {
    // Snapshot closest to 24h ago for delta (handles missed polls gracefully)
    let prev = null, bestDelta = Infinity;
    for (const h of s.history) {
      const d = Math.abs(h.ts - oneDayAgo);
      if (d < bestDelta) { bestDelta = d; prev = h; }
    }
    // Only count it as a "24h flow" if the prev snapshot is at least 12h old
    // — otherwise we're comparing today to today and the delta is noise.
    const validPrev = prev && (Date.now() - prev.ts) >= 12 * 60 * 60 * 1000;
    const flow24h = validPrev ? (s.balance - prev.balance) : null;
    const px = s.chain === 'btc' ? _treasuryPrices.btc : _treasuryPrices.eth;
    const flow24hUsd = (flow24h != null && px) ? flow24h * px : null;
    return {
      name: s.name,
      entity: s.entity,
      chain: s.chain,
      addr: s.addr,
      balance: s.balance,
      balanceUsd: s.balanceUsd,
      flow24h,
      flow24hUsd,
      asOf: s.asOf,
    };
  });
  rows.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0));
  res.json({
    rows,
    prices: {
      btc: _treasuryPrices.btc,
      eth: _treasuryPrices.eth,
      asOf: _treasuryPrices.asOf ? new Date(_treasuryPrices.asOf).toISOString() : null,
    },
    generatedAt: new Date().toISOString(),
  });
});

// ════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Henry The Hoover listening on :${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY not set');
  if (!process.env.DISCORD_WEBHOOK) console.warn('[warn] DISCORD_WEBHOOK not set');
  if (!process.env.DISCORD_AUTO_WEBHOOK) console.warn('[warn] DISCORD_AUTO_WEBHOOK not set');
  if (!process.env.DISCORD_STATUS_WEBHOOK) console.warn('[warn] DISCORD_STATUS_WEBHOOK not set — periodic status posts disabled');
  if (!process.env.DISCORD_JOURNAL_WEBHOOK) console.warn('[warn] DISCORD_JOURNAL_WEBHOOK not set — outcome cards skip the journal channel');
  // New routing (mirror signals + outcomes, dedicated WEEX channel):
  if (!process.env.DISCORD_SIGNALS_WEBHOOK) console.warn('[warn] DISCORD_SIGNALS_WEBHOOK not set — autoscan signals post to the auto channel only (no mirror)');
  if (!process.env.DISCORD_OUTCOME_WEBHOOK) console.warn('[warn] DISCORD_OUTCOME_WEBHOOK not set — signal outcomes post to the journal channel only (no mirror)');
  if (!process.env.DISCORD_WEEX_WEBHOOK) console.warn('[warn] DISCORD_WEEX_WEBHOOK not set — WEEX auto-trade execution alerts disabled');
  if (!POLYGON_API_KEY) console.warn('[warn] POLYGON_API_KEY not set — DXY and Gold endpoints will 502');
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) console.warn('[warn] VAPID keys not set — push notifications disabled');
  if (!process.env.WHOP_CHECKOUT_URL) console.warn('[warn] WHOP_CHECKOUT_URL not set — Whop subscriptions disabled');
  if (!process.env.WHOP_WEBHOOK_SECRET) console.warn('[warn] WHOP_WEBHOOK_SECRET not set — webhook signature verification will reject');
  if (!process.env.PADDLE_API_KEY) console.warn('[warn] PADDLE_API_KEY not set — Paddle card payments disabled');
  if (!process.env.NOWPAYMENTS_API_KEY) console.warn('[warn] NOWPAYMENTS_API_KEY not set — NowPayments crypto disabled');
});
