-- Execute este SQL no SQL Editor do seu projeto Supabase.
-- Ele cria as tabelas de armazenamento do Painel de Estudos e ativa Row Level Security (RLS)
-- sem políticas públicas, garantindo que APENAS o servidor (via Secret / Service Role Key) acesse seus dados.

create table if not exists public.painel_store (
  key text primary key,
  payload jsonb not null,
  rev integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.painel_store enable row level security;

-- Banco Permanente de Questões (armazena todas as questões geradas/respondidas separadamente do painel_state)
create table if not exists public.painel_questions (
  id text primary key,
  fingerprint text not null unique,
  edital_id text not null,
  materia_id text,
  materia_nome text not null default '',
  assunto_id text,
  assunto_nome text not null default '',
  banca text not null default 'FGV',
  formato text not null default 'multipla_escolha',
  nivel text not null default 'N2',
  conceito_chave text not null default '',
  enunciado text not null,
  alternativas jsonb not null default '[]'::jsonb,
  correta text not null,
  resolucao_passo_a_passo text not null default '',
  comentario_professor text not null default '',
  gerada_pela_ia boolean not null default true,
  auditada_pela_ia boolean not null default false,
  model_used text not null default '',
  times_answered integer not null default 0,
  times_correct integer not null default 0,
  times_wrong integer not null default 0,
  last_result text,
  last_answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pq_edital_assunto on public.painel_questions (edital_id, assunto_id);
create index if not exists idx_pq_edital_materia on public.painel_questions (edital_id, materia_id);
create index if not exists idx_pq_last_answered on public.painel_questions (last_answered_at nulls first);

alter table public.painel_questions enable row level security;
