-- ============================================================
-- Migration 020: Microsoft Teams task notifications (MVP, scope POS0059)
-- ============================================================
-- store_teams_chats: maps a store → its Teams chat config (for n8n).
-- teams_notification_events: audit log of every notify attempt.
-- Idempotent: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS.
-- ============================================================

create table if not exists public.store_teams_chats (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  teams_user_id text not null,
  teams_display_name text not null,
  tenant_id text not null,
  chat_id text not null,
  chat_web_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id),
  unique (chat_id)
);

alter table public.store_teams_chats enable row level security;

create table if not exists public.teams_notification_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  event_type text not null default 'task_created',
  status text not null check (status in ('pending', 'sent', 'failed', 'skipped')),
  n8n_payload jsonb,
  n8n_response jsonb,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.teams_notification_events enable row level security;

-- Policies — admin only. Server writes via service role (supabaseAdmin),
-- which bypasses RLS, so no INSERT policy is needed for the log table.
drop policy if exists "stc_admin_all" on public.store_teams_chats;
create policy "stc_admin_all" on public.store_teams_chats
  for all to authenticated
  using (get_user_role() = 'admin')
  with check (get_user_role() = 'admin');

drop policy if exists "tne_admin_select" on public.teams_notification_events;
create policy "tne_admin_select" on public.teams_notification_events
  for select to authenticated
  using (get_user_role() = 'admin');

-- Seed POS0059
insert into public.store_teams_chats (
  store_id, teams_user_id, teams_display_name, tenant_id, chat_id, is_active
)
select
  s.id,
  'c8570b06-fa97-4082-9767-e3bafd13c0f9',
  'Circa Tam Viet',
  '03dfe77f-0daf-487e-a6c7-2601e528133d',
  '19:83891f5b-0eb4-4894-af16-bc41daf822ac_c8570b06-fa97-4082-9767-e3bafd13c0f9@unq.gbl.spaces',
  true
from public.stores s
where s.code = 'POS0059'
on conflict (store_id) do update set
  teams_user_id      = excluded.teams_user_id,
  teams_display_name = excluded.teams_display_name,
  tenant_id          = excluded.tenant_id,
  chat_id            = excluded.chat_id,
  is_active          = true,
  updated_at         = now();
