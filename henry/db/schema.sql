-- ─────────────────────────────────────────────────────────────────────
-- Henry The Hoover — Supabase schema
-- Run this in Supabase → SQL Editor → New Query.
-- After running, edit the bootstrap line at the bottom with YOUR email.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  email         text primary key,
  user_id       uuid references auth.users(id) on delete set null,
  approved      boolean not null default false,
  is_admin      boolean not null default false,
  requested_at  timestamptz not null default now(),
  approved_at   timestamptz
);

create index if not exists profiles_user_id_idx on public.profiles(user_id);

-- The server uses the service_role key for all reads/writes on profiles,
-- so RLS doesn't have to allow anything for end users. We enable RLS with
-- no policies so the anon/auth roles can never touch this table directly.
alter table public.profiles enable row level security;

-- ─────────────────────────────────────────────────────────────────────
-- BOOTSTRAP: replace 'you@example.com' with your real email and run.
-- This pre-approves you and flags you as admin so you can sign in and
-- approve other users from /admin.
-- ─────────────────────────────────────────────────────────────────────
insert into public.profiles (email, approved, is_admin, approved_at)
values ('you@example.com', true, true, now())
on conflict (email) do update set approved = true, is_admin = true;

-- ─────────────────────────────────────────────────────────────────────
-- SIGNAL HISTORY — every signal generated, with optional outcome
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.signals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  pair            text not null,
  direction       text not null,
  entry           numeric,
  sl              numeric,
  tp              numeric,
  rr              numeric,
  confidence      integer,
  session_name    text,
  broker          text,
  timeframe       text,
  trigger_type    text,
  trigger_desc    text,
  entry_reason    text,
  reasoning       text,
  be_note         text,
  key_risk        text,
  invalidation    text,
  expiry_candles  integer,
  outcome         text,         -- 'TP' | 'SL' | 'BE' | null (still open)
  outcome_rr      numeric,
  created_at      timestamptz not null default now(),
  outcome_at      timestamptz
);

create index if not exists signals_user_id_idx     on public.signals(user_id);
create index if not exists signals_pair_idx        on public.signals(pair);
create index if not exists signals_created_at_idx  on public.signals(created_at desc);

alter table public.signals enable row level security;

-- ─────────────────────────────────────────────────────────────────────
-- PUSH SUBSCRIPTIONS — one row per browser/device that opted in to push
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  endpoint    text unique not null,
  p256dh      text not null,
  auth_key    text not null,
  created_at  timestamptz not null default now()
);

create index if not exists push_subs_user_id_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
