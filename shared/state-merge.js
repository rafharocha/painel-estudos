import { normalizeSubtopicMastery } from './adaptive-engine.js';

export function toTimestamp(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return Number.isFinite(t) ? t : 0;
}

function maxIsoTimestamp(a, b) {
  const ta = toTimestamp(a);
  const tb = toTimestamp(b);
  if (!ta && !tb) return null;
  return tb > ta ? b : a;
}

export function isStateEffectivelyEmpty(st) {
  if (!st || st.v !== 2 || !st.bank || typeof st.bank !== 'object') return true;
  const editais = Array.isArray(st.editais) ? st.editais : [];
  if (editais.length === 0) return true;
  const hasRealContent = Object.values(st.bank).some((c) => {
    if (!c || typeof c !== 'object') return false;
    return (
      (Array.isArray(c.materias) && c.materias.length > 0) ||
      (Array.isArray(c.assuntos) && c.assuntos.length > 0) ||
      (Array.isArray(c.schedule) && c.schedule.length > 0) ||
      (Array.isArray(c.log) && c.log.length > 0) ||
      (Array.isArray(c.offlinePacks) && c.offlinePacks.length > 0) ||
      (Array.isArray(c.reviewConcepts) && c.reviewConcepts.length > 0) ||
      (c.subtopicMastery && Object.keys(c.subtopicMastery).length > 0) ||
      (c.cadernoAssuntos && Object.keys(c.cadernoAssuntos).length > 0) ||
      (c.flashcardRatings && Object.keys(c.flashcardRatings).length > 0)
    );
  });
  return !hasRealContent;
}

export function mergePendingDoubts(listA = [], listB = []) {
  const map = new Map();
  const add = (item) => {
    if (!item || !item.pergunta) return;
    const key = item.id || item.pergunta.trim().toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...item });
      return;
    }
    if (item.status === 'done' && prev.status !== 'done') {
      map.set(key, { ...prev, ...item });
    } else if (prev.status !== 'done' && toTimestamp(item.updatedAt || item.createdAt) > toTimestamp(prev.updatedAt || prev.createdAt)) {
      map.set(key, { ...prev, ...item });
    }
  };
  (Array.isArray(listA) ? listA : []).forEach(add);
  (Array.isArray(listB) ? listB : []).forEach(add);
  return Array.from(map.values());
}

