/**
 * material — 质量六维评估、完成度检查、接收分析回写（阶段 0 + 跨阶段回写）
 *
 * 职责：
 *   1. assessQuality() — 六维质量总评（表 0-1，00b §2.3）
 *   2. checkCompleteness() — 8 项完成度检查（00b §2.4），不阻断
 *   3. upsertFromAnalysis() — 接收阶段 3/4/5 分析回写，返回更新意图
 *
 * 数据属主：资料库 8 表（product ~ optional_material）。
 * 所有函数为纯函数，无 IO；输入通过参数注入（规则 6）。
 * 只返回更新意图（MaterialUpdate），不直接操作数据库。
 */

import type {
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  CostRate,
  Maturity,
} from "@scene/contract";

// ─── 质量维度状态枚举 ────────────────────────────────────────

/** 质量维度评级状态 */
export type DimensionStatus = "pass" | "warn" | "fail";

// ─── 质量六维评估类型（表 0-1） ───────────────────────────────

/** 单个质量维度的评估结果 */
export interface QualityDimension {
  /** 维度名称 */
  dimension: string;
  /** 评级：pass=✅ / warn=⚠️ / fail=❌ */
  status: DimensionStatus;
  /** 评估说明 */
  description: string;
}

/** 六维质量总评结果（对应表 0-1） */
export interface QualityAssessment {
  /** 六个维度的评估结果 */
  dimensions: QualityDimension[];
  /** 综合通过维度数 */
  passCount: number;
  /** 综合警告维度数 */
  warnCount: number;
  /** 综合不通过维度数 */
  failCount: number;
}

// ─── 完成度检查类型（§2.4） ──────────────────────────────────

/** 完成度检查项 */
export interface CompletenessCheckItem {
  /** 检查编号 1-8 */
  id: number;
  /** 检查项名称 */
  name: string;
  /** 当前状态描述 */
  status: string;
  /** 缺失风险（后续阶段继承） */
  risk: string;
}

/** 材料补充提醒项（对应表 0-13） */
export interface MaterialReminder {
  /** 对应表编号 */
  table: string;
  /** 缺失项 */
  missing: string;
  /** 缺失影响 */
  impact: string;
  /** 建议操作 */
  suggestion: string;
}

/** 8 项完成度检查报告（§2.4） + 缺失提醒列表 */
export interface CompletenessReport {
  /** 8 项检查结果 */
  items: CompletenessCheckItem[];
  /** 缺失提醒列表 */
  reminders: MaterialReminder[];
}

// ─── 分析回写类型 ─────────────────────────────────────────────

/** 能力成熟度变更指令（来自阶段 4 匹配分析） */
export interface CapabilityMaturityChange {
  /** 能力清单条目 ID */
  capabilityId: string;
  /** 能力名称 */
  capabilityName: string;
  /** 新成熟度 */
  newMaturity: Maturity;
  /** 变更依据 */
  reason: string;
}

/** 单条更新操作（数据库更新意图，由 infra 执行） */
export type UpdateOperation =
  | {
      /** 操作类型：更新成熟度 */
      type: "update_maturity";
      /** 目标表 */
      table: "capability";
      /** 目标行 ID */
      targetId: string;
      /** 新成熟度值 */
      payload: { maturity: Maturity };
      /** 变更依据 */
      reason: string;
    }
  | {
      /** 操作类型：插入新记录 */
      type: "insert";
      /** 目标表 */
      table: "boundary" | "limitation";
      /** 待插入记录（不含 id/created_at/updated_at，由 infra 生成） */
      payload: Record<string, unknown>;
    };

/** 阶段 3/4/5 分析结果回写数据 */
export interface AnalysisWriteback {
  /** 能力成熟度变化列表（来自阶段 4 能力匹配分析） */
  capabilityMaturityChanges?: CapabilityMaturityChange[];
  /** 新发现的边界（来自阶段 3 市场分析等） */
  newBoundaries?: Array<Omit<Boundary, "id" | "created_at" | "updated_at">>;
  /** 新发现的限制（来自阶段 5 成本估算等） */
  newLimitations?: Array<Omit<Limitation, "id" | "created_at" | "updated_at">>;
}

