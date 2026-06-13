-- ─────────────────────────────────────────────────────────────────────
-- MT5 EA bridge — execution reports from the per-account Expert Advisor.
-- Run this in Supabase → SQL Editor → New Query.
--
-- Phase 1 = ADMIN ACCOUNT ONLY. The EA pulls confirmed GOLD signals from
-- /api/mt5/signals and POSTs each execution event here via /api/mt5/report
-- (filled / be / tp / sl / closed) so Henry can show MT5 gold trades and
-- survive Railway redeploys. Multi-user (subscriber EAs) comes later.
--
-- Grants follow the Supabase policy (Oct 30 2026 enforcement, see
-- ../CLAUDE memory reference-supabase-grants). service_role only — the
-- browser never reads/writes this table directly.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.mt5_trades (
  id            uuid primary key default gen_random_uuid(),
  signal_id     text not null,                 -- Henry signals.id the EA acted on
  account_id    text,                          -- MT5 account number the EA reported from
  symbol        text,                          -- broker gold symbol e.g. 'XAUUSD' / 'GOLD'
  side          text,                          -- 'long' | 'short'
  event         text not null,                 -- 'filled' | 'be' | 'tp' | 'sl' | 'closed'
  price         numeric,                       -- fill / event price on the broker
  lots          numeric,                       -- position size in lots
  ticket        text,                          -- broker order/position ticket
  pnl           numeric default 0,             -- realized PnL (on tp/sl/closed)
  reported_at   timestamptz not null default now(),
  -- One row per (signal, account, event) so EA re-reports are idempotent.
  unique (signal_id, account_id, event)
);

create index if not exists mt5_trades_signal_idx   on public.mt5_trades (signal_id);
create index if not exists mt5_trades_reported_idx on public.mt5_trades (reported_at desc);

grant select, insert, update, delete on public.mt5_trades to service_role;
