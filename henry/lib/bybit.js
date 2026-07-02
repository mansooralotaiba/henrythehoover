// ── Bybit v5 execution client ───────────────────────────────────────────────
// Implements the SAME method surface as lib/weex.js's WeexClient so the
// existing Executor (lib/executor.js) runs on either venue unchanged — the
// executor only ever talks to `this.client.<method>`, never to an exchange
// directly. Linear USDT perps only, ONE-WAY position mode (positionIdx 0);
// hedge-mode accounts are not supported.
//
// TP/SL design note: WEEX models SL/TP as standalone plan ORDERS with ids the
// executor cancels/replaces (BE move = cancelPlan + placeTpSl). Bybit's cleaner
// primitive is the POSITION-ATTACHED trading-stop (auto-cancels when the
// position closes, no orphan risk), so this client maps the executor's
// plan-order verbs onto trading-stop:
//   placeTpSl(STOP_LOSS x)  → set position stopLoss=x   → returns synthetic id `bb-sl-<sym>`
//   placeTpSl(TAKE_PROFIT x)→ set position takeProfit=x → returns synthetic id `bb-tp-<sym>`
//   cancelPlan(bb-sl-*)     → set stopLoss='0' (clears it)
//   getOpenAlgoOrders()     → synthesised from position/list's stopLoss/takeProfit fields
// The synthetic ids are stable per symbol, which is all the executor needs
// (it stores them and hands them back to cancelPlan).

import crypto from 'crypto';

const RECV_WINDOW = '15000';

function mapSide(side) {
  // executor sends 'BUY'/'SELL'; Bybit wants 'Buy'/'Sell'
  return /^buy$/i.test(String(side)) ? 'Buy' : 'Sell';
}
function decimalsOf(step) {
  // '0.001' → 3, '1' → 0, '0.1' → 1. Used to convert Bybit's qtyStep/tickSize
  // into the integer precision the executor's roundDown/roundPrice expect.
  const s = String(step);
  const i = s.indexOf('.');
  if (i < 0) return 0;
  return s.length - i - 1 - (s.match(/0+$/) ? s.match(/0+$/)[0].length : 0);
}

export class BybitClient {
  constructor({ apiKey, apiSecret, baseUrl, dryRun = false, timeoutMs = 10000, logger = console } = {}) {
    this._key = apiKey;
    this._secret = apiSecret;
    this.baseUrl = (baseUrl || 'https://api.bybit.com').replace(/\/$/, '');
    this.dryRun = !!dryRun;
    this.timeoutMs = timeoutMs;
    this.log = logger;
    this._instrumentCache = new Map(); // symbol → { ts, info }
  }

  _sign(timestamp, payload) {
    return crypto.createHmac('sha256', this._secret)
      .update(timestamp + this._key + RECV_WINDOW + payload)
      .digest('hex');
  }

