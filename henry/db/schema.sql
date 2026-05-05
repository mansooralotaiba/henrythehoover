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
