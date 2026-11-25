import crypto from 'crypto';
import { formatQuestionLevel, parseQuestionLevel } from './adaptive-engine.js';

const LETTER_REF_REGEX = /\b(alternativas?|itens?|letras?|op[çc][õo]es)\s+[A-E]\b|\b[A-E]\s+e\s+[A-E]\b|todas\s+as\s+(anteriores|acima|alternativas|demais)|nenhuma\s+das\s+(anteriores|acima|alternativas|demais)|est[áa]\s+corret[ao]\s+apenas\s+[A-E]/i;

export function normalizeTextForFingerprint(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeQuestionFingerprint({ editalId = 'default', enunciado = '' } = {}) {
  const normStem = normalizeTextForFingerprint(enunciado);
  if (!normStem) return '';
  const payload = `${String(editalId || 'default').trim()}||${normStem}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export function generateBankQuestionId() {
  return `qb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function normalizeAlternativas(rawAlts) {
  if (!Array.isArray(rawAlts)) return [];
  return rawAlts
    .filter((a) => a && typeof a === 'object' && a.letra && a.texto !== undefined)
    .map((a) => ({
      letra: String(a.letra).trim().toUpperCase(),
      texto: String(a.texto).trim()
    }))
    .filter((a) => a.letra && a.texto);
}

export function detectQuestionFormat(alternativas, fallback = 'multipla_escolha') {
  const alts = normalizeAlternativas(alternativas);
  if (alts.length === 2) {
    const letters = alts.map((a) => a.letra).sort().join('');
    if (letters === 'CE') return 'certo_errado';
  }
  if (fallback === 'certo_errado') return 'certo_errado';
  return 'multipla_escolha';
}

export function parseSavedErrorTextToParts(err) {
  if (!err || typeof err !== 'object') return null;

  const existingAlts = normalizeAlternativas(err.alternativas);
  const existingStem = String(err.enunciado || '').trim();
  const rawCorreta = String(err.correta || '').trim().toUpperCase();

  if (existingStem && existingAlts.length >= 2) {
    const validCorreta = existingAlts.some((a) => a.letra === rawCorreta)
      ? rawCorreta
      : existingAlts[0].letra;
    return {
      enunciado: existingStem,
      alternativas: existingAlts,
      correta: validCorreta
    };
  }

  const raw = String(err.texto || '').trim();
  if (!raw || raw.length < 15) return null;

  const lines = raw.split(/\r?\n/);
  const stemLines = [];
  const alts = [];
  let currentAlt = null;
  const altRegex = /^\s*(?:\(([A-Ea-e])\)|([A-Ea-e])\s*[\)\.\-:])\s*(.+)$/;

  for (const line of lines) {
    const m = line.match(altRegex);
    if (m) {
      const letra = (m[1] || m[2]).toUpperCase();
      const texto = m[3].trim();
      currentAlt = { letra, texto };
      alts.push(currentAlt);
    } else if (currentAlt) {
      currentAlt.texto += '\n' + line.trim();
    } else {
      stemLines.push(line);
    }
  }

  if (alts.length >= 2) {
    const stem = stemLines.join('\n').trim() || raw;
    const normAlts = normalizeAlternativas(alts);
    if (normAlts.length >= 2) {
      const validCorreta = normAlts.some((a) => a.letra === rawCorreta)
        ? rawCorreta
        : normAlts[0].letra;
      return {
        enunciado: stem,
        alternativas: normAlts,
        correta: validCorreta
      };
    }
  }

  // Aceita questões Certo/Errado coladas sem linhas de alternativa explícitas
  if ((rawCorreta === 'C' || rawCorreta === 'E') && raw.length >= 20) {
    return {
      enunciado: raw,
      alternativas: [
        { letra: 'C', texto: 'Certo' },
        { letra: 'E', texto: 'Errado' }
      ],
      correta: rawCorreta
    };
  }

  return null;
}

export function normalizeBankQuestionRow(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const enunciado = String(raw.enunciado || '').trim();
  const alternativas = normalizeAlternativas(raw.alternativas);
  if (!enunciado || alternativas.length < 2) return null;

  const editalId = String(raw.edital_id ?? raw.editalId ?? defaults.editalId ?? 'default').trim() || 'default';
  const fingerprint = String(raw.fingerprint || '').trim() || computeQuestionFingerprint({ editalId, enunciado });
  if (!fingerprint) return null;

  const rawCorreta = String(raw.correta || '').trim().toUpperCase();
  const correta = alternativas.some((a) => a.letra === rawCorreta) ? rawCorreta : alternativas[0].letra;
  const nowIso = defaults.nowIso || new Date().toISOString();

  const materiaId = raw.materia_id ?? raw.materiaId ?? defaults.materiaId ?? null;
  const assuntoId = raw.assunto_id ?? raw.assuntoId ?? defaults.assuntoId ?? null;
  const formato = detectQuestionFormat(alternativas, raw.formato || defaults.formato);
  const nivel = formatQuestionLevel(raw.nivel || raw.nivelInterno || defaults.nivel || 'N2', 2);

  return {
    id: String(raw.id || raw.bankQuestionId || generateBankQuestionId()),
    fingerprint,
    edital_id: editalId,
    materia_id: materiaId ? String(materiaId) : null,
    materia_nome: String(raw.materia_nome ?? raw.materiaNome ?? raw.materia ?? defaults.materiaNome ?? '').trim(),
    assunto_id: assuntoId ? String(assuntoId) : null,
    assunto_nome: String(raw.assunto_nome ?? raw.assuntoNome ?? raw.assunto ?? defaults.assuntoNome ?? '').trim(),
    banca: String(raw.banca || defaults.banca || 'FGV').trim() || 'FGV',
    formato,
    nivel,
    conceito_chave: String(raw.conceito_chave ?? raw.conceitoChave ?? raw.assunto_nome ?? raw.assunto ?? '').trim(),
    enunciado,
    alternativas,
    correta,
    resolucao_passo_a_passo: String(raw.resolucao_passo_a_passo ?? raw.resolucaoPassoAPassoVerificada ?? '').trim(),
    comentario_professor: String(raw.comentario_professor ?? raw.comentarioProfessor ?? raw.comentario ?? '').trim(),
    gerada_pela_ia: raw.gerada_pela_ia !== undefined
      ? Boolean(raw.gerada_pela_ia)
      : (raw.geradaPelaIA !== undefined ? Boolean(raw.geradaPelaIA) : true),
    auditada_pela_ia: Boolean(raw.auditada_pela_ia ?? raw.auditadaPelaIA ?? false),
    model_used: String(raw.model_used ?? raw.modelUsed ?? defaults.modelUsed ?? '').trim(),
    times_answered: Math.max(0, Number(raw.times_answered ?? raw.timesAnswered ?? 0) || 0),
    times_correct: Math.max(0, Number(raw.times_correct ?? raw.timesCorrect ?? 0) || 0),
    times_wrong: Math.max(0, Number(raw.times_wrong ?? raw.timesWrong ?? 0) || 0),
    last_result: raw.last_result ?? raw.lastResult ?? null,
    last_answered_at: raw.last_answered_at ?? raw.lastAnsweredAt ?? null,
    created_at: raw.created_at || raw.createdAt || nowIso,
    updated_at: raw.updated_at || raw.updatedAt || nowIso
  };
}

export function canSafelyShuffleAlternatives(question) {
  const alts = normalizeAlternativas(question && question.alternativas);
  if (alts.length < 3) return false;
  if (detectQuestionFormat(alts, question.formato) === 'certo_errado') return false;
  const correta = String(question.correta || '').trim().toUpperCase();
  if (!alts.some((a) => a.letra === correta)) return false;

  const combinedText = `${question.enunciado || ''}\n${alts.map((a) => a.texto).join('\n')}`;
  if (LETTER_REF_REGEX.test(combinedText)) return false;

  return true;
}

export function shuffleQuestionAlternatives(question, rng = Math.random) {
  if (!canSafelyShuffleAlternatives(question)) {
    return {
      ...question,
      alternativasEmbaralhadas: false
    };
  }

  const origAlts = normalizeAlternativas(question.alternativas);
  const origCorreta = String(question.correta || '').trim().toUpperCase();
  const letters = origAlts.map((a) => a.letra);

  const tagged = origAlts.map((a) => ({
    texto: a.texto,
    isCorrect: a.letra === origCorreta
  }));

  for (let i = tagged.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tagged[i], tagged[j]] = [tagged[j], tagged[i]];
  }

  let newCorreta = origCorreta;
  const shuffledAlts = tagged.map((item, idx) => {
    const letra = letters[idx];
    if (item.isCorrect) newCorreta = letra;
    return { letra, texto: item.texto };
  });

  return {
    ...question,
    alternativas: shuffledAlts,
    correta: newCorreta,
    alternativasEmbaralhadas: true
  };
}

