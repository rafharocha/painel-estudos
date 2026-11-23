import 'dotenv/config';
import express from 'express';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import {
  QUESTION_LEVELS,
  parseQuestionLevel,
  formatQuestionLevel,
  normalizeSubtopicMastery
} from './shared/adaptive-engine.js';
import { resolveSyncState } from './shared/state-merge.js';
import { createStorageAdapter } from './shared/storage.js';
import { createAuthHelper } from './shared/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

const ALLOWED_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4-argon'
];
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
// Apenas modelos disponíveis no Free Tier entram no fallback automático.
// Modelos exclusivos de Tier Pago (como gemini-4-argon) só são usados quando selecionados explicitamente.
const AUTO_FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-4-hydrogen'
];

const storage = createStorageAdapter({ dataDir: DATA_DIR });
const auth = createAuthHelper();

// Suporte a payload JSON comprimido em Gzip (application/octet-stream + X-Payload-Format: gzip-json)
// Reduz ~2,5 MB para ~400 KB na rede e protege contra o limite de 4,5 MB das funções Serverless da Vercel.
const rawOctetParser = express.raw({ type: 'application/octet-stream', limit: '4mb' });
app.use((req, res, next) => {
  if (req.headers['x-payload-format'] !== 'gzip-json') return next();
  rawOctetParser(req, res, (err) => {
    if (err) {
      return res.status(413).json({ ok: false, error: 'Payload comprimido excede o limite permitido.' });
    }
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const text = zlib.gunzipSync(buf).toString('utf-8');
      req.body = text ? JSON.parse(text) : {};
      return next();
    } catch {
      return res.status(400).json({ ok: false, error: 'Falha ao descompactar payload gzip-json.' });
    }
  });
});

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

function sendMaybeCompressedJson(req, res, payload) {
  if (req.headers['x-accept-payload'] === 'gzip-json') {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Payload-Format', 'gzip-json');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(gz);
  }
  return res.json(payload);
}

// ---------- ROTAS PÚBLICAS DE SAÚDE E AUTENTICAÇÃO ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    storageBackend: storage.backend,
    storageConfigured: storage.isConfigured,
    authRequired: auth.authRequired,
    ...(auth.misconfigured ? { authMisconfigured: true } : {})
  });
});

app.get('/api/auth/status', (req, res) => {
  const status = auth.getStatus(req);
  res.json({
    ok: true,
    ...status,
    storageBackend: storage.backend,
    storageConfigured: storage.isConfigured
  });
});

