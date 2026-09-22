/**
 * @scene/domain — 领域层模块桩
 *
 * 12 个领域模块，每个对应一个可独立描述的业务能力。
 * 依赖单向：domain → contract；不依赖 infra / server / web。
 * 领域模块不依赖 IO（DB/网络/模型），依赖通过参数注入。
 */

// 阶段 0 — 证据采集与溯源
export {
  gradeSource,
  gradeEvidence,
  verifyCitation,
} from "./evidence.js";

// 阶段 0 — 材料解析与入表
export {
  assessQuality,
  checkCompleteness,
  upsertFromAnalysis,
} from "./material.js";
export type {
  DimensionStatus,
  QualityDimension,
  QualityAssessment,
  CompletenessCheckItem,
  MaterialReminder,
  CompletenessReport,
  CapabilityMaturityChange,
  UpdateOperation,
  AnalysisWriteback,
  MaterialUpdate,
} from "./material.js";

// 阶段 1 — 解析计划
export { } from "./parse-plan.js";

// 阶段 2 — 门槛筛查
export {
  judgeBarrier,
  planStrategy,
} from "./barrier-scan.js";
export type {
  BarrierType,
  BarrierJudgment,
  StrategyRecommendation,
} from "./barrier-scan.js";

// 阶段 3 — 市场分析
export { } from "./market.js";

// 阶段 4 — 能力匹配
export { } from "./capability-match.js";

// 阶段 5 — 成本估算
export { } from "./cost-estimate.js";

// 阶段 6 — 价值验证
export { } from "./value-verify.js";

// 全局 — 质量关检查
export {
  runGate,
  sampleSources,
  decideAdvice,
  GATE_CHECK_TITLES,
  MIN_SAMPLE_SIZE,
} from "./gate.js";
export type {
  GateCheckInput,
  GateCheckResult,
} from "./gate.js";

// 全局 — 工作流编排
export {
  advance,
  canAdvance,
  rollback,
  markStale,
  getRiskChain,
  STAGES,
  FIRST_STAGE,
  LAST_STAGE,
} from "./workflow.js";
export type { StaleMark } from "./workflow.js";

// 全局 — 会话管理
export { } from "./session.js";

// 全局 — 知识库
export { } from "./knowledge.js";
