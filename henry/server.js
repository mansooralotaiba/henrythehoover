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
  // Mark in-memory sub so the server-side monitor doesn't try to log it again.
  const sub = scanSubscriptions.get(req.user.id);
  if (sub) sub._outcomeLogged = true;
  res.json({ ok: true });
});

// ── Shared outcome logger — used by browser PATCH endpoint AND server-side monitor.
//    Always updates the row; only fires the journal Discord post on the FIRST transition
//    from null → set so re-classifications don't double-post.
async function logSignalOutcomeAndJournal(userId, signalId, outcome, outcomeRr) {
  if (!signalId) return;
  const { data: existing } = await supaAdmin
    .from('signals')
    .select('*')
    .eq('id', signalId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!existing) return;
  const wasUnset = existing.outcome == null;
  const { error } = await supaAdmin
    .from('signals')
    .update({ outcome, outcome_rr: outcomeRr ?? null, outcome_at: new Date().toISOString() })
    .eq('id', signalId)
    .eq('user_id', userId);
  if (error) { console.error('[outcome update]', error.message); return; }
  // Only post to journal Discord on the first outcome assignment, not re-classifications.
  if (wasUnset && (outcome === 'TP' || outcome === 'SL' || outcome === 'BE')) {
    const stats = await getUserStats(userId).catch(() => null);
    postJournalToDiscord({ ...existing, outcome, outcome_rr: outcomeRr ?? null }, outcome, outcomeRr, stats)
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
  if (!process.env.DISCORD_JOURNAL_WEBHOOK || !signal) return;
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
    await fetch(process.env.DISCORD_JOURNAL_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], username: 'Henry Journal' }),
    });
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