  async _request(method, path, { params, body, mutating = false } = {}) {
    if (this.dryRun && mutating) {
      this.log.log(`[bybit dry-run] ${method} ${path}`, body || params || '');
      return { orderId: `dry-${Date.now()}`, dryRun: true };
    }
    const qs = params
      ? Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      : '';
    const bodyStr = body ? JSON.stringify(body) : '';
    const ts = String(Date.now());
    const sign = this._sign(ts, method === 'GET' ? qs : bodyStr);
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, {
        method,
        headers: {
          'X-BAPI-API-KEY': this._key,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': RECV_WINDOW,
          'X-BAPI-SIGN': sign,
          ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
        },
        body: bodyStr || undefined,
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`bybit HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      if (j.retCode !== 0) {
        // 110043 = "leverage not modified" — same-value set, treat as success
        // 34040  = trading-stop not modified — same trigger re-sent, success
        if (j.retCode === 110043 || j.retCode === 34040) return j.result || {};
        throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
      }
      return j.result || {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ── market metadata ───────────────────────────────────────────────────────
  async getSymbolInfo(symbol) {
    const hit = this._instrumentCache.get(symbol);
    if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.info;
    const res = await this._request('GET', '/v5/market/instruments-info', {
      params: { category: 'linear', symbol },
    });
    const it = res?.list?.[0];
    if (!it) throw new Error(`bybit: unknown symbol ${symbol}`);
    // Shape-match WeexClient.getSymbolInfo: integer precisions + minOrderSize + maxLeverage
    const info = {
      symbol: it.symbol,
      quantityPrecision: decimalsOf(it.lotSizeFilter?.qtyStep ?? '0.001'),
      pricePrecision: decimalsOf(it.priceFilter?.tickSize ?? '0.01'),
      minOrderSize: parseFloat(it.lotSizeFilter?.minOrderQty ?? '0'),
      maxLeverage: parseFloat(it.leverageFilter?.maxLeverage ?? '50'),
    };
    this._instrumentCache.set(symbol, { ts: Date.now(), info });
    return info;
  }

  // ── account ───────────────────────────────────────────────────────────────
  async getWallet() {
    // UTA first (the default for new accounts), fall back to classic CONTRACT.
    for (const accountType of ['UNIFIED', 'CONTRACT']) {
      try {
        const res = await this._request('GET', '/v5/account/wallet-balance', {
          params: { accountType, coin: 'USDT' },
        });
        const acct = res?.list?.[0];
        if (!acct) continue;
        const coin = (acct.coin || []).find(c => c.coin === 'USDT') || {};
        const equity = parseFloat(acct.totalEquity ?? coin.equity ?? 0);
        const available = parseFloat(
          acct.totalAvailableBalance !== '' && acct.totalAvailableBalance != null
            ? acct.totalAvailableBalance
            : (coin.availableToWithdraw || coin.walletBalance || 0)
        );
        const unrealizedPnl = parseFloat(acct.totalPerpUPL ?? coin.unrealisedPnl ?? 0);
        return { equity, available, unrealizedPnl, used: Math.max(0, equity - available) };
      } catch (e) {
        if (accountType === 'CONTRACT') throw e;
      }
    }
    throw new Error('bybit: no wallet data');
  }

  async getEquity() {
    try { const w = await this.getWallet(); return w.equity || 0; } catch { return 0; }
  }

  // ── positions ─────────────────────────────────────────────────────────────
  _mapPosition(p) {
    const size = parseFloat(p.size || 0);
    const positionSide = p.side === 'Buy' ? 'LONG' : 'SHORT';
    const avg = parseFloat(p.avgPrice || 0);
    // Redundant field aliases on purpose — the executor extracts defensively
    // (size/total/qty/quantity/holdSize, averagePrice/openPrice/avgEntryPrice,
    // open_value) because WEEX renames fields between API versions.
    return {
      symbol: p.symbol,
      size, total: size, qty: size, quantity: size, holdSize: size,
      positionSide, holdSide: positionSide, side: positionSide,
      averagePrice: avg, openPrice: avg, avgEntryPrice: avg,
      open_value: avg * size,
      leverage: parseFloat(p.leverage || 0),
      unrealizedPnl: parseFloat(p.unrealisedPnl || 0),
      // carried for getOpenAlgoOrders synthesis:
      _stopLoss: parseFloat(p.stopLoss || 0),
      _takeProfit: parseFloat(p.takeProfit || 0),
    };
  }

  async getAllPositions() {
    const res = await this._request('GET', '/v5/position/list', {
      params: { category: 'linear', settleCoin: 'USDT', limit: 200 },
    });
    return (res?.list || []).filter(p => parseFloat(p.size || 0) > 0).map(p => this._mapPosition(p));
  }

  async getPosition(symbol) {
    const res = await this._request('GET', '/v5/position/list', {
      params: { category: 'linear', symbol },
    });
    const p = (res?.list || []).find(x => parseFloat(x.size || 0) > 0);
    return p ? this._mapPosition(p) : null;
  }

  async setLeverage(symbol, leverage, _marginMode = 1) {
    return this._request('POST', '/v5/position/set-leverage', {
      body: { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) },
      mutating: true,
    });
  }

  // ── orders ────────────────────────────────────────────────────────────────
  async placeOrder({ symbol, side, positionSide, orderType = 'MARKET', quantity, price, clientOrderId, timeInForce, reduceOnly = false }) {
    const body = {
      category: 'linear',
      symbol,
      side: mapSide(side),
      orderType: /^market$/i.test(orderType) ? 'Market' : 'Limit',
      qty: String(quantity),
      positionIdx: 0, // one-way mode
    };
    if (body.orderType === 'Limit') {
      body.price = String(price);
      body.timeInForce = timeInForce || 'GTC';
    }
    if (reduceOnly) body.reduceOnly = true;
    if (clientOrderId) body.orderLinkId = String(clientOrderId).slice(0, 36);
    const res = await this._request('POST', '/v5/order/create', { body, mutating: true });
    return { orderId: res.orderId, clientOrderId: res.orderLinkId };
  }

  async cancelOrder({ symbol, orderId, clientOrderId }) {
    const body = { category: 'linear', symbol };
    if (orderId) body.orderId = orderId;
    else if (clientOrderId) body.orderLinkId = clientOrderId;
    else throw new Error('cancelOrder: orderId or clientOrderId required');
    return this._request('POST', '/v5/order/cancel', { body, mutating: true });
  }

  async getOpenOrders(symbol) {
    try {
      const params = { category: 'linear', openOnly: 0, limit: 50 };
      if (symbol) params.symbol = symbol; else params.settleCoin = 'USDT';
      const res = await this._request('GET', '/v5/order/realtime', { params });
      return (res?.list || []).map(o => ({
        orderId: o.orderId,
        clientOrderId: o.orderLinkId,
        symbol: o.symbol,
        side: (o.side || '').toUpperCase(),
        positionSide: o.side === 'Buy' ? 'LONG' : 'SHORT',
        type: (o.orderType || '').toUpperCase(),
      }));
    } catch (e) {
      this.log.warn('[bybit getOpenOrders]', e.message);
      return []; // fail-open, same as WeexClient
    }
  }

  // ── TP/SL via position trading-stop (see design note at top) ─────────────
  async placeTpSl({ symbol, positionSide, planType, triggerPrice, quantity, executePrice, clientAlgoId }) {
    const isSl = planType === 'STOP_LOSS';
    const body = {
      category: 'linear',
      symbol,
      tpslMode: 'Full',
      positionIdx: 0,
      ...(isSl ? { stopLoss: String(triggerPrice), slTriggerBy: 'MarkPrice' }
               : { takeProfit: String(triggerPrice), tpTriggerBy: 'LastPrice' }),
    };
    await this._request('POST', '/v5/position/trading-stop', { body, mutating: true });
    // Synthetic stable id — executor stores it and returns it to cancelPlan.
    return { algoId: `${isSl ? 'bb-sl' : 'bb-tp'}-${symbol}` };
  }

  async cancelPlan({ symbol, planOrderId, clientAlgoId }) {
    const id = String(planOrderId || clientAlgoId || '');
    const isSl = id.includes('bb-sl');
    const isTp = id.includes('bb-tp');
    if (!isSl && !isTp) return { skipped: true }; // unknown id shape — nothing to do
    const body = {
      category: 'linear', symbol, tpslMode: 'Full', positionIdx: 0,
      ...(isSl ? { stopLoss: '0' } : { takeProfit: '0' }), // '0' clears it
    };
    return this._request('POST', '/v5/position/trading-stop', { body, mutating: true });
  }

  async getOpenAlgoOrders(symbol) {
    // Synthesised from the positions' attached stopLoss/takeProfit — Bybit has
    // no standalone plan orders in this design. Shape matches what the
    // executor's reconcile expects: {symbol, positionSide, planType,
    // triggerPrice, algoId}.
    try {
      const positions = symbol
        ? [await this.getPosition(symbol)].filter(Boolean)
        : await this.getAllPositions();
      const out = [];
      for (const p of positions) {
        if (p._stopLoss > 0) out.push({ symbol: p.symbol, positionSide: p.positionSide, holdSide: p.positionSide, planType: 'STOP_LOSS', triggerPrice: p._stopLoss, algoId: `bb-sl-${p.symbol}`, planOrderId: `bb-sl-${p.symbol}` });
        if (p._takeProfit > 0) out.push({ symbol: p.symbol, positionSide: p.positionSide, holdSide: p.positionSide, planType: 'TAKE_PROFIT', triggerPrice: p._takeProfit, algoId: `bb-tp-${p.symbol}`, planOrderId: `bb-tp-${p.symbol}` });
      }
      return out;
    } catch (e) {
      this.log.warn('[bybit getOpenAlgoOrders]', e.message);
      return [];
    }
  }

  async closePositionMarket({ symbol, positionSide, quantity }) {
    const side = positionSide === 'LONG' ? 'SELL' : 'BUY';
    return this.placeOrder({ symbol, side, positionSide, orderType: 'MARKET', quantity, reduceOnly: true, clientOrderId: `bbclose${Date.now()}` });
  }

  // ── income / closed PnL ───────────────────────────────────────────────────
  // Mapped from /v5/position/closed-pnl. Each closed position becomes one
  // 'position_close' item (WEEX splits open/close — the server aggregation
  // tolerates single-sided items because it sums by symbol).
  async getAccountIncome({ startTime, endTime, limit = 100 } = {}) {
    try {
      const params = { category: 'linear', limit: Math.min(limit, 100) };
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;
      const res = await this._request('GET', '/v5/position/closed-pnl', { params });
      const items = (res?.list || []).map(x => ({
        billId: x.orderId,
        asset: 'USDT',
        symbol: x.symbol,
        income: parseFloat(x.closedPnl || 0),
        incomeType: 'position_close',
        balance: null,
        fillFee: parseFloat(x.cumEntryValue ? 0 : 0),
        time: parseInt(x.updatedTime || Date.now()),
        transferReason: null,
      }));
      return { hasNextPage: !!res?.nextPageCursor, items };
    } catch (e) {
      this.log.warn('[bybit getAccountIncome]', e.message);
      return null;
    }
  }

  async getAllIncomeSince(sinceMs, maxPages = 10) {
    const out = [];
    let endTime;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.getAccountIncome({ startTime: sinceMs, endTime, limit: 100 });
      if (!page || !page.items.length) break;
      out.push(...page.items.filter(x => x.time >= sinceMs));
      if (!page.hasNextPage) break;
      endTime = Math.min(...page.items.map(x => x.time)) - 1;
      if (endTime <= sinceMs) break;
    }
    return out;
  }
}

export default BybitClient;
