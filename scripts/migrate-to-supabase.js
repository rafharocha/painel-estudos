import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createStorageAdapter } from '../shared/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const LOCAL_STATE_FILE = path.join(DATA_DIR, 'painel-data.json');
const LOCAL_SETTINGS_FILE = path.join(DATA_DIR, 'gemini-settings.json');

const forceFlag = process.argv.includes('--force');

async function main() {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseKey = (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    ''
  ).trim();

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Defina SUPABASE_URL e SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) no seu arquivo .env antes de rodar a migração.');
    process.exit(1);
  }

  let localState;
  try {
    const raw = await fs.readFile(LOCAL_STATE_FILE, 'utf-8');
    localState = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Não foi possível ler ${LOCAL_STATE_FILE}:`, err.message);
    process.exit(1);
  }

  const storage = createStorageAdapter({
    dataDir: DATA_DIR,
    supabaseUrl,
    supabaseKey,
    isVercel: false
  });

  console.log('🔍 Verificando estado atual no Supabase...');
  const remoteState = await storage.readState();
  const localRev = Number(localState && localState.meta && localState.meta.rev) || 1;
  const remoteRev = Number(remoteState && remoteState.meta && remoteState.meta.rev) || 0;

  if (remoteState && !forceFlag) {
    console.error(
      `⚠️  Já existe estado salvo no Supabase (rev=${remoteRev}, updatedAt=${remoteState.meta?.updatedAt || 'desconhecido'}).\n` +
      `   Para evitar sobrescrever dados da nuvem por engano, a migração foi interrompida.\n` +
      `   Se tiver certeza de que deseja substituir os dados no Supabase pelo seu arquivo local (rev=${localRev}), rode:\n` +
      `   npm run migrate:supabase -- --force`
    );
    process.exit(1);
  }

  const nextRev = Math.max(localRev, remoteRev + 1);
  const stateToUpload = {
    ...localState,
    meta: {
      ...(localState.meta || {}),
      rev: nextRev,
      updatedAt: new Date().toISOString()
    }
  };

  console.log(`⬆️  Enviando painel-data.json (${(Buffer.byteLength(JSON.stringify(stateToUpload)) / (1024 * 1024)).toFixed(2)} MB) para o Supabase (rev=${nextRev})...`);
  await storage.syncState(() => ({
    state: stateToUpload,
    rev: nextRev,
    merged: false,
    skippedEmptyClient: false
  }));
  console.log('✅ painel-data.json enviado com sucesso para o Supabase!');

  // Opcional: migra preferências de modelo/autópsia (sem enviar apiKey se já estiver em GEMINI_API_KEY na Vercel)
  try {
    const rawSettings = await fs.readFile(LOCAL_SETTINGS_FILE, 'utf-8');
    const parsedSettings = JSON.parse(rawSettings);
    await storage.saveGeminiSettings(
      {
        model: parsedSettings.model,
        autoAutopsyOnError: parsedSettings.autoAutopsyOnError
      },
      {
        allowedModels: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
        defaultModel: 'gemini-3.8-flash'
      }
    );
    console.log('✅ Preferências do Gemini (modelo e autópsia automática) sincronizadas (a API Key continua segura via variável GEMINI_API_KEY na Vercel).');
  } catch {
    // Sem gemini-settings.json local — tudo bem
  }

  console.log('\n🎉 Migração concluída! Seu Painel na Vercel já pode ler seus dados do Supabase.');
}

main().catch((err) => {
  console.error('❌ Falha na migração para o Supabase:', err.message);
  process.exit(1);
});
