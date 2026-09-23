/**
 * @scene/infra — 应用自持供应商登记表（变更表 #16）
 *
 * 口径：模型配置与 DSH（.dsh/settings.yaml）解耦——应用默认"未配置"，
 * 供应商 / 链接(baseURL) / API Key / 模型全部由用户在设置页录入。
 * 存储：data/providers.local.json（不进 git，写盘 0600），可用
 * SCENE_PROVIDERS_FILE 环境变量指向其他路径（测试/CI 用）。
 * 密钥永不回显：公共面只给 has_key + key_masked。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── 类型 ──────────────────────────────────────────────────

export interface ProviderModelEntry {
  id: string;
  name?: string;
}

/** 完整档案（仅服务端内部使用，含密钥本体） */
export interface ProviderProfile {
  name: string;
  base_url: string;
  api_key: string;
  models: ProviderModelEntry[];
  updated_at: string;
}

/** 公共摘要（API 响应面，密钥脱敏） */
export interface ProviderPublic {
  name: string;
  base_url: string;
  models: ProviderModelEntry[];
  has_key: boolean;
  key_masked: string | null;
  updated_at: string;
}

export interface DefaultModelRef {
  provider: string;
  model: string;
}

export interface ProviderRegistry {
  providers: ProviderProfile[];
  default_model: DefaultModelRef | null;
}

/** 解析出的活跃模型调用参数（dsh-client 消费） */
export interface ResolvedModel {
  provider: ProviderProfile;
  modelId: string;
}

// ─── 读写 ──────────────────────────────────────────────────

export const NOT_CONFIGURED_MESSAGE =
  "尚未配置模型供应商：请在应用「设置 → 模型配置」添加供应商（名称 / 链接 / API Key / 模型）并选择默认模型";

function registryPath(): string {
  const env = process.env.SCENE_PROVIDERS_FILE;
  if (env) return resolve(env);
  return resolve(process.cwd(), "data", "providers.local.json");
}

function emptyRegistry(): ProviderRegistry {
  return { providers: [], default_model: null };
}

/** 读取登记表；文件缺失/损坏按"未配置"处理，不抛错 */
export function loadRegistry(): ProviderRegistry {
  try {
    const path = registryPath();
    if (!existsSync(path)) return emptyRegistry();
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) return emptyRegistry();
    const r = raw as Partial<ProviderRegistry>;
    const providers = Array.isArray(r.providers)
      ? r.providers.filter(
          (p): p is ProviderProfile =>
            typeof p === "object" && p !== null &&
            typeof (p as ProviderProfile).name === "string" &&
            typeof (p as ProviderProfile).base_url === "string",
        )
      : [];
    const def = r.default_model;
    const defaultModel =
      def && typeof def.provider === "string" && typeof def.model === "string"
        ? { provider: def.provider, model: def.model }
        : null;
    return { providers, default_model: defaultModel };
  } catch {
    return emptyRegistry();
  }
}

function saveRegistry(reg: ProviderRegistry): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// ─── 变更操作 ──────────────────────────────────────────────

/** 密钥脱敏：保留前 3 后 4，中间打点；短密钥全打点 */
export function maskKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export function toPublic(p: ProviderProfile): ProviderPublic {
  return {
    name: p.name,
    base_url: p.base_url,
    models: p.models,
    has_key: Boolean(p.api_key),
    key_masked: maskKey(p.api_key),
    updated_at: p.updated_at,
  };
}

export interface UpsertInput {
  name: string;
  base_url: string;
  /** 省略或空串 = 编辑时保留原密钥；新建时为空则存空串（has_key=false） */
  api_key?: string;
  models: ProviderModelEntry[];
}

