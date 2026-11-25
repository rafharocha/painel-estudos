import fs from 'fs/promises';
import path from 'path';
import {
  normalizeBankQuestionRow,
  selectQuestionsFromBank,
  computeQuestionBankStats,
  extractBackfillQuestionsFromState,
  computeQuestionFingerprint
} from './question-bank.js';

export const STATE_KEY = 'painel_state';
export const SETTINGS_KEY = 'gemini_settings';
export const DEFAULT_SUPABASE_TABLE = 'painel_store';
export const DEFAULT_QUESTIONS_TABLE = 'painel_questions';

export function isJwtKey(key) {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (!trimmed || trimmed.startsWith('sb_')) return false;
  const parts = trimmed.split('.');
  return parts.length === 3 && trimmed.startsWith('eyJ');
}

export function buildSupabaseHeaders(apiKey, extra = {}) {
  const key = String(apiKey || '').trim();
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...extra
  };
  // Chaves legadas (service_role) são JWTs e usam Authorization: Bearer.
  // Chaves novas (sb_secret_...) são opacas e devem ser enviadas apenas em apikey.
  if (isJwtKey(key)) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export function stripNullChars(value) {
  if (typeof value === 'string') {
    return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
  }
  if (Array.isArray(value)) {
    return value.map(stripNullChars);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripNullChars(v);
    }
    return out;
  }
  return value;
}

