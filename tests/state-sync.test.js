import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {
  mergeOfflinePacks,
  mergeSubtopicMastery,
  mergeReviewConcepts,
  mergePanelStates,
  resolveSyncState,
  isStateEffectivelyEmpty
} from '../shared/state-merge.js';

function makeBaseState({ rev = 10, updatedAt = '2026-11-23T10:00:00.000Z', localModifiedAt = null, container = {} } = {}) {
  return {
    v: 2,
    editais: [{ id: 'ed1', nome: 'TJPB 2027' }],
    activeEdital: 'ed1',
    bank: {
      ed1: {
        materias: [{ id: 'm1', nome: 'Banco de Dados' }],
        assuntos: [{ id: 'a1', materiaId: 'm1', nome: 'SQL' }],
        schedule: [{ id: 's1', data: '2026-11-23', horario: '09:00', materiaId: 'm1', assuntoIds: ['a1'], qtd: 5 }],
        log: [
          { id: 'l_old', date: '2026-11-22T18:00:00.000Z', materiaId: 'm1', assuntoId: 'a1', acertos: 4, total: 5, errors: [] }
        ],
        fired: {},
        offlinePacks: [],
        subtopicMastery: {
          a1: {
            score: 300,
            level: 2,
            totalResolved: 10,
            lastActivityDate: '2026-11-22',
            updatedAt: '2026-11-22T18:00:00.000Z',
            scoreHistory: [{ date: '2026-11-22T18:00:00.000Z', scoreAfter: 300, questionsCount: 5 }]
          }
        },
        reviewConcepts: [
          {
            id: 'rc1',
            materiaId: 'm1',
            assuntoId: 'a1',
            conceitoChave: 'LEFT JOIN vs INNER JOIN',
            srsStage: 0,
            lastReviewDate: '2026-11-22T18:00:00.000Z',
            history: [{ date: '2026-11-22T18:00:00.000Z', result: 'wrong', stageAfter: 0 }]
          }
        ],
        cadernoAssuntos: {},
        flashcardRatings: {},
        config: { banca: '102' },
        metas: { acertosPct: 80, questoesSemana: 100 },
        ...container
      }
    },
    ui: { catalog: true },
    meta: {
      rev,
      updatedAt,
      ...(localModifiedAt ? { localModifiedAt } : {})
    }
  };
}

test('mergeOfflinePacks preserva respostas offline mesmo se o servidor tiver updatedAt mais recente (clock skew / timer PC)', () => {
  const srvPack = {
    id: 'pack_1',
    status: 'ready',
    createdAt: '2026-11-22T20:00:00.000Z',
    updatedAt: '2026-11-23T11:05:00.000Z', // servidor com relógio adiantado ou tocado sem responder
    currentIndex: 0,
    elapsedSeconds: 15,
    questions: [
      { enunciado: 'Q1', correta: 'A', confirmed: false, selectedLetter: '', confidence: '' },
      { enunciado: 'Q2', correta: 'B', confirmed: false, selectedLetter: '', confidence: '' }
    ]
  };
  const cliPack = {
    id: 'pack_1',
    status: 'in_progress',
    createdAt: '2026-11-22T20:00:00.000Z',
    updatedAt: '2026-11-23T10:50:00.000Z', // relógio do celular atrasado em relação ao servidor
    currentIndex: 1,
    elapsedSeconds: 180,
    questions: [
      {
        enunciado: 'Q1',
        correta: 'A',
        confirmed: true,
        selectedLetter: 'C',
        confidence: 'certeza',
        errorReasonNote: 'Confundi WHERE com HAVING',
        duvidasPendentes: [{ id: 'd1', pergunta: 'Por que A?', status: 'pending', createdAt: '2026-11-23T10:49:00.000Z' }]
      },
      { enunciado: 'Q2', correta: 'B', confirmed: false, selectedLetter: 'B', confidence: 'duvida' }
    ]
  };

  const merged = mergeOfflinePacks([srvPack], [cliPack]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'in_progress');
  assert.equal(merged[0].elapsedSeconds, 180);
  assert.equal(merged[0].currentIndex, 1);
  assert.equal(merged[0].questions[0].confirmed, true);
  assert.equal(merged[0].questions[0].selectedLetter, 'C');
  assert.equal(merged[0].questions[0].errorReasonNote, 'Confundi WHERE com HAVING');
  assert.equal(merged[0].questions[0].duvidasPendentes.length, 1);
  assert.equal(merged[0].questions[1].selectedLetter, 'B');
});

