# MT5 gold EAs

Two EAs live here:

- **`HenryGoldHybridEA.mq5` (RECOMMENDED).** Self-contained: generates gold setups *locally* (ICT mechanical triggers), so it runs in the **MT5 Strategy Tester** and works even if Henry is down. When a setup fires it asks Henry's AI to **confirm or veto** (`POST /api/mt5/confirm`); if Henry's unreachable (e.g. inside the tester) it falls back to trading mechanically (or skips — `InpRequireConfirm`). Defaults bake in the 90-day backtest finding: **shorts-only, RR 2, run on a 15m chart.**
  - Backtest it: MT5 → View → Strategy Tester → pick HenryGoldHybridEA on `XAUUSD`, `M15`, 90+ days. The tester runs the mechanical layer (no AI/WebRequest) — exactly the edge we measured.
  - Inputs: `InpToken` (= HENRY_MT5_TOKEN, for confirm+report), `InpShortsOnly` (true), `InpRR` (2), `InpRiskPct`, `InpEnableTrading` (OFF to start — logs `[observe] would …`), `InpUseHenryConfirm` (true), `InpRequireConfirm` (false = trade mechanically if Henry's down).
- **`HenryGoldEA.mq5` (signal-pull variant).** Pulls Henry's confirmed gold signals via `/api/mt5/signals` instead of generating locally. Depends on Henry uptime, can't run in the tester. Kept as an alternative.

---

## HenryGoldEA — signal-pull variant (Phase 1)

Pulls Henry's confirmed **gold** signals and trades them on a MetaTrader 5 account, then reports every fill / TP / SL / close back to Henry. Phase 1 = **admin account only**; subscriber distribution comes later.

## How it works
```
Henry  ──GET /api/mt5/signals (CSV)──►  EA polls every ~10s
EA     ── places market order on YOUR broker with hard SL + TP
EA     ──POST /api/mt5/report (JSON)──►  Henry records filled / tp / sl / closed
```
The signal carries Henry's entry/SL/TP. The EA anchors the **SL/TP distances** to its own broker fill, so the price gap between WEEX and your MT5 broker doesn't matter — only the R-distances do.

## Server prerequisites (one-time)
1. Run `henry/db/mt5_trades.sql` in **Supabase → SQL Editor**.
2. Set `HENRY_MT5_TOKEN` on **Railway** to a long random string. (Empty = bridge disabled / returns 503.)
3. Deploy the `feat/mt5-bridge-phase1` branch.

## EA setup (in MetaTrader 5)
1. **Whitelist the URL**: Tools → Options → Expert Advisors → ✅ *Allow WebRequest for listed URL* → add `https://henrythehoover.com` (and your domain). Without this, `WebRequest` returns -1.
2. Copy `HenryGoldEA.mq5` into `MQL5/Experts/`, open in **MetaEditor**, press **Compile** (F7).
3. Attach the EA to **any chart** (it trades the symbol in `InpSymbol`, not the chart's symbol). Enable **Algo Trading**.
4. Set inputs:
   - `InpToken` = the `HENRY_MT5_TOKEN` value.
   - `InpSymbol` = your broker's **exact** gold symbol (check Market Watch: `XAUUSD`, `GOLD`, `XAUUSD.r`, …).
   - `InpRiskPct` = % of balance per trade (or set `InpFixedRiskUsd` for a fixed $).
   - `InpMaxLots` = safety cap.
   - **`InpEnableTrading` = false to start.** It logs `[observe] would …` so you can watch sizing/levels with zero risk. Flip to `true` only after a clean demo run.

## Test order (critical)
- **Demo first.** Run on a DEMO MT5 account with `InpEnableTrading=false`, confirm the `[observe]` logs look right (lots, SL/TP distances), then `true` on demo and watch a few real fills + a TP and an SL get reported into `mt5_trades`.
- Only after that, move to a live account.

## Phase 1 limits (by design)
- **No BE/trailing yet** — the EA sets a fixed SL + TP on the broker (the safety net). Henry's BE-move/early-close logic gets wired through `GET /api/mt5/manage` in Phase 1.5 (currently stubbed, returns none).
- **Gold only.** Other instruments are ignored.
- The EA must run 24/7 → use a VPS, or your PC stays on.

## Reported events (`mt5_trades` table)
`filled` (entry), `tp`, `sl`, `closed` (manual/other), each with price, lots, ticket, PnL, and the MT5 account id.