function toMs(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function smartPriorityBucket(row) {
  const answered = Number(row.times_answered) || 0;
  if (answered === 0) return 0; // geradas antes mas nunca respondidas
  const lr = String(row.last_result || '').toLowerCase();
  if (lr === 'error' || lr === 'chute') return 1;
  if (lr === 'doubt_hit') return 2;
  return 3; // hit
}

function sortBankCandidates(rows, mode = 'smart') {
  const list = [...rows];
  if (mode === 'errors_first') {
    const filtered = list.filter((r) => {
      const lr = String(r.last_result || '').toLowerCase();
      return (Number(r.times_wrong) || 0) > 0 || lr === 'error' || lr === 'chute';
    });
    filtered.sort((a, b) =>
      (toMs(a.last_answered_at) - toMs(b.last_answered_at)) ||
      ((Number(b.times_wrong) || 0) - (Number(a.times_wrong) || 0)) ||
      (toMs(a.created_at) - toMs(b.created_at))
    );
    return filtered;
  }

  if (mode === 'all_oldest') {
    list.sort((a, b) =>
      (toMs(a.last_answered_at) - toMs(b.last_answered_at)) ||
      ((Number(a.times_answered) || 0) - (Number(b.times_answered) || 0)) ||
      (toMs(a.created_at) - toMs(b.created_at))
    );
    return list;
  }

  // Padrão: smart (nunca respondidas -> erros/chutes -> dúvidas -> acertos mais antigos)
  list.sort((a, b) =>
    (smartPriorityBucket(a) - smartPriorityBucket(b)) ||
    (toMs(a.last_answered_at) - toMs(b.last_answered_at)) ||
    ((Number(a.times_answered) || 0) - (Number(b.times_answered) || 0)) ||
    (toMs(a.created_at) - toMs(b.created_at))
  );
  return list;
}

function pickFromPoolWithSlotPlan(pool, count, slotPlan) {
  if (!pool.length || count <= 0) return [];
  const slots = Array.isArray(slotPlan && slotPlan.slots) && slotPlan.slots.length
    ? slotPlan.slots.slice(0, count)
    : null;

  if (!slots) {
    return pool.slice(0, count);
  }

  const remaining = [...pool];
  const picked = [];

  for (const slot of slots) {
    if (!remaining.length) break;
    const targetLevelNum = parseQuestionLevel(slot.nivel, 2);
    const targetAssuntoId = slot.assuntoId || null;

    // Escolhe entre os top candidatos priorizando casamento de assunto + proximidade de nível N1-N5
    const windowSize = Math.min(remaining.length, 25);
    let bestIdx = 0;
    let bestScore = Infinity;

    for (let i = 0; i < windowSize; i++) {
      const cand = remaining[i];
      const candLevelNum = parseQuestionLevel(cand.nivel, 2);
      const levelDiff = Math.abs(candLevelNum - targetLevelNum);
      const assuntoPenalty = (targetAssuntoId && cand.assunto_id && cand.assunto_id !== targetAssuntoId) ? 2.5 : 0;
      // Posição na fila de prioridade (peso pequeno para preservar a ordenação smart/oldest)
      const rankPenalty = i * 0.25;
      const score = levelDiff * 1.5 + assuntoPenalty + rankPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    picked.push(remaining.splice(bestIdx, 1)[0]);
  }

  while (picked.length < count && remaining.length > 0) {
    picked.push(remaining.shift());
  }

  return picked;
}

export function bankRowToClientQuestion(row, { shuffleAlternatives = true, rng = Math.random } = {}) {
  const base = {
    bankQuestionId: row.id,
    fingerprint: row.fingerprint,
    isFromBank: true,
    isReview: row.last_result === 'error' || row.last_result === 'chute',
    isActiveReview: false,
    isExactReview: false,
    isErrorReinforcement: false,
    reviewConceptId: null,
    geradaPelaIA: Boolean(row.gerada_pela_ia),
    auditadaPelaIA: Boolean(row.auditada_pela_ia),
    assuntoId: row.assunto_id || null,
    assunto: row.assunto_nome || row.materia_nome || 'Assunto',
    materiaId: row.materia_id || null,
    materiaNome: row.materia_nome || '',
    banca: row.banca || 'FGV',
    formato: row.formato || 'multipla_escolha',
    nivel: formatQuestionLevel(row.nivel, 2),
    nivelInterno: parseQuestionLevel(row.nivel, 2),
    conceitoChave: row.conceito_chave || row.assunto_nome || '',
    enunciado: row.enunciado,
    alternativas: normalizeAlternativas(row.alternativas),
    correta: String(row.correta || 'A').trim().toUpperCase(),
    resolucaoPassoAPassoVerificada: row.resolucao_passo_a_passo || '',
    comentarioProfessor: row.comentario_professor || '',
    timesAnswered: Number(row.times_answered) || 0,
    timesCorrect: Number(row.times_correct) || 0,
    timesWrong: Number(row.times_wrong) || 0,
    lastResult: row.last_result || null,
    lastAnsweredAt: row.last_answered_at || null,
    analiseIA: '',
    link: '',
    sourceRefs: []
  };

  return shuffleAlternatives ? shuffleQuestionAlternatives(base, rng) : { ...base, alternativasEmbaralhadas: false };
}

export function selectQuestionsFromBank(allRows, {
  editalId = null,
  materiaId = null,
  assuntoIds = [],
  formato = null,
  mode = 'smart',
  limit = 5,
  slotPlan = null,
  expandToMateria = false,
  excludeIds = [],
  shuffleAlternatives = true,
  rng = Math.random
} = {}) {
  const desired = Math.max(1, Math.min(20, Number(limit) || 5));
  const excludeSet = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : []);
  const assuntoSet = new Set(Array.isArray(assuntoIds) ? assuntoIds.filter(Boolean) : []);

  const scoped = (Array.isArray(allRows) ? allRows : []).filter((r) => {
    if (!r || !r.enunciado) return false;
    if (editalId && r.edital_id !== editalId) return false;
    if (excludeSet.has(r.id) || excludeSet.has(r.fingerprint)) return false;
    return true;
  });

  // Se formato foi pedido, prioriza mesmo formato; só aceita outro formato se faltar questão
  const filterFormat = (rows, strict) => {
    if (!formato || formato === 'any' || !strict) return rows;
    return rows.filter((r) => r.formato === formato);
  };

  const subtopicAll = assuntoSet.size
    ? scoped.filter((r) => r.assunto_id && assuntoSet.has(r.assunto_id))
    : [];
  const materiaOnlyAll = materiaId
    ? scoped.filter((r) => r.materia_id === materiaId && !(r.assunto_id && assuntoSet.has(r.assunto_id)))
    : [];

  const subtopicMatchingFmt = sortBankCandidates(filterFormat(subtopicAll, true), mode);
  const subtopicOtherFmt = formato && formato !== 'any'
    ? sortBankCandidates(subtopicAll.filter((r) => r.formato !== formato), mode)
    : [];
  const subtopicPool = [...subtopicMatchingFmt, ...subtopicOtherFmt];

  const pickedSubtopic = pickFromPoolWithSlotPlan(subtopicPool, desired, slotPlan);
  const pickedIds = new Set(pickedSubtopic.map((r) => r.id));

  let pickedMateria = [];
  if (expandToMateria && pickedSubtopic.length < desired && materiaOnlyAll.length > 0) {
    const matMatchingFmt = sortBankCandidates(filterFormat(materiaOnlyAll, true), mode);
    const matOtherFmt = formato && formato !== 'any'
      ? sortBankCandidates(materiaOnlyAll.filter((r) => r.formato !== formato), mode)
      : [];
    const matPool = [...matMatchingFmt, ...matOtherFmt].filter((r) => !pickedIds.has(r.id));
    pickedMateria = pickFromPoolWithSlotPlan(matPool, desired - pickedSubtopic.length, null);
  }

  const finalRows = [...pickedSubtopic, ...pickedMateria];
  const questions = finalRows.map((row, idx) => ({
    ...bankRowToClientQuestion(row, { shuffleAlternatives, rng }),
    slotIndex: idx
  }));

  const subtopicStatsPool = mode === 'errors_first' ? sortBankCandidates(subtopicAll, 'errors_first') : subtopicAll;
  const materiaStatsPool = mode === 'errors_first'
    ? sortBankCandidates([...subtopicAll, ...materiaOnlyAll], 'errors_first')
    : [...subtopicAll, ...materiaOnlyAll];

  return {
    questions,
    meta: {
      requested: desired,
      returned: questions.length,
      fromSubtopics: pickedSubtopic.length,
      fromMateria: pickedMateria.length,
      expandedToMateria: pickedMateria.length > 0,
      totalAvailableSubtopics: subtopicStatsPool.length,
      totalAvailableMateria: materiaStatsPool.length
    }
  };
}

export function computeQuestionBankStats(allRows, { editalId = null, materiaId = null, assuntoIds = [] } = {}) {
  const assuntoSet = new Set(Array.isArray(assuntoIds) ? assuntoIds.filter(Boolean) : []);
  const rows = (Array.isArray(allRows) ? allRows : []).filter((r) => !editalId || r.edital_id === editalId);

  const inSubtopics = assuntoSet.size
    ? rows.filter((r) => r.assunto_id && assuntoSet.has(r.assunto_id))
    : [];
  const inMateria = materiaId
    ? rows.filter((r) => r.materia_id === materiaId)
    : [];

  const isErrorLike = (r) => (Number(r.times_wrong) || 0) > 0 || r.last_result === 'error' || r.last_result === 'chute';

  return {
    totalEdital: rows.length,
    totalMateria: inMateria.length,
    totalSubtopics: inSubtopics.length,
    errorsSubtopics: inSubtopics.filter(isErrorLike).length,
    errorsMateria: inMateria.filter(isErrorLike).length
  };
}

export function extractBackfillQuestionsFromState(panelState, { nowIso = new Date().toISOString() } = {}) {
  if (!panelState || typeof panelState !== 'object' || !panelState.bank) return [];

  const byFingerprint = new Map();

  for (const [editalId, container] of Object.entries(panelState.bank)) {
    if (!container || typeof container !== 'object') continue;
    const materiasById = new Map((Array.isArray(container.materias) ? container.materias : []).map((m) => [m.id, m.nome]));
    const assuntosById = new Map((Array.isArray(container.assuntos) ? container.assuntos : []).map((a) => [a.id, a]));

    // Percorre logs do mais antigo para o mais recente para preservar último resultado e contagens
    const logs = [...(Array.isArray(container.log) ? container.log : [])]
      .sort((a, b) => toMs(a && a.date) - toMs(b && b.date));

    for (const logEntry of logs) {
      if (!logEntry) continue;
      const logDate = logEntry.date || nowIso;
      const matId = logEntry.materiaId || null;
      const matNome = (matId && materiasById.get(matId)) || '';
      const banca = logEntry.banca || 'FGV';

      for (const err of (Array.isArray(logEntry.errors) ? logEntry.errors : [])) {
        if (!err || err.mergedIntoSourceRef) continue;
        const parts = parseSavedErrorTextToParts(err);
        if (!parts) continue;

        const assId = err.assuntoId || logEntry.assuntoId || null;
        const assObj = assId ? assuntosById.get(assId) : null;
        const assNome = err.assunto || (assObj && assObj.nome) || matNome || 'Assunto';
        const isChute = err.confidence === 'chute';
        const baseResult = isChute ? 'chute' : 'error';

        const row = normalizeBankQuestionRow({
          edital_id: editalId,
          materia_id: matId,
          materia_nome: matNome,
          assunto_id: assId,
          assunto_nome: assNome,
          banca,
          nivel: err.nivel || 'N2',
          conceito_chave: err.conceitoChave || assNome,
          enunciado: parts.enunciado,
          alternativas: parts.alternativas,
          correta: parts.correta,
          resolucao_passo_a_passo: err.resolucaoPassoAPassoVerificada || '',
          comentario_professor: err.comentario || '',
          gerada_pela_ia: err.geradaPelaIA !== false,
          auditada_pela_ia: false,
          times_answered: 1,
          times_correct: 0,
          times_wrong: 1,
          last_result: baseResult,
          last_answered_at: logDate,
          created_at: logDate,
          updated_at: nowIso
        }, { nowIso });

        if (!row) continue;

        // Incorpora histórico de revisões SRS caso o aluno já tenha revisado esta questão
        const srsHist = Array.isArray(err.srsHistory) ? err.srsHistory : [];
        for (const h of srsHist) {
          if (!h) continue;
          row.times_answered += 1;
          if (h.acertou) {
            row.times_correct += 1;
            row.last_result = 'hit';
          } else {
            row.times_wrong += 1;
            row.last_result = 'error';
          }
          if (h.date && toMs(h.date) >= toMs(row.last_answered_at)) {
            row.last_answered_at = h.date;
          }
        }

        const existing = byFingerprint.get(row.fingerprint);
        if (!existing) {
          byFingerprint.set(row.fingerprint, row);
        } else {
          existing.times_answered += row.times_answered;
          existing.times_correct += row.times_correct;
          existing.times_wrong += row.times_wrong;
          if (toMs(row.last_answered_at) >= toMs(existing.last_answered_at)) {
            existing.last_answered_at = row.last_answered_at;
            existing.last_result = row.last_result;
          }
          if (row.comentario_professor.length > existing.comentario_professor.length) {
            existing.comentario_professor = row.comentario_professor;
          }
          if (row.resolucao_passo_a_passo.length > existing.resolucao_passo_a_passo.length) {
            existing.resolucao_passo_a_passo = row.resolucao_passo_a_passo;
          }
        }
      }

      // Também aproveita pendingHitItems se houver
      for (const hit of (Array.isArray(logEntry.pendingHitItems) ? logEntry.pendingHitItems : [])) {
        if (!hit) continue;
        const row = normalizeBankQuestionRow({
          edital_id: editalId,
          materia_id: matId,
          materia_nome: matNome,
          assunto_id: logEntry.assuntoId || null,
          assunto_nome: hit.assunto || matNome,
          banca,
          nivel: hit.nivel || 'N2',
          enunciado: hit.enunciado,
          alternativas: hit.alternativas,
          correta: hit.correta,
          resolucao_passo_a_passo: hit.resolucaoPassoAPassoVerificada || '',
          comentario_professor: hit.comentario || '',
          gerada_pela_ia: hit.geradaPelaIA !== false,
          times_answered: 1,
          times_correct: 1,
          times_wrong: 0,
          last_result: 'hit',
          last_answered_at: logDate,
          created_at: logDate,
          updated_at: nowIso
        }, { nowIso });
        if (row && !byFingerprint.has(row.fingerprint)) {
          byFingerprint.set(row.fingerprint, row);
        }
      }
    }

    // Também aproveita questões de offlinePacks ainda ativos
    for (const pack of (Array.isArray(container.offlinePacks) ? container.offlinePacks : [])) {
      if (!pack || !Array.isArray(pack.questions) || !pack.questions.length) continue;
      for (const q of pack.questions) {
        const row = normalizeBankQuestionRow({
          ...q,
          edital_id: editalId,
          materia_id: pack.materiaId || null,
          materia_nome: pack.materiaNome || '',
          assunto_id: q.assuntoId || (Array.isArray(pack.assuntoIds) ? pack.assuntoIds[0] : null),
          assunto_nome: q.assunto || '',
          banca: pack.banca || 'FGV',
          formato: pack.formato || 'multipla_escolha',
          times_answered: q.confirmed ? 1 : 0,
          times_correct: (q.confirmed && q.selectedLetter === q.correta && q.confidence !== 'chute') ? 1 : 0,
          times_wrong: (q.confirmed && (q.selectedLetter !== q.correta || q.confidence === 'chute')) ? 1 : 0,
          last_result: q.confirmed
            ? (q.selectedLetter === q.correta ? (q.confidence === 'chute' ? 'chute' : (q.confidence === 'duvida' ? 'doubt_hit' : 'hit')) : 'error')
            : null,
          last_answered_at: q.confirmed ? (pack.updatedAt || nowIso) : null,
          created_at: pack.createdAt || nowIso,
          updated_at: nowIso
        }, { nowIso });
        if (row && !byFingerprint.has(row.fingerprint)) {
          byFingerprint.set(row.fingerprint, row);
        }
      }
    }
  }

  return Array.from(byFingerprint.values());
}
