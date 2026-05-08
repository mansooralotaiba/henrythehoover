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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mansoor.alotaiba@gmail.com').toLowerCase();
const PADDLE_API_HOST = process.env.PADDLE_ENV === 'sandbox'
  ? 'sandbox-api.paddle.com'
  : 'api.paddle.com';

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
    const profile = await loadProfile(email);
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
    const profile = await loadProfile(session.user.email.toLowerCase()).catch(() => null);
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
app.post('/api/claude', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'anthropic_not_configured' });
  }
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(req.body),
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding' || k === 'connection') return;
      res.setHeader(key, value);
    });
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      if (typeof res.flush === 'function') res.flush();
    }
    res.end();
  } catch (err) {
    console.error('[claude proxy]', err);
    if (!res.headersSent) res.status(502).json({ error: 'upstream', detail: String(err?.message || err) });
    else res.end();
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
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const tf = POLY_TF[interval] || POLY_TF['15m'];
    const start = Date.now() - tf.ms * limit * 2;
    const from = new Date(start).toISOString().split('T')[0];
    const to = new Date().toISOString().split('T')[0];
    const data = await polyFetch(
      `/v2/aggs/ticker/C:XAUUSD/range/${tf.multiplier}/${tf.timespan}/${from}/${to}`,
      { adjusted: 'true', sort: 'asc', limit }
    );
    const candles = (data.results || []).slice(-limit).map(r => ({
      time: Math.floor(r.t / 1000), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0,
    }));
    res.json({ candles });
  } catch (err) {
    console.error('[gold/candles]', err);
    res.status(502).json({ error: 'gold_candles_failed', detail: String(err.message || err) });
  }
});

