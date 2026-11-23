-- Execute este SQL uma única vez no SQL Editor do seu projeto Supabase.
-- Ele cria a tabela de armazenamento do Painel de Estudos e ativa Row Level Security (RLS)
-- sem políticas públicas, garantindo que APENAS o servidor (via Secret / Service Role Key) acesse seus dados.

create table if not exists public.painel_store (
  key text primary key,
  payload jsonb not null,
  rev integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.painel_store enable row level security;