/** 回写更新结果（更新意图列表，由 infra 层执行） */
export interface MaterialUpdate {
  /** 待执行的更新操作列表 */
  operations: UpdateOperation[];
  /** 操作摘要（人类可读） */
  summary: string;
}

// ─── 六维维度定义 ─────────────────────────────────────────────

interface DimensionDef {
  name: string;
  evaluate: (
    products: Product[],
    specParams: SpecParam[],
    boundaries: Boundary[],
    limitations: Limitation[],
  ) => { status: DimensionStatus; description: string };
}

const DIMENSIONS: DimensionDef[] = [
  {
    name: "状态可分辨",
    evaluate: (products) => {
      if (products.length === 0) {
        return { status: "fail", description: "无产品数据，无法判断产品状态" };
      }
      const confirmed = products.filter(
        (p) => p.status !== "待确认",
      ).length;
      if (confirmed === products.length) {
        return { status: "pass", description: `全部 ${confirmed} 个产品状态已确认` };
      }
      if (confirmed === 0) {
        return {
          status: "fail",
          description: `${products.length} 个产品全部待确认`,
        };
      }
      return {
        status: "warn",
        description: `${confirmed}/${products.length} 个产品状态已确认，${products.length - confirmed} 个待确认`,
      };
    },
  },
  {
    name: "可追溯",
    evaluate: (products, specParams) => {
      const all = [...products, ...specParams];
      if (all.length === 0) {
        return { status: "fail", description: "无任何数据，无法评估可追溯性" };
      }
      const sourced = all.filter((r) => !!r.source).length;
      if (sourced === all.length) {
        return { status: "pass", description: `全部 ${sourced} 条记录已标注来源` };
      }
      if (sourced === 0) {
        return { status: "fail", description: "无任何记录标注来源，无法追溯" };
      }
      return {
        status: "warn",
        description: `${sourced}/${all.length} 条记录已标注来源，${all.length - sourced} 条缺失`,
      };
    },
  },
  {
    name: "可验证",
    evaluate: (_products, specParams) => {
      if (specParams.length === 0) {
        return { status: "fail", description: "无规格参数，无法评估可验证性" };
      }
      const measured = specParams.filter((p) => p.measured === "实测").length;
      const unmeasured = specParams.filter((p) => p.measured === "未提及").length;
      if (measured === specParams.length) {
        return { status: "pass", description: `全部 ${measured} 个参数已实测验证` };
      }
      if (unmeasured > 0) {
        return {
          status: "fail",
          description: `${unmeasured}/${specParams.length} 个参数未提及测试数据`,
        };
      }
      return {
        status: "warn",
        description: `${measured}/${specParams.length} 个参数已实测，其余为厂商宣称`,
      };
    },
  },
  {
    name: "有时效",
    evaluate: (products) => {
      if (products.length === 0) {
        return { status: "fail", description: "无产品数据，无法评估时效性" };
      }
      const withDate = products.filter((p) => !!p.launch_date).length;
      if (withDate === products.length) {
        return { status: "pass", description: `全部 ${withDate} 个产品有发布日期` };
      }
      if (withDate === 0) {
        return { status: "fail", description: "所有产品均无发布日期" };
      }
      return {
        status: "warn",
        description: `${withDate}/${products.length} 个产品有发布日期，${products.length - withDate} 个缺失`,
      };
    },
  },
  {
    name: "含边界",
    evaluate: (_products, _specParams, boundaries) => {
      if (boundaries.length === 0) {
        return { status: "fail", description: "M4 边界声明为空，缺少'不做什么'信息" };
      }
      const withDesc = boundaries.filter((b) => !!b.description).length;
      if (withDesc === boundaries.length) {
        return { status: "pass", description: `已声明 ${boundaries.length} 条边界` };
      }
      return {
        status: "warn",
        description: `${boundaries.length} 条边界中有 ${withDesc} 条有具体描述`,
      };
    },
  },
  {
    name: "含反面",
    evaluate: (_products, _specParams, _boundaries, limitations) => {
      if (limitations.length === 0) {
        return { status: "fail", description: "M5 已知限制为空，缺少反面信息" };
      }
      const withDesc = limitations.filter((l) => !!l.description).length;
      if (withDesc === limitations.length) {
        return { status: "pass", description: `已记录 ${limitations.length} 条已知限制` };
      }
      return {
        status: "warn",
        description: `${limitations.length} 条限制中有 ${withDesc} 条有具体描述`,
      };
    },
  },
];

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 质量六维评估（表 0-1，00b §2.3）
 *
 * 评估维度：状态可分辨 / 可追溯 / 可验证 / 有时效 / 含边界 / 含反面。
 * 每项评级 ✅(pass) / ⚠️(warn) / ❌(fail)。
 *
 * @param products - 产品型号列表（M1）
 * @param specParams - 规格参数列表（M2）
 * @param boundaries - 边界声明列表（M4）
 * @param limitations - 已知限制列表（M5）
 * @returns 六维评估结果
 */
