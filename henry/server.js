import express from 'express';
import cookieParser from 'cookie-parser';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createClient } from '@supabase/supabase-js';
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
    const profile = await loadProfile(session.user.email);
    if (!profile || !profile.approved) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login?status=pending');
      return res.status(403).json({ error: 'not_approved' });
    }
    req.user = session.user;
    req.profile = profile;
    next();
  } catch (err) {
    console.error('[auth]', err);
    res.status(500).json({ error: 'auth_error' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.profile?.is_admin) {
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
      if (!profile || !profile.approved) return res.redirect('/login?status=pending');
      if (!profile.user_id) {
        await supaAdmin.from('profiles').update({ user_id: data.user.id }).eq('email', email);
      }
      setAuthCookies(res, data.session.access_token, data.session.refresh_token);
      return res.redirect('/');
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
    if (!profile || !profile.approved) return res.status(403).json({ error: 'not_approved' });
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

app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

// Identity for the frontend — used to gate admin-only UI (share signal, auto-scan).
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    email: req.user.email,
    is_admin: !!req.profile.is_admin,
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
app.get('/manifest.json', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'manifest.json')));
app.get('/login.html', (_req, res) => res.redirect('/login'));

// ── App (auth-gated) ────────────────────────────────────────────────────────
app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Catch-all static for any other public asset that might be added later.
// Anything that isn't in the explicit allowlist above will 404 here unless authenticated.
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

app.listen(PORT, () => {
  console.log(`Henry The Hoover listening on :${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY not set');
  if (!process.env.DISCORD_WEBHOOK) console.warn('[warn] DISCORD_WEBHOOK not set');
  if (!process.env.DISCORD_AUTO_WEBHOOK) console.warn('[warn] DISCORD_AUTO_WEBHOOK not set');
});
