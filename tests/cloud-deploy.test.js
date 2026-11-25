import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuthHelper, SESSION_COOKIE_NAME } from '../shared/auth.js';
import { createStorageAdapter, buildSupabaseHeaders, stripNullChars, isJwtKey } from '../shared/storage.js';

function invokeExpressApp(app, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const fakeSocket = new Duplex({
      read() {},
      write(_chunk, _encoding, cb) { cb(); }
    });
    fakeSocket.remoteAddress = '127.0.0.1';
    fakeSocket.encrypted = false;

    const req = new http.IncomingMessage(fakeSocket);
    req.method = method;
    req.url = url;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    const bodyBuf = body === null || body === undefined
      ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8'));
    if (bodyBuf && !req.headers['content-length']) {
      req.headers['content-length'] = String(bodyBuf.length);
    }

    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (chunk, encoding, cb) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf-8'));
      }
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = null;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf-8'));
      }
      if (typeof cb === 'function') cb();
      res.emit('finish');
      return res;
    };

    res.on('finish', () => {
      const finalBuf = Buffer.concat(chunks);
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        buffer: finalBuf,
        json() { return JSON.parse(finalBuf.toString('utf-8')); }
      });
    });
    res.on('error', reject);

    app(req, res);

    setImmediate(() => {
      if (bodyBuf) req.push(bodyBuf);
      req.push(null);
    });
  });
}

test('auth: desabilitado localmente sem APP_PASSWORD e bloqueado (fail-closed) na Vercel sem APP_PASSWORD', () => {
  const localAuth = createAuthHelper({ appPassword: '', isVercel: false });
  assert.equal(localAuth.authRequired, false);
  assert.equal(localAuth.getStatus({ headers: {} }).authenticated, true);

  const vercelAuth = createAuthHelper({ appPassword: '', isVercel: true });
  assert.equal(vercelAuth.authRequired, true);
  assert.ok(vercelAuth.misconfigured);
  assert.equal(vercelAuth.getStatus({ headers: {} }).authenticated, false);
});

test('auth: verifica senha, emite cookie HttpOnly assinado e rejeita cookie adulterado', () => {
  const auth = createAuthHelper({ appPassword: 'minha-senha-secreta', isVercel: true });
  assert.equal(auth.verifyPassword('errada'), false);
  assert.equal(auth.verifyPassword('minha-senha-secreta'), true);

  const headers = {};
  const fakeRes = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; }
  };
  auth.issueSessionCookie({ secure: true, headers: {} }, fakeRes);
  const setCookie = headers['set-cookie'];
  assert.ok(setCookie.includes(`${SESSION_COOKIE_NAME}=`));
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('SameSite=Lax'));
  assert.ok(setCookie.includes('Secure'));

  const cookiePair = setCookie.split(';')[0];
  assert.equal(auth.isAuthenticated({ headers: { cookie: cookiePair } }), true);
  assert.equal(auth.isAuthenticated({ headers: { cookie: cookiePair + 'tampered' } }), false);
  assert.equal(auth.isAuthenticated({ headers: {} }), false);
});

test('storage: monta headers corretos para chave sb_secret_ (sem Bearer) e chave legada service_role JWT (com Bearer)', () => {
  const secretKey = 'sb_secret_abc123xyz';
  assert.equal(isJwtKey(secretKey), false);
  const secretHeaders = buildSupabaseHeaders(secretKey);
  assert.equal(secretHeaders.apikey, secretKey);
  assert.equal(secretHeaders.Authorization, undefined);

  const legacyJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature';
  assert.equal(isJwtKey(legacyJwt), true);
  const legacyHeaders = buildSupabaseHeaders(legacyJwt);
  assert.equal(legacyHeaders.apikey, legacyJwt);
  assert.equal(legacyHeaders.Authorization, `Bearer ${legacyJwt}`);
});

test('storage: stripNullChars remove bytes nulos para compatibilidade com Postgres jsonb', () => {
  const cleaned = stripNullChars({
    texto: 'abc\u0000def',
    nested: [{ item: 'x\u0000y' }]
  });
  assert.equal(cleaned.texto, 'abcdef');
  assert.equal(cleaned.nested[0].item, 'xy');
});