export function assessQuality(
  products: Product[],
  specParams: SpecParam[],
  boundaries: Boundary[],
  limitations: Limitation[],
): QualityAssessment {
  const dimensions = DIMENSIONS.map((def) => {
    const result = def.evaluate(products, specParams, boundaries, limitations);
    return { dimension: def.name, ...result };
  });

  return {
    dimensions,
    passCount: dimensions.filter((d) => d.status === "pass").length,
    warnCount: dimensions.filter((d) => d.status === "warn").length,
    failCount: dimensions.filter((d) => d.status === "fail").length,
  };
}

/**
 * 完成度检查（00b §2.4，8 项，不阻断）
 *
 * 检查 M1-M6 必填表是否有数据 + 来源抽查 + 质量六维评估。
 * 不做通过/退回判定，仅记录当前状态和缺失风险。
 *
 * @param products - 产品型号列表（M1）
 * @param specParams - 规格参数列表（M2）
 * @param capabilities - 能力清单列表（M3）
 * @param boundaries - 边界声明列表（M4）
 * @param limitations - 已知限制列表（M5）
 * @param costRates - 成本单价列表（M6）
 * @returns 完成度报告（8 项检查 + 缺失提醒列表）
 */
export function checkCompleteness(
  products: Product[],
  specParams: SpecParam[],
  capabilities: Capability[],
  boundaries: Boundary[],
  limitations: Limitation[],
  costRates: CostRate[],
): CompletenessReport {
  // 来源抽查：至少有一条记录带有来源标注
  const allRecords = [
    ...products,
    ...specParams,
    ...capabilities,
    ...boundaries,
    ...limitations,
  ];
  const hasSources = allRecords.some((r) => !!r.source);

  // 质量六维：维度列表全部非 fail 即视为已评估
  const assessment = assessQuality(products, specParams, boundaries, limitations);
  const hasAssessment = assessment.dimensions.every((d) => d.status !== "fail");

  // 8 项检查定义（§2.4 对应表）
  const checks: Array<{
    name: string;
    hasData: boolean;
    count: number;
    unit: string;
    risk: string;
  }> = [
    {
      name: "M1 产品清单已填写",
      hasData: products.length > 0,
      count: products.length,
      unit: "项",
      risk: "阶段三匹配矩阵缺少候选池",
    },
    {
      name: "M2 规格书已填写",
      hasData: specParams.length > 0,
      count: specParams.length,
      unit: "个",
      risk: "阶段四选型缺少参数依据",
    },
    {
      name: "M3 能力清单已填写",
      hasData: capabilities.length > 0,
      count: capabilities.length,
      unit: "项",
      risk: "阶段三匹配矩阵缺少行",
    },
    {
      name: "M4 边界声明已填写",
      hasData: boundaries.length > 0,
      count: boundaries.length,
      unit: "条",
      risk: "阶段〇门槛扫描缺少判据，阶段四边界声明只能靠推断",
    },
    {
      name: "M5 已知限制已填写",
      hasData: limitations.length > 0,
      count: limitations.length,
      unit: "条",
      risk: "阶段五验收约束不完整",
    },
    {
      name: "M6 成本结构已填写",
      hasData: costRates.length > 0,
      count: costRates.length,
      unit: "项",
      risk: "阶段四成本估算缺少内部数据，只能用行业均值",
    },
  ];

  const items: CompletenessCheckItem[] = checks.map((c, i) => ({
    id: i + 1,
    name: c.name,
    status: c.hasData
      ? `✅ ${c.count} ${c.unit}`
      : "❌ 空白",
    risk: c.hasData ? "—" : c.risk,
  }));

  // 第 7 项：来源抽查
  items.push({
    id: 7,
    name: "来源抽查",
    status: hasSources ? "✅ 已抽查" : "⚠️ 未抽查",
    risk: hasSources ? "—" : "证据可信度未验证",
  });

  // 第 8 项：质量六维已评估
  items.push({
    id: 8,
    name: "质量六维已评估",
    status: hasAssessment ? "✅ 已评估" : "❌ 未评估",
    risk: hasAssessment ? "—" : "材料质量未评估",
  });

  // 生成缺失提醒（§2.4 / 表 0-13）
  const reminders: MaterialReminder[] = [];
  for (const c of checks) {
    if (!c.hasData) {
      reminders.push({
        table: c.name.split(" ")[0]!,
        missing: c.name.replace("已填写", "未填写"),
        impact: c.risk,
        suggestion: "用户手动编辑 / 上传补充材料",
      });
    }
  }
  if (!hasSources) {
    reminders.push({
      table: "全局",
      missing: "未进行来源抽查",
      impact: "证据可信度未验证",
      suggestion: "至少抽查 3 条来源并确认内容一致",
    });
  }
  if (!hasAssessment) {
    reminders.push({
      table: "M1-M5",
      missing: "质量六维未评估",
      impact: "材料质量未评估",
      suggestion: "补充材料或在对应表格手动编辑后重新评估",
    });
  }

  return { items, reminders };
}

