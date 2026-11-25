import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  computeQuestionFingerprint,
  shuffleQuestionAlternatives,
  canSafelyShuffleAlternatives,
  selectQuestionsFromBank,
  extractBackfillQuestionsFromState,
  normalizeBankQuestionRow
} from '../shared/question-bank.js';
import { createStorageAdapter } from '../shared/storage.js';

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

test('question-bank: fingerprint ignora acentos, caixa e pontuação extra, mas isola editais', () => {
  const fp1 = computeQuestionFingerprint({
    editalId: 'ed1',
    enunciado: 'Qual é a diferença entre **autoexecutoriedade** e exigibilidade?'
  });
  const fp2 = computeQuestionFingerprint({
    editalId: 'ed1',
    enunciado: 'qual e a diferenca entre autoexecutoriedade e exigibilidade'
  });
  const fpOtherEdital = computeQuestionFingerprint({
    editalId: 'ed2',
    enunciado: 'qual e a diferenca entre autoexecutoriedade e exigibilidade'
  });

  assert.ok(fp1.length === 32);
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, fpOtherEdital);
});

test('question-bank: shuffleQuestionAlternatives mantém gabarito apontando para o mesmo texto e pula referências a letras / Certo-Errado', () => {
  const mcQuestion = {
    formato: 'multipla_escolha',
    enunciado: 'Qual estrutura de dados usa política LIFO?',
    alternativas: [
      { letra: 'A', texto: 'Fila (Queue)' },
      { letra: 'B', texto: 'Pilha (Stack)' },
      { letra: 'C', texto: 'Grafo' },
      { letra: 'D', texto: 'Árvore B+' },
      { letra: 'E', texto: 'Tabela Hash' }
    ],
    correta: 'B'
  };

  // RNG determinístico que garante mudança de posição
  let step = 0;
  const rng = () => {
    const vals = [0.1, 0.7, 0.3, 0.9];
    return vals[step++ % vals.length];
  };

  const shuffled = shuffleQuestionAlternatives(mcQuestion, rng);
  assert.equal(shuffled.alternativasEmbaralhadas, true);
  assert.deepEqual(shuffled.alternativas.map((a) => a.letra), ['A', 'B', 'C', 'D', 'E']);
  const correctAlt = shuffled.alternativas.find((a) => a.letra === shuffled.correta);
  assert.equal(correctAlt.texto, 'Pilha (Stack)');

  // Referência a outra letra NÃO deve ser embaralhada
  const refQuestion = {
    ...mcQuestion,
    alternativas: [
      { letra: 'A', texto: 'Apenas I' },
      { letra: 'B', texto: 'Apenas II' },
      { letra: 'C', texto: 'As alternativas A e B estão corretas' },
      { letra: 'D', texto: 'Nenhuma das anteriores' }
    ],
    correta: 'C'
  };
  assert.equal(canSafelyShuffleAlternatives(refQuestion), false);
  const notShuffled = shuffleQuestionAlternatives(refQuestion, rng);
  assert.equal(notShuffled.alternativasEmbaralhadas, false);
  assert.equal(notShuffled.correta, 'C');

  // Certo/Errado NÃO deve ser embaralhado
  const ceQuestion = {
    formato: 'certo_errado',
    enunciado: 'O protocolo TCP é orientado a conexão.',
    alternativas: [
      { letra: 'C', texto: 'Certo' },
      { letra: 'E', texto: 'Errado' }
    ],
    correta: 'C'
  };
  assert.equal(canSafelyShuffleAlternatives(ceQuestion), false);
});

