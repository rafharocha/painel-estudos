(function (root) {
  'use strict';

  const QUESTION_LEVELS = {
    N1: {
      code: 'N1',
      num: 1,
      focus: 'Literalidade',
      rule: 'Cobra conceito isolado, definição direta, regra geral ou texto seco. Sem pegadinhas e com distratores claramente distintos.'
    },
    N2: {
      code: 'N2',
      num: 2,
      focus: 'Compreensão',
      rule: 'Cobra o mesmo conceito com paráfrases, sinônimos ou a exceção clássica da regra. Distratores já usam termos parecidos com a resposta correta.'
    },
    N3: {
      code: 'N3',
      num: 3,
      focus: 'Aplicação',
      rule: 'Apresenta um caso prático/cenário hipotético curto onde o aluno precisa identificar qual regra se aplica para resolver o problema.'
    },
    N4: {
      code: 'N4',
      num: 4,
      focus: 'Análise',
      rule: 'Cruza 2 ou mais subtópicos na mesma questão, cobra distinção entre institutos/conceitos parecidos ou pede para identificar um erro sutil em um cenário ou código.'
    },
    N5: {
      code: 'N5',
      num: 5,
      focus: 'Avaliação',
      rule: 'Casos limítrofes, exceção da exceção, múltiplas assertivas (I, II, III, IV) ou cenários de alta complexidade típicos de provas de ponta.'
    }
  };

  const STUDENT_LEVELS = {
    1: {
      level: 1,
      name: 'Iniciante',
      shortName: 'N1 · Iniciante',
      minScore: 0,
      maxScore: 349,
      compositionMode: 'focada',
      compositionLabel: 'Bateria focada (100% do mesmo subtópico)',
      recommendedSubtopics: 1,
      errorReserveRatio: 0
    },
    2: {
      level: 2,
      name: 'Intermediário',
      shortName: 'N2 · Intermediário',
      minScore: 350,
      maxScore: 649,
      compositionMode: 'focada',
      compositionLabel: 'Bateria focada, com 20% reservado para erros anteriores',
      recommendedSubtopics: 1,
      errorReserveRatio: 0.20
    },
    3: {
      level: 3,
      name: 'Avançado',
      shortName: 'N3 · Avançado',
      minScore: 650,
      maxScore: 849,
      compositionMode: 'mista',
      compositionLabel: 'Bateria mista (intercala 2 subtópicos relacionados)',
      recommendedSubtopics: 2,
      errorReserveRatio: 0
    },
    4: {
      level: 4,
      name: 'Manutenção',
      shortName: 'N4 · Manutenção',
      minScore: 850,
      maxScore: 1000,
      compositionMode: 'intercalada',
      compositionLabel: 'Bateria intercalada (3+ subtópicos) + revisões vencidas',
      recommendedSubtopics: 3,
      errorReserveRatio: 0
    }
  };

  const BATTERY_DISTRIBUTION = {
    1: { N1: 60, N2: 30, N3: 10, N4: 0, N5: 0 },
    2: { N1: 15, N2: 45, N3: 30, N4: 10, N5: 0 },
    3: { N1: 0, N2: 10, N3: 30, N4: 40, N5: 20 },
    4: { N1: 0, N2: 0, N3: 20, N4: 40, N5: 40 }
  };

  const INITIAL_SCORE = 200;
  const MIN_SCORE = 0;
  const MAX_SCORE = 1000;
  const MIN_INITIAL_QUESTIONS = 10;
  const BATTERY_MIN_SIZE = 5;
  const BATTERY_MAX_SIZE = 20;
  const ACTIVE_REVIEW_MAX_RATIO = 0.80;
  const URGENT_OVERDUE_DAYS = 3;
  const FRUSTRATION_THRESHOLD_PCT = 55;
  const MAINTENANCE_DECAY_GRACE_DAYS = 15;
  const MAINTENANCE_DECAY_PER_DAY = 5;
  const MAINTENANCE_DECAY_FLOOR = 750;
  const MAINTENANCE_VALIDATION_MIN_Q = 5;
  const MAINTENANCE_VALIDATION_PCT = 80;

  const SRS_ERROR_INTERVALS = [1, 4, 10, 25];
  const SRS_ERROR_LABELS = ['1d', '4d', '10d', '25d'];
  const DOUBT_REVIEW_DAYS = 3;

  const CONFIDENCE_OPTIONS = {
    certeza: { id: 'certeza', label: 'Certeza', desc: 'Sei o porquê da resposta' },
    duvida: { id: 'duvida', label: 'Dúvida', desc: 'Fiquei entre duas alternativas' },
    chute: { id: 'chute', label: 'Chute', desc: 'Eliminação cega / não fazia ideia' }
  };

  const ERROR_REASON_TYPES = {
    lacuna_teorica: { id: 'lacuna_teorica', label: 'Lacuna teórica' },
    falta_atencao: { id: 'falta_atencao', label: 'Falta de atenção' },
    pegadinha: { id: 'pegadinha', label: 'Pegadinha' }
  };

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toISODate(dateInput) {
    if (!dateInput) {
      const d = new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
      return dateInput.trim();
    }
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) {
      const now = new Date();
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function addDaysISO(baseDateInput, days) {
    const iso = toISODate(baseDateInput);
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }

  function diffDaysISO(laterDateInput, earlierDateInput) {
    const a = toISODate(laterDateInput).split('-').map(Number);
    const b = toISODate(earlierDateInput).split('-').map(Number);
    const tA = Date.UTC(a[0], a[1] - 1, a[2]);
    const tB = Date.UTC(b[0], b[1] - 1, b[2]);
    return Math.round((tA - tB) / 86400000);
  }

  function parseQuestionLevel(val, fallback) {
    const fb = fallback !== undefined ? clamp(Number(fallback) || 2, 1, 5) : 2;
    if (typeof val === 'number' && Number.isFinite(val)) {
      return clamp(Math.round(val), 1, 5);
    }
    const s = String(val || '').trim().toUpperCase();
    const m = s.match(/^N?([1-5])$/);
    if (m) return parseInt(m[1], 10);
    return fb;
  }

  function formatQuestionLevel(val, fallback) {
    return `N${parseQuestionLevel(val, fallback)}`;
  }

  function getQuestionLevelInfo(val) {
    const code = formatQuestionLevel(val, 2);
    return QUESTION_LEVELS[code];
  }

  function levelForScore(score) {
    const s = clamp(Number(score) || 0, MIN_SCORE, MAX_SCORE);
    if (s >= 850) return 4;
    if (s >= 650) return 3;
    if (s >= 350) return 2;
    return 1;
  }

  function getStudentLevelInfo(level) {
    const lvl = clamp(Math.round(Number(level) || 1), 1, 4);
    return STUDENT_LEVELS[lvl];
  }

  function createDefaultSubtopicMastery() {
    return {
      score: INITIAL_SCORE,
      level: 1,
      totalResolved: 0,
      batteriesAtCurrentLevel: 0,
      frustrationDropActive: false,
      lastActivityDate: null,
      maintenancePeakScore: null,
      decayStatus: 'ok',
      updatedAt: null,
      scoreHistory: []
    };
  }

  function normalizeSubtopicMastery(raw) {
    const base = createDefaultSubtopicMastery();
    if (!raw || typeof raw !== 'object') return base;
    const score = clamp(Number.isFinite(Number(raw.score)) ? Math.round(Number(raw.score)) : INITIAL_SCORE, MIN_SCORE, MAX_SCORE);
    const level = clamp(Number.isFinite(Number(raw.level)) ? Math.round(Number(raw.level)) : levelForScore(score), 1, 4);
    return {
      score,
      level,
      totalResolved: Math.max(0, Math.round(Number(raw.totalResolved) || 0)),
      batteriesAtCurrentLevel: Math.max(0, Math.round(Number(raw.batteriesAtCurrentLevel) || 0)),
      frustrationDropActive: Boolean(raw.frustrationDropActive),
      lastActivityDate: raw.lastActivityDate || null,
      maintenancePeakScore: raw.maintenancePeakScore != null && Number.isFinite(Number(raw.maintenancePeakScore))
        ? clamp(Math.round(Number(raw.maintenancePeakScore)), 850, MAX_SCORE)
        : null,
      decayStatus: raw.decayStatus === 'pending_review' ? 'pending_review' : 'ok',
      updatedAt: raw.updatedAt || null,
      scoreHistory: Array.isArray(raw.scoreHistory) ? raw.scoreHistory.slice(-50) : []
    };
  }

  function applyTemporalDecay(rawMastery, todayISO) {
    const st = normalizeSubtopicMastery(rawMastery);
    const today = toISODate(todayISO);

    if (st.level !== 4 && st.decayStatus !== 'pending_review') {
      return {
        ...st,
        daysInactive: st.lastActivityDate ? Math.max(0, diffDaysISO(today, st.lastActivityDate)) : 0,
        decayOverdueDays: 0,
        decayPointsLost: 0
      };
    }

    if (!st.lastActivityDate) {
      return {
        ...st,
        daysInactive: 0,
        decayOverdueDays: 0,
        decayPointsLost: 0
      };
    }

    const daysInactive = Math.max(0, diffDaysISO(today, st.lastActivityDate));
    if (daysInactive <= MAINTENANCE_DECAY_GRACE_DAYS) {
      return {
        ...st,
        daysInactive,
        decayOverdueDays: 0,
        decayPointsLost: 0
      };
    }

    const overdueDays = daysInactive - MAINTENANCE_DECAY_GRACE_DAYS;
    const peak = st.maintenancePeakScore != null ? st.maintenancePeakScore : Math.max(850, st.score);
    const decayedScore = Math.max(MAINTENANCE_DECAY_FLOOR, peak - overdueDays * MAINTENANCE_DECAY_PER_DAY);

    return {
      ...st,
      score: decayedScore,
      maintenancePeakScore: peak,
      decayStatus: 'pending_review',
      daysInactive,
      decayOverdueDays: overdueDays,
      decayPointsLost: Math.max(0, peak - decayedScore)
    };
  }

  function computeQuestionScoreDelta({ studentLevel, questionLevel, isCorrect, confidence }) {
    const sLevel = clamp(Math.round(Number(studentLevel) || 1), 1, 4);
    const qLevel = parseQuestionLevel(questionLevel, sLevel);
    const conf = CONFIDENCE_OPTIONS[confidence] ? confidence : 'certeza';
    const relation = qLevel > sLevel ? 'above' : (qLevel < sLevel ? 'below' : 'same');

    if (isCorrect) {
      if (conf === 'chute') {
        return {
          delta: 0,
          relation,
          effectiveHit: false,
          treatAsErrorForReview: true,
          scheduleShortReview: false,
          shortReviewDays: 0
        };
      }
      const base = relation === 'above' ? 35 : (relation === 'below' ? 10 : 20);
      if (conf === 'duvida') {
        return {
          delta: Math.round(base * 0.5),
          relation,
          effectiveHit: true,
          treatAsErrorForReview: false,
          scheduleShortReview: true,
          shortReviewDays: DOUBT_REVIEW_DAYS
        };
      }
      return {
        delta: base,
        relation,
        effectiveHit: true,
        treatAsErrorForReview: false,
        scheduleShortReview: false,
        shortReviewDays: 0
      };
    }

    const penalty = relation === 'above' ? -10 : (relation === 'below' ? -35 : -20);
    return {
      delta: penalty,
      relation,
      effectiveHit: false,
      treatAsErrorForReview: true,
      scheduleShortReview: false,
      shortReviewDays: 0
    };
  }

  function distributeCountsHamilton(total, pctMap) {
    const keys = ['N1', 'N2', 'N3', 'N4', 'N5'];
    const n = Math.max(0, Math.round(Number(total) || 0));
    const counts = { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 };
    if (n === 0) return counts;

    const sumPct = keys.reduce((acc, k) => acc + (Number(pctMap[k]) || 0), 0);
    if (sumPct <= 0) {
      counts.N2 = n;
      return counts;
    }

    const exact = keys.map(k => {
      const raw = (n * (Number(pctMap[k]) || 0)) / sumPct;
      const fl = Math.floor(raw);
      return { key: k, floor: fl, rem: raw - fl, pct: Number(pctMap[k]) || 0 };
    });

    let used = 0;
    exact.forEach(item => {
      counts[item.key] = item.floor;
      used += item.floor;
    });

    let remaining = n - used;
    exact.sort((a, b) => (b.rem - a.rem) || (b.pct - a.pct));
    for (let i = 0; i < exact.length && remaining > 0; i++) {
      if (exact[i].pct > 0) {
        counts[exact[i].key] += 1;
        remaining -= 1;
      }
    }
    return counts;
  }

  function pickReviewsAlignedToMatrix({ candidates, maxSlots, targetCounts, mode, effectiveLevel }) {
    const levelOrder = ['N1', 'N2', 'N3', 'N4', 'N5'];
    const remainingQuota = {
      N1: Number(targetCounts.N1) || 0,
      N2: Number(targetCounts.N2) || 0,
      N3: Number(targetCounts.N3) || 0,
      N4: Number(targetCounts.N4) || 0,
      N5: Number(targetCounts.N5) || 0
    };
    const pool = (Array.isArray(candidates) ? candidates : []).slice();
    const picked = [];

    const isDoubtOnly = (c) => c.origin === 'duvida' && !c.enteredErrorCycle;
    const isExactForMode = (c) => {
      if (mode === 'novel_only') return false;
      if (mode === 'exact_only') return c.hasOriginalQuestion !== false;
      // Modo Híbrido (Opção A — Por Degrau): 1d volta como questão original exata; 4d/10d/25d e 3d Dúvida voltam como inéditas da IA
      return c.hasOriginalQuestion !== false && !isDoubtOnly(c) && (Number(c.srsStage) || 0) === 0;
    };
    const isUrgent = (c) => Boolean(c.srs && Number(c.srs.diffDays) >= URGENT_OVERDUE_DAYS);
    const isReincidenteDropped = (c) => {
      const hist = Array.isArray(c.history) ? c.history : [];
      if (!hist.length) return false;
      const last = hist[hist.length - 1];
      return Boolean(last && (!last.hit || last.confidence === 'chute'));
    };

    const getOpenLevelNums = () => levelOrder
      .map((code, idx) => ({ code, num: idx + 1, count: remainingQuota[code] }))
      .filter(x => x.count > 0);

    const nearestOpenFor = (lvlNum) => {
      const open = getOpenLevelNums();
      if (!open.length) return { dist: 99, code: formatQuestionLevel(lvlNum, effectiveLevel) };
      let best = open[0];
      let bestDist = Math.abs(lvlNum - best.num);
      for (let i = 1; i < open.length; i++) {
        const d = Math.abs(lvlNum - open[i].num);
        if (d < bestDist || (d === bestDist && open[i].count > best.count)) {
          best = open[i];
          bestDist = d;
        }
      }
      return { dist: bestDist, code: best.code };
    };

    while (picked.length < maxSlots && pool.length > 0) {
      let bestIdx = 0;
      let bestScore = null;

      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        const lvlNum = parseQuestionLevel(c.targetLevel || effectiveLevel, effectiveLevel);
        const lvlCode = formatQuestionLevel(lvlNum, effectiveLevel);
        const urgent = isUrgent(c) ? 1 : 0;
        const directMatch = remainingQuota[lvlCode] > 0 ? 1 : 0;
        const nearest = nearestOpenFor(lvlNum);
        const stage = isDoubtOnly(c) ? 0.5 : (Number(c.srsStage) || 0);
        const overdueDays = (c.srs && Number.isFinite(Number(c.srs.diffDays))) ? Number(c.srs.diffDays) : 0;

        // Ordem de prioridade: 1) Urgente (>=3d atraso), 2) Casa exato na Matriz N1-N5, 3) Mais próximo da Matriz, 4) Menor degrau (1d antes), 5) Maior atraso
        const tuple = [urgent, directMatch, -nearest.dist, -stage, overdueDays];
        if (!bestScore) {
          bestScore = tuple;
          bestIdx = i;
        } else {
          for (let k = 0; k < tuple.length; k++) {
            if (tuple[k] !== bestScore[k]) {
              if (tuple[k] > bestScore[k]) {
                bestScore = tuple;
                bestIdx = i;
              }
              break;
            }
          }
        }
      }

      const chosen = pool.splice(bestIdx, 1)[0];
      const exact = isExactForMode(chosen);
      const baseLvlNum = parseQuestionLevel(chosen.targetLevel || effectiveLevel, effectiveLevel);
      const baseLvlCode = formatQuestionLevel(baseLvlNum, effectiveLevel);
      let assignedNivel = baseLvlCode;

      if (!exact && remainingQuota[baseLvlCode] <= 0 && !isReincidenteDropped(chosen)) {
        // Para revisão inédita (IA), se não houve queda por reincidência, alinha à vaga mais próxima na Matriz (±1 nível)
        const nearest = nearestOpenFor(baseLvlNum);
        if (nearest.dist <= 1) {
          assignedNivel = nearest.code;
        }
      }

      if (remainingQuota[assignedNivel] > 0) {
        remainingQuota[assignedNivel] -= 1;
      }

      picked.push({
        concept: chosen,
        isExactReview: exact,
        assignedNivel
      });
    }

    return { picked, remainingQuota };
  }

  function planBatterySlots({
    totalQtd = 5,
    primaryAssuntoId = '',
    selectedAssuntoIds = [],
    subtopicMasteryMap = {},
    dueReviewConcepts = [],
    pastErrorConcepts = [],
    reviewMode = 'hybrid',
    isValidationBattery = false,
    todayISO
  } = {}) {
    const qtd = clamp(Math.round(Number(totalQtd) || 5), 1, 25);
    const mode = ['hybrid', 'novel_only', 'exact_only'].includes(reviewMode) ? reviewMode : 'hybrid';
    const isCompleteBattery = qtd >= BATTERY_MIN_SIZE && qtd <= BATTERY_MAX_SIZE;
    const subIds = Array.isArray(selectedAssuntoIds) && selectedAssuntoIds.length
      ? selectedAssuntoIds.slice()
      : (primaryAssuntoId ? [primaryAssuntoId] : []);
    const primaryId = primaryAssuntoId || subIds[0] || '';

    const rawPrimary = subtopicMasteryMap[primaryId] || createDefaultSubtopicMastery();
    const decayedPrimary = applyTemporalDecay(rawPrimary, todayISO);
    const baseLevel = decayedPrimary.level;
    const frustrationDropApplied = Boolean(!isValidationBattery && decayedPrimary.frustrationDropActive);
    const effectiveLevel = frustrationDropApplied ? Math.max(1, baseLevel - 1) : baseLevel;

    const levelInfo = getStudentLevelInfo(effectiveLevel);
    const pctMap = BATTERY_DISTRIBUTION[effectiveLevel] || BATTERY_DISTRIBUTION[1];
    const targetCounts = distributeCountsHamilton(qtd, pctMap);

    const slots = [];
    const usedConceptIds = new Set();

    // 1. Drenagem de Revisões 80/20 alinhada à Matriz N1-N5:
    // - Até 80% da bateria (mínimo 1 questão reservada para inédita nova quando qtd >= 2) para zerar a fila vencida.
    // - Modo Híbrido (Opção A): degrau 1d volta como questão original exata; degraus 4d/10d/25d e 3d Dúvida voltam como inéditas da IA.
    const reviewBudget = qtd >= 2
      ? Math.min(qtd - 1, Math.floor(qtd * ACTIVE_REVIEW_MAX_RATIO))
      : Math.min(qtd, 1);

    const eligibleDueAll = (Array.isArray(dueReviewConcepts) ? dueReviewConcepts : [])
      .filter(c => c && !c.mastered && (!subIds.length || subIds.includes(c.assuntoId)));
    const eligibleDue = mode === 'exact_only'
      ? eligibleDueAll.filter(c => c.hasOriginalQuestion !== false)
      : eligibleDueAll;

    const { picked, remainingQuota } = pickReviewsAlignedToMatrix({
      candidates: eligibleDue,
      maxSlots: reviewBudget,
      targetCounts,
      mode,
      effectiveLevel
    });

    let exactReviewCount = 0;
    let novelReviewCount = 0;

    picked.forEach(({ concept: rc, isExactReview, assignedNivel }) => {
      usedConceptIds.add(rc.id);
      if (isExactReview) exactReviewCount++;
      else novelReviewCount++;
      slots.push({
        slotIndex: slots.length,
        assuntoId: rc.assuntoId || primaryId,
        nivel: assignedNivel,
        isActiveReview: true,
        isExactReview,
        isErrorReinforcement: false,
        reviewConceptId: rc.id,
        conceitoChave: rc.conceitoChave || '',
        errorReasonType: rc.errorReasonType || '',
        errorReasonNote: rc.errorReasonNote || '',
        origin: rc.origin || 'error',
        srsStage: Number(rc.srsStage) || 0,
        pastEnunciadoSnippet: rc.pastEnunciadoSnippet || ''
      });
    });

    const totalActiveReviewsPicked = exactReviewCount + novelReviewCount;

    // 2. Nível 2 (Intermediário): se houve menos de 20% de revisões vencidas, completa até 20% com erros anteriores não vencidos
    let errorReinforcementCount = 0;
    if (!isValidationBattery && effectiveLevel === 2) {
      const targetErrorSlots = Math.round(qtd * 0.20);
      const extraNeeded = Math.max(0, targetErrorSlots - totalActiveReviewsPicked);
      if (extraNeeded > 0) {
        const eligiblePast = (Array.isArray(pastErrorConcepts) ? pastErrorConcepts : [])
          .filter(c => c && !usedConceptIds.has(c.id) && (!subIds.length || subIds.includes(c.assuntoId)));
        eligiblePast.slice(0, extraNeeded).forEach(rc => {
          usedConceptIds.add(rc.id);
          errorReinforcementCount++;
          const targetLvlCode = formatQuestionLevel(rc.targetLevel || 2, 2);
          if (remainingQuota[targetLvlCode] > 0) remainingQuota[targetLvlCode] -= 1;
          slots.push({
            slotIndex: slots.length,
            assuntoId: rc.assuntoId || primaryId,
            nivel: targetLvlCode,
            isActiveReview: false,
            isExactReview: false,
            isErrorReinforcement: true,
            reviewConceptId: rc.id,
            conceitoChave: rc.conceitoChave || '',
            errorReasonType: rc.errorReasonType || '',
            errorReasonNote: rc.errorReasonNote || '',
            origin: rc.origin || 'error',
            srsStage: Number(rc.srsStage) || 0,
            pastEnunciadoSnippet: rc.pastEnunciadoSnippet || ''
          });
        });
      }
    }

    // 3. Slots regulares (20%+ inéditas novas) preenchendo as vagas restantes da Matriz N1-N5
    const remainingTotal = Math.max(0, qtd - slots.length);
    const levelOrder = ['N1', 'N2', 'N3', 'N4', 'N5'];
    const regularLevels = [];

    // Primeiro consome as vagas ainda abertas em remainingQuota (priorizando níveis com maior déficit na Matriz)
    const openCopy = { ...remainingQuota };
    while (regularLevels.length < remainingTotal) {
      const openKeys = levelOrder.filter(k => openCopy[k] > 0);
      if (!openKeys.length) break;
      openKeys.sort((a, b) => (openCopy[b] - openCopy[a]) || ((pctMap[b] || 0) - (pctMap[a] || 0)));
      const pickKey = openKeys[0];
      regularLevels.push(pickKey);
      openCopy[pickKey] -= 1;
    }

    // Se ainda faltar alguma vaga (caso revisões tenham extrapolado a cota de algum nível), completa via Hamilton
    if (regularLevels.length < remainingTotal) {
      const extraCounts = distributeCountsHamilton(remainingTotal - regularLevels.length, pctMap);
      levelOrder.forEach(lvl => {
        for (let i = 0; i < extraCounts[lvl]; i++) regularLevels.push(lvl);
      });
    }

    // Mantém ordenação crescente de dificuldade (N1 -> N5) para os slots novos
    regularLevels.sort((a, b) => parseQuestionLevel(a) - parseQuestionLevel(b));

    const targetSubIds = isValidationBattery ? [primaryId] : (subIds.length ? subIds : [primaryId]);
    regularLevels.forEach((lvl, idx) => {
      const assuntoId = targetSubIds[idx % targetSubIds.length] || primaryId;
      slots.push({
        slotIndex: slots.length,
        assuntoId,
        nivel: lvl,
        isActiveReview: false,
        isExactReview: false,
        isErrorReinforcement: false,
        reviewConceptId: null,
        conceitoChave: '',
        errorReasonType: '',
        errorReasonNote: '',
        origin: 'new',
        srsStage: null
      });
    });

    const finalCounts = { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 };
    slots.forEach(s => {
      if (finalCounts[s.nivel] !== undefined) finalCounts[s.nivel] += 1;
    });

    const compositionMode = isValidationBattery
      ? 'validacao_manutencao'
      : (targetSubIds.length >= 3 ? 'intercalada' : (targetSubIds.length === 2 ? 'mista' : levelInfo.compositionMode));

    return {
      totalQtd: qtd,
      reviewMode: mode,
      reviewCap: reviewBudget,
      isCompleteBattery,
      baseLevel,
      effectiveLevel,
      frustrationDropApplied,
      isValidationBattery: Boolean(isValidationBattery),
      compositionMode,
      recommendedSubtopics: levelInfo.recommendedSubtopics,
      targetDistributionCounts: targetCounts,
      finalDistributionCounts: finalCounts,
      pendingDueTotal: eligibleDueAll.length,
      activeReviewCount: totalActiveReviewsPicked,
      exactReviewCount,
      novelReviewCount,
      errorReinforcementCount,
      newQuestionsCount: Math.max(0, qtd - totalActiveReviewsPicked - errorReinforcementCount),
      remainingDueAfterBattery: Math.max(0, eligibleDueAll.length - totalActiveReviewsPicked),
      slots
    };
  }

  function computeReviewConceptStatus(concept, todayISO) {
    const c = concept || {};
    const today = toISODate(todayISO);
    const isDoubtShort = c.origin === 'duvida' && !c.enteredErrorCycle;

    if (c.mastered) {
      return {
        stage: isDoubtShort ? 1 : SRS_ERROR_INTERVALS.length,
        stageLabel: 'Dominado',
        intervalDays: isDoubtShort ? DOUBT_REVIEW_DAYS : 25,
        due: false,
        overdue: false,
        mastered: true,
        diffDays: -999,
        nextDueISO: null,
        nextDueShort: '',
        isDoubtShort,
        label: isDoubtShort ? '✅ Dúvida consolidada' : '🏆 Dominado (Ciclo 1d→4d→10d→25d concluído)'
      };
    }

    const stage = isDoubtShort ? 0 : clamp(Math.round(Number(c.srsStage) || 0), 0, SRS_ERROR_INTERVALS.length - 1);
    const intervalDays = isDoubtShort ? DOUBT_REVIEW_DAYS : SRS_ERROR_INTERVALS[stage];
    const stageLabel = isDoubtShort ? '3d (Dúvida)' : SRS_ERROR_LABELS[stage];
    const dueISO = c.nextDueDate && /^\d{4}-\d{2}-\d{2}$/.test(c.nextDueDate)
      ? c.nextDueDate
      : addDaysISO(c.lastReviewDate || c.createdAt || today, intervalDays);

    const diffDays = diffDaysISO(today, dueISO);
    const due = diffDays >= 0;
    const overdue = diffDays >= 1;
    const parts = dueISO.split('-');
    const shortDt = `${parts[2]}/${parts[1]}`;

    let label = '';
    if (diffDays > 0) {
      label = `⏰ Atrasada (${diffDays}d) · ${stageLabel} era p/ ${shortDt}`;
    } else if (diffDays === 0) {
      label = `🔔 Revisar Hoje · ${stageLabel} (${shortDt})`;
    } else {
      label = `⏳ ${stageLabel} agendada p/ ${shortDt} (em ${Math.abs(diffDays)}d)`;
    }

    return {
      stage,
      stageLabel,
      intervalDays,
      due,
      overdue,
      mastered: false,
      diffDays,
      nextDueISO: dueISO,
      nextDueShort: shortDt,
      isDoubtShort,
      label
    };
  }

  function advanceReviewConcept(concept, { isCorrect, confidence = 'certeza', currentQuestionLevel, nowISO, todayISO } = {}) {
    const now = nowISO || new Date().toISOString();
    const today = toISODate(todayISO || now);
    const c = {
      ...concept,
      history: Array.isArray(concept && concept.history) ? concept.history.slice() : []
    };
    const qLevel = parseQuestionLevel(currentQuestionLevel || c.targetLevel || 2, 2);
    const conf = CONFIDENCE_OPTIONS[confidence] ? confidence : 'certeza';
    const isDoubtShort = c.origin === 'duvida' && !c.enteredErrorCycle;

    if (isCorrect && conf === 'certeza') {
      if (isDoubtShort) {
        c.mastered = true;
        c.srsStage = 1;
        c.nextDueDate = null;
      } else {
        const nextStage = (Number(c.srsStage) || 0) + 1;
        c.srsStage = Math.min(SRS_ERROR_INTERVALS.length, nextStage);
        if (c.srsStage >= SRS_ERROR_INTERVALS.length) {
          c.mastered = true;
          c.nextDueDate = null;
        } else {
          c.mastered = false;
          c.nextDueDate = addDaysISO(today, SRS_ERROR_INTERVALS[c.srsStage]);
        }
      }
      c.lastReviewDate = now;
    } else if (isCorrect && conf === 'duvida') {
      // Acerto com dúvida: mantém o estágio atual e entra na fila de revisão curta (3 dias)
      c.mastered = false;
      c.lastReviewDate = now;
      c.nextDueDate = addDaysISO(today, DOUBT_REVIEW_DAYS);
    } else {
      // Erro ou Chute na revisão: zera o erro (volta para 1 dia) e desce 1 nível para consolidar a regra
      c.enteredErrorCycle = true;
      c.mastered = false;
      c.srsStage = 0;
      c.targetLevel = Math.max(1, qLevel - 1);
      c.lastReviewDate = now;
      c.nextDueDate = addDaysISO(today, SRS_ERROR_INTERVALS[0]);
    }

    c.history.push({
      date: now,
      hit: Boolean(isCorrect),
      confidence: conf,
      questionLevel: formatQuestionLevel(qLevel),
      targetLevelAfter: formatQuestionLevel(c.targetLevel || qLevel),
      stageAfter: c.srsStage,
      nextDueDateAfter: c.nextDueDate
    });

    return {
      concept: c,
      status: computeReviewConceptStatus(c, today)
    };
  }

  function evaluateBatteryOutcome({
    masteryState,
    subtopicQuestions = [],
    fullBatterySize = 0,
    fullBatteryEffectivePct = null,
    isValidationBattery = false,
    nowISO,
    todayISO
  } = {}) {
    const now = nowISO || new Date().toISOString();
    const today = toISODate(todayISO || now);
    const decayed = applyTemporalDecay(masteryState, today);
    const scoreBefore = decayed.score;
    const levelBefore = decayed.level;
    const wasPendingDecay = decayed.decayStatus === 'pending_review';
    const peakBefore = decayed.maintenancePeakScore;

    let runningScore = scoreBefore;
    let deltaTotal = 0;
    let rawHits = 0;
    let effectiveHits = 0;
    const questionDeltas = [];

    (Array.isArray(subtopicQuestions) ? subtopicQuestions : []).forEach(q => {
      const isCorrect = Boolean(q && q.isCorrect);
      const confidence = (q && q.confidence) || 'certeza';
      const qLevel = parseQuestionLevel(q && (q.nivel || q.nivelInterno), levelBefore);
      const res = computeQuestionScoreDelta({
        studentLevel: levelBefore,
        questionLevel: qLevel,
        isCorrect,
        confidence
      });
      if (isCorrect) rawHits++;
      if (res.effectiveHit) effectiveHits++;
      runningScore = clamp(runningScore + res.delta, MIN_SCORE, MAX_SCORE);
      deltaTotal += res.delta;
      questionDeltas.push({ ...res, questionLevel: formatQuestionLevel(qLevel) });
    });

    const subQCount = subtopicQuestions.length;
    const effBatterySize = fullBatterySize > 0 ? fullBatterySize : subQCount;
    const isCompleteBattery = effBatterySize >= BATTERY_MIN_SIZE && effBatterySize <= BATTERY_MAX_SIZE;
    const subRawPct = subQCount > 0 ? Math.round((rawHits / subQCount) * 100) : 0;
    const subEffectivePct = subQCount > 0 ? Math.round((effectiveHits / subQCount) * 100) : 0;
    const batteryPctForLock = fullBatteryEffectivePct != null ? fullBatteryEffectivePct : subEffectivePct;

    let nextScore = runningScore;
    let nextLevel = levelBefore;
    let totalResolved = decayed.totalResolved + subQCount;
    let batteriesAtCurrentLevel = decayed.batteriesAtCurrentLevel + (isCompleteBattery ? 1 : 0);
    let frustrationDropActive = decayed.frustrationDropActive;
    let frustrationTriggered = false;
    let promoted = false;
    let demoted = false;
    let restoredFromDecay = false;
    let decayStatus = decayed.decayStatus;
    let maintenancePeakScore = peakBefore;

    // 1. Restauração de Decaimento em Manutenção: 1 bateria de validação (10+ questões) com >= 80% de acerto
    const qualifiesForDecayRestore = wasPendingDecay &&
      (isValidationBattery || subQCount >= MAINTENANCE_VALIDATION_MIN_Q) &&
      effBatterySize >= MAINTENANCE_VALIDATION_MIN_Q &&
      subEffectivePct >= MAINTENANCE_VALIDATION_PCT;

    if (qualifiesForDecayRestore) {
      nextScore = clamp(Math.max(nextScore, peakBefore || 850), 850, MAX_SCORE);
      nextLevel = 4;
      decayStatus = 'ok';
      maintenancePeakScore = null;
      frustrationDropActive = false;
      restoredFromDecay = true;
    } else {
      // 2. Trava de Frustração: fechar bateria completa com < 55% reduz 1 degrau na próxima
      if (isCompleteBattery) {
        if (batteryPctForLock < FRUSTRATION_THRESHOLD_PCT) {
          frustrationDropActive = true;
          frustrationTriggered = true;
        } else {
          frustrationDropActive = false;
        }
      }

      // 3. Promoção e Rebaixamento por faixa de pontuação (exige >= 10 questões e >= 1 bateria completa no nível atual)
      const targetLevelByScore = levelForScore(nextScore);
      if (targetLevelByScore > nextLevel) {
        if (totalResolved >= MIN_INITIAL_QUESTIONS && batteriesAtCurrentLevel >= 1) {
          nextLevel = Math.min(4, nextLevel + 1);
          batteriesAtCurrentLevel = 0;
          promoted = true;
          if (nextLevel === 4) {
            decayStatus = 'ok';
            maintenancePeakScore = null;
          }
        }
      } else if (targetLevelByScore < nextLevel) {
        // Se estava em manutenção com decaimento pendente (piso 750), mantém em revisão pendente se ainda >= 750
        if (!(wasPendingDecay && nextScore >= MAINTENANCE_DECAY_FLOOR)) {
          nextLevel = targetLevelByScore;
          batteriesAtCurrentLevel = 0;
          demoted = true;
          if (nextLevel < 4) {
            decayStatus = 'ok';
            maintenancePeakScore = null;
          }
        }
      }
    }

    const historyEntry = {
      date: now,
      scoreBefore,
      scoreAfter: nextScore,
      delta: nextScore - scoreBefore,
      levelBefore,
      levelAfter: nextLevel,
      rawPct: subRawPct,
      effectivePct: subEffectivePct,
      questionsCount: subQCount,
      batterySize: effBatterySize,
      promoted,
      demoted,
      frustrationTriggered,
      restoredFromDecay
    };

    const nextState = {
      score: nextScore,
      level: nextLevel,
      totalResolved,
      batteriesAtCurrentLevel,
      frustrationDropActive,
      lastActivityDate: now,
      maintenancePeakScore,
      decayStatus,
      updatedAt: now,
      scoreHistory: [...decayed.scoreHistory, historyEntry].slice(-50)
    };

    return {
      nextState,
      questionDeltas,
      summary: {
        scoreBefore,
        scoreAfter: nextScore,
        deltaTotal: nextScore - scoreBefore,
        rawDeltaSum: deltaTotal,
        levelBefore,
        levelAfter: nextLevel,
        promoted,
        demoted,
        frustrationTriggered,
        restoredFromDecay,
        rawPct: subRawPct,
        effectivePct: subEffectivePct,
        totalQuestions: subQCount,
        totalResolvedAfter: totalResolved,
        isCompleteBattery,
        lockedAtInitialMin: totalResolved < MIN_INITIAL_QUESTIONS && levelForScore(nextScore) > 1
      }
    };
  }

  function calibrateMasteryFromLegacyLogs(assuntoLogs) {
    const logs = (Array.isArray(assuntoLogs) ? assuntoLogs : [])
      .filter(l => l && !l.primeiroEstudo && Number(l.total) > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const st = createDefaultSubtopicMastery();
    if (!logs.length) return st;

    const totalResolved = logs.reduce((acc, l) => acc + (Number(l.total) || 0), 0);
    const totalHits = logs.reduce((acc, l) => acc + (Number(l.acertos) || 0), 0);
    const pct = totalResolved > 0 ? (totalHits / totalResolved) * 100 : 0;
    let estScore = INITIAL_SCORE;
    if (totalResolved >= MIN_INITIAL_QUESTIONS) {
      // Estimativa conservadora entre 200 e 820 (nunca salta direto para Manutenção sem validação no novo motor)
      estScore = clamp(Math.round(150 + pct * 6.8), 100, 820);
    }
    const estLevel = totalResolved >= MIN_INITIAL_QUESTIONS ? Math.min(3, levelForScore(estScore)) : 1;
    const lastLog = logs[logs.length - 1];
    return {
      ...st,
      score: estScore,
      level: estLevel,
      totalResolved,
      batteriesAtCurrentLevel: logs.length >= 1 ? 1 : 0,
      lastActivityDate: lastLog ? lastLog.date : null,
      updatedAt: new Date().toISOString()
    };
  }

  const api = {
    QUESTION_LEVELS,
    STUDENT_LEVELS,
    BATTERY_DISTRIBUTION,
    INITIAL_SCORE,
    MIN_SCORE,
    MAX_SCORE,
    MIN_INITIAL_QUESTIONS,
    BATTERY_MIN_SIZE,
    BATTERY_MAX_SIZE,
    ACTIVE_REVIEW_MAX_RATIO,
    FRUSTRATION_THRESHOLD_PCT,
    MAINTENANCE_DECAY_GRACE_DAYS,
    MAINTENANCE_DECAY_PER_DAY,
    MAINTENANCE_DECAY_FLOOR,
    MAINTENANCE_VALIDATION_MIN_Q,
    MAINTENANCE_VALIDATION_PCT,
    SRS_ERROR_INTERVALS,
    SRS_ERROR_LABELS,
    DOUBT_REVIEW_DAYS,
    CONFIDENCE_OPTIONS,
    ERROR_REASON_TYPES,
    toISODate,
    addDaysISO,
    diffDaysISO,
    parseQuestionLevel,
    formatQuestionLevel,
    getQuestionLevelInfo,
    levelForScore,
    getStudentLevelInfo,
    createDefaultSubtopicMastery,
    normalizeSubtopicMastery,
    applyTemporalDecay,
    computeQuestionScoreDelta,
    distributeCountsHamilton,
    planBatterySlots,
    computeReviewConceptStatus,
    advanceReviewConcept,
    evaluateBatteryOutcome,
    calibrateMasteryFromLegacyLogs
  };

  root.AdaptiveEngine = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