export function mergeChatHistory(listA = [], listB = []) {
  const seen = new Set();
  const out = [];
  const add = (c) => {
    if (!c || !c.pergunta) return;
    const key = `${String(c.pergunta).trim()}||${String(c.resposta || '').trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  (Array.isArray(listA) ? listA : []).forEach(add);
  (Array.isArray(listB) ? listB : []).forEach(add);
  return out;
}

export function mergeErrorItem(srvErr, cliErr) {
  if (!srvErr) return cliErr;
  if (!cliErr) return srvErr;
  const srvSrsTime = toTimestamp(srvErr.srsLastReviewDate);
  const cliSrsTime = toTimestamp(cliErr.srsLastReviewDate);
  const srvHistLen = Array.isArray(srvErr.srsHistory) ? srvErr.srsHistory.length : 0;
  const cliHistLen = Array.isArray(cliErr.srsHistory) ? cliErr.srsHistory.length : 0;
  const useCliSrs = cliHistLen > srvHistLen || (cliHistLen === srvHistLen && cliSrsTime >= srvSrsTime);

  const srvAnalise = String(srvErr.analiseIA || '');
  const cliAnalise = String(cliErr.analiseIA || '');
  const analiseIA = cliAnalise.length >= srvAnalise.length ? (cliAnalise || srvAnalise) : srvAnalise;
  const resumoMentor = (cliErr.resumoMentor && cliErr.resumoMentor.length >= (srvErr.resumoMentor || '').length)
    ? cliErr.resumoMentor
    : (srvErr.resumoMentor || cliErr.resumoMentor || '');

  const autopsiaPendente = analiseIA
    ? (Boolean(srvErr.autopsiaPendente) && Boolean(cliErr.autopsiaPendente))
    : (Boolean(srvErr.autopsiaPendente) || Boolean(cliErr.autopsiaPendente));

  const duvidasPendentes = mergePendingDoubts(srvErr.duvidasPendentes, cliErr.duvidasPendentes);
  const chatHistory = mergeChatHistory(srvErr.chatHistory, cliErr.chatHistory);

  return {
    ...srvErr,
    ...cliErr,
    analiseIA,
    resumoMentor,
    autopsiaPendente,
    alertaGabaritoIA: cliErr.alertaGabaritoIA || srvErr.alertaGabaritoIA || '',
    duvidasPendentes,
    chatHistory,
    comentario: (cliErr.comentario || '').length >= (srvErr.comentario || '').length ? (cliErr.comentario || srvErr.comentario || '') : srvErr.comentario,
    errorReasonType: cliErr.errorReasonType || srvErr.errorReasonType || '',
    errorReasonNote: (cliErr.errorReasonNote || '').length >= (srvErr.errorReasonNote || '').length ? (cliErr.errorReasonNote || srvErr.errorReasonNote || '') : srvErr.errorReasonNote,
    revisado: useCliSrs ? Boolean(cliErr.revisado) : Boolean(srvErr.revisado),
    srsStage: useCliSrs ? cliErr.srsStage : srvErr.srsStage,
    srsLastReviewDate: useCliSrs ? cliErr.srsLastReviewDate : srvErr.srsLastReviewDate,
    srsNextDueDate: useCliSrs ? cliErr.srsNextDueDate : srvErr.srsNextDueDate,
    srsHistory: useCliSrs ? (cliErr.srsHistory || srvErr.srsHistory || []) : (srvErr.srsHistory || cliErr.srsHistory || [])
  };
}

export function mergePendingHitItems(listA = [], listB = []) {
  const map = new Map();
  const add = (item) => {
    if (!item || !item.id) return;
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, { ...item });
      return;
    }
    const analiseIA = (item.analiseIA || '').length >= (prev.analiseIA || '').length ? (item.analiseIA || prev.analiseIA || '') : prev.analiseIA;
    map.set(item.id, {
      ...prev,
      ...item,
      analiseIA,
      autopsiaPendente: analiseIA ? false : (Boolean(prev.autopsiaPendente) || Boolean(item.autopsiaPendente)),
      duvidasPendentes: mergePendingDoubts(prev.duvidasPendentes, item.duvidasPendentes),
      chatHistory: mergeChatHistory(prev.chatHistory, item.chatHistory)
    });
  };
  (Array.isArray(listA) ? listA : []).forEach(add);
  (Array.isArray(listB) ? listB : []).forEach(add);
  return Array.from(map.values());
}

export function mergeLogEntries(srvLogs = [], cliLogs = []) {
  const map = new Map();
  (Array.isArray(srvLogs) ? srvLogs : []).forEach(l => {
    if (l && l.id) map.set(l.id, l);
  });
  (Array.isArray(cliLogs) ? cliLogs : []).forEach(cliL => {
    if (!cliL || !cliL.id) return;
    const srvL = map.get(cliL.id);
    if (!srvL) {
      map.set(cliL.id, cliL);
      return;
    }
    const maxErrLen = Math.max((srvL.errors || []).length, (cliL.errors || []).length);
    const mergedErrors = [];
    for (let i = 0; i < maxErrLen; i++) {
      mergedErrors.push(mergeErrorItem((srvL.errors || [])[i], (cliL.errors || [])[i]));
    }
    let mergedCaderno = srvL.caderno || cliL.caderno;
    if (srvL.caderno && cliL.caderno) {
      if (srvL.caderno.status === 'aprovado' && cliL.caderno.status !== 'aprovado') {
        mergedCaderno = srvL.caderno;
      } else if (cliL.caderno.status === 'aprovado' && srvL.caderno.status !== 'aprovado') {
        mergedCaderno = cliL.caderno;
      } else {
        mergedCaderno = ((cliL.caderno.analise || '').length >= (srvL.caderno.analise || '').length) ? cliL.caderno : srvL.caderno;
      }
    }
    const mergedHitItems = mergePendingHitItems(srvL.pendingHitItems, cliL.pendingHitItems);
    map.set(cliL.id, {
      ...srvL,
      ...cliL,
      errors: mergedErrors,
      ...(mergedCaderno ? { caderno: mergedCaderno } : {}),
      ...(mergedHitItems.length ? { pendingHitItems: mergedHitItems } : {})
    });
  });
  return Array.from(map.values()).sort((a, b) => toTimestamp(b.date) - toTimestamp(a.date));
}

function questionProgressRank(q) {
  if (!q) return 0;
  let score = 0;
  if (q.confirmed) score += 100;
  if (q.selectedLetter) score += 20;
  if (q.confidence) score += 10;
  if (q.errorReasonNote) score += 5;
  if (q.errorReasonType) score += 3;
  if (q.analiseIA) score += 5;
  return score;
}

function mergeSimQuestion(srvQ, cliQ, cliPackNewer) {
  if (!srvQ) return cliQ;
  if (!cliQ) return srvQ;

  const srvRank = questionProgressRank(srvQ);
  const cliRank = questionProgressRank(cliQ);
  const useCli = cliRank > srvRank || (cliRank === srvRank && cliPackNewer);
  const base = useCli ? cliQ : srvQ;
  const other = useCli ? srvQ : cliQ;

  const srvAnalise = String(srvQ.analiseIA || '');
  const cliAnalise = String(cliQ.analiseIA || '');
  const analiseIA = cliAnalise.length >= srvAnalise.length ? (cliAnalise || srvAnalise) : srvAnalise;

  const srvResumo = String(srvQ.resumoMentor || '');
  const cliResumo = String(cliQ.resumoMentor || '');
  const resumoMentor = cliResumo.length >= srvResumo.length ? (cliResumo || srvResumo) : srvResumo;

  const srvNote = String(srvQ.errorReasonNote || '');
  const cliNote = String(cliQ.errorReasonNote || '');
  const errorReasonNote = cliNote.length >= srvNote.length ? (cliNote || srvNote) : srvNote;

  const struckSet = new Set([
    ...(Array.isArray(srvQ.struck) ? srvQ.struck : []),
    ...(Array.isArray(cliQ.struck) ? cliQ.struck : [])
  ]);

  const autopsiaPendente = analiseIA
    ? (Boolean(srvQ.autopsiaPendente) && Boolean(cliQ.autopsiaPendente))
    : (Boolean(srvQ.autopsiaPendente) || Boolean(cliQ.autopsiaPendente));

  return {
    ...other,
    ...base,
    confirmed: Boolean(srvQ.confirmed) || Boolean(cliQ.confirmed),
    selectedLetter: base.selectedLetter || other.selectedLetter || '',
    confidence: base.confidence || other.confidence || '',
    errorReasonType: base.errorReasonType || other.errorReasonType || '',
    errorReasonNote,
    analiseIA,
    resumoMentor,
    autopsiaPendente,
    struck: Array.from(struckSet),
    duvidasPendentes: mergePendingDoubts(srvQ.duvidasPendentes, cliQ.duvidasPendentes),
    chatHistory: mergeChatHistory(srvQ.chatHistory, cliQ.chatHistory)
  };
}

function mergeSingleOfflinePack(srvPack, cliPack) {
  if (!srvPack) return cliPack;
  if (!cliPack) return srvPack;

  const isTerminal = (st) => st === 'completed' || st === 'deleted';
  const srvTerm = isTerminal(srvPack.status);
  const cliTerm = isTerminal(cliPack.status);

  // Estado terminal (concluído ou excluído) sempre prevalece sobre pendente/em andamento
  if (srvTerm && !cliTerm) return srvPack;
  if (cliTerm && !srvTerm) return cliPack;
  if (srvTerm && cliTerm) {
    if (srvPack.status === 'completed' && cliPack.status !== 'completed') return srvPack;
    if (cliPack.status === 'completed' && srvPack.status !== 'completed') return cliPack;
    return toTimestamp(cliPack.updatedAt || cliPack.createdAt) >= toTimestamp(srvPack.updatedAt || srvPack.createdAt)
      ? cliPack
      : srvPack;
  }

  // Ambos ativos (ready / in_progress): faz merge questão a questão para nunca perder respostas offline
  const srvTime = toTimestamp(srvPack.updatedAt || srvPack.createdAt);
  const cliTime = toTimestamp(cliPack.updatedAt || cliPack.createdAt);
  const cliPackNewer = cliTime >= srvTime;

  const srvQs = Array.isArray(srvPack.questions) ? srvPack.questions : [];
  const cliQs = Array.isArray(cliPack.questions) ? cliPack.questions : [];
  const maxLen = Math.max(srvQs.length, cliQs.length);
  const mergedQuestions = [];
  for (let i = 0; i < maxLen; i++) {
    mergedQuestions.push(mergeSimQuestion(srvQs[i], cliQs[i], cliPackNewer));
  }

  const srvConf = srvQs.filter(q => q && q.confirmed).length;
  const cliConf = cliQs.filter(q => q && q.confirmed).length;
  const mergedConf = mergedQuestions.filter(q => q && q.confirmed).length;
  const elapsedSeconds = Math.max(Number(srvPack.elapsedSeconds) || 0, Number(cliPack.elapsedSeconds) || 0);

  let currentIndex = cliPackNewer ? (cliPack.currentIndex || 0) : (srvPack.currentIndex || 0);
  if (cliConf > srvConf) currentIndex = cliPack.currentIndex || 0;
  else if (srvConf > cliConf) currentIndex = srvPack.currentIndex || 0;
  if (mergedQuestions.length > 0) {
    currentIndex = Math.max(0, Math.min(currentIndex, mergedQuestions.length - 1));
  }

  const status = (mergedConf > 0 || elapsedSeconds > 0 || srvPack.status === 'in_progress' || cliPack.status === 'in_progress')
    ? 'in_progress'
    : 'ready';

  const base = (cliConf > srvConf || (cliConf === srvConf && cliPackNewer)) ? cliPack : srvPack;
  const other = base === cliPack ? srvPack : cliPack;

  return {
    ...other,
    ...base,
    status,
    elapsedSeconds,
    currentIndex,
    updatedAt: maxIsoTimestamp(srvPack.updatedAt || srvPack.createdAt, cliPack.updatedAt || cliPack.createdAt) || new Date().toISOString(),
    questions: mergedQuestions
  };
}

export function mergeOfflinePacks(srvPacks = [], cliPacks = []) {
  const map = new Map();
  const isTerminal = (st) => st === 'completed' || st === 'deleted';
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  (Array.isArray(srvPacks) ? srvPacks : []).forEach(p => {
    if (p && p.id) map.set(p.id, p);
  });
  (Array.isArray(cliPacks) ? cliPacks : []).forEach(p => {
    if (!p || !p.id) return;
    map.set(p.id, mergeSingleOfflinePack(map.get(p.id), p));
  });

  return Array.from(map.values())
    .filter(p => {
      if (isTerminal(p.status)) {
        const age = now - toTimestamp(p.updatedAt || p.createdAt);
        return age <= thirtyDaysMs;
      }
      return true;
    })
    .sort((a, b) => toTimestamp(b.updatedAt || b.createdAt) - toTimestamp(a.updatedAt || a.createdAt));
}

export function mergeByIdPreservingBase(baseList = [], extraList = [], requiredIds = null) {
  const map = new Map();
  (Array.isArray(baseList) ? baseList : []).forEach(item => {
    if (item && item.id) map.set(item.id, item);
  });
  (Array.isArray(extraList) ? extraList : []).forEach(item => {
    if (!item || !item.id || map.has(item.id)) return;
    if (!requiredIds || requiredIds.has(item.id)) {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

export function mergeCadernoAssuntos(srvObj = {}, cliObj = {}) {
  const out = { ...(srvObj || {}) };
  Object.entries(cliObj || {}).forEach(([assuntoId, cliVal]) => {
    const srvVal = out[assuntoId];
    if (!srvVal) {
      out[assuntoId] = cliVal;
      return;
    }
    const srvSintTime = toTimestamp(srvVal.sintese && srvVal.sintese.updatedAt);
    const cliSintTime = toTimestamp(cliVal.sintese && cliVal.sintese.updatedAt);
    const cliNota = cliVal.notaPessoal !== undefined ? String(cliVal.notaPessoal) : '';
    const srvNota = srvVal.notaPessoal !== undefined ? String(srvVal.notaPessoal) : '';
    out[assuntoId] = {
      ...srvVal,
      ...cliVal,
      notaPessoal: cliNota.length >= srvNota.length ? (cliNota || srvNota) : srvNota,
      sintese: cliSintTime >= srvSintTime ? (cliVal.sintese || srvVal.sintese) : srvVal.sintese
    };
  });
  return out;
}

export function mergeFlashcardRatings(srvObj = {}, cliObj = {}) {
  const out = { ...(srvObj || {}) };
  Object.entries(cliObj || {}).forEach(([k, cliVal]) => {
    const srvVal = out[k];
    if (!srvVal) {
      out[k] = cliVal;
      return;
    }
    const srvT = toTimestamp(srvVal && srvVal.updatedAt);
    const cliT = toTimestamp(cliVal && cliVal.updatedAt);
    out[k] = cliT >= srvT ? cliVal : srvVal;
  });
  return out;
}

export function mergeSubtopicMastery(srvObj = {}, cliObj = {}) {
  const out = {};
  const keys = new Set([...Object.keys(srvObj || {}), ...Object.keys(cliObj || {})]);
  keys.forEach((assuntoId) => {
    const srvVal = srvObj && srvObj[assuntoId] ? normalizeSubtopicMastery(srvObj[assuntoId]) : null;
    const cliVal = cliObj && cliObj[assuntoId] ? normalizeSubtopicMastery(cliObj[assuntoId]) : null;
    if (!srvVal) { out[assuntoId] = cliVal; return; }
    if (!cliVal) { out[assuntoId] = srvVal; return; }

    const srvT = toTimestamp(srvVal.updatedAt || srvVal.lastActivityDate);
    const cliT = toTimestamp(cliVal.updatedAt || cliVal.lastActivityDate);
    // totalResolved cresce monotonicamente durante estudos; isso protege contra diferença de relógio entre dispositivos
    let useCli;
    if (cliVal.totalResolved !== srvVal.totalResolved) {
      useCli = cliVal.totalResolved > srvVal.totalResolved;
    } else {
      useCli = cliT >= srvT;
    }
    const winner = useCli ? cliVal : srvVal;

    const histSeen = new Set();
    const mergedHistory = [...(srvVal.scoreHistory || []), ...(cliVal.scoreHistory || [])]
      .filter((h) => {
        if (!h || !h.date) return false;
        const key = `${h.date}|${h.scoreAfter}|${h.questionsCount}`;
        if (histSeen.has(key)) return false;
        histSeen.add(key);
        return true;
      })
      .sort((a, b) => toTimestamp(a.date) - toTimestamp(b.date))
      .slice(-50);

    out[assuntoId] = {
      ...winner,
      scoreHistory: mergedHistory
    };
  });
  return out;
}

export function mergeReviewConcepts(srvList = [], cliList = []) {
  const map = new Map();
  const mergeHist = (hA = [], hB = []) => {
    const seen = new Set();
    const out = [];
    const add = (entry) => {
      if (!entry) return;
      const key = `${entry.date || ''}|${entry.result || entry.confidence || ''}|${entry.stageAfter ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(entry);
    };
    (Array.isArray(hA) ? hA : []).forEach(add);
    (Array.isArray(hB) ? hB : []).forEach(add);
    return out.sort((a, b) => toTimestamp(a.date) - toTimestamp(b.date));
  };
  const pickBetter = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const aLen = Array.isArray(a.history) ? a.history.length : 0;
    const bLen = Array.isArray(b.history) ? b.history.length : 0;
    const aTime = toTimestamp(a.lastReviewDate || a.updatedAt || a.createdAt);
    const bTime = toTimestamp(b.lastReviewDate || b.updatedAt || b.createdAt);
    const useB = (bLen > aLen) || (bLen === aLen && bTime >= aTime);
    const mergedHistory = mergeHist(a.history, b.history);
    return useB
      ? { ...a, ...b, history: mergedHistory }
      : { ...b, ...a, history: mergedHistory };
  };
  (Array.isArray(srvList) ? srvList : []).forEach((item) => {
    if (item && item.id) map.set(item.id, item);
  });
  (Array.isArray(cliList) ? cliList : []).forEach((item) => {
    if (!item || !item.id) return;
    map.set(item.id, pickBetter(map.get(item.id), item));
  });
  return Array.from(map.values());
}