test('storage: Supabase syncState trata concorrência otimista (retry quando outro dispositivo avança rev)', async () => {
  let dbRow = {
    key: 'painel_state',
    rev: 5,
    payload: { v: 2, meta: { rev: 5 }, value: 'inicial' }
  };
  let patchCalls = 0;

  const mockFetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(dbRow ? [dbRow] : [])
      };
    }
    if (method === 'PATCH') {
      patchCalls += 1;
      // Na primeira tentativa, simula outro dispositivo avançando rev de 5 para 6 no meio da requisição
      if (patchCalls === 1) {
        dbRow = { key: 'painel_state', rev: 6, payload: { v: 2, meta: { rev: 6 }, value: 'outro-dispositivo' } };
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      const body = JSON.parse(opts.body);
      assert.ok(url.includes('rev=eq.6'));
      dbRow = { key: 'painel_state', rev: body.rev, payload: body.payload };
      return { ok: true, status: 200, text: async () => JSON.stringify([dbRow]) };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };

  const storage = createStorageAdapter({
    supabaseUrl: 'https://demo.supabase.co',
    supabaseKey: 'sb_secret_test',
    fetchImpl: mockFetch
  });

  const resolved = await storage.syncState((serverState) => {
    const nextRev = (serverState?.meta?.rev || 0) + 1;
    return {
      state: { ...serverState, mergedFromTest: true, meta: { rev: nextRev, updatedAt: '2026-11-23T13:00:00.000Z' } },
      rev: nextRev,
      merged: true,
      skippedEmptyClient: false
    };
  });

  assert.equal(patchCalls, 2);
  assert.equal(resolved.rev, 7);
  assert.equal(dbRow.rev, 7);
  assert.equal(dbRow.payload.value, 'outro-dispositivo');
  assert.equal(dbRow.payload.mergedFromTest, true);
});

test('storage: modo local na Vercel sem Supabase lança erro claro 503', async () => {
  const storage = createStorageAdapter({
    dataDir: '/tmp/unused',
    supabaseUrl: '',
    supabaseKey: '',
    isVercel: true
  });
  assert.equal(storage.isConfigured, false);
  await assert.rejects(() => storage.readState(), (err) => err.status === 503 && /SUPABASE_URL/.test(err.message));
});

