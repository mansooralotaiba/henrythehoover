-- ─────────────────────────────────────────────────────────────────────
-- WEEX auto-trade — closed-trade history.
-- Run this in Supabase → SQL Editor → New Query.
--
-- Stores every trade the executor finishes (TP / SL / BE / EXPIRED /
-- INVALIDATED / REJECTED) so realized PnL aggregates survive Railway
-- redeploys. Without this table, the executor's in-memory trade map
-- resets to empty on every deploy and Today / Month / Cumulative PnL
-- on the Kingdom dashboard zero out.
--
-- Grants follow the Supabase policy (Oct 30 2026 enforcement on
-- existing projects, see ../CLAUDE/memory). service_role only — the
-- browser never reads/writes this table directly.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.weex_trades (
  id              uuid primary key default gen_random_uuid(),
  signal_id       text not null,
  pair            text not null,                -- e.g. 'BNBUSDT' or 'GOLD' (website pseudo-symbol)
  symbol          text not null,                -- actual WEEX symbol e.g. 'BNBUSDT' / 'XAUTUSDT'
  side            text not null,                -- 'long' | 'short'
  entry_price     numeric,
  sl_price        numeric,
  tp_price        numeric,
  fill_price      numeric,
  exit_price      numeric,
  quantity        numeric,
  leverage        integer,
  state           text not null,                -- 'CLOSED' | 'EXPIRED' | 'INVALIDATED' | 'REJECTED'
  closed_pnl      numeric not null default 0,
  slippage        numeric default 0,
  recovered       boolean not null default false, -- true if seeded by executor.reconcile()
  reject_reason   text,                         -- set when state = 'REJECTED'
  created_at      timestamptz not null default now(),
  closed_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One row per signal_id. Upserts on close so multiple state transitions
  -- (PENDING → ACTIVE → CLOSED) collapse to a single row.
  unique (signal_id)
);

create index if not exists weex_trades_closed_at_idx on public.weex_trades (closed_at desc);
create index if not exists weex_trades_state_idx     on public.weex_trades (state);
create index if not exists weex_trades_pair_idx      on public.weex_trades (pair);

-- ── Grants (Supabase Data API policy, Oct 30 2026 enforcement) ──
-- service_role only; the browser is locked out. RLS enabled even though
-- no policies exist, so any direct anon/authenticated query fails closed.
grant select, insert, update, delete on public.weex_trades to service_role;
alter table public.weex_trades enable row level security;