export function mergeEditalContainer(srvC, cliC, clientIsNewer) {
  if (!srvC) return cliC;
  if (!cliC) return srvC;

  const mergedLog = mergeLogEntries(srvC.log, cliC.log);
  const mergedPacks = mergeOfflinePacks(srvC.offlinePacks, cliC.offlinePacks);
  const mergedMastery = mergeSubtopicMastery(srvC.subtopicMastery, cliC.subtopicMastery);
  const mergedReviewConcepts = mergeReviewConcepts(srvC.reviewConcepts, cliC.reviewConcepts);

  const refMateriaIds = new Set();
  const refAssuntoIds = new Set();
  mergedLog.forEach(l => {
    if (l.materiaId) refMateriaIds.add(l.materiaId);
    if (l.assuntoId) refAssuntoIds.add(l.assuntoId);
  });
  mergedPacks.forEach(p => {
    if (p.materiaId) refMateriaIds.add(p.materiaId);
    (p.assuntoIds || []).forEach(id => refAssuntoIds.add(id));
  });
  Object.keys(mergedMastery).forEach(id => refAssuntoIds.add(id));
  mergedReviewConcepts.forEach(rc => {
    if (rc.materiaId) refMateriaIds.add(rc.materiaId);
    if (rc.assuntoId) refAssuntoIds.add(rc.assuntoId);
  });

  const materias = clientIsNewer
    ? mergeByIdPreservingBase(cliC.materias, srvC.materias, refMateriaIds)
    : mergeByIdPreservingBase(srvC.materias, cliC.materias, refMateriaIds);
  const assuntos = clientIsNewer
    ? mergeByIdPreservingBase(cliC.assuntos, srvC.assuntos, refAssuntoIds)
    : mergeByIdPreservingBase(srvC.assuntos, cliC.assuntos, refAssuntoIds);
  const schedule = clientIsNewer
    ? (cliC.schedule || srvC.schedule || [])
    : (srvC.schedule || cliC.schedule || []);

  return {
    ...(clientIsNewer ? srvC : cliC),
    ...(clientIsNewer ? cliC : srvC),
    materias,
    assuntos,
    schedule,
    log: mergedLog,
    offlinePacks: mergedPacks,
    subtopicMastery: mergedMastery,
    reviewConcepts: mergedReviewConcepts,
    fired: { ...(srvC.fired || {}), ...(cliC.fired || {}) },
    cadernoAssuntos: mergeCadernoAssuntos(srvC.cadernoAssuntos, cliC.cadernoAssuntos),
    flashcardRatings: mergeFlashcardRatings(srvC.flashcardRatings, cliC.flashcardRatings),
    config: clientIsNewer ? { ...(srvC.config || {}), ...(cliC.config || {}) } : { ...(cliC.config || {}), ...(srvC.config || {}) },
    metas: clientIsNewer ? { ...(srvC.metas || {}), ...(cliC.metas || {}) } : { ...(cliC.metas || {}), ...(srvC.metas || {}) }
  };
}

