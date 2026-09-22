/**
 * @scene/domain — 领域层模块桩
 *
 * 12 个领域模块，每个对应一个可独立描述的业务能力。
 * 依赖单向：domain → contract；不依赖 infra / server / web。
 * 领域模块不依赖 IO（DB/网络/模型），依赖通过参数注入。
 */

// 阶段 0 — 证据采集与溯源
export { } from "./evidence.ts";

// 阶段 0 — 材料解析与入表
export { } from "./material.ts";

// 阶段 1 — 解析计划
export { } from "./parse-plan.ts";

// 阶段 2 — 门槛筛查
export { } from "./barrier-scan.ts";

// 阶段 3 — 市场分析
export { } from "./market.ts";

// 阶段 4 — 能力匹配
export { } from "./capability-match.ts";

// 阶段 5 — 成本估算
export { } from "./cost-estimate.ts";

// 阶段 6 — 价值验证
export { } from "./value-verify.ts";

// 全局 — 质量关检查
export { } from "./gate.ts";

// 全局 — 工作流编排
export { } from "./workflow.ts";

// 全局 — 会话管理
export { } from "./session.ts";

// 全局 — 知识库
export { } from "./knowledge.ts";