test('mergeOfflinePacks mescla questões respondidas em dispositivos diferentes sem perder nenhuma', () => {
  const srvPack = {
    id: 'pack_2',
    status: 'in_progress',
    updatedAt: '2026-11-23T10:00:00.000Z',
    currentIndex: 1,
    elapsedSeconds: 90,
    questions: [
      { enunciado: 'Q1', correta: 'A', confirmed: true, selectedLetter: 'A', confidence: 'certeza' },
      { enunciado: 'Q2', correta: 'B', confirmed: false, selectedLetter: '', confidence: '' }
    ]
  };
  const cliPack = {
    id: 'pack_2',
    status: 'in_progress',
    updatedAt: '2026-11-23T10:05:00.000Z',
    currentIndex: 1,
    elapsedSeconds: 120,
    questions: [
      { enunciado: 'Q1', correta: 'A', confirmed: false, selectedLetter: '', confidence: '' },
      { enunciado: 'Q2', correta: 'B', confirmed: true, selectedLetter: 'B', confidence: 'duvida' }
    ]
  };

  const merged = mergeOfflinePacks([srvPack], [cliPack]);
  assert.equal(merged[0].questions[0].confirmed, true);
  assert.equal(merged[0].questions[0].selectedLetter, 'A');
  assert.equal(merged[0].questions[1].confirmed, true);
  assert.equal(merged[0].questions[1].selectedLetter, 'B');
});

test('estudo offline finalizado sincroniza sem perda mesmo após PC disparar checkSchedule e avançar rev no servidor', () => {
  // Servidor avançou para rev 11 quando PC disparou alerta da agenda às 10:00
  const serverState = makeBaseState({
    rev: 11,
    updatedAt: '2026-11-23T13:00:09.000Z',
    localModifiedAt: '2026-11-23T13:00:09.000Z',
    container: {
      fired: { 's1|09:00': '2026-11-23', 's1|10:00': '2026-11-23' },
      offlinePacks: [
        { id: 'pack_off', status: 'ready', updatedAt: '2026-11-22T22:00:00.000Z', questions: [{ enunciado: 'Q1', confirmed: false }] }
      ]
    }
  });

  // Celular estava na rev 10, respondeu e finalizou a bateria offline às 09:30 (antes do checkSchedule do PC!)
  const clientState = makeBaseState({
    rev: 10,
    updatedAt: '2026-11-22T22:00:00.000Z',
    localModifiedAt: '2026-11-23T12:30:00.000Z',
    container: {
      log: [
        { id: 'l_offline_today', date: '2026-11-23T12:30:00.000Z', materiaId: 'm1', assuntoId: 'a1', acertos: 5, total: 5, errors: [] },
        { id: 'l_old', date: '2026-11-22T18:00:00.000Z', materiaId: 'm1', assuntoId: 'a1', acertos: 4, total: 5, errors: [] }
      ],
      offlinePacks: [
        { id: 'pack_off', status: 'completed', updatedAt: '2026-11-23T12:30:00.000Z', questions: [] }
      ],
      subtopicMastery: {
        a1: {
          score: 410,
          level: 2,
          totalResolved: 15,
          lastActivityDate: '2026-11-23',
          updatedAt: '2026-11-23T12:30:00.000Z',
          scoreHistory: [
            { date: '2026-11-22T18:00:00.000Z', scoreAfter: 300, questionsCount: 5 },
            { date: '2026-11-23T12:30:00.000Z', scoreAfter: 410, questionsCount: 5 }
          ]
        }
      },
      reviewConcepts: [
        {
          id: 'rc1',
          materiaId: 'm1',
          assuntoId: 'a1',
          conceitoChave: 'LEFT JOIN vs INNER JOIN',
          srsStage: 1,
          lastReviewDate: '2026-11-23T12:30:00.000Z',
          history: [
            { date: '2026-11-22T18:00:00.000Z', result: 'wrong', stageAfter: 0 },
            { date: '2026-11-23T12:30:00.000Z', result: 'correct', stageAfter: 1 }
          ]
        }
      ]
    }
  });

  const res = resolveSyncState({
    serverState,
    clientState,
    hasOfflineChanges: true,
    baseRev: 10,
    nowIso: '2026-11-23T13:15:00.000Z'
  });

  assert.equal(res.merged, true);
  assert.equal(res.rev, 12);
  const bank = res.state.bank.ed1;
  // Log offline preservado
  assert.equal(bank.log.some(l => l.id === 'l_offline_today'), true);
  assert.equal(bank.log.some(l => l.id === 'l_old'), true);
  // Bateria marcada como concluída
  assert.equal(bank.offlinePacks.find(p => p.id === 'pack_off').status, 'completed');
  // Mastery evoluído preservado
  assert.equal(bank.subtopicMastery.a1.totalResolved, 15);
  assert.equal(bank.subtopicMastery.a1.score, 410);
  // Revisão avançada preservada
  assert.equal(bank.reviewConcepts.find(r => r.id === 'rc1').srsStage, 1);
  // Disparos de agenda do PC também preservados
  assert.equal(bank.fired['s1|10:00'], '2026-11-23');
});