/** 新增/更新供应商（按 name 匹配）；返回公共摘要 */
export function upsertProvider(input: UpsertInput): ProviderPublic {
  const name = input.name.trim();
  let baseUrl = input.base_url.trim();
  if (!name) throw new Error("供应商名称不能为空");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`链接需以 http(s):// 开头：${baseUrl || "（空）"}`);
  }
  // 自动补全 /v1 后缀（OpenAI 兼容 API 标准路径）：裸域名与无版本段路径都补，
  // 已带版本段（/v1、/v4…）保持原样；特殊网关可用「获取模型列表」探测后回填修正
  if (!/\/v\d+\/?$/.test(baseUrl)) {
    baseUrl = baseUrl.replace(/\/+$/, "") + "/v1";
  }
  const models = input.models
    .map((m) => ({ id: m.id.trim(), name: m.name?.trim() || undefined }))
    .filter((m) => m.id);
  if (models.length === 0) throw new Error("至少填写一个模型 ID");

  const reg = loadRegistry();
  const existing = reg.providers.find((p) => p.name === name);
  const key = input.api_key?.trim();
  const profile: ProviderProfile = {
    name,
    base_url: baseUrl.replace(/\/+$/, ""),
    api_key: key || existing?.api_key || "",
    models,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    reg.providers = reg.providers.map((p) => (p.name === name ? profile : p));
  } else {
    reg.providers.push(profile);
  }
  saveRegistry(reg);
  return toPublic(profile);
}

/** 删除供应商；默认模型指向它时一并清空默认 */
export function removeProvider(name: string): boolean {
  const reg = loadRegistry();
  const before = reg.providers.length;
  reg.providers = reg.providers.filter((p) => p.name !== name);
  if (reg.default_model?.provider === name) reg.default_model = null;
  if (reg.providers.length === before) return false;
  saveRegistry(reg);
  return true;
}

/** 设置默认供应商+模型；两者必须存在于登记表 */
export function setDefaultModel(ref: DefaultModelRef): DefaultModelRef {
  const reg = loadRegistry();
  const provider = reg.providers.find((p) => p.name === ref.provider);
  if (!provider) throw new Error(`未找到供应商 "${ref.provider}"`);
  if (ref.model && !provider.models.some((m) => m.id === ref.model)) {
    throw new Error(`供应商 "${ref.provider}" 不含模型 ${ref.model}`);
  }
  const model = ref.model || provider.models[0]!.id;
  reg.default_model = { provider: ref.provider, model };
  saveRegistry(reg);
  return reg.default_model;
}

// ─── 解析 ──────────────────────────────────────────────────

/** 公共面快照（设置页/状态用） */
export function registrySummary(): {
  configured: boolean;
  providers: ProviderPublic[];
  default_model: DefaultModelRef | null;
} {
  const reg = loadRegistry();
  const defaultModel =
    reg.default_model &&
    reg.providers.some((p) => p.name === reg.default_model!.provider)
      ? reg.default_model
      : null;
  return {
    configured: defaultModel !== null && Boolean(
      reg.providers.find((p) => p.name === defaultModel?.provider)?.api_key,
    ),
    providers: reg.providers.map(toPublic),
    default_model: defaultModel,
  };
}

/**
 * 解析当前应使用的模型（dsh-client 每次调用实时解析，改配置即时生效）。
 * @throws 未配置时抛错，消息指向设置页
 */
export function resolveActiveModel(providerName?: string, modelId?: string): ResolvedModel {
  const reg = loadRegistry();
  if (providerName) {
    const provider = reg.providers.find((p) => p.name === providerName);
    if (!provider) throw new Error(`未找到供应商 "${providerName}"（${NOT_CONFIGURED_MESSAGE}）`);
    return { provider, modelId: modelId || provider.models[0]?.id || "" };
  }
  const def = registrySummary().default_model;
  if (!def) throw new Error(NOT_CONFIGURED_MESSAGE);
  const provider = reg.providers.find((p) => p.name === def.provider)!;
  if (!provider!.api_key) {
    throw new Error(`供应商 "${provider!.name}" 未填 API Key：请在设置页补录`);
  }
  return { provider, modelId: modelId || def.model };
}
