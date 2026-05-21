// WEEX contract REST API wrapper. Ported from bot/weex_client.py.
//
// Auth: HMAC-SHA256 over `timestamp + METHOD + path[?query] + body`, base64.
// Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP (ms), ACCESS-PASSPHRASE,
// Content-Type: application/json, locale: en-US.
//
// Symbol formats differ between endpoint versions:
//   v3 (orders, exchangeInfo, placeTpSl):     'ETHUSDT'      (uppercase)
//   v2 (account, leverage, position, plans):  'cmt_ethusdt'  (lowercase, prefixed)
// Mixing them gives misleading 40020 "Parameter symbol invalid" errors.
//
// The signature must match the exact wire query string — we build it manually
// (sorted keys, no encoding tricks) and append it to the path so fetch can't
// reserialize differently.

import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api-contract.weex.com';

export class WeexError extends Error {
  constructor(status, body) {
    super(`WEEX error ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

function mapSymbol(symbol) {
  return String(symbol || '').toUpperCase();
}

function mapSymbolV2(symbol) {
  return `cmt_${mapSymbol(symbol).toLowerCase()}`;
}

// Stable JSON stringify — sorted keys, no whitespace. Matches Python's
// json.dumps(separators=(",", ":"), sort_keys=True) byte-for-byte so the HMAC
// signature lines up with what the server reconstructs.
function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function respCarriesOrderId(resp) {
  if (!resp || typeof resp !== 'object') return false;
  for (const k of ['orderId', 'algoId', 'planOrderId']) {
    if (resp[k]) return true;
  }
  const data = resp.data;
  if (data && typeof data === 'object') {
    for (const k of ['orderId', 'algoId', 'planOrderId']) {
      if (data[k]) return true;
    }
  }
  return false;
}

export function extractOrderId(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (resp.dryRun) {
    const cid = resp.echo?.body?.newClientOrderId || resp.echo?.body?.clientAlgoId;
    return cid ? `dry-${cid}` : null;
  }
  for (const k of ['orderId', 'algoId', 'planOrderId']) {
    if (resp[k] != null) return String(resp[k]);
  }
  const data = resp.data;
  if (data && typeof data === 'object') {
    for (const k of ['orderId', 'algoId', 'planOrderId']) {
      if (data[k] != null) return String(data[k]);
    }
  }
  return null;
}

export class WeexClient {
  constructor({ apiKey, apiSecret, apiPassphrase, baseUrl, dryRun = false, timeoutMs = 10000, logger = console }) {
    if (!apiKey || !apiSecret || !apiPassphrase) {
      throw new Error('WeexClient: apiKey, apiSecret, apiPassphrase are required');
    }
    this._key = apiKey;
    this._secret = apiSecret;
    this._passphrase = apiPassphrase;
    this._baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this._dryRun = !!dryRun;
    this._timeoutMs = timeoutMs;
    this._log = logger;
    this._symbolInfoCache = new Map();
    this._symbolInfoInflight = new Map();
  }

  _sign(timestamp, method, path, query, body) {
    const requestPath = query ? `${path}?${query}` : path;
    const msg = `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
    return crypto.createHmac('sha256', this._secret).update(msg).digest('base64');
  }

  _headers(method, path, query, body) {
    const ts = String(Date.now());
    return {
      'ACCESS-KEY': this._key,
      'ACCESS-SIGN': this._sign(ts, method, path, query, body),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': this._passphrase,
      'Content-Type': 'application/json',
      'locale': 'en-US',
    };
  }

  async _request(method, path, { params, body, mutating = false } = {}) {
    const cleanParams = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== null && v !== undefined) cleanParams[k] = v;
      }
    }
    const queryKeys = Object.keys(cleanParams).sort();
    const query = queryKeys.map(k => `${k}=${cleanParams[k]}`).join('&');
    const bodyStr = body ? stableStringify(body) : '';

    if (this._dryRun && mutating) {
      this._log.info('[WEEX DRY-RUN]', method, path + (query ? '?' + query : ''), 'body=', bodyStr || '{}');
      return { dryRun: true, echo: { method, path, query: cleanParams, body: body || {} } };
    }

    const headers = this._headers(method, path, query, bodyStr);
    const fullUrl = `${this._baseUrl}${path}${query ? '?' + query : ''}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeoutMs);

    let resp, data;
    try {
      resp = await fetch(fullUrl, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: controller.signal,
      });
      const text = await resp.text();
      try { data = JSON.parse(text); } catch { data = text; }
    } finally {
      clearTimeout(timeoutId);
    }

    if (resp.status >= 400) {
      this._log.warn(`[WEEX] HTTP ${resp.status} on ${method} ${path}:`, data);
      throw new WeexError(resp.status, data);
    }
    if (data && typeof data === 'object' && 'code' in data) {
      const code = data.code;
      if (code !== 0 && code !== '0' && code !== '00000' && code !== null) {
        this._log.warn(`[WEEX] app error on ${method} ${path}:`, data);
        throw new WeexError(resp.status, data);
      }
    }
    return data;
  }

  async getSymbolInfo(symbol) {
    const sym = mapSymbol(symbol);
    const cached = this._symbolInfoCache.get(sym);
    if (cached) return cached;
    const inflight = this._symbolInfoInflight.get(sym);
    if (inflight) return inflight;

    const promise = (async () => {
      const data = await this._request('GET', '/capi/v3/market/exchangeInfo', { params: { symbol: sym } });
      const info = extractSymbolInfo(data, sym);
      this._symbolInfoCache.set(sym, info);
      return info;
    })().finally(() => this._symbolInfoInflight.delete(sym));

    this._symbolInfoInflight.set(sym, promise);
    return promise;
  }

  async getEquity() {
    const w = await this.getWallet();
    return w ? w.equity : 0;
  }

  async getWallet() {
    // Returns USDT wallet snapshot: { equity, available, unrealizedPnl, used }.
    // Field names vary between v2/v3 — try each candidate.
    const data = await this._request('GET', '/capi/v2/account/assets');
    const rows = (data && typeof data === 'object') ? (data.data ?? data) : null;
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      const coin = (r.coinName || r.marginCoin || r.coin || r.asset || '').toUpperCase();
      if (coin !== 'USDT') continue;
      const equity = parseFloat(r.equity ?? r.totalEquity ?? r.balance ?? 0) || 0;
      const available = parseFloat(r.available ?? r.availableBalance ?? r.crossMaxAvailable ?? 0) || 0;
      const unrealizedPnl = parseFloat(r.unrealizedPL ?? r.unrealizedPnl ?? r.upl ?? 0) || 0;
      const used = parseFloat(r.locked ?? r.frozen ?? r.positionMargin ?? Math.max(equity - available, 0)) || 0;
      return { equity, available, unrealizedPnl, used };
    }
    return null;
  }

  async getAllPositions() {
    const data = await this._request('GET', '/capi/v2/account/position/allPosition', {
      params: { productType: 'umcbl' },
    });
    const rows = (data && typeof data === 'object') ? (data.data ?? data) : null;
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => parseFloat(r.size ?? 0) > 0);
  }

  async getPosition(symbol) {
    const data = await this._request('GET', '/capi/v2/account/position/singlePosition', {
      params: { symbol: mapSymbolV2(symbol) },
    });
    const rows = (data && typeof data === 'object') ? (data.data ?? data) : null;
    if (!rows) return null;
    if (Array.isArray(rows)) return rows[0] || null;
    return rows;
  }

  async setLeverage(symbol, leverage, marginMode = 1) {
    // WEEX rejects this call when any open order exists (40015). Callers must
    // tolerate WeexError and continue with whatever the account default is.
    return this._request('POST', '/capi/v2/account/leverage', {
      body: {
        symbol: mapSymbolV2(symbol),
        marginMode,
        longLeverage: String(leverage),
        shortLeverage: String(leverage),
      },
      mutating: true,
    });
  }

  async placeOrder({ symbol, side, positionSide, orderType, quantity, price = null, clientOrderId = null, timeInForce = 'GTC' }) {
    const body = {
      symbol: mapSymbol(symbol),
      side: side.toUpperCase(),
      positionSide: positionSide.toUpperCase(),
      type: orderType.toUpperCase(),
      quantity: String(quantity),
      newClientOrderId: clientOrderId || `h-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    };
    if (orderType.toUpperCase() === 'LIMIT') {
      if (price == null) throw new Error('price is required for LIMIT orders');
      body.price = String(price);
      body.timeInForce = timeInForce;
    }
    return this._request('POST', '/capi/v3/order', { body, mutating: true });
  }

  async cancelOrder({ symbol, orderId = null, clientOrderId = null }) {
    if (!orderId && !clientOrderId) throw new Error('orderId or clientOrderId required');
    const params = { symbol: mapSymbol(symbol) };
    if (orderId) params.orderId = orderId;
    if (clientOrderId) params.origClientOrderId = clientOrderId;
    return this._request('DELETE', '/capi/v3/order', { params, mutating: true });
  }

  async placeTpSl({ symbol, positionSide, planType, triggerPrice, quantity, executePrice = null, triggerPriceType = 'MARK_PRICE', clientAlgoId = null }) {
    const cid = clientAlgoId || `h-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const body = {
      symbol: mapSymbol(symbol),
      planType: planType.toUpperCase(),
      positionSide: positionSide.toUpperCase(),
      triggerPrice: String(triggerPrice),
      quantity: String(quantity),
      triggerPriceType,
      clientAlgoId: cid,
    };
    if (executePrice != null && executePrice > 0) {
      body.executePrice = String(executePrice);
    }
    let resp = await this._request('POST', '/capi/v3/placeTpSlOrder', { body, mutating: true });
    // Response shape inconsistent — sometimes missing algoId. Reconcile via
    // openAlgoOrders lookup so callers always get an id.
    if (!this._dryRun && !respCarriesOrderId(resp)) {
      try {
        await new Promise(r => setTimeout(r, 300));
        const algoId = await this._findAlgoIdByClient(symbol, cid);
        if (algoId) {
          resp = (resp && typeof resp === 'object') ? { ...resp, algoId } : { algoId };
        }
      } catch (err) {
        this._log.warn(`[WEEX] placeTpSl reconciliation failed for ${cid}:`, err.message || err);
      }
    }
    return resp;
  }

  async _findAlgoIdByClient(symbol, clientAlgoId) {
    const plans = await this._request('GET', '/capi/v3/openAlgoOrders', {
      params: { symbol: mapSymbol(symbol) },
    });
    if (!Array.isArray(plans)) return null;
    for (const p of plans) {
      if ((p.clientAlgoId || '') === clientAlgoId && p.algoId) {
        return String(p.algoId);
      }
    }
    return null;
  }

  // List open algo orders. With no symbol, attempts to list across all
  // symbols (WEEX accepts an empty symbol on this endpoint). Used by
  // executor.reconcile() to find SL/TP plans for open positions on boot.
  async getOpenAlgoOrders(symbol = null) {
    const params = symbol ? { symbol: mapSymbol(symbol) } : {};
    const plans = await this._request('GET', '/capi/v3/openAlgoOrders', { params });
    if (Array.isArray(plans)) return plans;
    if (plans && Array.isArray(plans.data)) return plans.data;
    return [];
  }

  // Historical (closed) orders. Best-effort endpoint — WEEX docs aren't in
  // hand; we try the most likely v3 path. Returns raw rows so the caller can
  // adjust field-name extraction after one observed response. Returns [] on
  // unknown error (so callers can fall back to Supabase persistence).
  async getHistoryOrders({ symbol = null, startTime = null, endTime = null, limit = 100 } = {}) {
    const params = { limit };
    if (symbol) params.symbol = mapSymbol(symbol);
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    try {
      const data = await this._request('GET', '/capi/v3/order/historyOrders', { params });
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      return rows;
    } catch (err) {
      this._log.warn('[weex history orders]', err.message || err);
      return null;
    }
  }

  async cancelPlan({ symbol, planOrderId = null, clientAlgoId = null }) {
    if (!planOrderId && !clientAlgoId) throw new Error('planOrderId or clientAlgoId required');
    const body = { symbol: mapSymbolV2(symbol) };
    if (planOrderId) body.orderId = planOrderId;
    if (clientAlgoId) body.clientAlgoId = clientAlgoId;
    return this._request('POST', '/capi/v2/order/cancel_plan', { body, mutating: true });
  }

  async closePositionMarket({ symbol, positionSide, quantity }) {
    const side = positionSide.toUpperCase() === 'LONG' ? 'SELL' : 'BUY';
    return this.placeOrder({
      symbol, side, positionSide, orderType: 'MARKET', quantity,
    });
  }
}

function extractSymbolInfo(data, sym) {
  let symbols = [];
  if (data && typeof data === 'object') {
    symbols = data.symbols
      || (data.data && typeof data.data === 'object' ? data.data.symbols : null)
      || [];
    if ((!symbols || symbols.length === 0) && Array.isArray(data.data)) {
      symbols = data.data;
    }
  }
  for (const s of symbols) {
    if ((s.symbol || '').toUpperCase() === sym) return s;
  }
  throw new WeexError(404, `symbol ${sym} not in exchangeInfo response`);
}

export { mapSymbol, mapSymbolV2, stableStringify };
