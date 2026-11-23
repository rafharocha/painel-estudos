import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SCORE,
  computeQuestionScoreDelta,
  distributeCountsHamilton,
  planBatterySlots,
  evaluateBatteryOutcome,
  advanceReviewConcept,
  computeReviewConceptStatus,
  applyTemporalDecay,
  createDefaultSubtopicMastery,
  BATTERY_DISTRIBUTION
} from '../shared/adaptive-engine.js';

test('Pontuação por questão: Certeza, Dúvida (+50% + revisão 3d), Chute (0 pts + erro) e Erro', () => {
  // Acerto com Certeza
  assert.equal(computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N2', isCorrect: true, confidence: 'certeza' }).delta, 20);
  assert.equal(computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N3', isCorrect: true, confidence: 'certeza' }).delta, 35);
  assert.equal(computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N1', isCorrect: true, confidence: 'certeza' }).delta, 10);

  // Acerto com Dúvida (+50% e agenda revisão curta de 3 dias)
  const dSame = computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N2', isCorrect: true, confidence: 'duvida' });
  assert.equal(dSame.delta, 10);
  assert.equal(dSame.scheduleShortReview, true);
  assert.equal(dSame.shortReviewDays, 3);
  assert.equal(dSame.effectiveHit, true);

  const dAbove = computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N4', isCorrect: true, confidence: 'duvida' });
  assert.equal(dAbove.delta, 18); // Math.round(35 * 0.5)

  const dBelow = computeQuestionScoreDelta({ studentLevel: 3, questionLevel: 'N2', isCorrect: true, confidence: 'duvida' });
  assert.equal(dBelow.delta, 5);

  // Acerto no Chute (0 pts e tratado como erro para revisão e acerto efetivo)
  const chute = computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N4', isCorrect: true, confidence: 'chute' });
  assert.equal(chute.delta, 0);
  assert.equal(chute.effectiveHit, false);
  assert.equal(chute.treatAsErrorForReview, true);

  // Erro (acima -10, mesmo -20, abaixo -35)
  assert.equal(computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N3', isCorrect: false, confidence: 'certeza' }).delta, -10);
  assert.equal(computeQuestionScoreDelta({ studentLevel: 2, questionLevel: 'N2', isCorrect: false, confidence: 'duvida' }).delta, -20);
  assert.equal(computeQuestionScoreDelta({ studentLevel: 3, questionLevel: 'N1', isCorrect: false, confidence: 'chute' }).delta, -35);
});

test('Matriz de Distribuição (Hamilton) soma exatamente totalQtd para tamanhos 5..20 nos 4 níveis', () => {
  for (const lvl of [1, 2, 3, 4]) {
    for (const qtd of [5, 8, 10, 12, 15, 17, 20]) {
      const counts = distributeCountsHamilton(qtd, BATTERY_DISTRIBUTION[lvl]);
      const sum = counts.N1 + counts.N2 + counts.N3 + counts.N4 + counts.N5;
      assert.equal(sum, qtd, `Soma incorreta para nível ${lvl} com ${qtd} questões`);
    }
  }
  // Conferência exata para 5 e 10 questões
  assert.deepEqual(distributeCountsHamilton(5, BATTERY_DISTRIBUTION[1]), { N1: 3, N2: 2, N3: 0, N4: 0, N5: 0 });
  assert.deepEqual(distributeCountsHamilton(5, BATTERY_DISTRIBUTION[4]), { N1: 0, N2: 0, N3: 1, N4: 2, N5: 2 });
  assert.deepEqual(distributeCountsHamilton(10, BATTERY_DISTRIBUTION[1]), { N1: 6, N2: 3, N3: 1, N4: 0, N5: 0 });
  assert.deepEqual(distributeCountsHamilton(10, BATTERY_DISTRIBUTION[2]), { N1: 1, N2: 5, N3: 3, N4: 1, N5: 0 });
  assert.deepEqual(distributeCountsHamilton(20, BATTERY_DISTRIBUTION[2]), { N1: 3, N2: 9, N3: 6, N4: 2, N5: 0 });
  assert.deepEqual(distributeCountsHamilton(10, BATTERY_DISTRIBUTION[3]), { N1: 0, N2: 1, N3: 3, N4: 4, N5: 2 });
  assert.deepEqual(distributeCountsHamilton(10, BATTERY_DISTRIBUTION[4]), { N1: 0, N2: 0, N3: 2, N4: 4, N5: 4 });
});

test('Drenagem 80/20 (Opção A: 1d original + 4d+ inédita) e aderência à Matriz N1-N5', () => {
  // 9 erros vencidos (4 no degrau 1d e 5 no degrau 4d+)
  const due9 = Array.from({ length: 9 }, (_, i) => ({
    id: `rc_${i + 1}`,
    assuntoId: 'a1',
    conceitoChave: `Conceito ${i + 1}`,
    targetLevel: i < 5 ? 1 : 2,
    srsStage: i < 4 ? 0 : 1,
    hasOriginalQuestion: true,
    srs: { diffDays: 1, due: true, overdue: true },
    mastered: false
  }));

  // 5 questões com 9 erros vencidos -> 4 revisões (80%) + 1 inédita nova (20%), fila cai 9 -> 5
  const plan5 = planBatterySlots({
    totalQtd: 5,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1'],
    subtopicMasteryMap: { a1: { ...createDefaultSubtopicMastery(), score: 200, level: 1 } },
    dueReviewConcepts: due9,
    reviewMode: 'hybrid',
    todayISO: '2026-11-20'
  });
  assert.equal(plan5.slots.length, 5);
  assert.equal(plan5.activeReviewCount, 4);
  assert.equal(plan5.newQuestionsCount, 1);
  assert.equal(plan5.remainingDueAfterBattery, 5);
  // Nível 1 (5q): Matriz-alvo é 3x N1 + 2x N2 — confere que respeitou a Matriz!
  assert.deepEqual(plan5.finalDistributionCounts, { N1: 3, N2: 2, N3: 0, N4: 0, N5: 0 });
  // Opção A: itens em 1d (srsStage 0) são exact; itens em 4d (srsStage 1) são novel
  plan5.slots.filter(s => s.isActiveReview).forEach(s => {
    assert.equal(s.isExactReview, s.srsStage === 0);
  });

  // 5 questões com apenas 1 erro vencido -> 1 revisão + 4 inéditas novas (fila zerada!)
  const plan5One = planBatterySlots({
    totalQtd: 5,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1'],
    subtopicMasteryMap: { a1: { ...createDefaultSubtopicMastery(), score: 200, level: 1 } },
    dueReviewConcepts: [due9[0]],
    reviewMode: 'hybrid',
    todayISO: '2026-11-20'
  });
  assert.equal(plan5One.activeReviewCount, 1);
  assert.equal(plan5One.newQuestionsCount, 4);
  assert.equal(plan5One.remainingDueAfterBattery, 0);

  // 10 questões com 9 erros vencidos -> 8 revisões (80%) + 2 inéditas novas (20%)
  const plan10 = planBatterySlots({
    totalQtd: 10,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1'],
    subtopicMasteryMap: { a1: { ...createDefaultSubtopicMastery(), score: 200, level: 1 } },
    dueReviewConcepts: due9,
    reviewMode: 'hybrid',
    todayISO: '2026-11-20'
  });
  assert.equal(plan10.activeReviewCount, 8);
  assert.equal(plan10.newQuestionsCount, 2);
  assert.equal(plan10.remainingDueAfterBattery, 1);
  assert.equal(plan10.exactReviewCount, 4); // os 4 em 1d
  assert.equal(plan10.novelReviewCount, 4); // 4 dos 5 em 4d+

  // Casamento com a Matriz N1-N5: aluno Iniciante (quer N1 e N2) tendo erros em N1, N2 e N5 não urgentes -> escolhe N1/N2 antes de N5!
  const mixedLevelsDue = [
    { id: 'rc_n5', assuntoId: 'a1', conceitoChave: 'C N5', targetLevel: 5, srsStage: 0, hasOriginalQuestion: true, srs: { diffDays: 1 }, mastered: false },
    { id: 'rc_n4', assuntoId: 'a1', conceitoChave: 'C N4', targetLevel: 4, srsStage: 0, hasOriginalQuestion: true, srs: { diffDays: 1 }, mastered: false },
    { id: 'rc_n1a', assuntoId: 'a1', conceitoChave: 'C N1a', targetLevel: 1, srsStage: 0, hasOriginalQuestion: true, srs: { diffDays: 0 }, mastered: false },
    { id: 'rc_n1b', assuntoId: 'a1', conceitoChave: 'C N1b', targetLevel: 1, srsStage: 0, hasOriginalQuestion: true, srs: { diffDays: 0 }, mastered: false },
    { id: 'rc_n2a', assuntoId: 'a1', conceitoChave: 'C N2a', targetLevel: 2, srsStage: 1, hasOriginalQuestion: true, srs: { diffDays: 0 }, mastered: false },
    { id: 'rc_n2b', assuntoId: 'a1', conceitoChave: 'C N2b', targetLevel: 2, srsStage: 1, hasOriginalQuestion: true, srs: { diffDays: 0 }, mastered: false }
  ];
  const planMatrix = planBatterySlots({
    totalQtd: 5,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1'],
    subtopicMasteryMap: { a1: { ...createDefaultSubtopicMastery(), score: 200, level: 1 } },
    dueReviewConcepts: mixedLevelsDue,
    reviewMode: 'hybrid',
    todayISO: '2026-11-20'
  });
  const pickedIds = planMatrix.slots.filter(s => s.isActiveReview).map(s => s.reviewConceptId);
  assert.equal(pickedIds.includes('rc_n5'), false);
  assert.equal(pickedIds.includes('rc_n4'), false);
  assert.deepEqual(planMatrix.finalDistributionCounts, { N1: 3, N2: 2, N3: 0, N4: 0, N5: 0 });

  // Urgência (>=3d atraso): um erro N4 atrasado há 4 dias entra com prioridade absoluta para não ficar esquecido!
  mixedLevelsDue[1].srs.diffDays = 4;
  const planUrgent = planBatterySlots({
    totalQtd: 5,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1'],
    subtopicMasteryMap: { a1: { ...createDefaultSubtopicMastery(), score: 200, level: 1 } },
    dueReviewConcepts: mixedLevelsDue,
    reviewMode: 'hybrid',
    todayISO: '2026-11-20'
  });
  assert.equal(planUrgent.slots[0].reviewConceptId, 'rc_n4');

  // Avançado (Nível 3) com 2 subtópicos intercala ambos
  const planAdv = planBatterySlots({
    totalQtd: 10,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1', 'a2'],
    subtopicMasteryMap: { a1: { ...createDefaultSubtopicMastery(), score: 700, level: 3, totalResolved: 30 } },
    dueReviewConcepts: [],
    todayISO: '2026-11-20'
  });
  assert.equal(planAdv.compositionMode, 'mista');
  assert.equal(planAdv.slots.filter(s => s.assuntoId === 'a1').length, 5);
  assert.equal(planAdv.slots.filter(s => s.assuntoId === 'a2').length, 5);
});

test('Promoção com baterias de 5 questões exige mínimo cumulativo de 10 questões resolvidas e bateria completa (>=5)', () => {
  const initial = createDefaultSubtopicMastery();
  assert.equal(initial.score, INITIAL_SCORE);

  // 1ª bateria de 5 questões (N2 corretas = +175 -> score 375 > 350): é bateria completa, mas totalResolved = 5 < 10 -> ainda não promove
  const qs5a = Array.from({ length: 5 }, () => ({ nivel: 'N2', isCorrect: true, confidence: 'certeza' }));
  const out5a = evaluateBatteryOutcome({
    masteryState: initial,
    subtopicQuestions: qs5a,
    fullBatterySize: 5,
    todayISO: '2026-11-20'
  });
  assert.equal(out5a.nextState.score, 375);
  assert.equal(out5a.nextState.level, 1);
  assert.equal(out5a.nextState.batteriesAtCurrentLevel, 1);
  assert.equal(out5a.summary.promoted, false);

  // 2ª bateria de 5 questões -> totalResolved = 10 >= 10 e batteriesAtCurrentLevel >= 1 -> promove p/ Nível 2!
  const qs5b = Array.from({ length: 5 }, () => ({ nivel: 'N1', isCorrect: true, confidence: 'certeza' }));
  const out5b = evaluateBatteryOutcome({
    masteryState: out5a.nextState,
    subtopicQuestions: qs5b,
    fullBatterySize: 5,
    todayISO: '2026-11-20'
  });
  assert.equal(out5b.nextState.level, 2);
  assert.equal(out5b.summary.promoted, true);
  assert.equal(out5b.nextState.batteriesAtCurrentLevel, 0);
});

test('Trava de Frustração (<55%) funciona em bateria de 5 questões e reduz 1 degrau na próxima', () => {
  const inter = { ...createDefaultSubtopicMastery(), score: 500, level: 2, totalResolved: 25, batteriesAtCurrentLevel: 1 };
  // 2 acertos + 3 erros = 40% (< 55%) em bateria de 5 questões
  const qsBad = [
    ...Array.from({ length: 2 }, () => ({ nivel: 'N2', isCorrect: true, confidence: 'certeza' })),
    ...Array.from({ length: 3 }, () => ({ nivel: 'N2', isCorrect: false, confidence: 'duvida' }))
  ];
  const outBad = evaluateBatteryOutcome({
    masteryState: inter,
    subtopicQuestions: qsBad,
    fullBatterySize: 5,
    todayISO: '2026-11-20'
  });
  assert.equal(outBad.summary.frustrationTriggered, true);
  assert.equal(outBad.nextState.frustrationDropActive, true);

  // Planejamento da próxima bateria de 5 questões cai temporariamente do nível 2 para o nível 1
  const nextPlan = planBatterySlots({
    totalQtd: 5,
    primaryAssuntoId: 'a1',
    selectedAssuntoIds: ['a1'],
    subtopicMasteryMap: { a1: outBad.nextState },
    todayISO: '2026-11-20'
  });
  assert.equal(nextPlan.frustrationDropApplied, true);
  assert.equal(nextPlan.effectiveLevel, 1);
  assert.deepEqual(nextPlan.finalDistributionCounts, { N1: 3, N2: 2, N3: 0, N4: 0, N5: 0 });
});

test('Ciclo do Erro (1d -> 4d -> 10d -> 25d) e queda de 1 nível ao errar revisão', () => {
  let concept = {
    id: 'rc_1',
    assuntoId: 'a1',
    conceitoChave: 'Presunção de legitimidade',
    origin: 'error',
    targetLevel: 3,
    srsStage: 0,
    nextDueDate: '2026-11-21',
    mastered: false,
    history: []
  };

  // 1ª revisão (1d) acertada com certeza -> avança para 4d
  let r = advanceReviewConcept(concept, { isCorrect: true, confidence: 'certeza', currentQuestionLevel: 3, todayISO: '2026-11-21' });
  assert.equal(r.concept.srsStage, 1);
  assert.equal(r.concept.nextDueDate, '2026-11-25'); // +4 dias

  // 2ª revisão (4d) acertada com certeza -> avança para 10d
  r = advanceReviewConcept(r.concept, { isCorrect: true, confidence: 'certeza', currentQuestionLevel: 3, todayISO: '2026-11-25' });
  assert.equal(r.concept.srsStage, 2);
  assert.equal(r.concept.nextDueDate, '2026-12-05'); // +10 dias

  // 3ª revisão (10d) ERRADA -> volta para 1d e desce 1 nível (N3 -> N2)
  r = advanceReviewConcept(r.concept, { isCorrect: false, confidence: 'duvida', currentQuestionLevel: 3, todayISO: '2026-12-05' });
  assert.equal(r.concept.srsStage, 0);
  assert.equal(r.concept.targetLevel, 2);
  assert.equal(r.concept.nextDueDate, '2026-12-06'); // +1 dia

  // Avança todos os 4 degraus até dominar (1d -> 4d -> 10d -> 25d -> Dominado)
  r = advanceReviewConcept(r.concept, { isCorrect: true, confidence: 'certeza', currentQuestionLevel: 2, todayISO: '2026-12-06' });
  assert.equal(r.concept.srsStage, 1);
  r = advanceReviewConcept(r.concept, { isCorrect: true, confidence: 'certeza', currentQuestionLevel: 2, todayISO: '2026-12-10' });
  assert.equal(r.concept.srsStage, 2);
  r = advanceReviewConcept(r.concept, { isCorrect: true, confidence: 'certeza', currentQuestionLevel: 2, todayISO: '2026-12-20' });
  assert.equal(r.concept.srsStage, 3);
  assert.equal(r.concept.nextDueDate, '2027-01-14'); // +25 dias
  r = advanceReviewConcept(r.concept, { isCorrect: true, confidence: 'certeza', currentQuestionLevel: 2, todayISO: '2027-01-14' });
  assert.equal(r.concept.mastered, true);
  assert.equal(computeReviewConceptStatus(r.concept, '2027-01-15').mastered, true);
});

test('Decaimento Temporal em Manutenção (>15d perde 5 pts/dia até piso 750) e restauração com validação 80%+', () => {
  const maint = {
    ...createDefaultSubtopicMastery(),
    score: 910,
    level: 4,
    totalResolved: 60,
    lastActivityDate: '2026-11-01T10:00:00.000Z'
  };

  // Dia 15 (2026-11-16): sem decaimento
  const d15 = applyTemporalDecay(maint, '2026-11-16');
  assert.equal(d15.score, 910);
  assert.equal(d15.decayStatus, 'ok');

  // Dia 20 (5 dias de atraso): 910 - 25 = 885, status pending_review
  const d20 = applyTemporalDecay(maint, '2026-11-21');
  assert.equal(d20.score, 885);
  assert.equal(d20.maintenancePeakScore, 910);
  assert.equal(d20.decayStatus, 'pending_review');

  // Dia 90 (75 dias de atraso): piso exato de 750
  const d90 = applyTemporalDecay(maint, '2027-01-30');
  assert.equal(d90.score, 750);
  assert.equal(d90.decayStatus, 'pending_review');

  // Validação de 5 questões com 80% de acerto (4 certeza + 1 erro) restaura para 910!
  const valQs = [
    ...Array.from({ length: 4 }, () => ({ nivel: 'N4', isCorrect: true, confidence: 'certeza' })),
    ...Array.from({ length: 1 }, () => ({ nivel: 'N5', isCorrect: false, confidence: 'duvida' }))
  ];
  const restored = evaluateBatteryOutcome({
    masteryState: d90,
    subtopicQuestions: valQs,
    fullBatterySize: 5,
    isValidationBattery: true,
    todayISO: '2027-01-30',
    nowISO: '2027-01-30T12:00:00.000Z'
  });
  assert.equal(restored.summary.restoredFromDecay, true);
  assert.equal(restored.nextState.score, 910);
  assert.equal(restored.nextState.level, 4);
  assert.equal(restored.nextState.decayStatus, 'ok');
  assert.equal(restored.nextState.maintenancePeakScore, null);
});