export function mergePanelStates(serverState, clientState, { baseRev = null, serverRev = 0 } = {}) {
  if (!serverState || serverState.v !== 2 || !serverState.bank) return clientState;
  if (!clientState || clientState.v !== 2 || !clientState.bank) return serverState;
  if (isStateEffectivelyEmpty(clientState) && !isStateEffectivelyEmpty(serverState)) {
    return serverState;
  }

  const srvModTime = toTimestamp(serverState.meta && (serverState.meta.localModifiedAt || serverState.meta.updatedAt));
  const hasExplicitCliMod = Boolean(clientState.meta && clientState.meta.localModifiedAt);
  const cliModTime = hasExplicitCliMod
    ? toTimestamp(clientState.meta.localModifiedAt)
    : ((typeof baseRev === 'number' && baseRev >= serverRev) ? toTimestamp(clientState.meta && clientState.meta.updatedAt) : 0);
  const clientIsNewer = cliModTime > srvModTime || (cliModTime === srvModTime && typeof baseRev === 'number' && baseRev >= serverRev);

  const editalMap = new Map();
  (Array.isArray(serverState.editais) ? serverState.editais : []).forEach(e => {
    if (e && e.id) editalMap.set(e.id, e);
  });
  (Array.isArray(clientState.editais) ? clientState.editais : []).forEach(e => {
    if (!e || !e.id) return;
    if (!editalMap.has(e.id) || clientIsNewer) {
      editalMap.set(e.id, { ...(editalMap.get(e.id) || {}), ...e });
    }
  });
  const mergedEditais = Array.from(editalMap.values());
  const mergedBank = {};
  mergedEditais.forEach(e => {
    mergedBank[e.id] = mergeEditalContainer(serverState.bank[e.id], clientState.bank[e.id], clientIsNewer);
  });

  const activeEdital = mergedEditais.some(e => e.id === clientState.activeEdital)
    ? clientState.activeEdital
    : (mergedEditais.some(e => e.id === serverState.activeEdital) ? serverState.activeEdital : (mergedEditais[0] && mergedEditais[0].id));

  const latestMod = maxIsoTimestamp(
    serverState.meta && (serverState.meta.localModifiedAt || serverState.meta.updatedAt),
    clientState.meta && clientState.meta.localModifiedAt
  );

  return {
    v: 2,
    editais: mergedEditais,
    activeEdital,
    bank: mergedBank,
    ui: { ...(serverState.ui || {}), ...(clientState.ui || {}) },
    meta: {
      ...(serverState.meta || {}),
      ...(clientState.meta || {}),
      ...(latestMod ? { localModifiedAt: latestMod } : {})
    }
  };
}