test('question-bank: selectQuestionsFromBank prioriza smart (nunca respondidas -> erros -> dúvidas -> acertos antigos) e expande para matéria', () => {
  const makeRow = (id, overrides = {}) => normalizeBankQuestionRow({
    id,
    edital_id: 'ed1',
    materia_id: 'm1',
    materia_nome: 'Banco de Dados',
    assunto_id: 'a1',
    assunto_nome: 'Normalização',
    enunciado: `Enunciado único da questão ${id}`,
    alternativas: [
      { letra: 'A', texto: 'Opção 1' },
      { letra: 'B', texto: 'Opção 2' },
      { letra: 'C', texto: 'Opção 3' }
    ],
    correta: 'A',
    ...overrides
  });

  const rows = [
    makeRow('q_hit_new', { times_answered: 2, times_correct: 2, last_result: 'hit', last_answered_at: '2026-11-24T10:00:00.000Z' }),
    makeRow('q_hit_old', { times_answered: 1, times_correct: 1, last_result: 'hit', last_answered_at: '2026-11-10T10:00:00.000Z' }),
    makeRow('q_err_old', { times_answered: 1, times_wrong: 1, last_result: 'error', last_answered_at: '2026-11-12T10:00:00.000Z' }),
    makeRow('q_never', { times_answered: 0, last_result: null, last_answered_at: null }),
    makeRow('q_doubt', { times_answered: 1, times_correct: 1, last_result: 'doubt_hit', last_answered_at: '2026-11-15T10:00:00.000Z' }),
    makeRow('q_other_sub', { assunto_id: 'a2', assunto_nome: 'Índices', times_answered: 1, times_wrong: 1, last_result: 'error', last_answered_at: '2026-11-01T10:00:00.000Z' })
  ];

  // Modo smart sem expandir: respeita ordem q_never -> q_err_old -> q_doubt -> q_hit_old -> q_hit_new
  const smartRes = selectQuestionsFromBank(rows, {
    editalId: 'ed1',
    materiaId: 'm1',
    assuntoIds: ['a1'],
    mode: 'smart',
    limit: 5,
    expandToMateria: false,
    shuffleAlternatives: false
  });
  assert.deepEqual(
    smartRes.questions.map((q) => q.bankQuestionId),
    ['q_never', 'q_err_old', 'q_doubt', 'q_hit_old', 'q_hit_new']
  );
  assert.equal(smartRes.meta.expandedToMateria, false);

  // Modo errors_first com expansão para a matéria: pega q_err_old (a1) + q_other_sub (a2)
  const errExpand = selectQuestionsFromBank(rows, {
    editalId: 'ed1',
    materiaId: 'm1',
    assuntoIds: ['a1'],
    mode: 'errors_first',
    limit: 5,
    expandToMateria: true,
    shuffleAlternatives: false
  });
  assert.deepEqual(errExpand.questions.map((q) => q.bankQuestionId), ['q_err_old', 'q_other_sub']);
  assert.equal(errExpand.meta.fromSubtopics, 1);
  assert.equal(errExpand.meta.fromMateria, 1);
  assert.equal(errExpand.meta.expandedToMateria, true);
});

test('question-bank: extractBackfillQuestionsFromState importa erros estruturados, texto colado e deduplica corretamente', () => {
  const sampleState = {
    v: 2,
    editais: [{ id: 'ed1', nome: 'TJPB' }],
    activeEdital: 'ed1',
    bank: {
      ed1: {
        materias: [{ id: 'm1', nome: 'Engenharia de Software' }],
        assuntos: [{ id: 'a1', materiaId: 'm1', nome: 'Scrum' }],
        log: [
          {
            id: 'l1',
            date: '2026-11-01T10:00:00.000Z',
            materiaId: 'm1',
            assuntoId: 'a1',
            banca: 'FGV',
            errors: [
              {
                enunciado: 'No Scrum, quem prioriza o Product Backlog?',
                alternativas: [
                  { letra: 'A', texto: 'Scrum Master' },
                  { letra: 'B', texto: 'Product Owner' },
                  { letra: 'C', texto: 'Stakeholders' }
                ],
                correta: 'B',
                comentario: 'O Product Owner é o único responsável.',
                srsHistory: [{ date: '2026-11-05T10:00:00.000Z', acertou: true }]
              },
              {
                texto: 'Sobre Kanban, assinale a correta:\nA) Proíbe limitar WIP\nB) Limita o trabalho em progresso (WIP)\nC) Exige sprints fixas',
                correta: 'B'
              },
              {
                // Sem enunciado jogável (só link): deve ser ignorado
                link: 'https://questoes.exemplo/123',
                correta: 'A',
                texto: ''
              }
            ]
          },
          {
            id: 'l2',
            date: '2026-11-10T10:00:00.000Z',
            materiaId: 'm1',
            assuntoId: 'a1',
            banca: 'FGV',
            errors: [
              {
                // Mesma questão da sessão 1: deve acumular sem duplicar
                enunciado: 'No Scrum, quem prioriza o Product Backlog?',
                alternativas: [
                  { letra: 'A', texto: 'Scrum Master' },
                  { letra: 'B', texto: 'Product Owner' },
                  { letra: 'C', texto: 'Stakeholders' }
                ],
                correta: 'B',
                confidence: 'chute'
              }
            ]
          }
        ]
      }
    }
  };

  const extracted = extractBackfillQuestionsFromState(sampleState);
  assert.equal(extracted.length, 2);

  const scrumQ = extracted.find((q) => q.enunciado.includes('Product Backlog'));
  assert.ok(scrumQ);
  assert.equal(scrumQ.times_answered, 3); // 1 erro + 1 revisão SRS acerto + 1 chute
  assert.equal(scrumQ.times_correct, 1);
  assert.equal(scrumQ.times_wrong, 2);
  assert.equal(scrumQ.last_result, 'chute');

  const kanbanQ = extracted.find((q) => q.enunciado.includes('Kanban'));
  assert.ok(kanbanQ);
  assert.equal(kanbanQ.alternativas.length, 3);
  assert.equal(kanbanQ.correta, 'B');
});

