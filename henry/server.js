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
// Anthropic model used everywhere (server-side AI + browser AI ANALYSE).
// Override via HENRY_AI_MODEL env var on Railway when bumping to a new release.
// Models from generation 4.6+ use the dateless format `claude-{name}-{major}-{minor}`.
const AI_MODEL = process.env.HENRY_AI_MODEL || 'claude-sonnet-4-6';
// BE trigger: how far in profit before SL moves to breakeven. Default 70% of
// the way to TP (was 50%) — tested as the sweet spot in backtest. Override via
// HENRY_BE_TRIGGER_PCT env var on Railway (e.g. 0.5 for legacy behavior).
const BE_TRIGGER_PCT = parseFloat(process.env.HENRY_BE_TRIGGER_PCT) || 0.7;
const PADDLE_API_HOST = process.env.PADDLE_ENV === 'sandbox'
  ? 'sandbox-api.paddle.com'
  : 'api.paddle.com';

// ── WEEX auto-trade (admin-only) ────────────────────────────────────────────
// Wires the scan-loop signals → WEEX orders. Kill switch defaults OFF on every
// boot — must be explicitly turned on via /api/bot/state. Falls back to no-op
// if WEEX env vars are missing so the website still runs without keys.
const HENRY_RISK_USD = parseFloat(process.env.HENRY_RISK_USD) || 10;
const HENRY_LEVERAGE = parseInt(process.env.HENRY_LEVERAGE, 10) || 10;
const HENRY_BE_FEE_BUFFER_BPS = parseFloat(process.env.HENRY_BE_FEE_BUFFER_BPS) || 12;
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
    beFeeBufferBps: HENRY_BE_FEE_BUFFER_BPS,
    notifier: async (msg) => {
      if (process.env.DISCORD_JOURNAL_WEBHOOK) {
        try {
          await fetch(process.env.DISCORD_JOURNAL_WEBHOOK, {
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
  console.log('[weex] executor ready — risk=$' + HENRY_RISK_USD + ' lev=' + HENRY_LEVERAGE + 'x' + (HENRY_DRY_RUN ? ' DRY-RUN' : ''));
  // Reconcile on boot so a Railway redeploy doesn't lose BE management on
  // open positions. Best-effort: reads WEEX positions + their SL/TP plans
  // and rebuilds trade records. See lib/executor.js reconcile().
  weexExecutor.reconcile().then(r => {
    if (r.recovered > 0) console.log(`[weex] reconcile recovered ${r.recovered} open position(s)`);
    if (r.warnings && r.warnings.length) for (const w of r.warnings) console.warn(`[weex] reconcile warning: ${w}`);
  }).catch(err => console.warn('[weex] reconcile failed on boot:', err.message || err));
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
function pairIncomeEvents(events) {
  const queues = new Map();
  const trades = [];
  const sorted = [...events].sort((a, b) => (parseInt(a.time) || 0) - (parseInt(b.time) || 0));
  for (const ev of sorted) {
    const t = String(ev.incomeType || '');
    const ts = parseInt(ev.time) || 0;
    const income = parseFloat(ev.income) || 0;
    const sym = ev.symbol;
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

// WEEX-sourced PnL aggregation. Anchored at STATS_START_MS so the dashboard
// only counts trades from that date forward — historical data before the
// anchor is excluded entirely from today/month/total. Pairs income events
// into round-trips and rolls up. Returns null on fetch failure.
async function aggregateWeexIncomePnl() {
  if (!weexClient) return null;
  const now = Date.now();
  const cacheStale = now - _incomeCache.fetchedAt > INCOME_CACHE_MS;
  if (cacheStale) {
    const events = await weexClient.getAllIncomeSince(STATS_START_MS, 30).catch(err => {
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
  let today = 0, month = 0, total = 0;
  const dailyMap = new Map();
  for (const tr of trades) {
    if (tr.ts < STATS_START_MS) continue; // belt-and-suspenders
    total += tr.pnl;
    if (tr.ts >= startOfMonthUtc) {
      month += tr.pnl;
      const day = new Date(tr.ts).getUTCDate();
      dailyMap.set(day, (dailyMap.get(day) || 0) + tr.pnl);
    }
    if (tr.ts >= startOfTodayUtc) today += tr.pnl;
  }
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const daily = [];
  for (let day = 1; day <= dim; day++) daily.push({ day, pnl: dailyMap.get(day) || 0 });
  return { today, month, total, daily, closedCount: trades.length, source: 'weex_income' };
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
app.get('/terminal', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

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
  // EXPIRED is included so unfilled signals show up in the journal feed,
  // but circuit-breaker recording stays gated to TP/SL/BE only (expiry isn't
  // a P/L event — should never contribute to a "losing streak" pause).
  if (wasUnset && (outcome === 'TP' || outcome === 'SL' || outcome === 'BE' || outcome === 'EXPIRED')) {
    const stats = await getUserStats(userId).catch(() => null);
    postJournalToDiscord(signalForJournal, outcome, outcomeRr, stats)
      .catch(e => console.error('[journal post]', e.message));
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

// ── Journal Discord posting ──
async function postJournalToDiscord(signal, outcome, outcomeRr, stats) {
  if (!process.env.DISCORD_JOURNAL_WEBHOOK) {
    console.warn('[journal] DISCORD_JOURNAL_WEBHOOK env var not set — skipping post');
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
  try {
    const r = await fetch(process.env.DISCORD_JOURNAL_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], username: 'Henry Journal' }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[journal webhook]', r.status, t.slice(0, 200));
    } else {
      console.log('[journal] posted', outcome, signal.pair, signal.direction);
    }
  } catch (e) {
    console.error('[journal webhook]', e.message);
  }
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
// CORRELATION CLUSTERS — portfolio heat caps
// ════════════════════════════════════════════════════════════════════════════
function getClusterFor(coin) {
  const u = coin.toUpperCase();
  if (/^BTC/.test(u))                                            return 'btc';
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
  const url = process.env.DISCORD_AUTO_WEBHOOK;
  if (!url) return;
  const colorMap = { gr: 3066993, re: 15548997, am: 16750848, cy: 6535167, pu: 9699539 };
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Henry Auto Monitor',
        embeds: [{
          title, description: msg, color: colorMap[color] || colorMap.cy,
          footer: { text: 'Henry server-side monitor' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) { console.error('[discord auto]', e.message); }
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
        ps._entryAlerted = true;
        ps._expiryAlerted = true;
        ps.lastStatus = 'in-trade';
        await notifyUser(userId, isAdmin, {
          title: `🎯 ENTRY HIT: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
          body: `Entry filled @ ${price}. Trade is now ACTIVE.`,
          color: 'cy',
        });
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
          ps._entryAlerted = true;
          ps._expiryAlerted = true;
          ps.lastStatus = 'in-trade';
          const label = `${picked.r.summary} (score ${picked.r.score}, ${picked.tf})`;
          console.log('[entry-confirm]', coin, 'CONFIRMED:', label, 'price=' + price);
          await notifyUser(userId, isAdmin, {
            title: `🎯 ENTRY HIT: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
            body: `Entry filled @ ${price} — confirmed by ${label}. Trade is now ACTIVE.`,
            color: 'cy',
          });
        } else if (elapsed >= ENTRY_CONFIRM_TIMEOUT_MS) {
          // Fallback: 2h elapsed, fire anyway as UNCONFIRMED so trade isn't lost
          ps._entryAlerted = true;
          ps._expiryAlerted = true;
          ps.lastStatus = 'in-trade';
          console.log('[entry-confirm]', coin, 'TIMEOUT — firing unconfirmed', 'attempts=' + ps._confirmAttempts);
          await notifyUser(userId, isAdmin, {
            title: `🎯 ENTRY HIT (UNCONFIRMED): ${coin.replace('USDT', '')} ${pendSignal.direction}`,
            body: `Entry @ ${price}. 2h confirmation window elapsed — no qualifying ICT/S&D pattern fired. Trade is ACTIVE.`,
            color: 'am',
          });
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

  // WEEX auto-trade hook 2/6: entry confirmation → mark trade ACTIVE on WEEX
  // (and market-rescue if our LIMIT didn't fill). Fires exactly once per signal.
  if (ps._entryAlerted && !ps._weexEntryFired && autoTradeAllowed(isAdmin) && ps.signalId) {
    ps._weexEntryFired = true;
    fireExecutor('handleEntryHit', { signalId: ps.signalId, fillPrice: price }, 'entryHit');
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
      if (!ps._weexBeFired && autoTradeAllowed(isAdmin) && ps.signalId) {
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
      if (!ps._weexClosed && autoTradeAllowed(isAdmin) && ps.signalId) {
        ps._weexClosed = true;
        fireExecutor('handleTpHit', { signalId: ps.signalId, exitPrice: tpPrice }, 'tpHit');
      }
      clearPairState(ps);
      return;
    }
  }

  // SL hit — original stop-loss breached
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
    if (!ps._weexClosed && autoTradeAllowed(isAdmin) && ps.signalId) {
      ps._weexClosed = true;
      fireExecutor('handleSlHit', { signalId: ps.signalId, exitPrice: slPrice }, 'slHit');
    }
    clearPairState(ps);
    return;
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
      if (!ps._weexClosed && autoTradeAllowed(isAdmin) && ps.signalId) {
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
      const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin}&interval=${tf}&limit=${limit}`);
      const arr = await r.json();
      return arr.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
    }
    // weex (default) — they changed the API: granularity now takes string
    // suffixes ("15m" instead of "900") and the timestamp is returned in
    // MILLISECONDS, not seconds. The old format silently returned HTTP 400
    // with code 40020 ("参数granularity错误") and our parser swallowed the
    // error, leaving lastPrice=null and no triggers ever firing.
    const fsym = FUTURES_SYM_SERVER[coin] || ('cmt_' + coin.toLowerCase());
    const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '12h': '12h', '1d': '1d', '1w': '1w' };
    const gran = tfMap[tf] || '15m';
    const r = await fetch(`https://api-contract.weex.com/capi/v2/market/candles?symbol=${fsym}&granularity=${gran}&limit=${limit}`);
    const raw = await r.json();
    if (!Array.isArray(raw)) {
      // Weex error object — log so it surfaces in Railway instead of silent failure
      console.warn('[fetchCandlesServer] weex non-array:', coin, gran, JSON.stringify(raw).slice(0, 200));
      return [];
    }
    return raw.map(c => {
      const t = +c[0];
      // Auto-detect units: > 1e12 means ms already, else seconds
      return { t: t > 1e12 ? t : t * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] };
    });
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
async function callAnthropicServer(systemPrompt, userMessage, maxTokens = 800) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const d = await _anthropicFetchWithRetry({
    model: AI_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  return (d.content && d.content[0] && d.content[0].text) || '';
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

function buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, oi, trigger, indicators }) {
  const lines = [];
  lines.push(`AUTO TRIGGER: ${trigger.type.toUpperCase()} — ${trigger.desc}`);

  // ── ATR-based stop guidance (asset-class specific) ──
  if (indicators && indicators.atr14 != null) {
    const am = atrMultiplierForAsset(coin);
    const atrStopDist = indicators.atr14 * am.multiplier;
    const buffer = indicators.atr14 * 1.5;
    lines.push(
      `\nVOLATILITY (ATR-based stops — REPLACES fixed/round-number stops):` +
      `\n  ATR(14) on ${tf} = ${indicators.atr14.toFixed(4)}` +
      `\n  Asset class: ${am.klass} → multiplier ${am.multiplier}× ATR = ${atrStopDist.toFixed(4)} stop distance from entry` +
      `\n  STOP PLACEMENT RULE: place SL BEYOND structure (swing low for LONG, swing high for SHORT) + ${buffer.toFixed(4)} (1.5×ATR) buffer.` +
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

  if (oi != null && !Number.isNaN(oi)) {
    lines.push(`OPEN INTEREST: ${(oi / 1e6).toFixed(2)}M contracts.`);
  }

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
    '4. Funding rate — positioning, fade extremes',
    '5. Open interest — directional conviction',
    '6. Liquidity heatmap — swing levels, equal highs/lows, sweep targets',
    '7. Order flow / footprint — buy/sell delta, POC, imbalances, absorption',
    '8. CVD trend — cumulative volume delta momentum across 5 windows',
    '9. Cross-broker check — agreement across Weex/Binance/Hyperliquid',
    '10. News headlines — sentiment + impact tagged',
    '11. Economic calendar — high-impact events in next 4 hours',
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
    '• Place SL BEYOND the structural invalidation level (swing low for LONG, swing high for SHORT) PLUS a 1.5×ATR buffer.',
    '• For example, if structure low = 80,100 and ATR = 50, LONG SL should be near 80,100 - (1.5 × 50) = 80,025 — NOT at 80,100 itself.',
    '• Distance from entry to SL should approximate the asset-class multiplier × ATR (e.g. 2.0×ATR for BTC/ETH, 2.5×ATR for SOL/AVAX/oil, 3.0×ATR for PEPE/DOGE).',
    '• NEVER place SL exactly on a round number (80,000, 2,300, 100, etc). 80% of retail stops cluster there and get hunted by algos. Offset by at least 0.5×ATR.',
    '• Tighter stops than 1.5×ATR will fail more often. Wider than 4×ATR will tank your RR.',
    '',
    'BE_NOTE RULES:',
    'be_note is the price at which the user moves SL to entry (breakeven).',
    'For LONG: BE price MUST be ABOVE entry, BELOW TP. Recommended: 70% of the way from entry to TP (gives the trade more room before locking in BE).',
    'For SHORT: BE price MUST be BELOW entry, ABOVE TP. Recommended: 70% of the way from entry to TP.',
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
  const url = process.env.DISCORD_AUTO_WEBHOOK;
  if (!url || !signal || signal.direction === 'NO TRADE') return;
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
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], username: 'Henry Auto' }),
    });
  } catch (e) { console.error('[server signal discord]', e.message); }
}

// Main entry — runs the full AI flow on the server when a trigger fires for a pair.
async function runServerAIForPair(userId, sub, coin, ps, trigger, baseCandles, brokerOverride) {
  const { tf, isAdmin } = sub;
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
    mtfH1, mtfH4, btcCandles, funding, oi,
    trades, newsCtx, calCtx, crossBrokerCtx, dxyData,
  ] = await Promise.all([
    fetchCandlesServer(coin, '1h', 50, broker).catch(() => []),
    fetchCandlesServer(coin, '4h', 30, broker).catch(() => []),
    // BTC correlation only for non-gold + non-BTC pairs
    (!isMetalOrOilPair && coin !== 'BTCUSDT') ? fetchCandlesServer('BTCUSDT', tf, 30, btcBroker).catch(() => []) : Promise.resolve([]),
    fetchFundingRateServer(coin).catch(() => null),
    fetchOpenInterestServer(coin).catch(() => null),
    fetchTradesServer(coin, broker).catch(() => []),
    fetchNewsContext().catch(() => ''),
    fetchCalendarContext().catch(() => ''),
    buildCrossBrokerContextServer(coin, tf, broker).catch(() => ''),
    // DXY context for gold pairs only — replaces BTC correlation
    isMetalOrOilPair ? fetchDXYContextServer().catch(() => null) : Promise.resolve(null),
  ]);

  // Derived contexts from data we already fetched (synchronous, no extra fetches)
  const liquidityCtx = buildLiquidityContextServer(baseCandles, tf);
  const footprintCtx = buildFootprintContextServer(trades, baseCandles);
  const cvdCtx       = buildCVDContextServer(trades);

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
  const baseCtx = buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, oi, trigger, indicators });
  const dxyCtx = isMetalOrOilPair ? buildDXYContextString(dxyData) : '';
  const contextStr = [baseCtx, dxyCtx, liquidityCtx, footprintCtx, cvdCtx, crossBrokerCtx, newsCtx, calCtx]
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

  signal = validateAndFixBEServer(signal);
  if (signal.confidence != null) signal.confidence = Math.max(0, Math.min(100, parseFloat(signal.confidence) || 0));

  const signalId = await saveServerSignal(userId, signal, trigger, broker, tf);

  // Rich push with the full signal — phone shows entry/SL/TP/RR/confidence inline
  await sendPushTo(userId, {
    title: `⚡ ${signal.direction === 'LONG' ? '🟢' : '🔴'} ${coin.replace('USDT', '')} ${signal.direction}`,
    body: `Entry ${signal.entry} | SL ${signal.sl} | TP ${signal.tp} | ${signal.rr || '—'}R @ ${signal.confidence || '—'}%`,
    icon: '/manifest.json',
    data: { coin, tf, broker, signalId, trigger, signal },
  });

  // Discord (admin-only — auto-scan is admin-only anyway, but defensive).
  // Fall back to email check so a stale sub.isAdmin=false (from before the
  // email-fallback fix) doesn't silently swallow Discord posts.
  if (isAdmin || (sub.email && sub.email === ADMIN_EMAIL)) {
    await postServerSignalToDiscord(signal, trigger, broker, tf).catch(e => console.error('[discord auto]', e.message));
  }

  // Activate the trade monitor for THIS pair — other pairs continue scanning independently.
  ps.pendSignal = signal;
  ps.signalId = signalId;
  ps.signalTimestamp = Date.now();
  ps._entryAlerted = false;
  ps._beAlerted = false;
  ps._tpAlerted = false;
  ps._expiryAlerted = false;
  ps._outcomeLogged = false;
  ps._confirmationPending = false;  // signal already announced; LTF gate just confirms the entry
  ps._trigger = trigger;
  ps._broker = broker;
  ps.lastStatus = 'waiting';
  ps._weexEntryFired = false;
  ps._weexBeFired = false;
  ps._weexClosed = false;

  // WEEX auto-trade hook 1/6: place entry + SL + TP. Admin-only, gated by kill switch.
  if (autoTradeAllowed(isAdmin) && signalId) {
    fireExecutor('handleSetup', {
      signalId, pair: signal.pair,
      side: signal.direction === 'LONG' ? 'long' : 'short',
      entry: parseFloat(signal.entry), sl: parseFloat(signal.sl), tp: parseFloat(signal.tp),
    }, 'setup');
  }

  return signal;
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

  // 1) If pair has an active signal → monitor it (entry/BE/TP/SL/expiry)
  //    Trade monitor still runs even if circuit breaker is on — once you're IN
  //    a trade, you need exit alerts regardless.
  if (ps.pendSignal) {
    try {
      await runServerTradeMonitorForPair(userId, sub, coin, ps, broker);
    } catch (e) { console.error('[monitor]', coin, e.message); }
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

  try {
    // Fetch candles + detect trigger (using the pair's appropriate broker)
    let candles, trigger;
    try {
      candles = await fetchCandlesServer(coin, sub.tf, 30, broker);
      trigger = (candles && candles.length >= 11) ? detectTrigger(candles) : null;
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
    const pre = await preAiConfluenceScore(coin, sub.tf, broker, candles, trigger).catch(() => null);
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
      aiSignal = await runServerAIForPair(userId, sub, coin, ps, trigger, candles, broker);
    } catch (e) { console.error('[runServerAIForPair]', coin, e.message); }

    // Fallback: AI failed → still push a trigger alert
    if (!aiSignal) {
      ps.lastStatus = 'cooldown';
      await sendPushTo(userId, {
        title: `⚡ ${trigger.type.toUpperCase()}: ${coin.replace('USDT', '').replace('1000', '')}`,
        body: `${trigger.desc}. Open Henry to run AI analysis.`,
        icon: '/manifest.json',
        data: { coin, tf: sub.tf, broker, trigger },
      });
    }
  } finally {
    // Always release the in-flight lock, even on exceptions or early returns.
    ps._scanInFlight = false;
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
    const buffer = indicators.atr14 * 1.5;
    ctxLines.push(
      `\nVOLATILITY (ATR-based stops — REPLACES fixed/round-number stops):` +
      `\n  ATR(14) on ${tf} = ${indicators.atr14.toFixed(4)}` +
      `\n  Asset class: ${am.klass} → multiplier ${am.multiplier}× ATR = ${atrStopDist.toFixed(4)} stop distance from entry` +
      `\n  STOP PLACEMENT RULE: place SL BEYOND structure (swing low for LONG, swing high for SHORT) + ${buffer.toFixed(4)} (1.5×ATR) buffer.` +
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

app.listen(PORT, () => {
  console.log(`Henry The Hoover listening on :${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY not set');
  if (!process.env.DISCORD_WEBHOOK) console.warn('[warn] DISCORD_WEBHOOK not set');
  if (!process.env.DISCORD_AUTO_WEBHOOK) console.warn('[warn] DISCORD_AUTO_WEBHOOK not set');
  if (!process.env.DISCORD_STATUS_WEBHOOK) console.warn('[warn] DISCORD_STATUS_WEBHOOK not set — periodic status posts disabled');
  if (!process.env.DISCORD_JOURNAL_WEBHOOK) console.warn('[warn] DISCORD_JOURNAL_WEBHOOK not set — trade journal posts disabled');
  if (!POLYGON_API_KEY) console.warn('[warn] POLYGON_API_KEY not set — DXY and Gold endpoints will 502');
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) console.warn('[warn] VAPID keys not set — push notifications disabled');
  if (!process.env.WHOP_CHECKOUT_URL) console.warn('[warn] WHOP_CHECKOUT_URL not set — Whop subscriptions disabled');
  if (!process.env.WHOP_WEBHOOK_SECRET) console.warn('[warn] WHOP_WEBHOOK_SECRET not set — webhook signature verification will reject');
  if (!process.env.PADDLE_API_KEY) console.warn('[warn] PADDLE_API_KEY not set — Paddle card payments disabled');
  if (!process.env.NOWPAYMENTS_API_KEY) console.warn('[warn] NOWPAYMENTS_API_KEY not set — NowPayments crypto disabled');
});
