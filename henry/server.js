import express from 'express';
import cookieParser from 'cookie-parser';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import WebSocket from 'ws';
import { createHmac } from 'crypto';
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

// Requires only a valid session (no subscription check) — used for Stripe + account endpoints.
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
      const profile = await loadProfile(email);
      if (!profile.user_id) {
        await supaAdmin.from('profiles').update({ user_id: data.user.id }).eq('email', email);
      }
      setAuthCookies(res, data.session.access_token, data.session.refresh_token);
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
    if (r.ok) location.replace('/');
    else { const t = await r.text(); msg.textContent = 'Sign-in failed (' + r.status + '): ' + t; }
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
    const profile = await loadProfile(email);
    if (!profile) return res.status(403).json({ error: 'no_profile' });
    if (!profile.user_id) {
      await supaAdmin
        .from('profiles')
        .update({ user_id: data.user.id })
        .eq('email', email);
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

app.get('/login',    (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));
app.get('/subscribe',(_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'subscribe.html')));
app.get('/subscribe/success', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'subscribe-success.html')));
app.get('/account',  requireSession, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'account.html')));

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
    if (!sie && si?.session) setAuthCookies(res, si.session.access_token, si.session.refresh_token);
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
  await supaAnon.auth.resetPasswordForEmail(addr, { redirectTo: `${SITE_URL}/login?reset=1` });
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
  return expected === h1;
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
          stripe_customer_id:  data.customer_id, // reuse column — stores Paddle customer ID
          plan:                'monthly',
          current_period_end:  data.current_billing_period?.ends_at || null,
          updated_at:          new Date().toISOString(),
        };
        if (uid) {
          await supaAdmin.from('profiles').update(updates).eq('user_id', uid);
        } else if (data.customer_id) {
          await supaAdmin.from('profiles').update(updates).eq('stripe_customer_id', data.customer_id);
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
        }).eq('stripe_customer_id', data.customer_id);
        break;
      }
      // ── Subscription fully cancelled ───────────────────────────────────────
      case 'subscription.canceled': {
        await supaAdmin.from('profiles').update({
          subscription_status: 'inactive',
          plan:                'none',
          updated_at:          new Date().toISOString(),
        }).eq('stripe_customer_id', data.customer_id);
        break;
      }
      // ── Payment received (backup activation for renewals) ──────────────────
      case 'transaction.completed': {
        if (data.subscription_id && data.customer_id) {
          await supaAdmin.from('profiles').update({
            subscription_status: 'active',
            updated_at:          new Date().toISOString(),
          }).eq('stripe_customer_id', data.customer_id);
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
        // Subscription gone — clean up
        await supaAdmin.from('push_subscriptions').delete().eq('id', sub.id);
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
  const { error } = await supaAdmin
    .from('signals')
    .update({ outcome, outcome_rr: outcomeRr ?? null, outcome_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

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
  const { coin, tf, broker, cooldownMs } = req.body || {};
  if (!coin || !tf) return res.status(400).json({ error: 'missing_coin_or_tf' });
  scanSubscriptions.set(req.user.id, {
    active: true, coin, tf, broker: broker || 'weex',
    cooldownMs: cooldownMs || 180000, cooldownUntil: 0,
    pendSignal: null, signalTimestamp: null,
    isAdmin: !!req.profile.is_admin,
    _entryAlerted: false, _beAlerted: false, _tpAlerted: false, _expiryAlerted: false,
  });
  res.json({ ok: true });
});

app.post('/api/scan/stop', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (sub) sub.active = false;
  res.json({ ok: true });
});

app.post('/api/scan/signal', requireAuth, express.json({ limit: '512kb' }), (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (!sub) return res.status(404).json({ error: 'no_scan_session' });
  sub.pendSignal = req.body?.signal || null;
  sub.signalTimestamp = Date.now();
  sub._entryAlerted = false;
  sub._beAlerted = false;
  sub._tpAlerted = false;
  sub._expiryAlerted = false;
  res.json({ ok: true });
});

app.post('/api/scan/clear', requireAuth, (req, res) => {
  const sub = scanSubscriptions.get(req.user.id);
  if (sub) {
    sub.pendSignal = null;
    sub._entryAlerted = false;
    sub._beAlerted = false;
    sub._tpAlerted = false;
    sub._expiryAlerted = false;
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
    }
  }

  // SL — resets all flags
  const slHit = isLong ? price <= slP : price >= slP;
  if (slHit) {
    sub._entryAlerted = false; sub._beAlerted = false; sub._tpAlerted = false; sub._expiryAlerted = false;
    await notifyUser(userId, isAdmin, {
      title: `🛑 SL HIT: ${coin.replace('USDT', '')} ${pendSignal.direction}`,
      body: `Stop loss breached @ ${price.toFixed(2)}. Log your outcome.`,
      color: 're',
    });
  }

  // Expiry — only if entry never hit, fires once
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

async function runServerScan(userId, sub) {
  if (Date.now() < sub.cooldownUntil) return;
  if (sub.pendSignal) return runServerTradeMonitor(userId, sub);
  const candles = await fetchCandlesServer(sub.coin, sub.tf, 30, sub.broker);
  const trigger = detectTrigger(candles);
  if (!trigger) return;
  sub.cooldownUntil = Date.now() + sub.cooldownMs;
  // Server-side trigger: push notification only (no Discord — that posts when AI signal lands)
  await sendPushTo(userId, {
    title: `⚡ ${trigger.type.toUpperCase()}: ${sub.coin.replace('USDT', '')}`,
    body: `${trigger.desc}. Open Henry to run AI analysis.`,
    icon: '/manifest.json',
    data: { coin: sub.coin, tf: sub.tf, broker: sub.broker, trigger },
  });
}

setInterval(() => {
  for (const [userId, sub] of scanSubscriptions.entries()) {
    if (!sub.active) continue;
    runServerScan(userId, sub).catch(e => console.error('[scan loop]', userId, e.message));
  }
}, SCAN_INTERVAL_MS);

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
  if (!POLYGON_API_KEY) console.warn('[warn] POLYGON_API_KEY not set — DXY and Gold endpoints will 502');
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) console.warn('[warn] VAPID keys not set — push notifications disabled');
  if (!process.env.PADDLE_API_KEY) console.warn('[warn] PADDLE_API_KEY not set — payments disabled');
  if (!process.env.PADDLE_PRICE_ID) console.warn('[warn] PADDLE_PRICE_ID not set');
});