export function resolveSyncState({
  serverState,
  clientState,
  hasOfflineChanges = false,
  baseRev = null,
  forceReplace = false,
  nowIso = new Date().toISOString()
}) {
  const serverRev = Number(serverState && serverState.meta && serverState.meta.rev) || 0;

  if (!serverState) {
    const toSave = {
      ...clientState,
      meta: {
        ...(clientState.meta || {}),
        rev: 1,
        updatedAt: nowIso
      }
    };
    return { state: toSave, rev: 1, merged: false, skippedEmptyClient: false };
  }

  if (forceReplace) {
    const nextRev = serverRev + 1;
    const toSave = {
      ...clientState,
      meta: {
        ...(clientState.meta || {}),
        rev: nextRev,
        updatedAt: nowIso,
        localModifiedAt: (clientState.meta && clientState.meta.localModifiedAt) || nowIso
      }
    };
    return { state: toSave, rev: nextRev, merged: false, skippedEmptyClient: false };
  }

  // Proteção crítica: um cliente recém-aberto/vazio nunca pode sobrescrever dados reais do servidor
  if (isStateEffectivelyEmpty(clientState) && !isStateEffectivelyEmpty(serverState)) {
    return { state: serverState, rev: serverRev, merged: true, skippedEmptyClient: true };
  }

  const clientIsUpToDate = !hasOfflineChanges && typeof baseRev === 'number' && baseRev === serverRev;
  const needsMerge = !clientIsUpToDate;
  const nextRev = serverRev + 1;
  const finalState = needsMerge
    ? mergePanelStates(serverState, clientState, { baseRev, serverRev })
    : clientState;

  const latestMod = maxIsoTimestamp(
    finalState.meta && finalState.meta.localModifiedAt,
    serverState.meta && serverState.meta.localModifiedAt
  );

  finalState.meta = {
    ...(finalState.meta || {}),
    rev: nextRev,
    updatedAt: nowIso,
    ...(latestMod ? { localModifiedAt: latestMod } : {})
  };

  return { state: finalState, rev: nextRev, merged: needsMerge, skippedEmptyClient: false };
}