test('storage: persistência local em data/question-bank.json (save, recordAttempts, stats, draw, backfill idempotente)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'painel-qbank-'));
  try {
    const storage = createStorageAdapter({ dataDir: tmpDir, supabaseUrl: '', supabaseKey: '', isVercel: false });

    const saveRes = await storage.saveQuestionsToBank([
      {
        editalId: 'ed1',
        materiaId: 'm1',
        materiaNome: 'Redes',
        assuntoId: 'a1',
        assuntoNome: 'TCP/IP',
        nivel: 'N2',
        enunciado: 'Qual porta padrão o HTTPS utiliza?',
        alternativas: [
          { letra: 'A', texto: '80' },
          { letra: 'B', texto: '443' },
          { letra: 'C', texto: '22' }
        ],
        correta: 'B',
        comentarioProfessor: 'HTTPS usa TCP/443.'
      }
    ]);

    assert.equal(saveRes.inserted, 1);
    assert.equal(saveRes.items.length, 1);
    const savedId = saveRes.items[0].id;

    // Registrar 1 tentativa de acerto + 1 questão nova via attempts
    const attRes = await storage.recordQuestionAttempts([
      { bankQuestionId: savedId, editalId: 'ed1', result: 'hit', answeredAt: '2026-11-24T12:00:00.000Z' },
      {
        editalId: 'ed1',
        materiaId: 'm1',
        materiaNome: 'Redes',
        assuntoId: 'a1',
        assuntoNome: 'TCP/IP',
        nivel: 'N3',
        enunciado: 'Qual protocolo traduz nomes de domínio em IPs?',
        alternativas: [
          { letra: 'A', texto: 'ARP' },
          { letra: 'B', texto: 'DNS' },
          { letra: 'C', texto: 'ICMP' }
        ],
        correta: 'B',
        result: 'error',
        answeredAt: '2026-11-24T12:05:00.000Z'
      }
    ]);
    assert.equal(attRes.updated, 1);
    assert.equal(attRes.inserted, 1);

    const stats = await storage.getQuestionBankStats({ editalId: 'ed1', materiaId: 'm1', assuntoIds: ['a1'] });
    assert.equal(stats.totalSubtopics, 2);
    assert.equal(stats.errorsSubtopics, 1);

    const drawn = await storage.queryQuestionBank({
      editalId: 'ed1',
      materiaId: 'm1',
      assuntoIds: ['a1'],
      mode: 'smart',
      limit: 2,
      shuffleAlternatives: false
    });
    assert.equal(drawn.questions.length, 2);
    // Questão errada vem antes da acertada no modo smart
    assert.ok(drawn.questions[0].enunciado.includes('nomes de domínio'));
    assert.equal(drawn.questions[0].lastResult, 'error');
    assert.equal(drawn.questions[1].lastResult, 'hit');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('storage: Supabase detecta tabela painel_questions ausente graciosamente (QUESTIONS_TABLE_MISSING)', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.painel_questions' in the schema cache" })
  });

  const storage = createStorageAdapter({
    supabaseUrl: 'https://demo.supabase.co',
    supabaseKey: 'sb_secret_test',
    fetchImpl: mockFetch
  });

  await assert.rejects(
    () => storage.getQuestionBankStats({ editalId: 'ed1' }),
    (err) => err.code === 'QUESTIONS_TABLE_MISSING' && err.status === 503
  );
});

