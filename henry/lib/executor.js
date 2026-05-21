// Core auto-trade logic — turns scan-loop events into WEEX orders.
// Ported from bot/executor.py. Single-user (admin), in-memory trade map.
//
// Event dispatch:
//   setup        -> handleSetup        (place entry limit + SL plan + TP plan)
//   entryHit     -> handleEntryHit     (verify position, market-rescue if needed)
//   moveSlBe     -> handleMoveSlBe     (fee-buffered SL → BE)
//   invalidated  -> handleInvalidated  (cancel orders + close if active)
//   tpHit        -> handleTpHit        (informational; plan already closed it)
//   slHit        -> handleSlHit        (informational; plan already closed it)
//   expired      -> handleExpired      (same as invalidated)
//
// Concurrency: one promise-chain lock per signal_id prevents follow-up events
// racing setup. Caller's scan loop also has its own _scanInFlight guard.

import { extractOrderId, WeexError } from './weex.js';

export const TradeState = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
  EXPIRED: 'EXPIRED',
  INVALIDATED: 'INVALIDATED',
  REJECTED: 'REJECTED',
});

function roundDown(value, precision) {
  if (precision <= 0) return Math.floor(value);
  const f = 10 ** precision;
  return Math.floor(value * f) / f;
}

function roundPrice(value, precision) {
  if (precision <= 0) return Math.round(value);
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

function computePositionSize({ entry, sl, riskUsd, quantityPrecision, minOrderSize }) {
  const distance = Math.abs(entry - sl);
  if (distance <= 0) return { qty: 0, reject: 'entry equals sl — zero risk distance' };
  const raw = riskUsd / distance;
  const qty = roundDown(raw, quantityPrecision);
  if (qty < minOrderSize) {
    return { qty, reject: `computed size ${qty} below symbol min ${minOrderSize} (raw=${raw.toFixed(8)}, risk=${riskUsd}, dist=${distance})` };
  }
  return { qty, reject: null };
}

function beWithFeeBuffer(price, side, bufferBps) {
  if (bufferBps <= 0) return price;
  const delta = price * (bufferBps / 10000);
  return side === 'long' ? price + delta : price - delta;
}

function notionalPnl(trade, exitPrice) {
  const entry = trade.fillPrice || trade.entryPrice;
  const direction = trade.side === 'long' ? 1 : -1;
  return (exitPrice - entry) * direction * trade.quantity;
}

// Pseudo-symbols the website uses → actual WEEX contract symbols.
const SYMBOL_TRANSLATE = Object.freeze({
  GOLD: 'XAUTUSDT',
});

function toWeexSymbol(pair) {
  const up = String(pair || '').toUpperCase();
  return SYMBOL_TRANSLATE[up] || up;
}

export class Executor {
  constructor({ client, riskUsd, leverage, beFeeBufferBps, notifier, onTradeClosed, logger = console }) {
    this.client = client;
    this.riskUsd = riskUsd;
    this.leverage = leverage;
    this.beFeeBufferBps = beFeeBufferBps;
    this.notifier = notifier || (async () => {});
    // Called whenever a trade transitions to a terminal state (CLOSED, EXPIRED,
    // INVALIDATED, REJECTED). The handler is responsible for persistence — we
    // call it best-effort and swallow failures so a Supabase outage can't
    // cascade into a stuck handler.
    this.onTradeClosed = onTradeClosed || (async () => {});
    this.log = logger;
    this.trades = new Map();        // signalId -> trade
    this._signalChains = new Map(); // signalId -> Promise (serializes events per signal)
  }

  async _persistClosed(trade) {
    try { await this.onTradeClosed(trade); }
    catch (err) { this.log.warn('[executor onTradeClosed]', err.message || err); }
  }

  _runLocked(signalId, fn) {
    const prev = this._signalChains.get(signalId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._signalChains.set(signalId, next.finally(() => {
      // Drop the chain entry once it settles, if it's still the tail
      if (this._signalChains.get(signalId) === next) {
        this._signalChains.delete(signalId);
      }
    }));
    return next;
  }

  async _notify(msg) {
    try { await this.notifier(msg); }
    catch (err) { this.log.warn('[executor] notifier failed:', err?.message || err); }
  }

  // --------------------------------------------------------------------
  // SETUP — place entry limit + SL plan + TP plan
  // signal: { signalId, pair, side: 'long'|'short', entry, sl, tp, rr, confidence }
  // --------------------------------------------------------------------
  async handleSetup(signal) {
    return this._runLocked(signal.signalId, () => this._handleSetupInner(signal));
  }

  async _handleSetupInner(s) {
    const symbol = toWeexSymbol(s.pair);
    if (this.trades.has(s.signalId)) {
      this.log.info('[executor] duplicate signalId', s.signalId, '— ignoring');
      return;
    }

    // Dedupe by WEEX position. If a position already exists on the same
    // symbol+side, refuse the new setup so duplicate signals don't DCA into
    // the existing trade. Caught the BNB DCA bug from 2026-05-21. Defensive
    // field lookups — WEEX field names vary across endpoints.
    try {
      const existing = await this.client.getPosition(symbol);
      const existingSize = parseFloat(
        existing?.size ?? existing?.total ?? existing?.qty ?? existing?.quantity ?? existing?.holdSize ?? 0
      ) || 0;
      if (existingSize > 0) {
        const existingSide = String(
          existing?.holdSide ?? existing?.posSide ?? existing?.side ?? existing?.positionSide ?? ''
        ).toLowerCase();
        if (existingSide === s.side || !existingSide) {
          await this._reject(s.signalId, symbol, `WEEX already has an open ${existingSide || 'position'} (size ${existingSize}) — skipping to avoid DCA`);
          return;
        }
      }
    } catch (err) {
      this.log.warn(`[executor setup] existing-position check failed for ${symbol}: ${err.message || err} — continuing`);
    }

    let info;
    try {
      info = await this.client.getSymbolInfo(symbol);
    } catch (err) {
      await this._reject(s.signalId, symbol, `WEEX symbol info: ${err.message || err}`);
      return;
    }

    const qtyPrecision = parseInt(info.quantityPrecision ?? 0, 10) || 0;
    const pricePrecision = parseInt(info.pricePrecision ?? 0, 10) || 0;
    const minSize = parseFloat(info.minOrderSize ?? 0) || 0;

    const { qty, reject } = computePositionSize({
      entry: s.entry, sl: s.sl, riskUsd: this.riskUsd,
      quantityPrecision: qtyPrecision, minOrderSize: minSize,
    });
    if (reject) {
      await this._reject(s.signalId, symbol, reject, qty);
      return;
    }

    const entryPx = roundPrice(s.entry, pricePrecision);
    const slPx = roundPrice(s.sl, pricePrecision);
    const tpPx = roundPrice(s.tp, pricePrecision);

    try {
      await this.client.setLeverage(symbol, this.leverage);
    } catch (err) {
      this.log.warn(`[executor] setLeverage failed for ${symbol}: ${err.message || err} — continuing`);
    }

    const side = s.side === 'long' ? 'BUY' : 'SELL';
    const positionSide = s.side === 'long' ? 'LONG' : 'SHORT';
    const cidBase = String(s.signalId).slice(0, 24);

    let entryOid = null, slOid = null, tpOid = null, entryResp, slResp, tpResp;
    try {
      entryResp = await this.client.placeOrder({
        symbol, side, positionSide, orderType: 'LIMIT', quantity: qty, price: entryPx,
        clientOrderId: `h-entry-${cidBase}`.slice(0, 36),
      });
      entryOid = extractOrderId(entryResp);

      slResp = await this.client.placeTpSl({
        symbol, positionSide, planType: 'STOP_LOSS',
        triggerPrice: slPx, quantity: qty,
        clientAlgoId: `h-sl-${cidBase}`.slice(0, 36),
      });
      slOid = extractOrderId(slResp);

      tpResp = await this.client.placeTpSl({
        symbol, positionSide, planType: 'TAKE_PROFIT',
        triggerPrice: tpPx, quantity: qty, executePrice: tpPx,
        clientAlgoId: `h-tp-${cidBase}`.slice(0, 36),
      });
      tpOid = extractOrderId(tpResp);
    } catch (err) {
      await this._rollbackPartial(symbol, entryOid, slOid);
      await this._reject(s.signalId, symbol, `order placement failed: ${err.message || err}`, qty);
      return;
    }

    const now = Date.now();
    const trade = {
      signalId: s.signalId, pair: s.pair, symbol, side: s.side,
      entryPrice: entryPx, slPrice: slPx, tpPrice: tpPx,
      quantity: qty, leverage: this.leverage,
      state: TradeState.PENDING,
      entryOrderId: entryOid, slOrderId: slOid, tpOrderId: tpOid,
      fillPrice: null, slippage: 0, closedPnl: 0,
      createdAt: now, updatedAt: now,
    };
    this.trades.set(s.signalId, trade);

    await this._notify(`✅ WEEX order placed: ${symbol} ${s.side.toUpperCase()} qty=${qty} @ ${entryPx} (SL ${slPx} / TP ${tpPx}, lev ${this.leverage}x)`);
    this.log.info(`[executor] SETUP ok signal=${s.signalId} ${symbol} ${s.side} qty=${qty}`);
  }

  // --------------------------------------------------------------------
  // ENTRY HIT — confirm filled; market-rescue if limit never filled.
  // event: { signalId, fillPrice }
  // --------------------------------------------------------------------
  async handleEntryHit(event) {
    return this._runLocked(event.signalId, () => this._handleEntryHitInner(event));
  }

  async _handleEntryHitInner(s) {
    const trade = this.trades.get(s.signalId);
    if (!trade) { this.log.warn('[executor] entryHit for unknown signalId', s.signalId); return; }
    if (trade.state !== TradeState.PENDING && trade.state !== TradeState.ACTIVE) {
      this.log.info(`[executor] entryHit ignored — trade ${s.signalId} in state ${trade.state}`);
      return;
    }

    let position = null;
    try {
      position = await this.client.getPosition(trade.symbol);
    } catch (err) {
      this.log.warn(`[executor] getPosition failed for ${s.signalId}: ${err.message || err} — assuming filled`);
      position = { size: 1 };
    }
    const posSize = parseFloat(position?.size ?? 0) || 0;

    if (posSize <= 0 && trade.state === TradeState.PENDING) {
      this.log.info(`[executor] market-rescue for ${s.signalId} (limit unfilled at fill price ${s.fillPrice})`);
      if (trade.entryOrderId) {
        try {
          await this.client.cancelOrder({ symbol: trade.symbol, orderId: trade.entryOrderId });
        } catch (err) {
          this.log.info(`[executor] cancel unfilled limit ${trade.entryOrderId} ignored:`, err.message || err);
        }
      }
      const side = trade.side === 'long' ? 'BUY' : 'SELL';
      const positionSide = trade.side === 'long' ? 'LONG' : 'SHORT';
      try {
        const mktResp = await this.client.placeOrder({
          symbol: trade.symbol, side, positionSide,
          orderType: 'MARKET', quantity: trade.quantity,
          clientOrderId: `h-mkt-${String(s.signalId).slice(0, 24)}`.slice(0, 36),
        });
        trade.entryOrderId = extractOrderId(mktResp);
        await this._notify(`⚠️ WEEX market-rescue: ${trade.symbol} ${trade.side.toUpperCase()} ${trade.quantity} (confirmed @ ${s.fillPrice}, limit never filled)`);
      } catch (err) {
        await this._notify(`❌ WEEX market rescue FAILED for ${trade.symbol} (${s.signalId}): ${err.message || err}`);
        return;
      }
    }

    const slippage = (s.fillPrice - trade.entryPrice) * (trade.side === 'long' ? 1 : -1);
    trade.state = TradeState.ACTIVE;
    trade.fillPrice = s.fillPrice;
    trade.slippage = slippage;
    trade.updatedAt = Date.now();
    this.log.info(`[executor] entryHit ${s.signalId} fill=${s.fillPrice} slippage=${slippage > 0 ? '+' : ''}${slippage}`);
  }

  // --------------------------------------------------------------------
  // MOVE SL → BE — fee-buffered so SL hit nets ~0 after round-trip taker fees.
  // event: { signalId, newSl }
  // --------------------------------------------------------------------
  async handleMoveSlBe(event) {
    return this._runLocked(event.signalId, () => this._handleMoveSlBeInner(event));
  }

  async _handleMoveSlBeInner(s) {
    const trade = this.trades.get(s.signalId);
    if (!trade) { this.log.warn('[executor] moveSlBe for unknown signalId', s.signalId); return; }
    if (trade.state !== TradeState.PENDING && trade.state !== TradeState.ACTIVE) {
      this.log.info(`[executor] moveSlBe ignored — trade ${s.signalId} in state ${trade.state}`);
      return;
    }

    let adjusted = beWithFeeBuffer(s.newSl, trade.side, this.beFeeBufferBps);
    try {
      const info = await this.client.getSymbolInfo(trade.symbol);
      adjusted = roundPrice(adjusted, parseInt(info.pricePrecision ?? 0, 10) || 0);
    } catch (err) {
      this.log.warn(`[executor] getSymbolInfo failed when rounding BE SL: ${err.message || err}`);
    }

    if (trade.slOrderId) {
      try {
        await this.client.cancelPlan({ symbol: trade.symbol, planOrderId: trade.slOrderId });
      } catch (err) {
        this.log.warn(`[executor] cancel old SL ${trade.slOrderId} failed: ${err.message || err} — placing new anyway`);
      }
    }

    const positionSide = trade.side === 'long' ? 'LONG' : 'SHORT';
    try {
      const slResp = await this.client.placeTpSl({
        symbol: trade.symbol, positionSide, planType: 'STOP_LOSS',
        triggerPrice: adjusted, quantity: trade.quantity,
        clientAlgoId: `h-slbe-${String(s.signalId).slice(0, 24)}`.slice(0, 36),
      });
      trade.slPrice = adjusted;
      trade.slOrderId = extractOrderId(slResp);
      trade.updatedAt = Date.now();
    } catch (err) {
      await this._notify(`⚠️ WEEX move-SL-to-BE failed for ${trade.symbol}: ${err.message || err}`);
      return;
    }

    const suffix = adjusted === s.newSl ? '' : ` (fee-adj from ${s.newSl})`;
    await this._notify(`📋 WEEX SL → BE for ${trade.symbol} @ ${adjusted}${suffix}`);
  }

  // --------------------------------------------------------------------
  // TP / SL / INVALIDATED / EXPIRED — outcome handlers
  // --------------------------------------------------------------------
  async handleTpHit(event) {
    return this._runLocked(event.signalId, async () => {
      const t = this.trades.get(event.signalId);
      if (!t) return;
      await this._forceCloseIfOpen(t, 'TP hit');
      const exit = event.exitPrice ?? t.tpPrice;
      t.state = TradeState.CLOSED;
      t.exitPrice = exit;
      t.closedPnl = notionalPnl(t, exit);
      t.updatedAt = Date.now();
      await this._notify(`💚 WEEX TP hit: ${t.symbol} pnl=$${t.closedPnl >= 0 ? '+' : ''}${t.closedPnl.toFixed(2)}`);
      await this._persistClosed(t);
    });
  }

  async handleSlHit(event) {
    return this._runLocked(event.signalId, async () => {
      const t = this.trades.get(event.signalId);
      if (!t) return;
      await this._forceCloseIfOpen(t, 'SL hit');
      const exit = event.exitPrice ?? t.slPrice;
      t.state = TradeState.CLOSED;
      t.exitPrice = exit;
      t.closedPnl = notionalPnl(t, exit);
      t.updatedAt = Date.now();
      await this._notify(`💀 WEEX SL hit: ${t.symbol} pnl=$${t.closedPnl >= 0 ? '+' : ''}${t.closedPnl.toFixed(2)}`);
      await this._persistClosed(t);
    });
  }

  // Verify the WEEX position is actually closed when Henry detects TP/SL.
  // Catches the case where the plan order didn't fire — without this, the
  // next signal for the same pair would DCA into the still-open position.
  async _forceCloseIfOpen(trade, label) {
    try {
      const pos = await this.client.getPosition(trade.symbol);
      const size = parseFloat(
        pos?.size ?? pos?.total ?? pos?.qty ?? pos?.quantity ?? pos?.holdSize ?? 0
      ) || 0;
      if (size <= 0) return;
      const positionSide = trade.side === 'long' ? 'LONG' : 'SHORT';
      this.log.warn(`[executor] ${label} but WEEX position still open for ${trade.symbol} (size=${size}) — force-closing market`);
      await this.client.closePositionMarket({ symbol: trade.symbol, positionSide, quantity: size });
      // Also try to cancel lingering SL/TP plans so they don't fire on a closed pair.
      for (const oid of [trade.slOrderId, trade.tpOrderId]) {
        if (!oid) continue;
        try { await this.client.cancelPlan({ symbol: trade.symbol, planOrderId: oid }); }
        catch (err) { this.log.info(`[executor] ${label} cancel lingering plan ${oid}:`, err.message || err); }
      }
      await this._notify(`⚠️ WEEX force-close on ${label}: ${trade.symbol} ${trade.side.toUpperCase()} (plan didn't fire, closed at market)`);
    } catch (err) {
      this.log.warn(`[executor] ${label} force-close check failed for ${trade.symbol}:`, err.message || err);
    }
  }

  async handleInvalidated(event) {
    return this._runLocked(event.signalId, () => this._terminate(event.signalId, TradeState.INVALIDATED, 'invalidated'));
  }

  async handleExpired(event) {
    return this._runLocked(event.signalId, () => this._terminate(event.signalId, TradeState.EXPIRED, 'expired'));
  }

  async _terminate(signalId, newState, label) {
    const trade = this.trades.get(signalId);
    if (!trade) { this.log.warn(`[executor] ${label} for unknown signalId`, signalId); return; }

    for (const [oid, kind] of [
      [trade.entryOrderId, 'entry'],
      [trade.slOrderId, 'sl'],
      [trade.tpOrderId, 'tp'],
    ]) {
      if (!oid) continue;
      try {
        if (kind === 'entry') {
          await this.client.cancelOrder({ symbol: trade.symbol, orderId: oid });
        } else {
          await this.client.cancelPlan({ symbol: trade.symbol, planOrderId: oid });
        }
      } catch (err) {
        this.log.info(`[executor] ${label} cancel ${kind}/${oid} ignored:`, err.message || err);
      }
    }

    if (trade.state === TradeState.ACTIVE) {
      const positionSide = trade.side === 'long' ? 'LONG' : 'SHORT';
      try {
        await this.client.closePositionMarket({
          symbol: trade.symbol, positionSide, quantity: trade.quantity,
        });
      } catch (err) {
        await this._notify(`⚠️ WEEX market-close failed for ${trade.symbol} on ${label}: ${err.message || err}`);
      }
    }

    trade.state = newState;
    trade.updatedAt = Date.now();
    await this._notify(`💀 WEEX position closed: ${trade.symbol} (${label})`);
    await this._persistClosed(trade);
  }

  async _rollbackPartial(symbol, entryOrderId, slOrderId) {
    if (entryOrderId) {
      try {
        await this.client.cancelOrder({ symbol, orderId: entryOrderId });
        this.log.info(`[executor] rolled back entry ${entryOrderId} for ${symbol}`);
      } catch (err) {
        this.log.warn(`[executor] rollback cancel entry ${entryOrderId} failed:`, err.message || err);
      }
    }
    if (slOrderId) {
      try {
        await this.client.cancelPlan({ symbol, planOrderId: slOrderId });
        this.log.info(`[executor] rolled back SL ${slOrderId} for ${symbol}`);
      } catch (err) {
        this.log.warn(`[executor] rollback cancel SL ${slOrderId} failed:`, err.message || err);
      }
    }
  }

  async _reject(signalId, symbol, reason, qty = 0) {
    this.log.warn(`[executor] REJECT ${signalId} (${symbol}): ${reason}`);
    let trade;
    if (!this.trades.has(signalId)) {
      trade = {
        signalId, symbol, side: '?', pair: symbol,
        entryPrice: 0, slPrice: 0, tpPrice: 0,
        quantity: qty, leverage: this.leverage,
        state: TradeState.REJECTED, rejectReason: reason,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      this.trades.set(signalId, trade);
    } else {
      trade = this.trades.get(signalId);
      trade.state = TradeState.REJECTED;
      trade.rejectReason = reason;
      trade.updatedAt = Date.now();
    }
    await this._notify(`❌ WEEX rejected ${symbol} (${signalId}): ${reason}`);
    await this._persistClosed(trade);
  }

  // Best-effort startup reconciliation. Reads open WEEX positions and their
  // SL/TP plans, then rebuilds trade records so a Railway redeploy doesn't
  // lose BE management. Trades recovered this way get a synthetic signalId
  // prefixed `recovered-`. Warnings surface positions missing one or both
  // plans (BE management won't work without an SL plan we can cancel/replace).
  async reconcile() {
    const result = { recovered: 0, warnings: [] };
    if (!this.client) return result;
    let positions, algos;
    try {
      [positions, algos] = await Promise.all([
        this.client.getAllPositions(),
        this.client.getOpenAlgoOrders().catch(() => []),
      ]);
    } catch (err) {
      this.log.warn('[executor reconcile] fetch failed:', err.message || err);
      result.warnings.push(`fetch failed: ${err.message || err}`);
      return result;
    }
    const isOpenState = (st) =>
      st === TradeState.PENDING || st === TradeState.ACTIVE;
    for (const pos of (positions || [])) {
      const size = parseFloat(pos.size ?? 0) || 0;
      if (size <= 0) continue;
      const symbol = String(pos.symbol || '').toUpperCase().replace(/^CMT_/, '');
      const side = String(pos.holdSide || pos.posSide || pos.side || '').toLowerCase();
      if (!symbol || (side !== 'long' && side !== 'short')) continue;
      // Skip if executor already has an open trade for this symbol+side.
      const dupe = Array.from(this.trades.values()).find(t =>
        t.symbol === symbol && t.side === side && isOpenState(t.state)
      );
      if (dupe) continue;
      const matching = (algos || []).filter(a => {
        const aSym = String(a.symbol || '').toUpperCase().replace(/^CMT_/, '');
        const aSide = String(a.positionSide || a.holdSide || '').toLowerCase();
        return aSym === symbol && aSide === side;
      });
      const slPlan = matching.find(a => String(a.planType || '').toUpperCase() === 'STOP_LOSS');
      const tpPlan = matching.find(a => String(a.planType || '').toUpperCase() === 'TAKE_PROFIT');
      const avgPrice = parseFloat(pos.averagePrice ?? pos.openPrice ?? pos.avgEntryPrice ?? 0) || 0;
      const signalId = `recovered-${symbol}-${side}-${Date.now()}`;
      const trade = {
        signalId, pair: symbol, symbol, side,
        entryPrice: avgPrice,
        slPrice: slPlan ? parseFloat(slPlan.triggerPrice) || null : null,
        tpPrice: tpPlan ? parseFloat(tpPlan.triggerPrice) || null : null,
        quantity: size,
        leverage: parseInt(pos.leverage || this.leverage) || this.leverage,
        state: TradeState.ACTIVE,
        entryOrderId: null,
        slOrderId: slPlan ? String(slPlan.algoId || slPlan.planOrderId || '') || null : null,
        tpOrderId: tpPlan ? String(tpPlan.algoId || tpPlan.planOrderId || '') || null : null,
        fillPrice: avgPrice,
        slippage: 0,
        closedPnl: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        recovered: true,
      };
      this.trades.set(signalId, trade);
      result.recovered++;
      if (!slPlan && !tpPlan) {
        result.warnings.push(`${symbol} ${side}: no SL/TP plans found — BE management disabled`);
      } else if (!slPlan) {
        result.warnings.push(`${symbol} ${side}: no SL plan — BE move-to-entry won't work`);
      } else if (!tpPlan) {
        result.warnings.push(`${symbol} ${side}: no TP plan — TP won't auto-close on WEEX`);
      }
      this.log.info(`[executor reconcile] ${symbol} ${side} size=${size} entry=${avgPrice} sl=${trade.slPrice ?? '?'} tp=${trade.tpPrice ?? '?'}`);
    }
    return result;
  }

  // Public diagnostics — used by /api/bot/state
  snapshot() {
    return Array.from(this.trades.values()).map(t => ({
      signalId: t.signalId, pair: t.pair, symbol: t.symbol, side: t.side,
      state: t.state, qty: t.quantity, leverage: t.leverage,
      entry: t.entryPrice, sl: t.slPrice, tp: t.tpPrice,
      fillPrice: t.fillPrice, closedPnl: t.closedPnl, updatedAt: t.updatedAt,
      rejectReason: t.rejectReason || null,
    }));
  }
}

export { toWeexSymbol, computePositionSize, beWithFeeBuffer };
