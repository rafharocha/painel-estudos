import '../public/js/adaptive-engine.js';

const AdaptiveEngine = globalThis.AdaptiveEngine;

export const {
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
} = AdaptiveEngine;

export default AdaptiveEngine;
