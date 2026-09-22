/**
 * @scene/infra — DSH 配置读取
 *
 * 从 .dsh/settings.yaml 读取 LLM 供应商配置。
 * apiKeyEnv 是环境变量名，不是密钥本身（AGENTS.md 规则 4）。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

// ─── 类型定义 ─────────────────────────────────────────────

/** 单个模型定义 */
export interface ModelSpec {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** 供应商配置 */
export interface ProviderConfig {
  displayName?: string;
  apiKeyEnv: string;
  api: "openai-completions";
  baseURL?: string;
  models: ModelSpec[];
}

/** 默认模型配置 */
export interface DefaultModelConfig {
  provider: string;
  model: string;
}

// ─── 内部缓存 ─────────────────────────────────────────────

let cachedProviders: Record<string, ProviderConfig> | null = null;
let cachedDefaultModel: DefaultModelConfig | null = null;

// ─── 解析工具 ─────────────────────────────────────────────

/**
 * 解析 settings.yaml 原始对象，提取 providers 和 default model。
 * 测试时可传入自定义 raw 对象。
 */
export function parseSettings(raw: Record<string, unknown>): {
  providers: Record<string, ProviderConfig>;
  defaultModel: DefaultModelConfig;
} {
  const llmSection = raw["llm-pi-ai"] as Record<string, unknown> | undefined;
  const providersRaw = (llmSection?.["providers"] ?? {}) as Record<string, unknown>;
  const providers: Record<string, ProviderConfig> = {};

  for (const [name, rawConfig] of Object.entries(providersRaw)) {
    const cfg = rawConfig as Record<string, unknown>;
    const apiKeyEnv = cfg["apiKeyEnv"] as string;
    if (!apiKeyEnv) {
      throw new Error(`provider "${name}" 缺少 apiKeyEnv 配置`);
    }

    providers[name] = {
      displayName: cfg["displayName"] as string | undefined,
      apiKeyEnv,
      api: (cfg["api"] as "openai-completions") ?? "openai-completions",
      baseURL: cfg["baseURL"] as string | undefined,
      models: ((cfg["models"] ?? []) as Record<string, unknown>[]).map((m) => ({
        id: m["id"] as string,
        name: (m["name"] as string) ?? (m["id"] as string),
        contextWindow: m["contextWindow"] as number | undefined,
        maxTokens: m["maxTokens"] as number | undefined,
      })),
    };
  }

  const agentSection = raw["agent-default-model"] as Record<string, unknown> | undefined;
  const defaultModel: DefaultModelConfig = {
    provider: (agentSection?.["provider"] as string) ?? "talkweb",
    model: (agentSection?.["model"] as string) ?? "deepseek-v4-pro",
  };

  return { providers, defaultModel };
}

// ─── 公共 API ─────────────────────────────────────────────

/**
 * 获取指定供应商的配置。
 *
 * @param providerName 供应商名称（如 "talkweb"、"zai-coding-cn"）
 * @throws 找不到供应商时抛出错误
 */
export function getProviderConfig(providerName: string): ProviderConfig {
  if (!cachedProviders) {
    loadSettings();
  }
  const cfg = cachedProviders![providerName];
  if (!cfg) {
    const available = Object.keys(cachedProviders!).join(", ");
    throw new Error(
      `未找到供应商 "${providerName}"，可用供应商：${available || "无（settings.yaml 未配置）"}`,
    );
  }
  return cfg;
}

/**
 * 获取默认模型配置（agent-default-model 段）。
 */
export function getDefaultModelConfig(): DefaultModelConfig {
  if (!cachedDefaultModel) {
    loadSettings();
  }
  return cachedDefaultModel!;
}

/**
 * 获取供应商的 API Key（从 apiKeyEnv 对应的环境变量读取）。
 *
 * @param providerName 供应商名称
 * @returns API Key
 * @throws 环境变量未设置时抛出错误
 */
export function getApiKey(providerName: string): string {
  const cfg = getProviderConfig(providerName);
  const key = process.env[cfg.apiKeyEnv];
  if (!key) {
    throw new Error(
      `环境变量 ${cfg.apiKeyEnv} 未设置（供应商 "${providerName}" 需要此密钥）`,
    );
  }
  return key;
}

/**
 * 获取供应商的 baseURL。
 * 如果供应商配置中没有 baseURL，使用 DSH 代理地址。
 *
 * @param providerName 供应商名称
 * @param dshPort DSH 端口（默认从 DSH_PORT 环境变量读取，fallback 3081）
 */
export function getBaseURL(providerName: string, dshPort?: number): string {
  const cfg = getProviderConfig(providerName);
  if (cfg.baseURL) {
    return cfg.baseURL;
  }
  // 无显式 baseURL 时，通过 DSH 代理转发
  const port = dshPort ?? getDshPort();
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * 获取 DSH 端口。
 * 优先 DSH_PORT 环境变量，默认 3081。
 */
export function getDshPort(): number {
  const envPort = process.env.DSH_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`DSH_PORT 环境变量值无效：${envPort}`);
    }
    return port;
  }
  return 3081;
}

/**
 * 获取 DSH Token（可选鉴权令牌）。
 */
export function getDshToken(): string | undefined {
  return process.env.DSH_TOKEN || undefined;
}

/**
 * 清除缓存（用于测试）。
 */
export function clearConfigCache(): void {
  cachedProviders = null;
  cachedDefaultModel = null;
}

// ─── 内部实现 ─────────────────────────────────────────────

function loadSettings(): void {
  const settingsPath = resolveSettingsPath();

  if (!existsSync(settingsPath)) {
    throw new Error(
      `DSH 配置文件不存在：${settingsPath}\n` +
      "请先启动 DSH 或创建 .dsh/settings.yaml",
    );
  }

  const content = readFileSync(settingsPath, "utf-8");
  const raw = parseYaml(content) as Record<string, unknown>;
  const { providers, defaultModel } = parseSettings(raw);

  cachedProviders = providers;
  cachedDefaultModel = defaultModel;
}

function resolveSettingsPath(): string {
  // 从项目根目录的 .dsh/ 下读取
  // 进程工作目录应为项目根
  return resolve(process.cwd(), ".dsh", "settings.yaml");
}