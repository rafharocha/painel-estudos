# Deploy na Nuvem (Vercel + Supabase) — Uso Pessoal

Este guia coloca seu **Painel de Estudos** online gratuitamente (sem precisar de cartão de crédito), protegido por **senha pessoal**, com seus dados salvos no **Supabase** e compressão Gzip automática no sync (evitando o limite de 4,5 MB da Vercel).

---

## Passo 1 — Criar o banco no Supabase (2 minutos)

1. Acesse [supabase.com](https://supabase.com) e crie um projeto gratuito (escolha uma região próxima, ex: **South America (São Paulo)**).
2. No menu lateral do projeto, abra **SQL Editor** → clique em **New query**.
3. Cole todo o conteúdo do arquivo `supabase-schema.sql` e clique em **Run**:
   ```sql
   create table if not exists public.painel_store (
     key text primary key,
     payload jsonb not null,
     rev integer not null default 0,
     updated_at timestamptz not null default now()
   );

   alter table public.painel_store enable row level security;
   ```
4. Vá em **Project Settings → API** (ou **API Keys**) e anote dois valores:
   * **Project URL** (`https://xxxxx.supabase.co`) → será sua variável `SUPABASE_URL`.
   * **Secret key** (`sb_secret_...`) ou **service_role key** (em *Legacy API Keys*) → será sua variável `SUPABASE_SECRET_KEY`.
   > ⚠️ **Nunca** use a chave `anon` / `publishable` aqui, e nunca compartilhe a chave `secret` / `service_role`. Como ativamos RLS sem políticas públicas, somente o seu servidor consegue ler/gravar.

---

## Passo 2 — Migrar seu histórico local (`data/painel-data.json`) para o Supabase

Para não começar do zero na nuvem e já levar todo o seu histórico atual (~2,45 MB):

1. No seu PC, abra o arquivo `.env` na raiz do projeto e adicione:
   ```env
   SUPABASE_URL=https://seu-projeto.supabase.co
   SUPABASE_SECRET_KEY=sua_chave_secret_ou_service_role
   ```
2. No terminal, na pasta do projeto, execute:
   ```bash
   npm run migrate:supabase
   ```
3. Aguarde a mensagem `✅ painel-data.json enviado com sucesso para o Supabase!`.
   *(Dica: se quiser continuar usando o painel localmente salvando apenas em disco, basta comentar ou remover `SUPABASE_URL` e `SUPABASE_SECRET_KEY` do `.env` local depois da migração — ou mantê-las se quiser que o PC local também sincronize com o mesmo Supabase!)*

---

## Passo 3 — Subir o código no GitHub (repositório PRIVADO)

1. Crie um repositório **privado** no [github.com](https://github.com/new) (ex: `painel-de-estudos`).
2. O `.gitignore` já está configurado para **ignorar** `.env`, `data/` e `estudo.zip`, então suas chaves e seus dados pessoais não vão para o GitHub.
3. Envie o projeto para o repositório (`git init`, `git add .`, `git commit -m "Deploy Vercel + Supabase"`, `git push`).

---

## Passo 4 — Publicar na Vercel (2 minutos)

1. Acesse [vercel.com](https://vercel.com), entre com sua conta do GitHub e clique em **Add New… → Project**.
2. Selecione seu repositório privado `painel-de-estudos`.
3. Em **Environment Variables**, cadastre estas 4 variáveis:
   * `APP_PASSWORD` → **sua senha pessoal** para destravar o painel no celular/PC *(obrigatória na Vercel)*.
   * `GEMINI_API_KEY` → sua chave da API do Google AI Studio.
   * `SUPABASE_URL` → a URL do seu projeto Supabase (`https://xxxxx.supabase.co`).
   * `SUPABASE_SECRET_KEY` → sua chave `sb_secret_...` (ou `service_role`) do Supabase.
   * *(Opcional)* `SESSION_SECRET` → qualquer texto longo aleatório para assinar o cookie de sessão.
4. Clique em **Deploy**.

---

## Passo 5 — Usar em todos os seus dispositivos (PWA)

1. Abra a URL gerada pela Vercel (`https://seu-projeto.vercel.app`) no PC e no celular.
2. Digite sua `APP_PASSWORD` (a sessão fica salva por **30 dias** em cookie `HttpOnly` seguro).
3. No celular, toque no menu do navegador → **Adicionar à tela inicial / Instalar aplicativo** para usar como PWA com suporte offline e sincronização automática entre dispositivos!

---

### Dica sobre pausa por inatividade do Supabase Free
O plano gratuito do Supabase pausa o banco se ficar **7 dias seguidos sem nenhuma requisição**. Se você abrir o painel pelo menos 1 vez por semana, ele nunca pausa. Se um dia pausar após férias, basta clicar em **Restore project** no painel do Supabase (seus dados continuam intactos).
mYKA5KWwCSVkfJxa