app.post('/api/auth/login', async (req, res) => {
  if (auth.misconfigured) {
    return res.status(503).json({ ok: false, error: auth.misconfigured });
  }
  if (!auth.authRequired) {
    return res.json({ ok: true, authRequired: false, authenticated: true });
  }
  const limit = auth.checkRateLimit(req);
  if (limit.blocked) {
    return res.status(429).json({
      ok: false,
      error: `Muitas tentativas incorretas. Aguarde ${Math.ceil(limit.retryAfterSec / 60)} min e tente novamente.`
    });
  }
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!auth.verifyPassword(password)) {
    auth.recordFailedAttempt(req);
    await new Promise((r) => setTimeout(r, 350));
    return res.status(401).json({ ok: false, error: 'Senha incorreta.' });
  }
  auth.clearFailedAttempts(req);
  auth.issueSessionCookie(req, res);
  return res.json({ ok: true, authRequired: true, authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Protege todas as demais rotas /api/* quando APP_PASSWORD está configurado (ou na Vercel)
app.use(auth.requireAuthMiddleware);

async function loadGeminiSettings() {
  return storage.loadGeminiSettings({
    allowedModels: ALLOWED_MODELS,
    defaultModel: DEFAULT_MODEL
  });
}

async function saveGeminiSettings(settings) {
  return storage.saveGeminiSettings(settings, {
    allowedModels: ALLOWED_MODELS,
    defaultModel: DEFAULT_MODEL
  });
}

function createGeminiClient(apiKey) {
  // Evita que o SDK fique minutos em backoff interno em caso de 503; o fallback entre modelos é gerenciado por runGeminiInteraction
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: { attempts: 1 }
    }
  });
}

async function resolveGeminiContext(overrideModel) {
  const settings = await loadGeminiSettings();
  const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const apiKey = settings.apiKey || envKey;
  if (!apiKey) {
    const err = new Error('Chave da API do Gemini não configurada. Acesse Gerenciador > Conexão Gemini IA e cole sua API Key do Google AI Studio.');
    err.status = 400;
    throw err;
  }
  const model = ALLOWED_MODELS.includes(overrideModel) ? overrideModel : settings.model;
  const client = createGeminiClient(apiKey);
  return { client, model, settings };
}

function isTransientOrOverloadError(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  const status = err && (err.status || err.statusCode || err.code);
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('resource_exhausted') ||
    msg.includes('try again later')
  );
}

function isZeroOrDailyQuotaError(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  return (
    msg.includes('limit: 0') ||
    msg.includes('limit:0') ||
    msg.includes('requests per day') ||
    msg.includes('not available on the free tier')
  );
}

function summarizeGeminiErrorTag(err) {
  const msg = String(err && err.message || err || '').toLowerCase();
  const status = err && (err.status || err.statusCode || err.code);
  if (status === 503 || msg.includes('503') || msg.includes('high demand') || msg.includes('overloaded')) {
    return '503 alta demanda';
  }
  if (msg.includes('requests per day')) return '429 cota diária';
  if (msg.includes('limit: 0') || msg.includes('limit:0')) return '429 indisponível no Free Tier';
  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return '429 limite de taxa';
  }
  return status ? `erro ${status}` : 'indisponível';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callSingleModelInteraction(client, params) {
  if (client.interactions && typeof client.interactions.create === 'function') {
    const interaction = await client.interactions.create(params, { maxRetries: 0 });
    return {
      text: interaction.output_text || '',
      id: interaction.id || null,
      usedModel: params.model
    };
  }
  // Fallback caso o ambiente tenha instalado uma versão anterior do pacote @google/genai no npm público
  const fallbackModel = params.model;
  const config = {};
  if (params.system_instruction) {
    config.systemInstruction = params.system_instruction;
  }
  if (params.response_format && params.response_format.mime_type === 'application/json') {
    config.responseMimeType = 'application/json';
    if (params.response_format.schema) {
      config.responseSchema = params.response_format.schema;
    }
  }
  const res = await client.models.generateContent({
    model: fallbackModel,
    contents: params.input,
    config
  });
  return {
    text: res.text || '',
    id: null,
    usedModel: fallbackModel
  };
}

// Helper com retry automático e fallback inteligente de modelo em caso de pico de demanda (503 / 429) nos servidores do Google
export async function runGeminiInteraction(client, params) {
  const { allowFallback = true, ...baseParams } = params || {};
  const primaryModel = baseParams.model || DEFAULT_MODEL;
  const fallbackOrder = allowFallback
    ? [primaryModel, ...AUTO_FALLBACK_MODELS].filter((m, idx, arr) => ALLOWED_MODELS.includes(m) && arr.indexOf(m) === idx)
    : [primaryModel];

  let primaryError = null;
  let lastError = null;
  const attemptErrors = [];

  for (let i = 0; i < fallbackOrder.length; i++) {
    const candidateModel = fallbackOrder[i];
    // No modelo principal, faz até 3 tentativas curtas para superar picos breves de 503; nos fallbacks, 1 tentativa
    const maxAttempts = i === 0 ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Se mudou de modelo por fallback, não envia previous_interaction_id de outro modelo
        const callParams = { ...baseParams, model: candidateModel };
        if (candidateModel !== primaryModel && callParams.previous_interaction_id) {
          delete callParams.previous_interaction_id;
        }
        return await callSingleModelInteraction(client, callParams);
      } catch (err) {
        lastError = err;
        if (i === 0) primaryError = err;
        if (!isTransientOrOverloadError(err)) {
          throw err;
        }
        // Se o modelo tem cota 0 ou esgotou o limite diário (RPD), não perde tempo repetindo
        if (isZeroOrDailyQuotaError(err)) {
          attemptErrors.push({ model: candidateModel, tag: summarizeGeminiErrorTag(err), message: String(err.message || err) });
          break;
        }
        if (attempt < maxAttempts) {
          await sleep(attempt === 1 ? 1000 : 2200);
        } else {
          attemptErrors.push({ model: candidateModel, tag: summarizeGeminiErrorTag(err), message: String(err.message || err) });
        }
      }
    }
  }

  const rootError = primaryError || lastError;
  const fallbackEntries = attemptErrors.filter((entry) => entry.model !== primaryModel);

  if (fallbackEntries.length > 0) {
    const primaryMsg = String((rootError && rootError.message) || rootError || 'Erro desconhecido');
    const fallbackList = fallbackEntries.map((e) => `${e.model} (${e.tag})`).join(', ');
    const anyQuota = attemptErrors.some((e) => e.tag.startsWith('429'));
    const hint = anyQuota
      ? ' Aguarde alguns segundos e tente novamente (picos de 503 são temporários) ou confira suas cotas em https://aistudio.google.com/rate-limit.'
      : ' Todos os modelos gratuitos estão com pico temporário de demanda (503) nos servidores do Google. Aguarde alguns segundos e tente novamente.';
    const combined = new Error(
      `Falha no modelo selecionado (${primaryModel}): ${primaryMsg} | Fallbacks tentados: ${fallbackList}.${hint}`
    );
    combined.status = (rootError && (rootError.status || rootError.statusCode)) || 503;
    combined.attemptErrors = attemptErrors;
    throw combined;
  }

  throw rootError;
}

function maskKey(k) {
  if (!k || k.length < 8) return '';
  return k.slice(0, 4) + '••••••••' + k.slice(-4);
}

// ---------- ROTAS DE PERSISTÊNCIA DO PAINEL ----------
app.get('/api/state', async (req, res) => {
  try {
    const parsed = await storage.readState();
    if (!parsed) {
      return sendMaybeCompressedJson(req, res, { ok: true, state: null, rev: 0 });
    }
    const rev = Number(parsed && parsed.meta && parsed.meta.rev) || 0;
    return sendMaybeCompressedJson(req, res, { ok: true, state: parsed, rev });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const { state } = req.body || {};
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ ok: false, error: 'Estado inválido.' });
    }
    const result = await storage.saveStateDirect(state);
    return res.json({ ok: true, rev: result.rev });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/state/sync', async (req, res) => {
  try {
    const { state: clientState, hasOfflineChanges = false, baseRev = null, forceReplace = false } = req.body || {};
    if (!clientState || typeof clientState !== 'object') {
      return res.status(400).json({ ok: false, error: 'Estado inválido para sincronização.' });
    }
    const result = await storage.syncState((serverState) =>
      resolveSyncState({
        serverState,
        clientState,
        hasOfflineChanges: Boolean(hasOfflineChanges),
        baseRev: typeof baseRev === 'number' ? baseRev : null,
        forceReplace: Boolean(forceReplace),
        nowIso: new Date().toISOString()
      })
    );
    return sendMaybeCompressedJson(req, res, {
      ok: true,
      state: result.state,
      rev: result.rev,
      merged: result.merged,
      ...(result.skippedEmptyClient ? { skippedEmptyClient: true } : {})
    });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------- ROTAS DE CONFIGURAÇÃO DO GEMINI ----------
app.get('/api/gemini/config', async (req, res) => {
  try {
    const settings = await loadGeminiSettings();
    const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    const effectiveKey = settings.apiKey || envKey;
    const source = settings.apiKey ? 'ui' : (envKey ? 'env' : 'none');
    res.json({
      ok: true,
      hasKey: Boolean(effectiveKey),
      maskedKey: maskKey(effectiveKey),
      model: settings.model,
      autoAutopsyOnError: settings.autoAutopsyOnError,
      source,
      allowedModels: ALLOWED_MODELS
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/gemini/config', async (req, res) => {
  try {
    const { apiKey, model, autoAutopsyOnError } = req.body || {};
    const saved = await saveGeminiSettings({ apiKey, model, autoAutopsyOnError });
    const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    const effectiveKey = saved.apiKey || envKey;
    res.json({
      ok: true,
      hasKey: Boolean(effectiveKey),
      maskedKey: maskKey(effectiveKey),
      model: saved.model,
      autoAutopsyOnError: saved.autoAutopsyOnError,
      source: saved.apiKey ? 'ui' : (envKey ? 'env' : 'none')
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/gemini/test', async (req, res) => {
  try {
    const { apiKey: tempKey, model: tempModel } = req.body || {};
    let client, model;
    if (tempKey && String(tempKey).trim()) {
      client = createGeminiClient(String(tempKey).trim());
      model = ALLOWED_MODELS.includes(tempModel) ? tempModel : DEFAULT_MODEL;
    } else {
      const ctx = await resolveGeminiContext(tempModel);
      client = ctx.client;
      model = ctx.model;
    }
    const result = await runGeminiInteraction(client, {
      model,
      input: 'Responda em português com uma única frase curta confirmando que o Mentor Gemini está conectado ao Painel de Estudos.'
    });
    res.json({
      ok: true,
      model: result.usedModel || model,
      requestedModel: model,
      fallbackUsed: Boolean(result.usedModel && result.usedModel !== model),
      message: result.text.trim()
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Falha ao conectar ao Gemini.' });
  }
});

// ---------- 1. GERADOR DE QUESTÕES ESTRUTURADAS (MATRIZ N1-N5, REVISÃO ATIVA INÉDITA, PROVA LÓGICA PRÉVIA & DNA DA BANCA) ----------
const questionsJsonSchema = {
  type: 'object',
  properties: {
    questoes: {
      type: 'array',
      description: 'Lista de questões inéditas geradas exatamente conforme os slots e a Matriz de Calibração N1-N5.',
      items: {
        type: 'object',
        properties: {
          slotIndex: {
            type: 'integer',
            description: 'Índice exato (0, 1, 2...) do slot solicitado no plano da bateria.'
          },
          assunto: {
            type: 'string',
            description: 'Nome do subtópico/assunto específico cobrado nesta questão.'
          },
          nivel: {
            type: 'string',
            enum: ['N1', 'N2', 'N3', 'N4', 'N5'],
            description: 'Tag obrigatória de nível da Matriz de Calibração: N1 (Literalidade), N2 (Compreensão), N3 (Aplicação), N4 (Análise), N5 (Avaliação).'
          },
          conceitoChave: {
            type: 'string',
            description: 'Frase curta e precisa (máx. 110 caracteres) nomeando a regra, exceção ou conceito específico avaliado nesta questão (usado para agendar futuras questões inéditas de revalidação).'
          },
          isRevalidacao: {
            type: 'boolean',
            description: 'true se esta questão corresponde a um slot de Revisão Ativa / Revalidação Inédita de erro anterior; false caso contrário.'
          },
          armadilhaProjetada: {
            type: 'string',
            description: 'Planejamento interno do examinador: em N1 deixe vazio ou indique distratores claros; em N2-N5 indique a pegadinha, exceção ou distinção técnica usada no distrator principal.'
          },
          enunciado: {
            type: 'string',
            description: 'Enunciado completo e formatado em Markdown limpo e escaneável: separe cenário/caso prático do comando final com quebra dupla de linha (\\n\\n); use **negrito** em termos-chave do comando (ex: **CORRETO**, **INCORRETO**, **EXCETO**, **exclusivamente**); use blocos de código cercados (```sql, ```java, ```python, etc.) ou `código inline` quando aplicável; se houver assertivas (I, II, III, IV), coloque cada item em uma linha separada.'
          },
          resolucaoPassoAPassoVerificada: {
            type: 'string',
            description: 'OBRIGATÓRIO ANTES DE ESCREVER AS ALTERNATIVAS E O GABARITO: Resolva o problema do enunciado passo a passo do zero (em Raciocínio Lógico, Matemática, Contagem, Probabilidade, Equivalências, Tabelas-Verdade, Negações, Quantificadores ou Código/SQL, faça toda a dedução formal simbólica e cálculo exato aqui). Encontre o resultado exato e inequívoco primeiro.'
          },
          alternativas: {
            type: 'array',
            description: 'Alternativas da questão (A a E para múltipla escolha, ou C e E para Certo/Errado). Garanta que EXATAMENTE UMA alternativa contenha o resultado exato obtido em resolucaoPassoAPassoVerificada e que todas as demais sejam comprovadamente falsas sem ambiguidade.',
            items: {
              type: 'object',
              properties: {
                letra: { type: 'string', description: 'Letra identificadora (ex: A, B, C, D, E ou C/E)' },
                texto: { type: 'string', description: 'Texto completo e claro da alternativa (pode usar `código inline` ou **negrito** pontual se necessário para legibilidade).' }
              },
              required: ['letra', 'texto']
            }
          },
          correta: {
            type: 'string',
            description: 'Letra da única alternativa correta (ex: A, B, C, D, E ou C/E) que corresponde 100% ao resultado provado em resolucaoPassoAPassoVerificada.'
          },
          verificacaoConsistenciaGabarito: {
            type: 'string',
            description: 'Checagem cruzada final: confirme explicitamente que o texto da letra indicada em "correta" bate palavra por palavra/valor por valor com a conclusão de "resolucaoPassoAPassoVerificada" e que nenhuma outra alternativa também satisfaz o enunciado.'
          },
          comentarioProfessor: {
            type: 'string',
            description: 'Explicação técnica didática do gabarito (incluindo o passo a passo da resolução) e análise objetiva do motivo pelo qual cada distrator está incorreto.'
          }
        },
        required: [
          'slotIndex',
          'assunto',
          'nivel',
          'conceitoChave',
          'isRevalidacao',
          'armadilhaProjetada',
          'enunciado',
          'resolucaoPassoAPassoVerificada',
          'alternativas',
          'correta',
          'verificacaoConsistenciaGabarito',
          'comentarioProfessor'
        ]
      }
    }
  },
  required: ['questoes']
};

const auditQuestionsJsonSchema = {
  type: 'object',
  properties: {
    revisoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Índice da questão (0, 1, 2...)' },
          provaFormalIndependente: { type: 'string', description: 'Resolução matemática/lógica/técnica feita 100% às cegas e do zero pelo auditor independente.' },
          unicaCorretaEncontrada: { type: 'string', description: 'Letra da única alternativa correta encontrada na resolução cega (A, B, C, D, E ou C/E).' },
          houveAmbiguidade: { type: 'boolean', description: 'true APENAS se nenhuma alternativa satisfizer o enunciado ou se houver 2+ alternativas idênticas/corretas.' },
          alternativasCorrigidas: {
            type: 'array',
            description: 'Se houveAmbiguidade for true, ajuste os distratores para que apenas unicaCorretaEncontrada seja verdadeira; caso contrário, mantenha exatamente as alternativas originais.',
            items: {
              type: 'object',
              properties: {
                letra: { type: 'string' },
                texto: { type: 'string' }
              },
              required: ['letra', 'texto']
            }
          },
          comentarioProfessorCorrigido: { type: 'string', description: 'Comentário do professor detalhado e 100% alinhado com a provaFormalIndependente e com unicaCorretaEncontrada.' }
        },
        required: [
          'index',
          'provaFormalIndependente',
          'unicaCorretaEncontrada',
          'houveAmbiguidade',
          'alternativasCorrigidas',
          'comentarioProfessorCorrigido'
        ]
      }
    }
  },
  required: ['revisoes']
};

function isLogicalOrExactSubject(materia, listaAssuntos) {
  const combined = `${materia || ''} ${listaAssuntos || ''}`;
  return /racioc[ií]nio|l[oó]gic|matem[aá]tic|estat[ií]stic|exatas|combinat[oó]ri|probabilidad|proposi|tabela[\s-]*verdade|quantificador|conjunto|sequ[eê]nci|verdades?\s+e\s+mentiras?|algoritm|estrutura\s+de\s+dados|sql|complexidade/i.test(combined);
}

// Auditoria 100% CEGA em lote: NÃO envia o gabarito proposto nem qualquer resposta de aluno!
async function auditAndFixQuestionsBatch(client, model, questoes, banca) {
  if (!Array.isArray(questoes) || !questoes.length) return questoes;
  try {
    // Envia APENAS enunciado e alternativas (sem gabarito proposto, para zero viés de confirmação)
    const payloadForBlindAudit = questoes.map((q, idx) => ({
      index: idx,
      assunto: q.assunto,
      enunciado: q.enunciado,
      alternativas: q.alternativas
    }));

    const auditPrompt = `Você é o Revisor-Chefe Independente da banca ${banca}.
Sua missão é realizar uma RESOLUÇÃO CEGA (Blind Audit) das questões abaixo, SEM saber qual era o gabarito original.

Para cada questão:
1. Resolva o enunciado do zero em "provaFormalIndependente" com rigor absoluto (use tabela-verdade, leis de De Morgan, equivalências formais P->Q ≡ ~Q->~P ≡ ~PvQ, negações ~(P->Q) ≡ P^~Q, equações, contagem ou análise técnica estrita).
2. Determine em "unicaCorretaEncontrada" qual é a ÚNICA letra correta (A, B, C, D, E ou C/E) segundo a sua resolução formal.
3. Se e somente se não houver nenhuma alternativa correta ou houver duas alternativas inequivocamente verdadeiras, marque "houveAmbiguidade": true e ajuste "alternativasCorrigidas" para eliminar a ambiguidade mantendo "unicaCorretaEncontrada" como única correta. Caso contrário, marque "houveAmbiguidade": false e mantenha "alternativasCorrigidas" idênticas às originais.
4. Escreva em "comentarioProfessorCorrigido" a explicação passo a passo provando por que "unicaCorretaEncontrada" é a correta e por que cada uma das demais está incorreta.

QUESTÕES PARA RESOLUÇÃO CEGA:
${JSON.stringify(payloadForBlindAudit, null, 2)}`;

    const res = await runGeminiInteraction(client, {
      model,
      input: auditPrompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: auditQuestionsJsonSchema
      }
    });

    const cleaned = res.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.revisoes)) return questoes;

    return questoes.map((q, idx) => {
      const rev = parsed.revisoes.find(r => r.index === idx);
      if (!rev) return q;
      const blindLetter = String(rev.unicaCorretaEncontrada || q.correta).trim().toUpperCase();
      return {
        ...q,
        alternativas: (rev.houveAmbiguidade && Array.isArray(rev.alternativasCorrigidas) && rev.alternativasCorrigidas.length)
          ? rev.alternativasCorrigidas
          : q.alternativas,
        correta: blindLetter,
        resolucaoPassoAPassoVerificada: rev.provaFormalIndependente || q.resolucaoPassoAPassoVerificada,
        comentarioProfessor: rev.comentarioProfessorCorrigido || q.comentarioProfessor,
        auditadaPelaIA: true
      };
    });
  } catch (err) {
    console.warn('[Gemini Audit] Falha não-bloqueante na segunda passagem de auditoria, mantendo lote original:', err.message);
    return questoes;
  }
}

// Auditoria 100% CEGA de uma questão individual: NUNCA recebe a resposta marcada pelo aluno ("marcada") nem o gabarito ("correta")!
const singleBlindAuditSchema = {
  type: 'object',
  properties: {
    resolucaoCegaPassoAPasso: {
      type: 'string',
      description: 'Resolução formal passo a passo feita do zero olhando apenas o enunciado e as alternativas.'
    },
    letraCorretaCega: {
      type: 'string',
      description: 'Letra da única alternativa verdadeira (A, B, C, D, E ou C/E), ou "ANULADA" se nenhuma ou duas+ alternativas forem comprovadamente verdadeiras.'
    }
  },
  required: ['resolucaoCegaPassoAPasso', 'letraCorretaCega']
};

async function verifyQuestionGabaritoBlindly(client, model, { banca, materia, assunto, enunciado, alternativas }) {
  try {
    const altsText = Array.isArray(alternativas) && alternativas.length
      ? alternativas.map(a => `${a.letra}) ${a.texto}`).join('\n')
      : '';
    const blindPrompt = `Você é um Auditor Cego e Imparcial da banca ${banca} (${materia} — ${assunto}).
Você NÃO sabe qual é o gabarito preliminar e NÃO sabe o que nenhum candidato marcou.
Sua única tarefa é resolver a questão abaixo do zero com rigor técnico/lógico/matemático absoluto e apontar qual é a alternativa verdadeira.

ENUNCIADO:
${enunciado}

ALTERNATIVAS:
${altsText}

Resolva passo a passo em "resolucaoCegaPassoAPasso" e informe em "letraCorretaCega" apenas a letra da única alternativa correta (ex: A, B, C, D, E ou C/E), ou "ANULADA" se e somente se for matematicamente/tecnicamente impossível haver apenas uma alternativa correta.`;

    const res = await runGeminiInteraction(client, {
      model,
      input: blindPrompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: singleBlindAuditSchema
      }
    });
    const cleaned = res.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

function buildBancaDnaInstructions(banca, hasN1Slots = false) {
  const b = String(banca || 'FGV').toUpperCase();
  const n1Note = hasN1Slots
    ? '\n- EXCEÇÃO OBRIGATÓRIA PARA SLOTS N1 (Literalidade): nos slots marcados como N1, respeite estritamente a Matriz de Calibração (conceito isolado, regra geral ou definição direta, sem pegadinhas e com distratores claramente distintos), mantendo o vocabulário técnico formal da banca. Aplique os casos práticos e pegadinhas complexas da banca a partir de N2/N3.'
    : '';
  if (b.includes('FGV')) {
    return `DNA ESPECÍFICO DA BANCA FGV:
- A partir de N3 (Aplicação, Análise, Avaliação), apresente CASO PRÁTICO / SITUAÇÃO-PROBLEMA realista (ex: cenário de arquitetura, órgão público/Tribunal, incidente em produção, trecho de código/SQL ou decisão técnica).
- Em N2-N5, as alternativas devem ter tamanho e estrutura gramatical semelhantes; em N4-N5, explore trade-offs, exceções sutis e cruzamento de subtópicos.
- Distribua a letra do gabarito de forma variada entre A, B, C, D e E ao longo da bateria.${n1Note}`;
  }
  if (b.includes('CEBRASPE') || b.includes('CESPE')) {
    return `DNA ESPECÍFICO DA BANCA CEBRASPE:
- Em N3-N5, contextualize com situação hipotética técnica antes da assertiva ou do comando.
- Em N2-N5, explore inversões sutis de conceitos próximos, extrapolação indevida ("sempre", "exclusivamente") e exceções da regra.${n1Note}`;
  }
  return `DNA ESPECÍFICO DA BANCA ${banca}:
- Adapte o rigor, o tamanho do enunciado e a sutileza dos distratores estritamente ao nível (N1 a N5) exigido em cada slot da bateria.${n1Note}`;
}

function buildCalibratedMatrixPrompt(slotPlan, qtd, assuntosNames) {
  const matrixLines = Object.values(QUESTION_LEVELS)
    .map(lv => `- **${lv.code} (${lv.focus}):** ${lv.rule}`)
    .join('\n');

  const slots = Array.isArray(slotPlan && slotPlan.slots) && slotPlan.slots.length
    ? slotPlan.slots
    : Array.from({ length: qtd }, (_, i) => ({
        slotIndex: i,
        assuntoNome: assuntosNames[i % Math.max(1, assuntosNames.length)] || 'Assunto',
        nivel: i < Math.ceil(qtd * 0.6) ? 'N1' : (i < Math.ceil(qtd * 0.9) ? 'N2' : 'N3'),
        isActiveReview: false,
        isErrorReinforcement: false
      }));

  const slotInstructions = slots.map((s) => {
    const lvlCode = formatQuestionLevel(s.nivel, 2);
    const lvlMeta = QUESTION_LEVELS[lvlCode] || QUESTION_LEVELS.N2;
    const assLabel = s.assuntoNome || assuntosNames[0] || 'Subtópico';
    if (s.isActiveReview || s.isErrorReinforcement) {
      const kind = s.isActiveReview ? 'REVISÃO ATIVA VENCIDA (GERAR QUESTÃO 100% INÉDITA)' : 'REFORÇO DE ERRO ANTERIOR (GERAR QUESTÃO 100% INÉDITA)';
      const reasonLine = s.errorReasonNote ? ` | Motivo anotado pelo aluno: "${s.errorReasonNote}"` : '';
      const typeLine = s.errorReasonType ? ` [${s.errorReasonType}]` : '';
      const prevSnippet = s.pastEnunciadoSnippet ? ` | NÃO repita o texto anterior ("${s.pastEnunciadoSnippet}")` : '';
      return `  * Slot ${s.slotIndex} [${lvlCode} — ${lvlMeta.focus}] · ${kind} · Subtópico: "${assLabel}" · Conceito-alvo a revalidar: "${s.conceitoChave || assLabel}"${typeLine}${reasonLine}${prevSnippet}. Crie um enunciado totalmente NOVO testando exatamente este conceito no nível ${lvlCode} (marque isRevalidacao: true).`;
    }
    return `  * Slot ${s.slotIndex} [${lvlCode} — ${lvlMeta.focus}] · Subtópico: "${assLabel}" · Questão inédita regular seguindo rigorosamente o critério ${lvlCode} (marque isRevalidacao: false).`;
  }).join('\n');

  return `MATRIZ DE CALIBRAÇÃO OBRIGATÓRIA (N1 a N5):
Cada questão gerada DEVE receber obrigatoriamente a tag de nível ("N1", "N2", "N3", "N4" ou "N5") e obedecer exatamente aos critérios objetivos abaixo:
${matrixLines}

PLANO EXATO DE SLOTS DA BATERIA (${slots.length} questões — siga a ordem e o nível de cada slot sem alterar):
${slotInstructions}

REGRA DE OURO DA REVISÃO ATIVA INÉDITA:
- Para todo slot marcado como REVISÃO ATIVA ou REFORÇO DE ERRO ANTERIOR, é PROIBIDO copiar/parafrasear levemente o enunciado antigo. Crie uma questão 100% INÉDITA (novo exemplo, novo caso ou nova abordagem) avaliando exatamente o mesmo conceito/ponto cego no nível especificado no slot.`;
}

app.post('/api/gemini/generate-questions', async (req, res) => {
  try {
    const {
      materia,
      assuntos = [],
      quantidade = 5,
      banca = 'FGV',
      concurso = 'TJPB (Analista de TI: Desenvolvimento de Sistemas)',
      formato = 'multipla_escolha',
      instrucoesExtras = '',
      pastErrorsContext = [],
      slotPlan = null,
      model: requestedModel
    } = req.body || {};

    const plannedSlots = Array.isArray(slotPlan && slotPlan.slots) && slotPlan.slots.length ? slotPlan.slots : null;
    const qtd = plannedSlots ? Math.max(1, Math.min(20, plannedSlots.length)) : Math.max(1, Math.min(20, Number(quantidade) || 5));
    const { client, model } = await resolveGeminiContext(requestedModel);

    const listaAssuntos = Array.isArray(assuntos) && assuntos.length ? assuntos.join(', ') : materia;
    const isCE = formato === 'certo_errado';
    const formatoInstrucao = isCE
      ? 'Formato CERTO ou ERRADO (estilo Cebraspe): crie exatamente 2 alternativas com letras "C" (texto: "Certo") e "E" (texto: "Errado"). O campo "correta" deve ser "C" ou "E".'
      : 'Formato MÚLTIPLA ESCOLHA com 5 alternativas ("A", "B", "C", "D", "E"). O campo "correta" deve ser apenas a letra ("A", "B", "C", "D" ou "E").';

    const hasN1Slots = plannedSlots ? plannedSlots.some(s => formatQuestionLevel(s.nivel) === 'N1') : true;
    const bancaDna = buildBancaDnaInstructions(banca, hasN1Slots);
    const matrixPrompt = buildCalibratedMatrixPrompt(slotPlan, qtd, Array.isArray(assuntos) ? assuntos : [materia]);

    const historicoErrosPrompt = Array.isArray(pastErrorsContext) && pastErrorsContext.length
      ? `\nCONTEXTO ADICIONAL DE PONTOS CEGOS RECENTES DO ALUNO (use como referência para não repetir textos antigos e reforçar distinções relevantes):\n${pastErrorsContext.map((e, i) => `- Ponto cego ${i + 1}: ${e}`).join('\n')}\n`
      : '';

    const prompt = `Você é o Examinador Sênior da banca ${banca}, responsável por elaborar questões calibradas para o cargo ${concurso}.
Crie exatamente ${qtd} questão(ões) INÉDITA(S) seguindo rigorosamente o plano de slots abaixo:
- Matéria: ${materia}
- Subtópico(s): ${listaAssuntos}

1. FORMATO:
${formatoInstrucao}

2. ${matrixPrompt}

3. ${bancaDna}

4. FORMATAÇÃO VISUAL DO ENUNCIADO (ESCANEÁVEL EM MARKDOWN):
- Estruture o campo "enunciado" em Markdown claro:
  * Em N1/N2: enunciado objetivo e limpo; separe contexto e comando final com "\\n\\n".
  * Em N3/N4/N5: Parágrafo 1 com cenário/estudo de caso; itens/assertivas (I, II, III, IV) ou requisitos em linhas separadas ("\\n\\n**I.** ...\\n**II.** ..."); blocos de código cercados (\`\`\`sql ... \`\`\`) ou \`código inline\` quando houver código; último parágrafo separado por "\\n\\n" com o comando destacando em **negrito** palavras restritivas (**EXCETO**, **INCORRETO**, **NÃO**, **exclusivamente**, **apenas**).

5. PROTOCOLO ANTI-ERRO DE GABARITO (RIGOR MATEMÁTICO, LÓGICO E TÉCNICO ABSOLUTO):
- É INACEITÁVEL gerar questão com gabarito errado, duas alternativas corretas ou nenhuma alternativa correta.
- Você DEVE resolver o problema passo a passo do zero no campo "resolucaoPassoAPassoVerificada" ANTES de redigir as alternativas e ANTES de definir a letra em "correta".
- Em questões de Raciocínio Lógico, Matemática, Contagem, Probabilidade, Conjuntos, Equivalências, Negações, Tabelas-Verdade ou Código/SQL, escreva a dedução simbólica formal completa e confira conectivo por conectivo.
- Garanta que a letra gravada em "correta" corresponda 100% à única alternativa que contém o resultado obtido em "resolucaoPassoAPassoVerificada".

6. COMENTÁRIO DO PROFESSOR & CONCEITO-CHAVE:
- No campo "conceitoChave", sintetize em 1 frase curta o conceito/regra específica avaliada (ex: "Diferença entre autoexecutoriedade e exigibilidade dos atos administrativos").
- No campo "comentarioProfessor", explique de forma didática por que o gabarito é correto e por que cada distrator está errado.
${historicoErrosPrompt}${instrucoesExtras ? `\nINSTRUÇÕES EXTRAS DO ALUNO:\n${instrucoesExtras}\n` : ''}`;

    const result = await runGeminiInteraction(client, {
      model,
      input: prompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: questionsJsonSchema
      }
    });

    const cleanedText = result.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleanedText);
    if (!parsed || !Array.isArray(parsed.questoes)) {
      throw new Error('O Gemini retornou um formato inesperado ao gerar questões.');
    }

    let finalQuestions = parsed.questoes.map((q, idx) => {
      const slot = plannedSlots
        ? (plannedSlots.find(s => Number(s.slotIndex) === Number(q.slotIndex)) || plannedSlots[idx] || null)
        : null;
      const enforcedNivel = slot ? formatQuestionLevel(slot.nivel, 2) : formatQuestionLevel(q.nivel || q.nivelInterno, 2);
      return {
        ...q,
        slotIndex: slot ? slot.slotIndex : idx,
        nivel: enforcedNivel,
        nivelInterno: parseQuestionLevel(enforcedNivel, 2),
        conceitoChave: String(q.conceitoChave || (slot && slot.conceitoChave) || q.assunto || '').trim(),
        assunto: String((slot && slot.assuntoNome) || q.assunto || (Array.isArray(assuntos) && assuntos[0]) || materia).trim(),
        assuntoId: slot && slot.assuntoId ? slot.assuntoId : null,
        isActiveReview: Boolean(slot && slot.isActiveReview),
        isErrorReinforcement: Boolean(slot && slot.isErrorReinforcement),
        reviewConceptId: slot && slot.reviewConceptId ? slot.reviewConceptId : null
      };
    });

    // Garante ordenação por slotIndex (revisões ativas nos primeiros slots)
    finalQuestions.sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));

    // Se for Raciocínio Lógico / Matemática / Exatas / Algoritmos, passa por uma segunda auditoria formal independente antes de entregar ao aluno
    if (isLogicalOrExactSubject(materia, listaAssuntos)) {
      finalQuestions = await auditAndFixQuestionsBatch(client, result.usedModel || model, finalQuestions, banca);
    }

    res.json({
      ok: true,
      model: result.usedModel || model,
      questoes: finalQuestions
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Erro ao gerar questões no Gemini.' });
  }
});

// ---------- 2. FEEDBACK IMEDIATO POR QUESTÃO (MODO ESTUDO REVERSO IMEDIATO) ----------
app.post('/api/gemini/question-feedback', async (req, res) => {
  try {
    const {
      banca = 'FGV',
      concurso = 'TJPB (Analista de TI: Desenvolvimento de Sistemas)',
      materia = '',
      assunto = '',
      nivel = 'N2',
      conceitoChave = '',
      confidence = 'certeza',
      enunciado = '',
      alternativas = [],
      marcada = '',
      correta = '',
      comentarioProfessor = '',
      resolucaoPassoAPassoVerificada = '',
      geradaPelaIA = true,
      acertou = false,
      isReview = false,
      pastMarcada = '',
      pastDate = '',
      model: requestedModel
    } = req.body || {};

    const { client, model } = await resolveGeminiContext(requestedModel);
    const nivelNorm = formatQuestionLevel(nivel, 2);
    const nivelMeta = QUESTION_LEVELS[nivelNorm] || QUESTION_LEVELS.N2;
    const isChuteHit = Boolean(acertou && confidence === 'chute');
    const isDoubtHit = Boolean(acertou && confidence === 'duvida');
    const treatAsErrorFeedback = !acertou || isChuteHit;

    const altsText = Array.isArray(alternativas) && alternativas.length
      ? alternativas.map(a => `${a.letra}) ${a.texto}`).join('\n')
      : '';

    const reviewNotice = isReview
      ? `\nATENÇÃO: Esta questão veio da fila de REVISÃO ATIVA do aluno (revalidação de conceito errado anteriormente${pastDate ? ' em ' + pastDate : ''}).`
      : '';

    const confidenceNotice = isChuteHit
      ? `\nATENÇÃO (ACERTO NO CHUTE): O aluno acertou a letra (${marcada}), mas marcou **CHUTE** (não sabia o porquê). Pelo algoritmo de Estudo Reverso, o chute vale 0 pontos e deve ser tratado exatamente como um ERRO para construir a base teórica do conceito.`
      : (isDoubtHit
        ? `\nATENÇÃO (ACERTO COM DÚVIDA): O aluno acertou (${marcada}), mas ficou em **DÚVIDA** entre alternativas. Esclareça de forma cirúrgica a distinção que elimina a dúvida para a revisão curta de 3 dias.`
        : '');

    const authorshipNotice = geradaPelaIA
      ? `\n**IDENTIDADE & AUTORIA DA QUESTÃO (MUITO IMPORTANTE):**
- Esta questão (${nivelNorm} — ${nivelMeta.focus}) foi elaborada por **VOCÊ MESMO (o Mentor Gemini integrado ao Painel de Estudos)**, simulando o estilo da banca ${banca}.
- Fale em primeira pessoa (*"Nesta questão ${nivelNorm} que elaborei para você..."*).`
      : '';

    // AUDITORIA 100% CEGA (NÃO envia "marcada" nem "correta" para o verificador!)
    let blindDiscrepancyTag = '';
    let auditInstructionForPrompt = '';
    const normCorreta = String(correta || '').trim().toUpperCase();

    if (!acertou && Array.isArray(alternativas) && alternativas.length) {
      const blindAudit = await verifyQuestionGabaritoBlindly(client, model, {
        banca,
        materia,
        assunto,
        enunciado,
        alternativas
      });
      const blindLetter = blindAudit && blindAudit.letraCorretaCega
        ? String(blindAudit.letraCorretaCega).trim().toUpperCase()
        : normCorreta;

      if (blindLetter && blindLetter !== normCorreta) {
        blindDiscrepancyTag = `[FALHA_GABARITO_IA: CORRETA=${blindLetter}]\n\n`;
        auditInstructionForPrompt = `\n**RESULTADO DA AUDITORIA CEGA INDEPENDENTE (SEM VER A RESPOSTA DO ALUNO):**
- Um auditor cego resolveu esta questão do zero (sem saber o que o aluno marcou) e concluiu que o gabarito verdadeiro é **${blindLetter}** (e não **${normCorreta}**).
- Resolução da auditoria cega: ${blindAudit.resolucaoCegaPassoAPasso || ''}
- Portanto, admita que houve uma falha no seu gabarito preliminar (${normCorreta}) e explique a resolução correta apontando **${blindLetter}** como resposta verdadeira.`;
      } else {
        auditInstructionForPrompt = `\n**REGRA RÍGIDA ANTI-CONDESCENDÊNCIA (GABARITO JÁ VALIDADO ÀS CEGAS):**
- Uma auditoria 100% cega (feita sem ver a resposta do aluno) JÁ CONFIRMOU que o seu gabarito oficial (**${normCorreta}**) está **100% CORRETO** e que a alternativa marcada pelo aluno (**${marcada}**) está **DEFINITIVAMENTE ERRADA**.
- **PROIBIDO** concordar com a alternativa marcada pelo aluno (**${marcada}**) ou inventar falha no gabarito! Explique com firmeza e didática por que **${normCorreta}** é a única correta e por que **${marcada}** é incorreta.`;
      }
    }

    const prompt = !treatAsErrorFeedback
      ? `Atue como meu Mentor Especialista na banca ${banca} (${concurso}).${authorshipNotice}${confidenceNotice}
Acabei de ACERTAR a questão **${nivelNorm} (${nivelMeta.focus})** sobre **${assunto}** (${materia})${conceitoChave ? ` — Conceito: ${conceitoChave}` : ''}.${reviewNotice}

QUESTÃO:
${enunciado}
${altsText ? '\nALTERNATIVAS:\n' + altsText : ''}
Marquei: ${marcada} (Confiança: ${confidence.toUpperCase()} | Gabarito: ${correta})
${comentarioProfessor ? '\nComentário base:\n' + comentarioProfessor : ''}

Faça um resumo de reforço rápido e direto em Markdown:
1. **💡 Ponto-Chave Validado (${nivelNorm})**: O conceito central que garantiu o acerto${isDoubtHit ? ' e a distinção exata para eliminar a dúvida de vez' : ''}.
2. **⚠️ Casca de Banana Evitada**: Qual era a pegadinha/distrator principal e como continuar não caindo nela.`
      : `**CONTEXTO & PAPEL**
Atue como meu Mentor de Alta Performance e Especialista na Banca ${banca}. Estou em preparação pós-edital para o ${concurso}. ${isChuteHit ? 'Acabei de acertar NO CHUTE (sem saber o porquê)' : 'Acabei de ERRAR'} a questão **${nivelNorm} (${nivelMeta.focus})** abaixo no modo Estudo Reverso Imediato e preciso da sua autópsia técnica para meu Histórico e Ciclo do Erro.${authorshipNotice}${reviewNotice}${confidenceNotice}${auditInstructionForPrompt}

**MATÉRIA / SUBTÓPICO:** ${materia} — ${assunto}${conceitoChave ? `\n**CONCEITO-CHAVE:** ${conceitoChave}` : ''}
**NÍVEL DA QUESTÃO:** ${nivelNorm} — ${nivelMeta.focus} (${nivelMeta.rule})

**QUESTÃO:**
${enunciado}
${altsText ? '\n**ALTERNATIVAS:**\n' + altsText : ''}

- **Alternativa que marquei:** ${marcada || '—'} (Confiança: ${String(confidence || 'certeza').toUpperCase()})
- **Gabarito Oficial:** ${correta || '—'}
${resolucaoPassoAPassoVerificada ? '\n**Memória de resolução na criação:**\n' + resolucaoPassoAPassoVerificada : ''}
${comentarioProfessor ? '\n**Comentário base na criação:**\n' + comentarioProfessor : ''}

**SUA MISSÃO:**
Estruture sua resposta em Markdown nestas 4 seções claras e coesas:

### 1. 💡 BASE NÍVEL ZERO (O Fundamento do Conceito)
- Explique de forma intuitiva, simples e direta: O que preciso saber sobre esse conceito (${conceitoChave || assunto})? Qual é a regra geral e a exceção aplicável?

### 2. 🔍 DIAGNÓSTICO DO ERRO & A PEGADINHA (${nivelNorm} · ${banca.toUpperCase()})
- Explique por que a alternativa **${marcada || 'marcada'}** ${isChuteHit ? 'está correta e por que as demais são falsas (eliminando o chute)' : 'está incorreta e qual confusão conceitual ela explora'}.
- Qual detalhe exato do enunciado torna **${correta || 'correta'}** a única verdadeira?${isReview ? '\n- Como este conceito veio de revisão ativa, aponte com franqueza qual vício de raciocínio está impedindo a fixação.' : ''}

### 3. 🎯 REGRA DE BOLSO (Para o Caderno de Erros & Flashcards)
- Síntese em até 3 bullets diretos no formato "**Gatilho na prova** → **Regra de bolso**" para revisão espaçada (1d → 4d → 10d → 25d).

### 4. 📋 RESUMO PARA O MENTOR (Relatório Diário)
- Escreva um único parágrafo curto (máx. 280 caracteres, sem bullets) resumindo: (1) o conceito exato cobrado, (2) a lacuna/confusão que gerou o ${isChuteHit ? 'chute' : 'erro'}, e (3) a distinção correta.`;

    const result = await runGeminiInteraction(client, {
      model,
      input: prompt
    });

    const finalMarkdown = blindDiscrepancyTag + result.text.trim().replace(/\[FALHA_GABARITO_IA:[^\]]*\]\s*/gi, '');

    // Extrai automaticamente a seção 4 (Resumo para o Mentor) para uso direto no Relatório Diário
    let resumoMentor = '';
    const mentorMatch = finalMarkdown.match(/###\s*4\.[^\n]*\n+([\s\S]*?)(?=###|$)/i);
    if (mentorMatch && mentorMatch[1]) {
      resumoMentor = mentorMatch[1]
        .replace(/^[\s*\-•>]+/gm, '')
        .replace(/\r?\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    res.json({
      ok: true,
      model: result.usedModel || model,
      analiseMarkdown: finalMarkdown,
      resumoMentor,
      interactionId: result.id
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Erro ao gerar diagnóstico no Gemini.' });
  }
});

// ---------- 3. CHAT CONTEXTUAL TIRA-DÚVIDAS DA QUESTÃO ----------
app.post('/api/gemini/question-chat', async (req, res) => {
  try {
    const {
      banca = 'FGV',
      concurso = 'TJPB',
      materia = '',
      assunto = '',
      enunciado = '',
      alternativas = [],
      marcada = '',
      correta = '',
      analiseAnterior = '',
      pergunta = '',
      previousInteractionId = null,
      model: requestedModel
    } = req.body || {};

    if (!pergunta || !String(pergunta).trim()) {
      return res.status(400).json({ ok: false, error: 'Digite sua dúvida.' });
    }

    const { client, model } = await resolveGeminiContext(requestedModel);

    const altsText = Array.isArray(alternativas) && alternativas.length
      ? alternativas.map(a => `${a.letra}) ${a.texto}`).join('\n')
      : '';

    // Se o aluno estiver contestando o gabarito no chat, faz a verificação 100% CEGA (sem passar "marcada"!)
    let blindVerdictNote = '';
    if (/gabarito|certeza|correta|errad|anula|discordo/i.test(pergunta) && Array.isArray(alternativas) && alternativas.length) {
      const blindAudit = await verifyQuestionGabaritoBlindly(client, model, {
        banca,
        materia,
        assunto,
        enunciado,
        alternativas
      });
      if (blindAudit && blindAudit.letraCorretaCega) {
        const blindL = String(blindAudit.letraCorretaCega).trim().toUpperCase();
        blindVerdictNote = `\nRESULTADO DA AUDITORIA CEGA (FEITA SEM VER O QUE O ALUNO MARCOU): A resolução cega apontou que a alternativa verdadeira é **${blindL}** (${blindAudit.resolucaoCegaPassoAPasso}). Baseie-se estritamente nesta prova cega e NUNCA concorde com o aluno por simpatia se a resposta dele divergir da auditoria cega!`;
      }
    }

    const selfAuthorContext = `LEMBRETE DE IDENTIDADE E RIGOR:
1. Esta questão foi elaborada por VOCÊ MESMO (o Mentor Gemini do Painel de Estudos), simulando a banca ${banca}. Fale em 1ª pessoa como autor da questão ("Nesta questão que criei para você...").
2. REGRA ANTI-CONDESCENDÊNCIA: JAMAIS valide a alternativa marcada pelo aluno (${marcada}) por simpatia ou sugestão. Julgue estritamente pela lógica formal e pela auditoria cega (que desconhece o que o aluno marcou).${blindVerdictNote}`;

    const interactionParams = {
      model,
      input: previousInteractionId
        ? `${selfAuthorContext}\n\nDúvida do aluno sobre a questão que você elaborou:\n${String(pergunta).trim()}`
        : `Contexto: Sou candidato ao ${concurso} (Banca ${banca}), estudando ${materia} — ${assunto}.
${selfAuthorContext}

Questão elaborada por você:
${enunciado}
${altsText ? '\nAlternativas:\n' + altsText : ''}
Marquei: ${marcada} | Seu Gabarito oficial: ${correta}
Análise já realizada:
${analiseAnterior}

Minha dúvida específica agora:
${String(pergunta).trim()}

Responda de forma didática, firme, direta e em Markdown.`
    };

    if (previousInteractionId) {
      interactionParams.previous_interaction_id = previousInteractionId;
    }

    const result = await runGeminiInteraction(client, interactionParams);
    res.json({
      ok: true,
      model: result.usedModel || model,
      respostaMarkdown: result.text.trim(),
      interactionId: result.id
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Erro ao responder dúvida no Gemini.' });
  }
});

// ---------- 4. ANÁLISE COMPLETA DE SESSÃO (CADERNO DE ERROS) ----------
app.post('/api/gemini/analyze-session', async (req, res) => {
  try {
    const { prompt, model: requestedModel } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ ok: false, error: 'Prompt de sessão vazio.' });
    }
    const { client, model } = await resolveGeminiContext(requestedModel);
    const result = await runGeminiInteraction(client, {
      model,
      input: String(prompt).trim()
    });
    res.json({
      ok: true,
      model: result.usedModel || model,
      analise: result.text.trim(),
      interactionId: result.id
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Erro ao analisar sessão com o Gemini.' });
  }
});

// ---------- 5. SÍNTESE CONSOLIDADA DE ASSUNTO PARA O CADERNO DE ESTUDOS ----------
app.post('/api/gemini/synthesize-subject', async (req, res) => {
  try {
    const {
      banca = 'FGV',
      concurso = 'TJPB',
      materia = '',
      assunto = '',
      errorsList = [],
      sessionAnalyses = [],
      notaPessoal = '',
      model: requestedModel
    } = req.body || {};

    if (!assunto) {
      return res.status(400).json({ ok: false, error: 'Informe o assunto para consolidar no caderno.' });
    }

    const { client, model } = await resolveGeminiContext(requestedModel);

    const schema = {
      type: 'object',
      properties: {
        baseNivelZero: {
          type: 'string',
          description: 'Explicação didática em Markdown (com listas e negritos) dos fundamentos essenciais do assunto a partir dos erros do aluno.'
        },
        pegadinhasBanca: {
          type: 'string',
          description: 'Lista em Markdown das pegadinhas da banca, confusões conceituais e pontos cegos identificados nas questões que o aluno errou.'
        },
        regrasDeBolso: {
          type: 'string',
          description: 'Checklist direto de regras de bolso, macetes e gatilhos de prova em Markdown para revisão rápida de repetição espaçada.'
        },
        flashcards: {
          type: 'array',
          description: 'Lista de 4 a 8 flashcards de Active Recall cobrindo as regras de bolso e pegadinhas mais importantes deste assunto.',
          items: {
            type: 'object',
            properties: {
              frente: { type: 'string', description: 'Pergunta direta, situação-gatilho de prova ou pegadinha clássica da banca (sem entregar a resposta).' },
              verso: { type: 'string', description: 'Resposta curta, direta e objetiva com a regra de bolso ou distinção técnica.' },
              categoria: { type: 'string', description: 'Ex: Regra de Bolso, Pegadinha da Banca ou Conceito-Chave' }
            },
            required: ['frente', 'verso', 'categoria']
          }
        }
      },
      required: ['baseNivelZero', 'pegadinhasBanca', 'regrasDeBolso', 'flashcards']
    };

    const errsFormatted = (Array.isArray(errorsList) ? errorsList : []).map((e, i) => {
      return `Questão Errada #${i + 1} (${e.dateLabel || ''}):
Enunciado: ${e.texto || e.enunciado || '(sem enunciado)'}
Marquei: ${e.marcada || '—'} | Gabarito: ${e.correta || '—'}
${e.comentario ? 'Comentário do professor: ' + e.comentario : ''}
${e.analiseIA ? 'Diagnóstico prévio: ' + e.analiseIA : ''}`;
    }).join('\n\n---\n\n');

    const sessFormatted = (Array.isArray(sessionAnalyses) ? sessionAnalyses : []).filter(Boolean).join('\n\n---\n\n');

    const prompt = `Atue como meu Mentor de Alta Performance e Especialista na Banca ${banca} para o concurso ${concurso}.
Estou organizando a página definitiva de revisão do assunto "${assunto}" (Matéria: "${materia}") no meu Caderno de Erros Digital.

Abaixo estão todas as questões que já errei neste assunto e os diagnósticos anteriores:

${errsFormatted || '(Nenhuma questão detalhada ainda)'}

${sessFormatted ? '\nANÁLISES DE SESSÕES ANTERIORES:\n' + sessFormatted : ''}
${notaPessoal ? '\nMINHAS ANOTAÇÕES PESSOAIS ATUAIS:\n' + notaPessoal : ''}

Elabore um Guia de Estudo Reverso consolidado para este assunto dividido em 4 campos (use formatação Markdown rica com bullet points `- `, termos em **negrito** e exemplos curtos, sem incluir o título da seção dentro do texto pois o cartão já tem título):
1. baseNivelZero: O fundamento nível zero dos tópicos cobrados nesses erros (o que é, para que serve, como funciona na prática e diferenças entre conceitos parecidos).
2. pegadinhasBanca: O mapa das cascas de banana da ${banca} neste assunto e os vícios de raciocínio que me fizeram errar.
3. regrasDeBolso: Gatilhos rápidos de prova ("**Viu X no enunciado** → **Lembre de Y**") e macetes para revisão batida de olho antes da prova.
4. flashcards: De 4 a 8 flashcards curtos e cirúrgicos (frente: pergunta/situação-gatilho da ${banca}; verso: regra de bolso direta) para treino de Active Recall.`;

    const result = await runGeminiInteraction(client, {
      model,
      input: prompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema
      }
    });

    let parsed;
    try {
      const cleaned = result.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(500).json({
        ok: false,
        error: 'O Gemini retornou um formato inesperado ao sintetizar o assunto. Tente novamente.'
      });
    }

    res.json({
      ok: true,
      model: result.usedModel || model,
      sintese: {
        baseNivelZero: parsed.baseNivelZero || '',
        pegadinhasBanca: parsed.pegadinhasBanca || '',
        regrasDeBolso: parsed.regrasDeBolso || '',
        flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards : [],
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Erro ao sintetizar assunto no Gemini.' });
  }
});

export default app;

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (!process.env.VERCEL && isDirectRun) {
  const HOST = (process.env.HOST || '').trim();
  const modeLabel = storage.useSupabase ? 'Supabase' : 'Disco local';
  const authLabel = auth.authRequired ? 'Login ativo' : 'Sem senha (local)';
  if (HOST) {
    app.listen(PORT, HOST, () => {
      console.log(`\n🚀 Painel de Estudos (Node.js + Gemini + PWA | ${modeLabel} | ${authLabel}) rodando em: http://${HOST}:${PORT}\n`);
    });
  } else {
    app.listen(PORT, () => {
      console.log(`\n🚀 Painel de Estudos (Node.js + Gemini + PWA | ${modeLabel} | ${authLabel}) rodando em: http://localhost:${PORT}\n`);
    });
  }
}

