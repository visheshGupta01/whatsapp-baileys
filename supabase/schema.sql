-- Baileys production schema for Supabase/Postgres.
-- Run this in Supabase SQL Editor or with `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.wa_sessions (
  id text primary key,
  owner_id uuid,
  jid text,
  phone text,
  push_name text,
  status text not null default 'idle',
  last_error text,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wa_auth_creds (
  session_id text primary key references public.wa_sessions(id) on delete cascade,
  data text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.wa_signal_keys (
  session_id text not null references public.wa_sessions(id) on delete cascade,
  key_type text not null,
  key_id text not null,
  data text,
  updated_at timestamptz not null default now(),
  primary key (session_id, key_type, key_id)
);

create index if not exists wa_signal_keys_lookup
  on public.wa_signal_keys(session_id, key_type, key_id);

create table if not exists public.wa_contacts (
  session_id text not null references public.wa_sessions(id) on delete cascade,
  jid text not null,
  lid text,
  name text,
  notify text,
  verified_name text,
  img_url text,
  status text,
  raw text,
  updated_at timestamptz not null default now(),
  primary key (session_id, jid)
);

create index if not exists wa_contacts_name_idx
  on public.wa_contacts(session_id, name);

create table if not exists public.wa_chats (
  session_id text not null references public.wa_sessions(id) on delete cascade,
  jid text not null,
  name text,
  unread_count integer not null default 0,
  conversation_timestamp bigint,
  archived boolean not null default false,
  pinned boolean not null default false,
  muted_until bigint,
  raw text,
  updated_at timestamptz not null default now(),
  primary key (session_id, jid)
);

create index if not exists wa_chats_recent_idx
  on public.wa_chats(session_id, conversation_timestamp desc);

create table if not exists public.wa_messages (
  session_id text not null references public.wa_sessions(id) on delete cascade,
  id text not null,
  remote_jid text not null,
  participant text,
  from_me boolean not null default false,
  message_timestamp bigint,
  push_name text,
  status integer,
  message text,
  raw text,
  updated_at timestamptz not null default now(),
  primary key (session_id, remote_jid, id)
);

create index if not exists wa_messages_chat_idx
  on public.wa_messages(session_id, remote_jid, message_timestamp desc);

create index if not exists wa_messages_message_id_idx
  on public.wa_messages(session_id, id);

create table if not exists public.wa_groups (
  session_id text not null references public.wa_sessions(id) on delete cascade,
  jid text not null,
  subject text,
  subject_owner text,
  subject_time bigint,
  owner text,
  creation bigint,
  description text,
  announce boolean not null default false,
  restrict boolean not null default false,
  size integer,
  raw text,
  updated_at timestamptz not null default now(),
  primary key (session_id, jid)
);

create table if not exists public.wa_group_participants (
  session_id text not null references public.wa_sessions(id) on delete cascade,
  group_jid text not null,
  jid text not null,
  admin text,
  is_super_admin boolean not null default false,
  raw text,
  updated_at timestamptz not null default now(),
  primary key (session_id, group_jid, jid)
);

create index if not exists wa_group_participants_group_idx
  on public.wa_group_participants(session_id, group_jid);

create table if not exists public.wa_media (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references public.wa_sessions(id) on delete cascade,
  message_id text,
  remote_jid text,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  file_name text,
  created_at timestamptz not null default now(),
  unique(session_id, remote_jid, message_id)
);

create index if not exists wa_media_chat_idx
  on public.wa_media(session_id, remote_jid, created_at desc);

create table if not exists public.wa_events (
  id bigint generated always as identity primary key,
  session_id text not null references public.wa_sessions(id) on delete cascade,
  event_name text not null,
  payload text,
  created_at timestamptz not null default now()
);

create index if not exists wa_events_session_idx
  on public.wa_events(session_id, created_at desc);

-- The Node backend uses the service-role key and therefore bypasses RLS.
-- RLS is still enabled so the tables are not accidentally exposed through the
-- browser-facing anon key.
alter table public.wa_sessions enable row level security;
alter table public.wa_auth_creds enable row level security;
alter table public.wa_signal_keys enable row level security;
alter table public.wa_contacts enable row level security;
alter table public.wa_chats enable row level security;
alter table public.wa_messages enable row level security;
alter table public.wa_groups enable row level security;
alter table public.wa_group_participants enable row level security;
alter table public.wa_media enable row level security;
alter table public.wa_events enable row level security;

-- Private media bucket. The backend uses service-role signed URLs.
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;
