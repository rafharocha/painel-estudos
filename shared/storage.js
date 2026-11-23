import fs from 'fs/promises';
import path from 'path';

export const STATE_KEY = 'painel_state';
export const SETTINGS_KEY = 'gemini_settings';
export const DEFAULT_SUPABASE_TABLE = 'painel_store';

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
  isVercel = Boolean(process.env.VERCEL),
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanUrl = String(supabaseUrl || '').trim().replace(/\/+$/, '');
  const cleanKey = String(supabaseKey || '').trim();
  const cleanTable = String(tableName || DEFAULT_SUPABASE_TABLE).trim() || DEFAULT_SUPABASE_TABLE;
  const useSupabase = Boolean(cleanUrl && cleanKey);
  const backend = useSupabase ? 'supabase' : 'local';

  const stateFile = dataDir ? path.join(dataDir, 'painel-data.json') : '';
  const settingsFile = dataDir ? path.join(dataDir, 'gemini-settings.json') : '';

  // Mutex em memória para o modo local em disco
  let localWriteChain = Promise.resolve();
  function withLocalWriteLock(fn) {
    const next = localWriteChain.then(fn, fn);
    localWriteChain = next.catch(() => {});
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

  return {
    backend,
    useSupabase,
    isConfigured: useSupabase || !isVercel,
    tableName: cleanTable,
    readState,
    syncState,
    saveStateDirect,
    loadGeminiSettings,
    saveGeminiSettings
  };
}
