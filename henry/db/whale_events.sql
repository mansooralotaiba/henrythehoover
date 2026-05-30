-- ─────────────────────────────────────────────────────────────────────
-- Whale tracker — Hyperliquid top-15 activity feed.
-- Run this in Supabase → SQL Editor → New Query.
--
-- Stores OPEN / CLOSE / INCREASE / DECREASE events detected by the
-- server-side poll loop (every 30s per tracked address). Lets the
-- activity feed survive Railway redeploys instead of resetting from
-- in-memory cache only.
--
-- service_role only — the browser never reads/writes this table
-- directly; it goes through GET /api/whales/events.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.whale_events (
  id              bigserial primary key,
  address         text not null,                 -- 0x… HL wallet
  alias           text,                          -- displayName or truncated 0xABCD…1234
  coin            text not null,                 -- 'BTC' | 'ETH' | 'HYPE' | …
  direction       text not null check (direction in ('LONG','SHORT')),
  action          text not null check (action in ('OPEN','CLOSE','INCREASE','DECREASE')),
  size_usd        numeric,                       -- positionValue at event time
  size_coin       numeric,                       -- abs(szi)
  entry_px        numeric,
  leverage        numeric,
  pnl_usd         numeric,                       -- unrealizedPnl at event time
  account_value   numeric,                       -- whale's total accountValue at event time
  ts              timestamptz not null default now()
);

create index if not exists whale_events_ts_idx       on public.whale_events (ts desc);
create index if not exists whale_events_address_idx  on public.whale_events (address, ts desc);
create index if not exists whale_events_coin_idx     on public.whale_events (coin, ts desc);

-- ── Grants (Supabase Data API policy, Oct 30 2026 enforcement) ──
-- service_role only; the browser is locked out. RLS enabled even though
-- no policies exist, so any direct anon/authenticated query fails closed.
grant select, insert, update, delete on public.whale_events to service_role;
alter table public.whale_events enable row level security;