/**
 * 接收分析回写（阶段 3/4/5 完成后），生成更新意图
 *
 * 返回 MaterialUpdate（更新操作列表 + 人类可读摘要），由 infra 层执行。
 * 纯函数，不直接操作数据库（规则：只返回意图，infra 执行）。
 *
 * @param data - 阶段分析回写数据
 * @returns 更新意图（操作列表 + 摘要）
 */
export function upsertFromAnalysis(data: AnalysisWriteback): MaterialUpdate {
  const operations: UpdateOperation[] = [];

  // 处理能力成熟度变化
  const maturityChanges = data.capabilityMaturityChanges ?? [];
  for (const change of maturityChanges) {
    operations.push({
      type: "update_maturity",
      table: "capability",
      targetId: change.capabilityId,
      payload: { maturity: change.newMaturity },
      reason: change.reason,
    });
  }

  // 处理新发现的边界
  const newBoundaries = data.newBoundaries ?? [];
  for (const boundary of newBoundaries) {
    operations.push({
      type: "insert",
      table: "boundary",
      payload: { ...boundary } as Record<string, unknown>,
    });
  }

  // 处理新发现的限制
  const newLimitations = data.newLimitations ?? [];
  for (const limitation of newLimitations) {
    operations.push({
      type: "insert",
      table: "limitation",
      payload: { ...limitation } as Record<string, unknown>,
    });
  }

  // 生成人类可读摘要
  const parts: string[] = [];
  if (maturityChanges.length > 0) {
    parts.push(`${maturityChanges.length} 项能力成熟度更新`);
  }
  if (newBoundaries.length > 0) {
    parts.push(`${newBoundaries.length} 条新边界`);
  }
  if (newLimitations.length > 0) {
    parts.push(`${newLimitations.length} 条新限制`);
  }
  const summary = parts.length > 0
    ? `待执行：${parts.join("、")}`
    : "无更新";

  return { operations, summary };
}