app.post('/api/scan/start', requireAuth, express.json(), async (req, res) => {
  const { coin, tf, broker, cooldownMs, watchlist } = req.body || {};
  if (!coin || !tf) return res.status(400).json({ error: 'missing_coin_or_tf' });
  scanSubscriptions.set(req.user.id, {
    active: true, coin, tf, broker: broker || 'weex',
    cooldownMs: cooldownMs || 180000, cooldownUntil: 0,
    watchlist: Array.isArray(watchlist) ? watchlist : [],
    pendSignal: null, signalId: null, signalTimestamp: null,
    isAdmin: !!req.profile.is_admin,
    _entryAlerted: false, _beAlerted: false, _tpAlerted: false, _expiryAlerted: false,
    _outcomeLogged: false,
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

// Returns the user's current pending signal if the server-side AI generated one.
// Browser polls this on page load to sync UI with server state when the AI was
// generated while no browser was open.
app.get('/api/scan/current-signal', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub || !sub.pendSignal) return res.json({ signal: null });
  res.json({
    signal: sub.pendSignal,
    signalId: sub.signalId,
    signalTimestamp: sub.signalTimestamp,
    coin: sub.coin,
    tf: sub.tf,
    broker: sub.broker,
    state: {
      entryAlerted: !!sub._entryAlerted,
      beAlerted:    !!sub._beAlerted,
      tpAlerted:    !!sub._tpAlerted,
      outcomeLogged:!!sub._outcomeLogged,
    },
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
  sub.pendSignal = req.body?.signal || null;
  sub.signalId = req.body?.signalId || null;
  sub.signalTimestamp = Date.now();
  sub._entryAlerted = false;
  sub._beAlerted = false;
  sub._tpAlerted = false;
  sub._expiryAlerted = false;
  sub._outcomeLogged = false;
  res.json({ ok: true });
});

app.post('/api/scan/clear', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (sub) {
    sub.pendSignal = null;
    sub.signalId = null;
    sub._entryAlerted = false;
    sub._beAlerted = false;
    sub._tpAlerted = false;
    sub._expiryAlerted = false;
    sub._outcomeLogged = false;
  }
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

async function runServerTradeMonitor(userId, sub) {
  const { pendSignal, coin, tf, broker, isAdmin } = sub;
  const price = await getCurrentPriceServer(coin, broker);
  if (!price) return;
  const e = parseFloat(pendSignal.entry), slP = parseFloat(pendSignal.sl), tpP = parseFloat(pendSignal.tp);
  const isLong = pendSignal.direction === 'LONG';

  // Entry hit
  const entryHit = isLong ? price <= e : price >= e;
  if (entryHit && !sub._entryAlerted) {
    sub._entryAlerted = true;
    sub._expiryAlerted = true;
    await notifyUser(userId, isAdmin, {
      title: `🎯 ENTRY HIT: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
      body: `Entry filled @ ${price}. Trade is now ACTIVE.`,
      color: 'cy',
    });
  }

  // BE
  if (sub._entryAlerted && !sub._beAlerted) {
    const bePrice = isLong ? e + (tpP - e) * 0.5 : e - (e - tpP) * 0.5;
    const beReached = isLong ? price >= bePrice : price <= bePrice;
    if (beReached) {
      sub._beAlerted = true;
      await notifyUser(userId, isAdmin, {
        title: '⚑ MOVE SL TO BREAKEVEN',
        body: `${coin.replace('USDT', '')} reached BE @ ${price.toFixed(2)}. Move SL to ${e}.`,
        color: 'am',
      });
    }
  }

  // TP
  if (sub._entryAlerted && !sub._tpAlerted) {
    const tpHit = isLong ? price >= tpP : price <= tpP;
    if (tpHit) {
      sub._tpAlerted = true;
      await notifyUser(userId, isAdmin, {
        title: `🎯 TP REACHED: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
        body: `Take profit hit @ ${price.toFixed(2)}. Log your outcome.`,
        color: 'gr',
      });
      // Persist outcome + post journal once (idempotent)
      if (sub.signalId && !sub._outcomeLogged) {
        sub._outcomeLogged = true;
        await logSignalOutcomeAndJournal(userId, sub.signalId, 'TP', parseFloat(pendSignal.rr) || 2)
          .catch(e => console.error('[server TP outcome]', e.message));
      }
      // Clear so the next scan can resume on the watchlist
      sub.pendSignal = null; sub.signalId = null; sub.signalTimestamp = null;
      sub._entryAlerted = false; sub._beAlerted = false; sub._tpAlerted = false; sub._expiryAlerted = false; sub._outcomeLogged = false;
      return;
    }
  }

  // SL — also clears the active trade so next scan resumes
  const slHit = isLong ? price <= slP : price >= slP;
  if (slHit) {
    // Decide BE vs SL BEFORE clearing flags
    const wasBE = sub._beAlerted;
    if (sub.signalId && !sub._outcomeLogged) {
      sub._outcomeLogged = true;
      await logSignalOutcomeAndJournal(userId, sub.signalId, wasBE ? 'BE' : 'SL', wasBE ? 0 : -1)
        .catch(e => console.error('[server SL outcome]', e.message));
    }
    await notifyUser(userId, isAdmin, {
      title: `${wasBE ? '⚑ STOPPED AT BE' : '🛑 SL HIT'}: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
      body: `${wasBE ? 'Closed at breakeven' : 'Stop loss breached'} @ ${price.toFixed(2)}. Logged automatically.`,
      color: wasBE ? 'am' : 're',
    });
    sub.pendSignal = null; sub.signalId = null; sub.signalTimestamp = null;
    sub._entryAlerted = false; sub._beAlerted = false; sub._tpAlerted = false; sub._expiryAlerted = false; sub._outcomeLogged = false;
    return;
  }

  // Expiry — only if entry never hit, fires once, clears the trade
  if (!sub._entryAlerted && !sub._expiryAlerted && pendSignal.expiry_candles) {
    const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
    const maxMs = pendSignal.expiry_candles * (tfMs[tf] || 900000);
    if (Date.now() - sub.signalTimestamp > maxMs) {
      sub._expiryAlerted = true;
      await notifyUser(userId, isAdmin, {
        title: '⏱ SIGNAL EXPIRED',
        body: `Cancel limit order — ${coin.replace('USDT', '')} signal expired after ${pendSignal.expiry_candles} candles.`,
        color: 'am',
      });
      // Clear so scan resumes — but don't log outcome to journal (no trade actually happened)
      sub.pendSignal = null; sub.signalId = null; sub.signalTimestamp = null;
      sub._entryAlerted = false; sub._beAlerted = false; sub._tpAlerted = false; sub._expiryAlerted = false; sub._outcomeLogged = false;
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
    'CONTEXT FROM SERVER-SIDE SCAN:',
    contextStr,
    '',
    'CURRENT PRICE: ' + (lastClose != null ? lastClose : 'unknown') + '. DO NOT use current price as entry — choose a structural level (zone/FVG/OB/post-sweep).',
    '',
    'DIRECTION RULES — READ CAREFULLY:',
    `LONG: entry < current_price, SL BELOW entry, TP ABOVE entry. Example: entry=${exLE}, sl=${exLS}, tp=${exLT}`,
    `SHORT: entry > current_price (or at current for market), SL ABOVE entry, TP BELOW entry. Example: entry=${exSE}, sl=${exSS}, tp=${exST}`,
    'rr for LONG = (tp-entry)/(entry-sl). rr for SHORT = (entry-tp)/(sl-entry). BOTH must be positive numbers >= 1.5.',
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
    if (error) { console.error('[saveServerSignal]', error.message); return null; }
    return data.id;
  } catch (e) { console.error('[saveServerSignal]', e.message); return null; }
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

// Main entry — runs the full AI flow on the server when a trigger fires.
async function runServerAI(userId, sub, trigger, baseCandles) {
  const { coin, tf, broker, isAdmin } = sub;
  const lastClose = baseCandles && baseCandles.length ? baseCandles[baseCandles.length - 1].c : null;

  // Fetch all extra context in parallel — failures are isolated, AI gets whatever lands.
  const [mtfH1, mtfH4, btcCandles, funding, oi] = await Promise.all([
    fetchCandlesServer(coin, '1h', 50, broker).catch(() => []),
    fetchCandlesServer(coin, '4h', 30, broker).catch(() => []),
    coin !== 'BTCUSDT' ? fetchCandlesServer('BTCUSDT', tf, 30, broker).catch(() => []) : Promise.resolve([]),
    fetchFundingRateServer(coin).catch(() => null),
    fetchOpenInterestServer(coin).catch(() => null),
  ]);

  const contextStr = buildServerContextString({ coin, tf, baseCandles, mtfH1, mtfH4, btcCandles, funding, oi, trigger });
  const systemPrompt = buildServerSystemPrompt(coin, tf, broker, contextStr, lastClose);
  const userMessage = `Analyse ${coin} on ${tf}. Auto trigger fired: ${trigger.type.toUpperCase()} — ${trigger.desc}. Output the signal JSON.`;

  let signal = null;
  try {
    const text = await callAnthropicServer(systemPrompt, userMessage, 800);
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

  // Activate the trade monitor — the next scan tick will route to runServerTradeMonitor
  sub.pendSignal = signal;
  sub.signalId = signalId;
  sub.signalTimestamp = Date.now();
  sub._entryAlerted = false;
  sub._beAlerted = false;
  sub._tpAlerted = false;
  sub._expiryAlerted = false;
  sub._outcomeLogged = false;
  // Lock the monitor onto the triggered pair (in case watchlist scan picked a different one)
  sub.coin = signal.pair;

  return signal;
}

async function runServerScan(userId, sub) {
  if (Date.now() < sub.cooldownUntil) return;
  if (sub.pendSignal) return runServerTradeMonitor(userId, sub);

  // Determine pairs to scan: custom watchlist if set, else fall back to current coin
  const pairsToScan = (sub.watchlist && sub.watchlist.length)
    ? sub.watchlist.map(s => ({ sym: s, lbl: s.replace('USDT', '').replace('1000', '') }))
    : [{ sym: sub.coin, lbl: sub.coin.replace('USDT', '') }];

  // Scan all pairs in parallel — lightweight (30 candles each).
  // Errors per-pair are isolated; one broken symbol doesn't kill the whole scan.
  const results = await Promise.all(pairsToScan.map(async p => {
    try {
      const candles = await fetchCandlesServer(p.sym, sub.tf, 30, sub.broker);
      const trigger = candles && candles.length >= 11 ? detectTrigger(candles) : null;
      return { pair: p, candles, trigger };
    } catch {
      return { pair: p, candles: [], trigger: null };
    }
  }));

  // Pick highest-priority trigger across all pairs (BOS > sweep)
  const priority = ['bos', 'sweep'];
  const triggered = results
    .filter(r => r.trigger !== null)
    .sort((a, b) => priority.indexOf(a.trigger.type) - priority.indexOf(b.trigger.type));

  if (!triggered.length) return;
  const best = triggered[0];

  // Apply cooldown — only count the scan as "fired" when something actually triggered
  sub.cooldownUntil = Date.now() + sub.cooldownMs;

  // Run full AI analysis on the triggered pair (autonomous: phone push + Discord get full signal).
  const originalCoin = sub.coin;
  sub.coin = best.pair.sym; // temporarily so context strings reference the right pair
  let aiSignal = null;
  try {
    aiSignal = await runServerAI(userId, sub, best.trigger, best.candles);
  } catch (e) { console.error('[runServerAI top]', e.message); }

  // If AI failed (network/API error), restore coin and fall back to a trigger-only push
  // so the user still hears about the signal candidate.
  if (!aiSignal) {
    sub.coin = originalCoin;
    await sendPushTo(userId, {
      title: `⚡ ${best.trigger.type.toUpperCase()}: ${best.pair.lbl}`,
      body: `${best.trigger.desc}. Open Henry to run AI analysis.`,
      icon: '/manifest.json',
      data: { coin: best.pair.sym, tf: sub.tf, broker: sub.broker, trigger: best.trigger },
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
  const { coin, tf, broker, pendSignal } = sub;
  const lines = [];

  if (pendSignal && pendSignal.direction !== 'NO TRADE') {
    const e = parseFloat(pendSignal.entry);
    const slP = parseFloat(pendSignal.sl);
    const tpP = parseFloat(pendSignal.tp);
    const isLong = pendSignal.direction === 'LONG';
    const cp = await getCurrentPriceServer(coin, broker).catch(() => null);

    if (sub._entryAlerted) {
      // ── In trade ──
      const pctToTp = (tpP && e && cp) ? Math.round(Math.abs(cp - e) / Math.abs(tpP - e) * 100) : 0;
      const bePrice = isLong ? e + (tpP - e) * 0.5 : e - (e - tpP) * 0.5;
      const beReached = cp != null ? (isLong ? cp >= bePrice : cp <= bePrice) : false;
      lines.push('✅ **IN TRADE**');
      lines.push(`${coin.replace('USDT', '')} **${pendSignal.direction}** @ \`${e}\``);
      lines.push(`SL: \`${slP}\` | TP: \`${tpP}\` | ${pendSignal.rr || '—'}R`);
      if (cp != null) lines.push(`Current: \`${cp.toFixed(2)}\` | Progress: **${pctToTp}%** to TP`);
      lines.push(`BE: \`${bePrice.toFixed(2)}\` ${beReached ? '✓ REACHED — move SL now' : '(not yet reached)'}`);
      if (pendSignal.invalidation) lines.push(`Invalidation: ${pendSignal.invalidation}`);
    } else {
      // ── Waiting entry ──
      const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
      const elapsed = sub.signalTimestamp ? Date.now() - sub.signalTimestamp : 0;
      const maxMs = pendSignal.expiry_candles ? pendSignal.expiry_candles * (tfMs[tf] || 900000) : null;
      const remainingCandles = maxMs != null
        ? Math.max(0, Math.ceil((maxMs - elapsed) / (tfMs[tf] || 900000)))
        : null;
      const distPct = (cp != null && e) ? Math.abs((cp - e) / e * 100).toFixed(2) : null;
      lines.push('⏳ **WAITING ENTRY**');
      lines.push(`${coin.replace('USDT', '')} **${pendSignal.direction}** @ \`${e}\``);
      lines.push(`SL: \`${slP}\` | TP: \`${tpP}\` | ${pendSignal.rr || '—'}R | Conf: ${pendSignal.confidence || '—'}%`);
      if (cp != null) lines.push(`Current: \`${cp.toFixed(2)}\` | Distance: ${distPct}% from entry`);
      if (remainingCandles !== null) lines.push(`Expires: **${remainingCandles} candles** remaining on ${tf}`);
      if (pendSignal.invalidation) lines.push(`Cancel if: ${pendSignal.invalidation}`);
    }
  } else {
    lines.push('💤 **No active signal**');
    lines.push(`Scanning: ${coin.replace('USDT', '')} on ${tf} (${broker})`);
    if (sub.cooldownUntil > Date.now()) {
      const secs = Math.ceil((sub.cooldownUntil - Date.now()) / 1000);
      lines.push(`Cooldown: ${secs}s remaining`);
    }
  }
  lines.push('');
  lines.push(`⚡ Scan: ${sub.active ? 'ACTIVE' : 'STOPPED'} | Broker: ${broker}`);

  const utcTime = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const embed = {
    title: `📊 Henry Status — ${utcTime} UTC`,
    description: lines.join('\n'),
    color: sub._entryAlerted ? 3066993 : pendSignal ? 16750848 : 9699539,
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
