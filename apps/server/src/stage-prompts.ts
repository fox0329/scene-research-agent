/**
 * @scene/server — 阶段 prompt 模板（阶段 0-2）
 *
 * 职责：为每个分析阶段构建 system + user prompt。
 * 规则：prompt 只注入当前阶段 schema + 上游表数据（F2 上下文控制约束）。
 *
 * 阶段 0（材料解析）：验证材料质量 + 完成度评估（由 ingest 已完成，此阶段 advance 仅做总结）
 * 阶段 1（门槛筛查）：五类门槛判定 + 处置策略 → 表1-1 至 表1-5
 * 阶段 2（架构约束）：架构分析 + 技术约束 → 表2-1 至 表2-8
 */

import type { StageId } from "@scene/contract";
import {
  STAGE0_TABLES,
  STAGE1_TABLES,
  STAGE2_TABLES,
} from "@scene/contract";

// ─── 输出 JSON Schema ─────────────────────────────────────

/** 阶段 1 输出契约 */
const STAGE1_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: {
            type: "string",
            enum: [...STAGE1_TABLES],
          },
          fields: { type: "object" },
          source: { type: "string", description: "来源标注，格式：文件名:页码" },
        },
      },
    },
  },
  required: ["rows"],
};

/** 阶段 2 输出契约 */
const STAGE2_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: {
            type: "string",
            enum: [...STAGE2_TABLES],
          },
          fields: { type: "object" },
          source: { type: "string", description: "来源标注，格式：文件名:页码" },
        },
      },
    },
  },
  required: ["rows"],
};

// ─── 阶段 0 system prompt ──────────────────────────────────

const STAGE0_SYSTEM = `你是场景落地分析助手。当前处于阶段 0（材料解析），该阶段由文档解析入库流程完成。

你的任务是基于已入库的产品资料（M1-M6、O1-O6），对材料质量进行总结性分析，输出结构化 JSON。

## 总结要求
1. 识别资料覆盖度：哪些表有数据、哪些为空
2. 标注数据质量疑点：来源权威性不足（T3/T4）、证据级别偏低（C/D）的条目
3. 建议补充方向：缺失的必填字段、需要用户确认的 AI 推断条目

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。
source 使用 "系统分析:阶段0" 格式。`;

// ─── 阶段 1 system prompt ──────────────────────────────────

const STAGE1_SYSTEM = `你是场景落地分析助手，专注于门槛筛查（阶段 1，00b §3.2）。

你的任务是基于上游产品资料（M1-M6），分析该场景的五类门槛并填写表 1-1 至 表 1-5。

## 表结构

### 表1-1 场景概述
字段：scene_name(场景名称), customer_type(客户类型), use_case(核心用途), entry_point(切入点), value_proposition(价值主张)
必填：scene_name, customer_type, use_case, entry_point, value_proposition

### 表1-2 角色与认证
字段：our_role(我方角色), required_certs(需要的认证), held_certs(已持有的认证), gap(差距), mitigation(弥补措施)
必填：our_role, required_certs, held_certs, gap

### 表1-3 门槛判定（五类）
字段：barrier_type(技术/行业准入/经济/生态锁定/一票否决者), criteria(判据), current_status(现状), judgment(过得了/绕道/借道/过不了/等窗口/不知道), evidence(证据)
必填：barrier_type, criteria, current_status, judgment

### 表1-4 处置策略
字段：barrier_ref(关联门槛类型), strategy(直接进入/找替代路径/找合作伙伴/不进入/等政策变化/列为调研重点), action_items(行动项), owner(负责人), timeline(时间线)
必填：barrier_ref, strategy, action_items

### 表1-5 风险标注
字段：risk_id(风险编号), description(风险描述), severity(高/中/低), inherited_from(继承自哪个门槛), mitigation(缓解措施)
必填：risk_id, description, severity, inherited_from

## 分析规则
1. 门槛判定只基于已有资料，不编造数据；资料不足的项标记为"不知道"
2. 一票否决者（法规禁止、安全责任核心）必须明确标注
3. 生态锁定必须给出借道或绕道策略
4. 每条结论必须标注来源（文件名:页码）
5. 阶段 1-2 只记事实，不标注推理（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 2 system prompt ──────────────────────────────────

const STAGE2_SYSTEM = `你是场景落地分析助手，专注于架构与约束分析（阶段 2，00b §4.2）。

你的任务是基于上游产品资料（M1-M6）和阶段 1 门槛筛查结果（表 1-1 至 表 1-5），进行架构与约束分析，填写表 2-1 至 表 2-8。

## 表结构

### 表2-1 架构总览
字段：architecture_name(架构名称), components(关键组件列表), interfaces(接口方式), deployment_model(部署模式)
必填：architecture_name, components, interfaces, deployment_model

### 表2-2 用户服务映射
字段：user_role(用户角色), service_description(得到什么服务), implementation(实现载体), touchpoints(触点)
必填：user_role, service_description, implementation

### 表2-3 关键设备与价格
字段：device_name(设备名称), vendor(供应商), price_range(价格量级), competition_intensity(竞争强度: 高/中/低), notes(备注)
必填：device_name, vendor, price_range, competition_intensity

### 表2-4 物理与合规约束
字段：constraint_type(物理/合规/标准), description(约束描述), requirement(具体要求值), compliance_path(合规路径), owner(责任人)
必填：constraint_type, description, requirement

### 表2-5 数据规模估算
字段：metric(指标名称), current_value(当前值), growth_rate(增长率), storage_need(存储需求), notes(备注)
必填：metric, current_value