function makeConfigError(message, status = 503) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function createStorageAdapter({
  dataDir,
  supabaseUrl = process.env.SUPABASE_URL || '',
  supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '',
  tableName = process.env.SUPABASE_TABLE || DEFAULT_SUPABASE_TABLE,
  questionsTableName = process.env.SUPABASE_QUESTIONS_TABLE || DEFAULT_QUESTIONS_TABLE,
  isVercel = Boolean(process.env.VERCEL),
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanUrl = String(supabaseUrl || '').trim().replace(/\/+$/, '');
  const cleanKey = String(supabaseKey || '').trim();
  const cleanTable = String(tableName || DEFAULT_SUPABASE_TABLE).trim() || DEFAULT_SUPABASE_TABLE;
  const cleanQuestionsTable = String(questionsTableName || DEFAULT_QUESTIONS_TABLE).trim() || DEFAULT_QUESTIONS_TABLE;
  const useSupabase = Boolean(cleanUrl && cleanKey);
  const backend = useSupabase ? 'supabase' : 'local';

  const stateFile = dataDir ? path.join(dataDir, 'painel-data.json') : '';
  const settingsFile = dataDir ? path.join(dataDir, 'gemini-settings.json') : '';
  const questionBankFile = dataDir ? path.join(dataDir, 'question-bank.json') : '';

  // Mutex em memória para o modo local em disco
  let localWriteChain = Promise.resolve();
  function withLocalWriteLock(fn) {
    const next = localWriteChain.then(fn, fn);
    localWriteChain = next.catch(() => {});
    return next;
  }

  let localQuestionsWriteChain = Promise.resolve();
  function withLocalQuestionsWriteLock(fn) {
    const next = localQuestionsWriteChain.then(fn, fn);
    localQuestionsWriteChain = next.catch(() => {});
    return next;
  }

  function assertStorageReady() {
    if (!useSupabase && isVercel) {
      throw makeConfigError(
        'Armazenamento em nuvem não configurado na Vercel. Defina SUPABASE_URL e SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) nas variáveis de ambiente do projeto.',
        503
      );
    }
  }

  async function ensureDataDir() {
    if (!dataDir) return;
    await fs.mkdir(dataDir, { recursive: true });
  }

  async function writeFileAtomic(filePath, content) {
    await ensureDataDir();
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  async function supabaseRequest(relativePath, { method = 'GET', body = undefined, extraHeaders = {} } = {}) {
    const url = `${cleanUrl}/rest/v1/${relativePath}`;
    const res = await fetchImpl(url, {
      method,
      headers: buildSupabaseHeaders(cleanKey, extraHeaders),
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { ok: res.ok, status: res.status, data: parsed, rawText: text };
  }

  function formatSupabaseError(res, action) {
    const detail = (res.data && (res.data.message || res.data.error || res.data.hint)) || res.rawText || `HTTP ${res.status}`;
    const err = new Error(`Erro no Supabase ao ${action} (${res.status}): ${detail}`);
    err.status = res.status >= 400 && res.status < 500 ? 502 : 503;
    return err;
  }

  async function supabaseReadRow(key) {
    const q = `${encodeURIComponent(cleanTable)}?key=eq.${encodeURIComponent(key)}&select=key,payload,rev,updated_at&limit=1`;
    const res = await supabaseRequest(q, { method: 'GET' });
    if (!res.ok) {
      throw formatSupabaseError(res, `ler ${key}`);
    }
    if (!Array.isArray(res.data) || res.data.length === 0) return null;
    return res.data[0];
  }

  async function supabaseUpsertRow(key, payload, rev = 0, nowIso = new Date().toISOString()) {
    const cleanPayload = stripNullChars(payload);
    const q = `${encodeURIComponent(cleanTable)}?on_conflict=key`;
    const res = await supabaseRequest(q, {
      method: 'POST',
      extraHeaders: {
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: {
        key,
        payload: cleanPayload,
        rev,
        updated_at: nowIso
      }
    });
    if (!res.ok) {
      throw formatSupabaseError(res, `salvar ${key}`);
    }
    return Array.isArray(res.data) ? res.data[0] : res.data;
  }

  async function readState() {
    assertStorageReady();
    if (useSupabase) {
      const row = await supabaseReadRow(STATE_KEY);
      return row && row.payload ? row.payload : null;
    }
    try {
      const raw = await fs.readFile(stateFile, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function syncState(resolverFn, { maxRetries = 4 } = {}) {
    assertStorageReady();

    if (!useSupabase) {
      return withLocalWriteLock(async () => {
        const current = await readState();
        const resolved = resolverFn(current);
        if (!resolved.skippedEmptyClient) {
          await writeFileAtomic(stateFile, JSON.stringify(resolved.state));
        }
        return resolved;
      });
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const row = await supabaseReadRow(STATE_KEY);
      const serverState = row && row.payload ? row.payload : null;
      const expectedRev = row ? Number(row.rev || 0) : null;
      const resolved = resolverFn(serverState);

      if (resolved.skippedEmptyClient) {
        return resolved;
      }

      const nowIso = (resolved.state && resolved.state.meta && resolved.state.meta.updatedAt) || new Date().toISOString();
      const nextRev = Number(resolved.rev) || 1;
      const cleanPayload = stripNullChars(resolved.state);

      if (expectedRev === null) {
        const insertRes = await supabaseRequest(encodeURIComponent(cleanTable), {
          method: 'POST',
          extraHeaders: { Prefer: 'return=representation' },
          body: {
            key: STATE_KEY,
            payload: cleanPayload,
            rev: nextRev,
            updated_at: nowIso
          }
        });
        if (insertRes.ok) {
          return resolved;
        }
        // 409 = outra instância inseriu simultaneamente; tenta novamente fazendo merge
        if (insertRes.status === 409 && attempt < maxRetries) {
          continue;
        }
        throw formatSupabaseError(insertRes, 'inserir estado inicial');
      }

      const patchQuery = `${encodeURIComponent(cleanTable)}?key=eq.${encodeURIComponent(STATE_KEY)}&rev=eq.${expectedRev}`;
      const patchRes = await supabaseRequest(patchQuery, {
        method: 'PATCH',
        extraHeaders: { Prefer: 'return=representation' },
        body: {
          payload: cleanPayload,
          rev: nextRev,
          updated_at: nowIso
        }
      });

      if (!patchRes.ok) {
        throw formatSupabaseError(patchRes, 'atualizar estado');
      }

      // Se o PATCH atualizou a linha esperada, concluímos sem race condition
      if (Array.isArray(patchRes.data) && patchRes.data.length > 0) {
        return resolved;
      }

      // Se 0 linhas foram atualizadas, outro dispositivo avançou o rev no meio do caminho; refaz leitura + merge
      if (attempt < maxRetries) {
        continue;
      }
      throw makeConfigError('Conflito simultâneo ao sincronizar estado no Supabase. Tente novamente.', 409);
    }
  }

  async function saveStateDirect(nextState) {
    return syncState((current) => {
      const nextRev = (Number(current && current.meta && current.meta.rev) || 0) + 1;
      const toSave = {
        ...nextState,
        meta: {
          ...(nextState.meta || {}),
          rev: nextRev,
          updatedAt: new Date().toISOString()
        }
      };
      return { state: toSave, rev: nextRev, merged: false, skippedEmptyClient: false };
    });
  }

  async function loadGeminiSettings({ allowedModels, defaultModel }) {
    const fallback = {
      apiKey: '',
      model: defaultModel,
      autoAutopsyOnError: true
    };
    if (!useSupabase && isVercel) {
      return fallback;
    }
    try {
      let parsed = null;
      if (useSupabase) {
        const row = await supabaseReadRow(SETTINGS_KEY);
        parsed = row && row.payload ? row.payload : null;
      } else {
        const raw = await fs.readFile(settingsFile, 'utf-8');
        parsed = JSON.parse(raw);
      }
      if (!parsed || typeof parsed !== 'object') return fallback;
      return {
        apiKey: parsed.apiKey || '',
        model: allowedModels.includes(parsed.model) ? parsed.model : defaultModel,
        autoAutopsyOnError: parsed.autoAutopsyOnError !== undefined ? Boolean(parsed.autoAutopsyOnError) : true
      };
    } catch {
      return fallback;
    }
  }

  async function saveGeminiSettings(settings, { allowedModels, defaultModel }) {
    assertStorageReady();
    const current = await loadGeminiSettings({ allowedModels, defaultModel });
    const next = {
      apiKey: settings.apiKey !== undefined ? String(settings.apiKey).trim() : current.apiKey,
      model: allowedModels.includes(settings.model) ? settings.model : current.model,
      autoAutopsyOnError: settings.autoAutopsyOnError !== undefined ? Boolean(settings.autoAutopsyOnError) : current.autoAutopsyOnError
    };
    if (useSupabase) {
      await supabaseUpsertRow(SETTINGS_KEY, next, 1, new Date().toISOString());
    } else {
      await writeFileAtomic(settingsFile, JSON.stringify(next, null, 2));
    }
    return next;
  }

  // ---------- BANCO PERMANENTE DE QUESTÕES (painel_questions / data/question-bank.json) ----------
  function isSupabaseMissingTableError(res) {
    if (!res) return false;
    const raw = `${res.rawText || ''} ${(res.data && (res.data.message || res.data.code || res.data.hint)) || ''}`.toLowerCase();
    return (
      res.status === 404 ||
      raw.includes('42p01') ||
      raw.includes('pgrst205') ||
      raw.includes('could not find the table') ||
      (raw.includes('relation') && raw.includes('does not exist'))
    );
  }

  function makeQuestionsTableMissingError() {
    const err = new Error(
      `A tabela "${cleanQuestionsTable}" ainda não existe no Supabase. Execute o SQL atualizado de supabase-schema.sql no SQL Editor do Supabase.`
    );
    err.status = 503;
    err.code = 'QUESTIONS_TABLE_MISSING';
    return err;
  }

  async function readLocalQuestionBank() {
    if (!questionBankFile) return [];
    try {
      const raw = await fs.readFile(questionBankFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed && parsed.questions) ? parsed.questions : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function writeLocalQuestionBank(questions) {
    await writeFileAtomic(questionBankFile, JSON.stringify({
      v: 1,
      updatedAt: new Date().toISOString(),
      questions
    }));
  }

  async function supabaseQueryQuestions(queryParams) {
    const q = `${encodeURIComponent(cleanQuestionsTable)}?${queryParams}`;
    const res = await supabaseRequest(q, { method: 'GET' });
    if (!res.ok) {
      if (isSupabaseMissingTableError(res)) throw makeQuestionsTableMissingError();
      throw formatSupabaseError(res, `consultar ${cleanQuestionsTable}`);
    }
    return Array.isArray(res.data) ? res.data : [];
  }

  async function supabaseListQuestionsByEdital(editalId, { materiaId = null } = {}) {
    const parts = [];
    if (editalId) parts.push(`edital_id=eq.${encodeURIComponent(editalId)}`);
    if (materiaId) parts.push(`materia_id=eq.${encodeURIComponent(materiaId)}`);
    parts.push('select=*');
    parts.push('limit=1000');

    const rows = [];
    let offset = 0;
    while (true) {
      const page = await supabaseQueryQuestions(`${parts.join('&')}&offset=${offset}`);
      rows.push(...page);
      if (page.length < 1000 || rows.length >= 5000) break;
      offset += 1000;
    }
    return rows;
  }

  async function supabaseFetchExistingByFingerprints(fingerprints) {
    const existingMap = new Map();
    const unique = Array.from(new Set(fingerprints.filter(Boolean)));
    const chunkSize = 40;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const inExpr = `(${chunk.map((fp) => `"${String(fp).replace(/"/g, '')}"`).join(',')})`;
      const rows = await supabaseQueryQuestions(`fingerprint=in.${encodeURIComponent(inExpr)}&select=*`);
      rows.forEach((r) => {
        if (r && r.fingerprint) existingMap.set(r.fingerprint, r);
      });
    }
    return existingMap;
  }

  async function supabaseUpsertQuestionRows(rows) {
    const cleanRows = stripNullChars(rows);
    const chunkSize = 80;
    const saved = [];
    for (let i = 0; i < cleanRows.length; i += chunkSize) {
      const chunk = cleanRows.slice(i, i + chunkSize);
      const q = `${encodeURIComponent(cleanQuestionsTable)}?on_conflict=fingerprint`;
      const res = await supabaseRequest(q, {
        method: 'POST',
        extraHeaders: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: chunk
      });
      if (!res.ok) {
        if (isSupabaseMissingTableError(res)) throw makeQuestionsTableMissingError();
        throw formatSupabaseError(res, `salvar em ${cleanQuestionsTable}`);
      }
      if (Array.isArray(res.data)) saved.push(...res.data);
    }
    return saved;
  }

  async function saveQuestionsToBank(items, { defaults = {}, insertOnlyNew = false } = {}) {
    assertStorageReady();
    const nowIso = new Date().toISOString();
    const normalized = [];
    const seenFp = new Set();

    for (const raw of (Array.isArray(items) ? items : [])) {
      const row = normalizeBankQuestionRow(raw, { ...defaults, nowIso });
      if (!row || seenFp.has(row.fingerprint)) continue;
      seenFp.add(row.fingerprint);
      normalized.push(row);
    }

    if (!normalized.length) {
      return { inserted: 0, updated: 0, skipped: 0, total: 0, items: [] };
    }

    if (!useSupabase) {
      return withLocalQuestionsWriteLock(async () => {
        const current = await readLocalQuestionBank();
        const byFp = new Map(current.map((r) => [r.fingerprint, r]));
        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        const resultItems = [];

        for (const row of normalized) {
          const prev = byFp.get(row.fingerprint);
          if (!prev) {
            byFp.set(row.fingerprint, row);
            inserted += 1;
            resultItems.push(row);
          } else if (insertOnlyNew) {
            skipped += 1;
            resultItems.push(prev);
          } else {
            const merged = {
              ...prev,
              materia_id: row.materia_id || prev.materia_id,
              materia_nome: row.materia_nome || prev.materia_nome,
              assunto_id: row.assunto_id || prev.assunto_id,
              assunto_nome: row.assunto_nome || prev.assunto_nome,
              banca: row.banca || prev.banca,
              nivel: row.nivel || prev.nivel,
              conceito_chave: row.conceito_chave || prev.conceito_chave,
              resolucao_passo_a_passo: row.resolucao_passo_a_passo.length > (prev.resolucao_passo_a_passo || '').length
                ? row.resolucao_passo_a_passo
                : (prev.resolucao_passo_a_passo || ''),
              comentario_professor: row.comentario_professor.length > (prev.comentario_professor || '').length
                ? row.comentario_professor
                : (prev.comentario_professor || ''),
              auditada_pela_ia: Boolean(prev.auditada_pela_ia || row.auditada_pela_ia),
              updated_at: nowIso
            };
            byFp.set(row.fingerprint, merged);
            updated += 1;
            resultItems.push(merged);
          }
        }

        if (inserted > 0 || updated > 0) {
          await writeLocalQuestionBank(Array.from(byFp.values()));
        }
        return { inserted, updated, skipped, total: resultItems.length, items: resultItems };
      });
    }

    const existingMap = await supabaseFetchExistingByFingerprints(normalized.map((r) => r.fingerprint));
    const toWrite = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const resultItems = [];

    for (const row of normalized) {
      const prev = existingMap.get(row.fingerprint);
      if (!prev) {
        toWrite.push(row);
        inserted += 1;
        resultItems.push(row);
      } else if (insertOnlyNew) {
        skipped += 1;
        resultItems.push(prev);
      } else {
        const merged = {
          ...prev,
          materia_id: row.materia_id || prev.materia_id,
          materia_nome: row.materia_nome || prev.materia_nome,
          assunto_id: row.assunto_id || prev.assunto_id,
          assunto_nome: row.assunto_nome || prev.assunto_nome,
          banca: row.banca || prev.banca,
          nivel: row.nivel || prev.nivel,
          conceito_chave: row.conceito_chave || prev.conceito_chave,
          resolucao_passo_a_passo: row.resolucao_passo_a_passo.length > (prev.resolucao_passo_a_passo || '').length
            ? row.resolucao_passo_a_passo
            : (prev.resolucao_passo_a_passo || ''),
          comentario_professor: row.comentario_professor.length > (prev.comentario_professor || '').length
            ? row.comentario_professor
            : (prev.comentario_professor || ''),
          auditada_pela_ia: Boolean(prev.auditada_pela_ia || row.auditada_pela_ia),
          updated_at: nowIso
        };
        toWrite.push(merged);
        updated += 1;
        resultItems.push(merged);
      }
    }

    if (toWrite.length > 0) {
      await supabaseUpsertQuestionRows(toWrite);
    }

    return { inserted, updated, skipped, total: resultItems.length, items: resultItems };
  }

  async function recordQuestionAttempts(attempts, { defaults = {} } = {}) {
    assertStorageReady();
    const list = Array.isArray(attempts) ? attempts.filter(Boolean) : [];
    if (!list.length) return { updated: 0, inserted: 0 };

    const nowIso = new Date().toISOString();
    const resolveOutcome = (att) => {
      const r = String(att.result || '').toLowerCase();
      if (r === 'hit' || r === 'doubt_hit' || r === 'chute' || r === 'error') return r;
      if (att.acertou) {
        if (att.confidence === 'chute') return 'chute';
        if (att.confidence === 'duvida') return 'doubt_hit';
        return 'hit';
      }
      return 'error';
    };

    const applyOutcomeToRow = (row, outcome, answeredAt) => {
      const isCorrect = outcome === 'hit' || outcome === 'doubt_hit';
      return {
        ...row,
        times_answered: (Number(row.times_answered) || 0) + 1,
        times_correct: (Number(row.times_correct) || 0) + (isCorrect ? 1 : 0),
        times_wrong: (Number(row.times_wrong) || 0) + (isCorrect ? 0 : 1),
        last_result: outcome,
        last_answered_at: answeredAt || nowIso,
        updated_at: nowIso
      };
    };

    if (!useSupabase) {
      return withLocalQuestionsWriteLock(async () => {
        const current = await readLocalQuestionBank();
        const byId = new Map(current.map((r) => [r.id, r]));
        const byFp = new Map(current.map((r) => [r.fingerprint, r]));
        let updated = 0;
        let inserted = 0;

        for (const att of list) {
          const outcome = resolveOutcome(att);
          const answeredAt = att.answeredAt || nowIso;
          const editalId = att.editalId || defaults.editalId || 'default';
          const fp = att.fingerprint || (att.enunciado ? computeQuestionFingerprint({ editalId, enunciado: att.enunciado }) : '');
          const existing = (att.bankQuestionId && byId.get(att.bankQuestionId)) || (fp && byFp.get(fp)) || null;

          if (existing) {
            const nextRow = applyOutcomeToRow(existing, outcome, answeredAt);
            byId.set(nextRow.id, nextRow);
            byFp.set(nextRow.fingerprint, nextRow);
            updated += 1;
          } else if (att.enunciado && Array.isArray(att.alternativas) && att.alternativas.length >= 2) {
            const created = normalizeBankQuestionRow(att, { ...defaults, editalId, nowIso });
            if (created) {
              const nextRow = applyOutcomeToRow(created, outcome, answeredAt);
              byId.set(nextRow.id, nextRow);
              byFp.set(nextRow.fingerprint, nextRow);
              inserted += 1;
            }
          }
        }

        if (updated > 0 || inserted > 0) {
          await writeLocalQuestionBank(Array.from(byFp.values()));
        }
        return { updated, inserted };
      });
    }

    const fingerprints = [];
    const prepared = list.map((att) => {
      const editalId = att.editalId || defaults.editalId || 'default';
      const fp = att.fingerprint || (att.enunciado ? computeQuestionFingerprint({ editalId, enunciado: att.enunciado }) : '');
      if (fp) fingerprints.push(fp);
      return { att, editalId, fp, outcome: resolveOutcome(att), answeredAt: att.answeredAt || nowIso };
    });

    const existingByFp = await supabaseFetchExistingByFingerprints(fingerprints);
    // Caso algum item só tenha bankQuestionId (sem fingerprint), busca por id
    const missingIds = prepared
      .filter((p) => !p.fp && p.att.bankQuestionId)
      .map((p) => p.att.bankQuestionId);
    const existingById = new Map();
    if (missingIds.length) {
      const inExpr = `(${missingIds.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',')})`;
      const byIdRows = await supabaseQueryQuestions(`id=in.${encodeURIComponent(inExpr)}&select=*`);
      byIdRows.forEach((r) => {
        if (r && r.id) existingById.set(r.id, r);
        if (r && r.fingerprint) existingByFp.set(r.fingerprint, r);
      });
    }

    const toUpsertByFp = new Map();
    let updated = 0;
    let inserted = 0;

    for (const p of prepared) {
      const existing = (p.fp && (toUpsertByFp.get(p.fp) || existingByFp.get(p.fp)))
        || (p.att.bankQuestionId && existingById.get(p.att.bankQuestionId))
        || null;
      if (existing) {
        const nextRow = applyOutcomeToRow(existing, p.outcome, p.answeredAt);
        toUpsertByFp.set(nextRow.fingerprint, nextRow);
        updated += 1;
      } else if (p.att.enunciado && Array.isArray(p.att.alternativas) && p.att.alternativas.length >= 2) {
        const created = normalizeBankQuestionRow(p.att, { ...defaults, editalId: p.editalId, nowIso });
        if (created) {
          const nextRow = applyOutcomeToRow(created, p.outcome, p.answeredAt);
          toUpsertByFp.set(nextRow.fingerprint, nextRow);
          inserted += 1;
        }
      }
    }

    const toWrite = Array.from(toUpsertByFp.values());
    if (toWrite.length > 0) {
      await supabaseUpsertQuestionRows(toWrite);
    }

    return { updated, inserted };
  }

  async function listQuestionsForEdital(editalId, { materiaId = null } = {}) {
    assertStorageReady();
    if (useSupabase) {
      return supabaseListQuestionsByEdital(editalId, { materiaId });
    }
    const all = await readLocalQuestionBank();
    return all.filter((r) => {
      if (editalId && r.edital_id !== editalId) return false;
      if (materiaId && r.materia_id !== materiaId) return false;
      return true;
    });
  }

  async function getQuestionBankStats({ editalId, materiaId = null, assuntoIds = [] } = {}) {
    const rows = await listQuestionsForEdital(editalId);
    return computeQuestionBankStats(rows, { editalId, materiaId, assuntoIds });
  }

  async function queryQuestionBank(options = {}) {
    const { editalId, materiaId = null } = options;
    const rows = await listQuestionsForEdital(editalId, {
      materiaId: options.expandToMateria || materiaId ? materiaId : null
    });
    return selectQuestionsFromBank(rows, options);
  }

  async function backfillQuestionsFromState(panelState = null) {
    assertStorageReady();
    const stateObj = panelState || await readState();
    if (!stateObj) {
      return { extracted: 0, inserted: 0, updated: 0, skipped: 0 };
    }
    const extracted = extractBackfillQuestionsFromState(stateObj);
    if (!extracted.length) {
      return { extracted: 0, inserted: 0, updated: 0, skipped: 0 };
    }
    const res = await saveQuestionsToBank(extracted, { insertOnlyNew: true });
    return {
      extracted: extracted.length,
      inserted: res.inserted,
      updated: res.updated,
      skipped: res.skipped
    };
  }

  return {
    backend,
    useSupabase,
    isConfigured: useSupabase || !isVercel,
    tableName: cleanTable,
    questionsTableName: cleanQuestionsTable,
    readState,
    syncState,
    saveStateDirect,
    loadGeminiSettings,
    saveGeminiSettings,
    saveQuestionsToBank,
    recordQuestionAttempts,
    listQuestionsForEdital,
    getQuestionBankStats,
    queryQuestionBank,
    backfillQuestionsFromState
  };
}