async function getGoldSpot() {
  // Snapshot endpoint works for forex; /v2/last/trade is stocks-only.
  const data = await polyFetch('/v2/snapshot/locale/global/markets/forex/tickers', { tickers: 'C:XAUUSD' });
  const t = data.tickers && data.tickers[0];
  if (!t) return null;
  const ask = t.lastQuote?.a;
  const bid = t.lastQuote?.b;
  if (ask && bid) return (ask + bid) / 2;
  return ask || bid || t.day?.c || t.prevDay?.c || null;
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

  // Post journal on first outcome assignment OR when we just backfilled
  if (wasUnset && (outcome === 'TP' || outcome === 'SL' || outcome === 'BE')) {
    const stats = await getUserStats(userId).catch(() => null);
    postJournalToDiscord(signalForJournal, outcome, outcomeRr, stats)
      .catch(e => console.error('[journal post]', e.message));
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
  const isWin = outcome === 'TP';
  const isBE  = outcome === 'BE';
  const outcomeEmoji = isWin ? '🟢' : isBE ? '🟡' : '🔴';
  const outcomeLabel = isWin ? 'TAKE PROFIT' : isBE ? 'BREAKEVEN' : 'STOP LOSS';
  const rrDisplay = isWin ? `+${outcomeRr ?? signal.rr ?? '—'}R` : isBE ? '0R' : '-1R';
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
    color: isWin ? 3066993 : isBE ? 16776960 : 15548997,
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

// ════════════════════════════════════════════════════════════════════════════
// PART 4A/B/F — SERVER-SIDE SCAN LOOP + TRADE MONITOR
// ════════════════════════════════════════════════════════════════════════════

const scanSubscriptions = new Map(); // userId → { active, coin, tf, broker, isAdmin, ... }
const SCAN_INTERVAL_MS = 30000;

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
  ps.lastStatus = 'idle';
}

app.post('/api/scan/start', requireAuth, express.json(), async (req, res) => {
  const { coin, tf, broker, cooldownMs, watchlist } = req.body || {};
  if (!coin || !tf) return res.status(400).json({ error: 'missing_coin_or_tf' });
  // Preserve existing per-pair state if scan is restarted (e.g. user toggled AUTO off and on)
  const prev = scanSubscriptions.get(req.user.id);
  scanSubscriptions.set(req.user.id, {
    active: true, coin, tf, broker: broker || 'weex',
    cooldownMs: cooldownMs || 180000,
    watchlist: Array.isArray(watchlist) ? watchlist : [],
    isAdmin: !!req.profile.is_admin,
    pairs: prev?.pairs || {},
  });
  res.json({ ok: true });
});

// Update watchlist on the fly without restarting the scan
app.post('/api/scan/update-watchlist', requireAuth, express.json(), (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.status(404).json({ error: 'no_scan_session' });
  sub.watchlist = Array.isArray(req.body?.watchlist) ? req.body.watchlist : [];
  res.json({ ok: true, count: sub.watchlist.length });
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

// Returns state for ALL pairs in the watchlist — used by mini-cards UI.
app.get('/api/scan/all-pairs', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.json({ active: false, pairs: [] });
  // Pairs to report on: union of watchlist + any pair that has state (e.g. signal active)
  const pairCoins = new Set([
    ...(sub.watchlist || []),
    ...(sub.pairs ? Object.keys(sub.pairs) : []),
  ]);
  if (!pairCoins.size && sub.coin) pairCoins.add(sub.coin);
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
      cooldownUntil: ps ? ps.cooldownUntil : 0,
      cooldownRemaining: ps ? Math.max(0, ps.cooldownUntil - Date.now()) : 0,
      status: ps ? ps.lastStatus : 'idle',
      entryAlerted: !!(ps && ps._entryAlerted),
      beAlerted:    !!(ps && ps._beAlerted),
      tpAlerted:    !!(ps && ps._tpAlerted),
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
  await postAlertToDiscord(title, body, color || 'cy', isAdmin);
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

  // Entry hit
  const entryHit = isLong ? price <= e : price >= e;
  if (entryHit && !ps._entryAlerted) {
    ps._entryAlerted = true;
    ps._expiryAlerted = true;
    ps.lastStatus = 'in-trade';
    await notifyUser(userId, isAdmin, {
      title: `🎯 ENTRY HIT: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
      body: `Entry filled @ ${price}. Trade is now ACTIVE.`,
      color: 'cy',
    });
  }

  // BE
  if (ps._entryAlerted && !ps._beAlerted) {
    const bePrice = isLong ? e + (tpP - e) * 0.5 : e - (e - tpP) * 0.5;
    const beReached = isLong ? price >= bePrice : price <= bePrice;
    if (beReached) {
      ps._beAlerted = true;
      await notifyUser(userId, isAdmin, {
        title: '⚑ MOVE SL TO BREAKEVEN',
        body: `${coin.replace('USDT', '')} reached BE @ ${price.toFixed(2)}. Move SL to ${e}.`,
        color: 'am',
      });
    }
  }

  // TP
  if (ps._entryAlerted && !ps._tpAlerted) {
    const tpHit = isLong ? price >= tpP : price <= tpP;
    if (tpHit) {
      ps._tpAlerted = true;
      console.log('[monitor]', coin, 'TP hit at', price, 'signalId=' + ps.signalId);
      await notifyUser(userId, isAdmin, {
        title: `🎯 TP REACHED: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
        body: `Take profit hit @ ${price.toFixed(2)}. Logged.`,
        color: 'gr',
      });
      if (!ps._outcomeLogged) {
        ps._outcomeLogged = true;
        // Pass in-memory signal as fallback so journal still posts if DB row is missing
        await logSignalOutcomeAndJournal(userId, ps.signalId, 'TP', parseFloat(pendSignal.rr) || 2, pendSignal, broker, tf)
          .catch(e => console.error('[server TP outcome]', e.message));
      }
      clearPairState(ps);
      return;
    }
  }

  // SL hit — original stop-loss breached
  const slHit = isLong ? price <= slP : price >= slP;
  // BE-stop hit — fires when:
  //   • BE alert already fired (user should have moved SL to entry)
  //   • Price returned to entry (LONG: cp <= e; SHORT: cp >= e)
  //   • Price hasn't yet reached original SL (otherwise slHit handles it)
  // This catches the case where price spikes to BE level, user moves SL to entry,
  // price comes back to entry → effective SL hit at breakeven, no need to wait
  // for the original (further-away) SL.
  const beStopHit = ps._beAlerted && (isLong ? (price <= e && price > slP) : (price >= e && price < slP));
  if (slHit || beStopHit) {
    const wasBE = ps._beAlerted; // true if BE-stop OR (slHit while _beAlerted is set)
    const reason = beStopHit ? 'BE-stop' : (wasBE ? 'SL-after-BE' : 'SL');
    console.log('[monitor]', coin, reason, 'hit at', price, 'signalId=' + ps.signalId);
    if (!ps._outcomeLogged) {
      ps._outcomeLogged = true;
      await logSignalOutcomeAndJournal(userId, ps.signalId, wasBE ? 'BE' : 'SL', wasBE ? 0 : -1, pendSignal, broker, tf)
        .catch(e => console.error('[server SL outcome]', e.message));
    }
    await notifyUser(userId, isAdmin, {
      title: `${wasBE ? '⚑ STOPPED AT BE' : '🛑 SL HIT'}: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
      body: `${wasBE ? 'Closed at breakeven' : 'Stop loss breached'} @ ${price.toFixed(2)}. Logged automatically.`,
      color: wasBE ? 'am' : 're',
    });
    clearPairState(ps);
    return;
  }

  // Expiry — only if entry never hit, fires once, clears the trade
  if (!ps._entryAlerted && !ps._expiryAlerted && pendSignal.expiry_candles) {
    const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
    const maxMs = pendSignal.expiry_candles * (tfMs[tf] || 900000);
    if (Date.now() - ps.signalTimestamp > maxMs) {
      ps._expiryAlerted = true;
      await notifyUser(userId, isAdmin, {
        title: '⏱ SIGNAL EXPIRED',
        body: `Cancel limit order — ${coin.replace('USDT', '')} signal expired after ${pendSignal.expiry_candles} candles.`,
        color: 'am',
      });
      clearPairState(ps);
    }
  }
}

// Lightweight server-side trigger detection — close-vs-prev-high/low scan.
// Browser does the heavy multi-source analysis; server only flags candidates worth investigating.
async function fetchCandlesServer(coin, tf, limit, broker) {
  try {
    if (broker === 'massive' || coin === 'GOLD' || coin === 'XAUUSD') {
      const tfDef = POLY_TF[tf] || POLY_TF['15m'];
      const start = Date.now() - tfDef.ms * limit * 2;
      const from = new Date(start).toISOString().split('T')[0];
      const to = new Date().toISOString().split('T')[0];
      const data = await polyFetch(
        `/v2/aggs/ticker/C:XAUUSD/range/${tfDef.multiplier}/${tfDef.timespan}/${from}/${to}`,
        { adjusted: 'true', sort: 'asc', limit }
      );
      return (data.results || []).slice(-limit).map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0 }));
    }
    if (broker === 'binance') {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin}&interval=${tf}&limit=${limit}`);
      const arr = await r.json();
      return arr.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
    }
    // weex (default)
    const fsym = FUTURES_SYM_SERVER[coin] || ('cmt_' + coin.toLowerCase());
    const tfMap = { '1m': '60', '5m': '300', '15m': '900', '1h': '3600', '4h': '14400', '1d': '86400' };
    const r = await fetch(`https://api-contract.weex.com/capi/v2/market/candles?symbol=${fsym}&granularity=${tfMap[tf] || '900'}&limit=${limit}`);
    const arr = await r.json();
    return (Array.isArray(arr) ? arr : []).map(c => ({ t: +c[0] * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
  } catch (e) {
    console.error('[fetchCandlesServer]', e.message);
    return [];
  }
}

function detectTrigger(candles) {
  if (!candles || candles.length < 10) return null;
  const last = candles[candles.length - 1];
  const recent = candles.slice(-11, -1);
  const highs = recent.map(c => c.h), lows = recent.map(c => c.l);
  const maxH = Math.max(...highs), minL = Math.min(...lows);
  // Break of structure: close exceeds recent range
  if (last.c > maxH) return { type: 'bos', desc: `BOS up — close ${last.c} > prev high ${maxH.toFixed(2)}` };
  if (last.c < minL) return { type: 'bos', desc: `BOS down — close ${last.c} < prev low ${minL.toFixed(2)}` };
  // Sweep: wick beyond range but close back inside
  if (last.h > maxH && last.c < maxH) return { type: 'sweep', desc: `Sweep high — wick ${last.h.toFixed(2)} swept ${maxH.toFixed(2)}, closed back inside` };
  if (last.l < minL && last.c > minL) return { type: 'sweep', desc: `Sweep low — wick ${last.l.toFixed(2)} swept ${minL.toFixed(2)}, closed back inside` };
  return null;
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
const CALENDAR_EVENTS_SERVER = [
  { time: 'Mon 08:30', zone: 'USD', name: 'ISM Manufacturing PMI',           imp: 'high' },
  { time: 'Tue 10:00', zone: 'USD', name: 'JOLTS Job Openings',              imp: 'high' },
  { time: 'Wed 14:30', zone: 'USD', name: 'ADP Employment Change',           imp: 'high' },
  { time: 'Wed 14:30', zone: 'USD', name: 'US CPI m/m',                      imp: 'high' },
  { time: 'Wed 20:00', zone: 'USD', name: 'FOMC Statement / Rate Decision',  imp: 'high' },
  { time: 'Thu 14:30', zone: 'USD', name: 'Initial Jobless Claims',          imp: 'med'  },
  { time: 'Thu 14:30', zone: 'USD', name: 'US PPI m/m',                      imp: 'med'  },
  { time: 'Fri 14:30', zone: 'USD', name: 'Non-Farm Payrolls',               imp: 'high' },
  { time: 'Fri 14:30', zone: 'USD', name: 'Unemployment Rate',               imp: 'high' },
  { time: 'Tue 09:30', zone: 'GBP', name: 'UK CPI y/y',                      imp: 'high' },
  { time: 'Wed 09:00', zone: 'EUR', name: 'Eurozone CPI Flash',              imp: 'high' },
  { time: 'Thu 13:45', zone: 'EUR', name: 'ECB Rate Decision',               imp: 'high' },
  { time: 'Fri 09:30', zone: 'GBP', name: 'UK GDP m/m',                      imp: 'high' },
];
let _calendarCache = { ts: 0, items: [] };

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
      if (r.ok) {
        const raw = await r.json();
        if (Array.isArray(raw)) {
          live = raw
            .filter(e => e.impact === 'High' || e.impact === 'Medium')
            .map(e => ({
              dt: new Date(e.date).getTime(),
              zone: e.country, name: e.title,
              imp: e.impact === 'High' ? 'high' : 'med',
              forecast: e.forecast, prev: e.previous, actual: e.actual,
            }));
        }
      }
    } catch {}
    if (!live.length) {
      // Fallback: build static events with current-week dates (UTC)
      const dnow = new Date();
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      live = CALENDAR_EVENTS_SERVER.map(e => {
        const parts = e.time.split(' ');
        if (parts.length < 2) return null;
        const dayIdx = days.indexOf(parts[0]);
        if (dayIdx < 0) return null;
        const hm = parts[1].split(':');
        const dt = new Date(dnow);
        let diff = dayIdx - dnow.getUTCDay();
        if (diff < 0) diff += 7;
        dt.setUTCDate(dnow.getUTCDate() + diff);
        dt.setUTCHours(parseInt(hm[0]), parseInt(hm[1]), 0, 0);
        return { dt: dt.getTime(), zone: e.zone, name: e.name, imp: e.imp };
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

// Direct Anthropic API call (bypasses /api/claude proxy — no cookie auth needed server-side).
async function callAnthropicServer(systemPrompt, userMessage, maxTokens = 800) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'Anthropic API error');
  return (d.content && d.content[0] && d.content[0].text) || '';
}

function parseSignalJSONServer(text) {
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
    const correctBE = isLong ? e + (tp - e) * 0.5 : e - (e - tp) * 0.5;
    const decimals = e >= 1000 ? 2 : e >= 100 ? 2 : e >= 1 ? 4 : 6;
    sig.be_note = `Move SL to BE at ${correctBE.toFixed(decimals)} (50% to TP)`;
  }
  return sig;
}

function buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, oi, trigger }) {
  const lines = [];
  lines.push(`AUTO TRIGGER: ${trigger.type.toUpperCase()} — ${trigger.desc}`);

  if (baseCandles && baseCandles.length >= 5) {
    const recent = baseCandles.slice(-15);
    const closes = recent.map(c => c.c);
    const highs = recent.map(c => c.h);
    const lows  = recent.map(c => c.l);
    const high = Math.max(...highs), low = Math.min(...lows);
    const lastClose = closes[closes.length - 1];
    const dir = closes[0] < lastClose ? 'rising' : 'falling';
    lines.push(`\n${tf} STRUCTURE (last 15 candles): range ${low.toFixed(4)} — ${high.toFixed(4)}, last close ${lastClose}, recent ${dir}.`);
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
    '1. Trigger detection (BOS/sweep) — what fired the scan',
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
    'rr for LONG = (tp-entry)/(entry-sl). rr for SHORT = (entry-tp)/(sl-entry). BOTH must be positive numbers >= 1.5.',
    'STRICT RR FLOOR: if you cannot find a setup where RR >= 1.5, return direction "NO TRADE" — do not stretch TP or tighten SL artificially. A trade that backtests to 1.4R or lower will be auto-downgraded to NO TRADE on the server side anyway.',
    '',
    'BE_NOTE RULES:',
    'be_note is the price at which the user moves SL to entry (breakeven).',
    'For LONG: BE price MUST be ABOVE entry, BELOW TP. Recommended: halfway between entry and TP.',
    'For SHORT: BE price MUST be BELOW entry, ABOVE TP. Recommended: halfway between entry and TP.',
    'Format: "Move SL to BE at <PRICE>".',
    '',
    'WHEN UNSURE: return direction "NO TRADE" with reasoning explaining why. Do NOT force a low-quality signal.',
    '',
    'Output ONLY this JSON (no markdown, no extra text):',
    `{"pair":"${coin}","direction":"LONG or SHORT or NO TRADE","entry":${exLE},"sl":${exLS},"tp":${exLT},"rr":2.1,"confidence":72,"session":"","entry_reason":"Level and why","reasoning":"Reference the data sources you used (1H/4H/BTC/funding/etc).","be_note":"Move SL to BE at X","key_risk":"Main risk","expiry_candles":3,"invalidation":"Price action that cancels trade"}`,
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
  const baseCtx = buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, oi, trigger });
  const dxyCtx = isMetalOrOilPair ? buildDXYContextString(dxyData) : '';
  const contextStr = [baseCtx, dxyCtx, liquidityCtx, footprintCtx, cvdCtx, crossBrokerCtx, newsCtx, calCtx]
    .filter(s => s && s.length).join('\n');

  const systemPrompt = buildServerSystemPrompt(coin, tf, broker, contextStr, lastClose);
  const userMessage = `Analyse ${coin} on ${tf}. Auto trigger fired: ${trigger.type.toUpperCase()} — ${trigger.desc}. Output the signal JSON.`;

  let signal = null;
  try {
    // 1200 max tokens — context is now ~2-3x larger with news/calendar/footprint/etc.
    const text = await callAnthropicServer(systemPrompt, userMessage, 1200);
    signal = parseSignalJSONServer(text);
  } catch (e) {
    console.error('[runServerAI call]', e.message);
    return null;
  }
  if (!signal) { console.error('[runServerAI] no JSON parsed'); return null; }

  // Validate levels — auto-retry once with explicit correction
  if (signal.direction !== 'NO TRADE' && !validateSignalLevelsServer(signal)) {
    const correction = `Your previous output had invalid levels. Direction was ${signal.direction} but: entry=${signal.entry} SL=${signal.sl} TP=${signal.tp}. ` +
      (signal.direction === 'LONG' ? 'For LONG: SL must be BELOW entry, TP must be ABOVE entry.' : 'For SHORT: SL must be ABOVE entry, TP must be BELOW entry.') +
      ' Recalculate and output corrected JSON only.';
    try {
      const retryText = await callAnthropicServer(systemPrompt, userMessage + '\n\n' + correction, 800);
      const retried = parseSignalJSONServer(retryText);
      if (retried && validateSignalLevelsServer(retried)) signal = retried;
    } catch (e) { console.error('[runServerAI retry]', e.message); }
  }
  if (signal.direction !== 'NO TRADE' && !validateSignalLevelsServer(signal)) {
    console.error('[runServerAI] invalid levels after retry, aborting');
    return null;
  }

  // ── Hard floor on RR: any signal with computed RR < 1.5 is downgraded to NO TRADE ──
  // Reason: poor RR setups skew the journal stats negative even when the AI thinks it's
  // a valid pattern. Better to skip than enter a marginal trade autonomously.
  if (signal.direction !== 'NO TRADE' && signal.entry && signal.sl && signal.tp) {
    const e = parseFloat(signal.entry), sl = parseFloat(signal.sl), tp = parseFloat(signal.tp);
    const rr = signal.direction === 'LONG' ? (tp - e) / (e - sl) : (e - tp) / (sl - e);
    if (isFinite(rr) && rr < 1.5) {
      console.log('[runServerAI]', coin, 'RR', rr.toFixed(2), '< 1.5 → downgrading to NO TRADE');
      const origDir = signal.direction;
      signal.direction = 'NO TRADE';
      signal.reasoning = `Auto-downgraded from ${origDir}: computed RR ${rr.toFixed(2)} below 1.5R minimum. ` + (signal.reasoning || '');
    }
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

  // Discord (admin-only — auto-scan is admin-only anyway, but defensive)
  if (isAdmin) {
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
  ps.lastStatus = 'waiting';

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

  // 1) If pair has an active signal → monitor it (entry/BE/TP/SL/expiry)
  if (ps.pendSignal) {
    try {
      await runServerTradeMonitorForPair(userId, sub, coin, ps, broker);
    } catch (e) { console.error('[monitor]', coin, e.message); }
    return;
  }

  // 2) Else if past cooldown → scan + (if triggered) run AI
  if (Date.now() < ps.cooldownUntil) {
    ps.lastStatus = 'cooldown';
    return;
  }
  ps.lastStatus = 'scanning';

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
  if (!trigger) return;

  // Apply per-pair cooldown — extended automatically during 22:00-08:00 UTC dead zone
  ps.cooldownUntil = Date.now() + effectiveCooldownMs(sub);
  ps.lastTrigger = trigger;

  // Run full AI analysis for this pair
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
        const bePrice = isLong ? e + (tpP - e) * 0.5 : e - (e - tpP) * 0.5;
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
  if (!process.env.PADDLE_API_KEY) console.warn('[warn] PADDLE_API_KEY not set — payments disabled');
  if (!process.env.PADDLE_PRICE_ID) console.warn('[warn] PADDLE_PRICE_ID not set');
});