test('server.js: fluxo completo com senha + compressão gzip-json no /api/state/sync e /api/state', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'painel-test-'));
  const prevEnv = {
    DATA_DIR: process.env.DATA_DIR,
    APP_PASSWORD: process.env.APP_PASSWORD,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_KEY: process.env.SUPABASE_KEY
  };

  process.env.DATA_DIR = tmpDir;
  process.env.APP_PASSWORD = 'senha-teste-123';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SECRET_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.SUPABASE_KEY = '';

  // Import com query string única para instanciar o app com as env vars de teste
  const { default: app } = await import(`../server.js?test=${Date.now()}`);

  try {
    // 1. Sem cookie, /api/state bloqueia com 401
    const unauthRes = await invokeExpressApp(app, { method: 'GET', url: '/api/state' });
    assert.equal(unauthRes.status, 401);

    // 2. /api/auth/status informa que precisa login
    const statusRes = await invokeExpressApp(app, { method: 'GET', url: '/api/auth/status' });
    const statusBefore = statusRes.json();
    assert.equal(statusBefore.authRequired, true);
    assert.equal(statusBefore.authenticated, false);

    // 3. Login com senha errada retorna 401
    const badLogin = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'errada' })
    });
    assert.equal(badLogin.status, 401);

    // 4. Login com senha certa emite cookie
    const goodLogin = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'senha-teste-123' })
    });
    assert.equal(goodLogin.status, 200);
    const setCookieHeader = Array.isArray(goodLogin.headers['set-cookie'])
      ? goodLogin.headers['set-cookie'][0]
      : goodLogin.headers['set-cookie'];
    const cookieHeader = setCookieHeader.split(';')[0];

    // 5. Envia /api/state/sync comprimido em gzip-json e recebe resposta comprimida em gzip-json
    const sampleState = {
      v: 2,
      editais: [{ id: 'ed1', nome: 'TJPB' }],
      activeEdital: 'ed1',
      bank: {
        ed1: {
          materias: [{ id: 'm1', nome: 'Direito Constitucional' }],
          assuntos: [],
          schedule: [],
          log: [],
          fired: {},
          offlinePacks: [],
          subtopicMastery: {},
          reviewConcepts: [],
          cadernoAssuntos: {},
          flashcardRatings: {}
        }
      },
      ui: {},
      meta: { rev: 0 }
    };
    const gzReqBody = zlib.gzipSync(Buffer.from(JSON.stringify({
      state: sampleState,
      hasOfflineChanges: false,
      baseRev: null
    }), 'utf-8'));

    const syncRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/state/sync',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/octet-stream',
        'X-Payload-Format': 'gzip-json',
        'X-Accept-Payload': 'gzip-json'
      },
      body: gzReqBody
    });
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.headers['x-payload-format'], 'gzip-json');
    const syncJson = JSON.parse(zlib.gunzipSync(syncRes.buffer).toString('utf-8'));
    assert.equal(syncJson.ok, true);
    assert.equal(syncJson.rev, 1);
    assert.equal(syncJson.state.bank.ed1.materias[0].nome, 'Direito Constitucional');

    // 6. GET /api/state comprimido devolve o mesmo estado salvo
    const getRes = await invokeExpressApp(app, {
      method: 'GET',
      url: '/api/state',
      headers: {
        Cookie: cookieHeader,
        'X-Accept-Payload': 'gzip-json'
      }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers['x-payload-format'], 'gzip-json');
    const getJson = JSON.parse(zlib.gunzipSync(getRes.buffer).toString('utf-8'));
    assert.equal(getJson.ok, true);
    assert.equal(getJson.rev, 1);

    // 7. Logout limpa sessão
    const logoutRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: { Cookie: cookieHeader }
    });
    assert.equal(logoutRes.status, 200);
    const logoutCookie = Array.isArray(logoutRes.headers['set-cookie'])
      ? logoutRes.headers['set-cookie'][0]
      : logoutRes.headers['set-cookie'];
    assert.ok(logoutCookie.includes('Max-Age=0'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('runGeminiInteraction: nunca faz fallback automático para gemini-4-argon e preserva erro real do modelo selecionado', async () => {
  const { runGeminiInteraction } = await import(`../server.js?gemini-fallback=${Date.now()}`);
  const calledModels = [];
  const fakeClient = {
    interactions: {
      async create({ model }) {
        calledModels.push(model);
        const err = new Error(`429 Rate limit exceeded for model ${model} (limit: 0 input tokens per minute on Free Tier).`);
        err.status = 429;
        throw err;
      }
    }
  };

  await assert.rejects(
    () => runGeminiInteraction(fakeClient, { model: 'gemini-3.5-flash-lite', input: 'ping' }),
    (err) => {
      assert.equal(err.status, 429);
      assert.ok(err.message.includes('gemini-3.5-flash-lite'), `Erro deveria mencionar modelo selecionado: ${err.message}`);
      assert.ok(!err.message.includes('gemini-4-argon'), `Erro não deveria mencionar gemini-4-argon: ${err.message}`);
      return true;
    }
  );

  assert.equal(calledModels.includes('gemini-4-argon'), false);
  // Com limit: 0, não desperdiça retry duplicado no mesmo modelo
  assert.equal(calledModels.filter((m) => m === 'gemini-3.5-flash-lite').length, 1);
  assert.ok(calledModels.includes('gemini-4-hydrogen'));
});

test('runGeminiInteraction: faz fallback automático para outro modelo Free Tier quando o principal está em 429', async () => {
  const { runGeminiInteraction } = await import(`../server.js?gemini-ok=${Date.now()}`);
  const fakeClient = {
    interactions: {
      async create({ model }) {
        if (model === 'gemini-4-hydrogen') {
          return { id: 'inter-1', output_text: 'Conectado!' };
        }
        const err = new Error(`429 Rate limit exceeded for model ${model} (limit: 0 input tokens per minute on Free Tier).`);
        err.status = 429;
        throw err;
      }
    }
  };

  const result = await runGeminiInteraction(fakeClient, { model: 'gemini-3.8-flash', input: 'ping' });
  assert.equal(result.usedModel, 'gemini-4-hydrogen');
  assert.equal(result.text, 'Conectado!');
});