### 表2-6 适用标准与合规
字段：standard_no(标准号), standard_name(标准名称), applicability(适用性), compliance_status(合规状态), path(路径)
必填：standard_no, standard_name, applicability

### 表2-7 安全责任边界
字段：boundary_area(边界领域), description(哪个环节不能碰), reason(原因), alternative(替代方案)
必填：boundary_area, description, reason

### 表2-8 来源抽查记录
字段：source_ref(来源引用), original_content(原文内容摘要), consistency_check(一致性检查: 一致/不一致/无法核实), checker(检查方式)
必填：source_ref, consistency_check

## 分析规则
1. 架构分析必须与阶段 1 的门槛判定一致——过不了的门槛不能出现在可行架构中
2. 重要结论来源权威性达标：协议/接口有 T1/T2，约束有 T1
3. 安全责任边界必须明确"不碰什么"（G-R4 边界声明）
4. 来源抽查至少 3 条（G-R3），每条打开确认内容一致
5. 阶段 2 只记事实，不标注推理（G-R5）

## 输出格式
输出 JSON 对象，包含 rows 数组。每条记录包含 table_code、fields、source 三个字段。`;

// ─── 阶段 0 输出契约（总结用，无固定表结构） ──────────────

const STAGE0_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["table_code", "fields", "source"],
        properties: {
          table_code: { type: "string" },
          fields: { type: "object" },
          source: { type: "string" },
        },
      },
    },
  },
  required: ["rows"],
};

// ─── 公共接口 ──────────────────────────────────────────────

export interface StagePrompt {
  system: string;
  user: string;
  outputContract: Record<string, unknown>;
}

/**
 * 构建阶段 prompt。
 *
 * 根据 stage 选择对应的 system prompt 模板，
 * 将上游数据摘要填入 user prompt。
 * 遵循 F2 上下文控制约束：只注入当前阶段需要的上游数据。
 *
 * @param stage - 阶段编号（0-2）
 * @param upstreamData - 上游表数据摘要（table_code → 行数组）
 * @returns system + user prompt + outputContract
 */
export function buildStagePrompt(
  stage: StageId,
  upstreamData: Record<string, unknown>,
): StagePrompt {
  switch (stage) {
    case 0:
      return buildStage0Prompt(upstreamData);
    case 1:
      return buildStage1Prompt(upstreamData);
    case 2:
      return buildStage2Prompt(upstreamData);
    default:
      throw new Error(`阶段 ${stage} 的 prompt 模板尚未实现`);
  }
}

/**
 * 获取阶段对应的输出 JSON Schema（用于 DSH Function Calling 注入）。
 */
export function getStageOutputContract(stage: StageId): Record<string, unknown> {
  switch (stage) {
    case 0: return STAGE0_OUTPUT_CONTRACT;
    case 1: return STAGE1_OUTPUT_CONTRACT;
    case 2: return STAGE2_OUTPUT_CONTRACT;
    default:
      throw new Error(`阶段 ${stage} 的输出契约尚未实现`);
  }
}

// ─── 内部构建函数 ──────────────────────────────────────────

function buildStage0Prompt(upstreamData: Record<string, unknown>): StagePrompt {
  const user = buildUserPromptSection(0, upstreamData, [
    "M1 产品型号", "M2 规格参数", "M3 能力清单",
    "M4 边界声明", "M5 已知限制", "M6 成本单价",
    "O1-O6 可选材料",
  ]);
  return { system: STAGE0_SYSTEM, user, outputContract: STAGE0_OUTPUT_CONTRACT };
}

function buildStage1Prompt(upstreamData: Record<string, unknown>): StagePrompt {
  const user = buildUserPromptSection(1, upstreamData, [
    "M1 产品型号", "M2 规格参数", "M3 能力清单",
    "M4 边界声明", "M5 已知限制", "M6 成本单价",
  ]);
  return { system: STAGE1_SYSTEM, user, outputContract: STAGE1_OUTPUT_CONTRACT };
}

function buildStage2Prompt(upstreamData: Record<string, unknown>): StagePrompt {
  const user = buildUserPromptSection(2, upstreamData, [
    "M1-M6 产品资料", "表1-1 至 表1-5 阶段 1 门槛筛查结果",
  ]);
  return { system: STAGE2_SYSTEM, user, outputContract: STAGE2_OUTPUT_CONTRACT };
}

/**
 * 构建 user prompt 的上游数据摘要部分。
 * 将 upstreamData 中的各表数据格式化为 markdown。
 */
function buildUserPromptSection(
  stage: StageId,
  upstreamData: Record<string, unknown>,
  sourceLabels: string[],
): string {
  const parts: string[] = [];

  parts.push(`以下是阶段 ${stage} 分析所需的上游数据摘要。`);
  parts.push(`数据来源：${sourceLabels.join("、")}`);
  parts.push("");

  for (const [tableCode, rows] of Object.entries(upstreamData)) {
    if (!rows || (Array.isArray(rows) && rows.length === 0)) continue;

    parts.push(`### ${tableCode}`);
    if (Array.isArray(rows)) {
      parts.push(`（共 ${rows.length} 条记录）`);
      for (const row of rows) {
        parts.push(`- ${JSON.stringify(row)}`);
      }
    } else {
      parts.push(JSON.stringify(rows, null, 2));
    }
    parts.push("");
  }

  parts.push("请根据以上数据进行分析，输出 JSON。每条记录的 source 字段必须包含来源标注。");

  return parts.join("\n");
}