test('server.js: endpoints HTTP /api/questions/{backfill,stats,draw,attempts} funcionam ponta a ponta', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'painel-api-qbank-'));
  const prevEnv = {
    DATA_DIR: process.env.DATA_DIR,
    APP_PASSWORD: process.env.APP_PASSWORD,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_KEY: process.env.SUPABASE_KEY
  };

  process.env.DATA_DIR = tmpDir;
  process.env.APP_PASSWORD = '';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SECRET_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.SUPABASE_KEY = '';

  const { default: app } = await import(`../server.js?qbank=${Date.now()}`);

  try {
    // 1. Backfill a partir de um estado enviado no body
    const bfRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/questions/backfill',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: {
          v: 2,
          editais: [{ id: 'ed1', nome: 'TJPB' }],
          bank: {
            ed1: {
              materias: [{ id: 'm1', nome: 'Direito Administrativo' }],
              assuntos: [{ id: 'a1', materiaId: 'm1', nome: 'Atos Administrativos' }],
              log: [{
                id: 'l1',
                date: '2026-11-20T10:00:00.000Z',
                materiaId: 'm1',
                assuntoId: 'a1',
                banca: 'FGV',
                errors: [{
                  enunciado: 'Qual atributo permite à Administração executar diretamente o ato sem ordem judicial?',
                  alternativas: [
                    { letra: 'A', texto: 'Imperatividade' },
                    { letra: 'B', texto: 'Autoexecutoriedade' },
                    { letra: 'C', texto: 'Tipicidade' }
                  ],
                  correta: 'B',
                  comentario: 'Autoexecutoriedade dispensa prévia intervenção do Judiciário.'
                }]
              }]
            }
          }
        }
      })
    });
    assert.equal(bfRes.status, 200);
    const bfJson = bfRes.json();
    assert.equal(bfJson.ok, true);
    assert.equal(bfJson.inserted, 1);

    // 2. Stats devolve 1 questão no subtópico
    const statsRes = await invokeExpressApp(app, {
      method: 'GET',
      url: '/api/questions/stats?editalId=ed1&materiaId=m1&assuntoIds=a1'
    });
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.json().stats.totalSubtopics, 1);

    // 3. Draw sorteia a questão com alternativas embaralhadas e gabarito consistente
    const drawRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/questions/draw',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editalId: 'ed1',
        materiaId: 'm1',
        assuntoIds: ['a1'],
        limit: 5,
        shuffleAlternatives: true
      })
    });
    assert.equal(drawRes.status, 200);
    const drawJson = drawRes.json();
    assert.equal(drawJson.ok, true);
    assert.equal(drawJson.questoes.length, 1);
    const q = drawJson.questoes[0];
    const correctAlt = q.alternativas.find((a) => a.letra === q.correta);
    assert.equal(correctAlt.texto, 'Autoexecutoriedade');

    // 4. Attempts atualiza o histórico da questão
    const attRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/questions/attempts',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editalId: 'ed1',
        attempts: [{ bankQuestionId: q.bankQuestionId, result: 'hit' }]
      })
    });
    assert.equal(attRes.status, 200);
    assert.equal(attRes.json().updated, 1);

    // 5. Segundo backfill é idempotente (0 inseridas, 1 pulada)
    const bf2Res = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/questions/backfill',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: {
          v: 2,
          editais: [{ id: 'ed1', nome: 'TJPB' }],
          bank: {
            ed1: {
              materias: [{ id: 'm1', nome: 'Direito Administrativo' }],
              assuntos: [{ id: 'a1', materiaId: 'm1', nome: 'Atos Administrativos' }],
              log: [{
                id: 'l1',
                date: '2026-11-20T10:00:00.000Z',
                materiaId: 'm1',
                assuntoId: 'a1',
                banca: 'FGV',
                errors: [{
                  enunciado: 'Qual atributo permite à Administração executar diretamente o ato sem ordem judicial?',
                  alternativas: [
                    { letra: 'A', texto: 'Imperatividade' },
                    { letra: 'B', texto: 'Autoexecutoriedade' },
                    { letra: 'C', texto: 'Tipicidade' }
                  ],
                  correta: 'B'
                }]
              }]
            }
          }
        }
      })
    });
    assert.equal(bf2Res.json().inserted, 0);
    assert.equal(bf2Res.json().skipped, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