test('aba antiga (sem localModifiedAt mais novo) não sobrescreve agenda ou estudos mais recentes do servidor', () => {
  const serverState = makeBaseState({
    rev: 20,
    updatedAt: '2026-11-23T12:00:00.000Z',
    localModifiedAt: '2026-11-23T12:00:00.000Z',
    container: {
      schedule: [
        { id: 's1', data: '2026-11-23', horario: '09:00', materiaId: 'm1', assuntoIds: ['a1'], qtd: 5 },
        { id: 's_new', data: '2026-11-24', horario: '14:00', materiaId: 'm1', assuntoIds: ['a1'], qtd: 10 }
      ]
    }
  });

  // Aba antiga aberta ontem tentando sincronizar com baseRev 18
  const staleTab = makeBaseState({
    rev: 18,
    updatedAt: '2026-11-23T15:00:00.000Z', // mesmo se updatedAt fosse recente, baseRev < serverRev sem localModifiedAt
    container: {
      schedule: [{ id: 's1', data: '2026-11-23', horario: '09:00', materiaId: 'm1', assuntoIds: ['a1'], qtd: 5 }]
    }
  });

  const merged = mergePanelStates(serverState, staleTab, { baseRev: 18, serverRev: 20 });
  assert.equal(merged.bank.ed1.schedule.length, 2);
  assert.equal(merged.bank.ed1.schedule.some(s => s.id === 's_new'), true);
});

test('cliente vazio recém-inicializado nunca sobrescreve dados reais do servidor', () => {
  const serverState = makeBaseState({ rev: 50 });
  const emptyClient = {
    v: 2,
    editais: [{ id: 'e1', nome: 'Meu edital' }],
    activeEdital: 'e1',
    bank: {
      e1: {
        materias: [],
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
    meta: { rev: 0, updatedAt: null }
  };

  assert.equal(isStateEffectivelyEmpty(emptyClient), true);
  assert.equal(isStateEffectivelyEmpty(serverState), false);

  const res = resolveSyncState({
    serverState,
    clientState: emptyClient,
    hasOfflineChanges: true,
    baseRev: 0
  });
  assert.equal(res.skippedEmptyClient, true);
  assert.equal(res.rev, 50);
  assert.equal(res.state.bank.ed1.log.length, 1);
});

test('mergeSubtopicMastery e mergeReviewConcepts são imunes a diferença de relógio quando há mais progresso', () => {
  const srvM = {
    a1: { score: 250, level: 2, totalResolved: 8, updatedAt: '2026-11-23T12:10:00.000Z', scoreHistory: [] }
  };
  const cliM = {
    a1: { score: 340, level: 2, totalResolved: 13, updatedAt: '2026-11-23T11:55:00.000Z', scoreHistory: [] }
  };
  const mergedM = mergeSubtopicMastery(srvM, cliM);
  assert.equal(mergedM.a1.totalResolved, 13);
  assert.equal(mergedM.a1.score, 340);

  const srvRc = [
    { id: 'rc1', srsStage: 0, lastReviewDate: '2026-11-23T12:10:00.000Z', history: [{ date: '2026-11-22', result: 'wrong', stageAfter: 0 }] }
  ];
  const cliRc = [
    {
      id: 'rc1',
      srsStage: 1,
      lastReviewDate: '2026-11-23T11:55:00.000Z',
      history: [
        { date: '2026-11-22', result: 'wrong', stageAfter: 0 },
        { date: '2026-11-23T11:55:00.000Z', result: 'correct', stageAfter: 1 }
      ]
    }
  ];
  const mergedRc = mergeReviewConcepts(srvRc, cliRc);
  assert.equal(mergedRc[0].srsStage, 1);
  assert.equal(mergedRc[0].history.length, 2);
});

test('exclusão online atualizada (baseRev === serverRev) e forceReplace funcionam normalmente', () => {
  const serverState = makeBaseState({ rev: 10 });
  const deletedLogClient = makeBaseState({ rev: 10, localModifiedAt: '2026-11-23T13:05:00.000Z', container: { log: [] } });

  const onlineDel = resolveSyncState({
    serverState,
    clientState: deletedLogClient,
    hasOfflineChanges: false,
    baseRev: 10
  });
  assert.equal(onlineDel.merged, false);
  assert.equal(onlineDel.rev, 11);
  assert.equal(onlineDel.state.bank.ed1.log.length, 0);

  const forced = resolveSyncState({
    serverState,
    clientState: deletedLogClient,
    hasOfflineChanges: true,
    baseRev: 5,
    forceReplace: true
  });
  assert.equal(forced.merged, false);
  assert.equal(forced.state.bank.ed1.log.length, 0);
});

test('script inline de public/index.html possui sintaxe JavaScript válida', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/i.test(m[1]))
    .map(m => m[2]);
  assert.ok(scripts.length >= 1, 'Esperado ao menos um script inline em public/index.html');
  scripts.forEach((code, idx) => {
    assert.doesNotThrow(() => new vm.Script(code, { filename: `public/index.html#script-${idx}` }));
  });
});
