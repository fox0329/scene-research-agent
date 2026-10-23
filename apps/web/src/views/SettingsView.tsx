import React, { useMemo, useState } from "react";
import { useToast } from "../components/Toast";
import {
  api,
  type ApiConnectionCheck,
  type ApiProviderPublic,
  type ApiProvidersState,
} from "../api";
import { useAsync } from "../hooks/useAsync";

/* ── 视图入口 ── */

interface SettingsViewProps {
  /** 联真模式：应用自持供应商登记表（变更表 #16）；演示模式保持 mock 面板 */
  live?: boolean;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ live }) =>
  live ? <SettingsViewLive /> : <SettingsViewMock />;

/** 桌面壳桥（preload 暴露）：浏览器版没有这个对象 */
interface SceneDesktopBridge {
  openDataDir?: () => Promise<unknown>;
  appInfo?: () => Promise<{ version?: string }>;
}

function desktopBridge(): SceneDesktopBridge | null {
  const w = window as unknown as { sceneDesktop?: SceneDesktopBridge };
  return w.sceneDesktop ?? null;
}

/* ══════════════ 联真模式：模型配置（供应商/链接/Key/模型 + 测试连接） ══════════════ */

interface FormState {
  name: string;
  base_url: string;
  api_key: string;
  /** 模型 ID 列表 */
  models: string[];
}

const EMPTY_FORM: FormState = { name: "", base_url: "", api_key: "", models: [] };

/** 检查结果 → 一行人类可读文案 */
function describeCheck(r: ApiConnectionCheck): string {
  const ms =
    r.stage === "chat"
      ? `模型可用 · 生成往返 ${r.chat_latency_ms ?? "-"}ms`
      : `链路可达 · 往返 ${r.models_latency_ms ?? "-"}ms`;
  const seen = r.models_seen?.length ? ` · 发现 ${r.models_seen.length} 个模型` : "";
  return r.ok ? `✅ ${ms}${seen}` : `❌ ${r.error ?? "检查失败"}`;
}

const SettingsViewLive: React.FC = () => {
  const { showToast } = useToast();
  const state = useAsync<ApiProvidersState>(() => api.providers(), []);
  const status = useAsync(() => api.systemStatus(), []);
  /** 桌面壳版本（浏览器版没有桥，显示“浏览器版”） */
  const appInfo = useAsync<{ version?: string }>(() => desktopBridge()?.appInfo?.() ?? Promise.resolve({}), []);

  const [creating, setCreating] = useState(false);
  /** 编辑中的供应商名（null=新建） */
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [draftCheck, setDraftCheck] = useState<ApiConnectionCheck | null>(null);
  const [rowCheck, setRowCheck] = useState<Record<string, ApiConnectionCheck | null>>({});
  const [busy, setBusy] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  /** 一键发现：进行中标记与拉到的候选模型 ID 列表（null=未拉取） */
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);

  const providers = useMemo(() => state.data?.providers ?? [], [state.data]);
  const defaultModel = state.data?.default_model ?? null;
  const defaultProvider = providers.find((p) => p.name === defaultModel?.provider) ?? null;

  const openCreate = () => {
    setCreating(true);
    setEditingName(null);
    setForm(EMPTY_FORM);
    setDraftCheck(null);
    setNewModelId("");
    setDiscovered(null);
  };

  const openEdit = (p: ApiProviderPublic) => {
    setCreating(true);
    setEditingName(p.name);
    setForm({
      name: p.name,
      base_url: p.base_url,
      api_key: "",
      models: p.models.map((m) => m.id),
    });
    setDraftCheck(null);
    setNewModelId("");
    setDiscovered(null);
  };

  const closeForm = () => {
    setCreating(false);
    setEditingName(null);
    setForm(EMPTY_FORM);
    setDraftCheck(null);
    setNewModelId("");
    setDiscovered(null);
  };

  const handleAddModel = () => {
    const id = newModelId.trim();
    if (!id) return;
    if (form.models.includes(id)) return;
    setForm((f) => ({ ...f, models: [...f.models, id] }));
    setNewModelId("");
  };

  const handleRemoveModel = (id: string) => {
    setForm((f) => ({ ...f, models: f.models.filter((m) => m !== id) }));
  };

  const toggleModel = (id: string) => {
    setForm((f) =>
      f.models.includes(id)
        ? { ...f, models: f.models.filter((m) => m !== id) }
        : { ...f, models: [...f.models, id] },
    );
  };

  /**
   * 一键发现服务端模型列表（仿 CC Switch）：候选端点自动探测，免手敲 ID。
   * 命中的实际链接与输入不同（如自动补了 /v1）时回填表单。
   * 编辑态未重输 Key 用已存密钥（密钥不回传前端）。
   */
  const handleFetchModels = async () => {
    const draftUrl = form.base_url.trim();
    setDiscovering(true);
    try {
      const r =
        editingName && !form.api_key.trim()
          ? await api.fetchProviderModels({ name: editingName, base_url: draftUrl })
          : await api.fetchProviderModels({ base_url: draftUrl, api_key: form.api_key.trim() });
      if (!r.ok) {
        setDiscovered(null);
        showToast(r.error ?? "获取模型列表失败");
        return;
      }
      setDiscovered(r.models);
      const resolved = r.resolved_base_url?.replace(/\/+$/, "") ?? "";
      if (resolved && resolved !== draftUrl.replace(/\/+$/, "")) {
        setForm((f) => ({ ...f, base_url: resolved }));
        showToast(`链接已自动修正为 ${resolved}（发现 ${r.models.length} 个模型）`);
      } else {
        showToast(`发现 ${r.models.length} 个模型，点击选用`);
      }
    } catch (err: unknown) {
      setDiscovered(null);
      showToast(`获取失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiscovering(false);
    }
  };

  /** 草稿态连接测试：未保存也可先测链接质量；编辑且未重输 Key 时用已存密钥 */
  const handleDraftTest = async () => {
    const firstModel = form.models[0];
    setBusy(true);
    try {
      const r =
        editingName && !form.api_key.trim()
          ? await api.testProvider({ name: editingName, model: firstModel })
          : await api.testProvider({
              base_url: form.base_url.trim(),
              api_key: form.api_key.trim(),
              model: firstModel,
            });
      setDraftCheck(r);
    } catch (err: unknown) {
      setDraftCheck({ ok: false, stage: "models", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await api.upsertProvider({
        name: form.name,
        base_url: form.base_url,
        ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}),
        models: form.models.map((id) => ({ id })),
      });
      showToast(`已保存供应商「${form.name.trim()}」`);
      closeForm();
      state.reload();
      void status.reload();
    } catch (err: unknown) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRowTest = async (p: ApiProviderPublic) => {
    setRowCheck((m) => ({ ...m, [p.name]: null }));
    try {
      const r = await api.testProvider({ name: p.name });
      setRowCheck((m) => ({ ...m, [p.name]: r }));
    } catch (err: unknown) {
      setRowCheck((m) => ({
        ...m,
        [p.name]: { ok: false, stage: "models", error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const handleDelete = async (p: ApiProviderPublic) => {
    if (!window.confirm(`删除供应商「${p.name}」？其链接与 API Key 一并删除。`)) return;
    try {
      await api.deleteProvider(p.name);
      showToast(`已删除供应商「${p.name}」`);
      state.reload();
      void status.reload();
    } catch (err: unknown) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSetDefault = async (p: ApiProviderPublic, model: string) => {
    try {
      await api.setDefaultModel(p.name, model);
      showToast(`默认模型：${p.name} / ${model}`);
      state.reload();
      void status.reload();
    } catch (err: unknown) {
      showToast(`设置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const editingProvider = providers.find((p) => p.name === editingName) ?? null;

  return (
    <>
      <div className="pgh">
        <div className="pgt">设置</div>
        <span className="pgs">data/providers.local.json</span>
      </div>

      <div className="ws ws-settings">
        {/* 面板 0：应用状态 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>应用状态</h2>
              <p>数据库与模型配置概览</p>
            </div>
          </div>
          <div className="pnl-b">
            <div className="settings-kv-grid">
              <span className="kv-k">业务数据库</span>
              <span className="kv-v">
                {status.status === "loading" ? (
                  <span className="badge">检测中…</span>
                ) : (
                  <span className={`badge ${status.data?.db === "ok" ? "success" : "error"}`}>
                    {status.data?.db === "ok" ? "正常" : "异常"}
                  </span>
                )}
              </span>

              <span className="kv-k">模型配置</span>
              <span className="kv-v">
                {state.status === "ok" &&
                  (state.data?.configured ? (
                    <span className="badge success">
                      已配置 · {defaultModel?.provider} / {defaultModel?.model}
                    </span>
                  ) : (
                    <span className="badge warning">未配置（AI 分析暂不可用）</span>
                  ))}
              </span>
            </div>
          </div>
        </section>

        {/* 面板 1：产品立场（2026-10-21 用户定调）——目的不是"证明产品万能"，
            而是客观调研场景；结论可以有立场，但决定权在用户，门禁兜底不许编事实 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>产品立场</h2>
              <p>这个工具为什么存在：客观调研场景，把产品放到能赢的位置</p>
            </div>
          </div>
          <div className="pnl-b">
            <ul className="stance-list">
              <li>
                <strong>不是证明"什么场景都能用"</strong>：先摸清场景的门槛、玩家、采购与利润池，再判断我方在哪一段有真实赢面——把产品价值放到最大，不用话术掩盖短板。
              </li>
              <li>
                <strong>结论可以有立场</strong>：门槛过不去、没有相关资质、价格无成本优势、能力有缺口，结论提醒会直说「不建议贸然进入 / 不建议正面竞争」，并注明依据（哪张表哪一行）。
              </li>
              <li>
                <strong>建议权归智能体，决定权归用户</strong>：进不进、投不投由你拍板；工具只给有依据的提醒，不阻断推进。
              </li>
              <li>
                <strong>门禁兜底</strong>：30 条确定性门禁在导出前逐条校验数字可溯源、来源权威性、证据等级；查不到一律写「未知」，不许编事实。
              </li>
            </ul>
          </div>
        </section>

        {/* 面板 2：模型配置 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>模型配置</h2>
              <p>供应商 / 链接 / API Key / 模型由本页录入，与 DSH 配置无关；密钥存本机 data/（不进 git）</p>
            </div>
            {!creating && providers.length > 0 && (
              <button className="btn" type="button" onClick={openCreate}>
                添加供应商
              </button>
            )}
          </div>
          <div className="pnl-b">
            {state.status === "loading" && (
              <div className="loading-strip" role="status" aria-label="加载中" />
            )}
            {state.status === "error" && (
              <div className="empty-state">
                <div className="empty-state-title">加载失败</div>
                <div className="empty-state-desc">{state.error}</div>
                <button className="btn" type="button" onClick={state.reload}>重试</button>
              </div>
            )}

            {state.status === "ok" && providers.length === 0 && !creating && (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <div className="empty-state-title">尚未配置模型供应商</div>
                <div className="empty-state-desc">
                  填写供应商名称、OpenAI 兼容链接（以 /v1 结尾）、API Key 与模型 ID，
                  点「测试连接」验证链路质量后保存，AI 分析即可用
                </div>
                <button className="btn primary" type="button" onClick={openCreate}>
                  添加供应商
                </button>
              </div>
            )}

            {/* 供应商列表 */}
            {providers.length > 0 && (
              <div className="provider-list">
                {providers.map((p) => {
                  const isDefaultProvider = defaultModel?.provider === p.name;
                  const check = rowCheck[p.name];
                  return (
                    <div key={p.name} className="provider-item">
                      <div className="provider-item-head">
                        <span className="provider-item-name">{p.name}</span>
                        {isDefaultProvider && <span className="badge primary">默认</span>}
                        <span className={`badge ${p.has_key ? "success" : "warning"}`}>
                          {p.has_key ? `Key 已配置 ${p.key_masked ?? ""}` : "Key 未填"}
                        </span>
                      </div>
                      <div className="provider-item-meta kv-mono">{p.base_url}/models</div>
                      <div className="provider-models-list">
                        {p.models.length === 0 ? (
                          <span className="provider-item-meta">（无模型）</span>
                        ) : (
                          p.models.map((m) => (
                            <span key={m.id} className="provider-model-tag">
                              {m.id}
                            </span>
                          ))
                        )}
                      </div>
                      {check && (
                        <div className={`conn-check ${check.ok ? "conn-check--ok" : "conn-check--err"}`}>
                          {describeCheck(check)}
                        </div>
                      )}
                      <div className="provider-item-actions">
                        <button className="btn" type="button" onClick={() => void handleRowTest(p)}>
                          测试连接
                        </button>
                        <button className="btn" type="button" onClick={() => openEdit(p)}>
                          编辑
                        </button>
                        <button className="btn" type="button" onClick={() => void handleDelete(p)}>
                          删除
                        </button>
                        <select
                          className="settings-select provider-model-select"
                          aria-label={`${p.name} 默认模型`}
                          value={isDefaultProvider ? defaultModel?.model ?? "" : ""}
                          onChange={(e) => e.target.value && void handleSetDefault(p, e.target.value)}
                        >
                          <option value="" disabled>
                            设为默认模型…
                          </option>
                          {p.models.map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 添加/编辑表单 */}
            {creating && (
              <div className="provider-form">
                <div className="settings-form">
                  <label className="settings-field">
                    <span className="settings-label">供应商名称</span>
                    <input
                      className="settings-input"
                      value={form.name}
                      disabled={editingName !== null}
                      placeholder="例：deepseek-official"
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">链接（OpenAI 兼容 baseURL）</span>
                    <input
                      className="settings-input"
                      value={form.base_url}
                      placeholder="https://api.example.com/v1（不带 /v1 也能自动识别）"
                      onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">
                      API Key{editingProvider?.has_key ? `（已存 ${editingProvider.key_masked}，留空保持不变）` : ""}
                    </span>
                    <input
                      className="settings-input"
                      type="password"
                      value={form.api_key}
                      placeholder="sk-…"
                      onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">模型列表</span>
                    <div className="model-discover-row">
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={
                          discovering ||
                          !form.base_url.trim() ||
                          (!editingName && !form.api_key.trim())
                        }
                        onClick={() => void handleFetchModels()}
                      >
                        {discovering ? "获取中…" : "从服务端获取模型列表"}
                      </button>
                      <span className="provider-item-meta">
                        填好链接与 Key 后一键发现，点选即用；获取不到可手填
                      </span>
                    </div>
                    {discovered && discovered.length > 0 && (
                      <div className="model-pick-list" role="group" aria-label="服务端发现的模型">
                        {discovered.map((id) => {
                          const on = form.models.includes(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              className={`model-pick-tag${on ? " on" : ""}`}
                              aria-pressed={on}
                              onClick={() => toggleModel(id)}
                            >
                              {id}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="model-list">
                      {form.models.length === 0 && (
                        <span className="provider-item-meta">尚未添加模型</span>
                      )}
                      {form.models.map((id) => (
                        <div key={id} className="model-list-item">
                          <span className="kv-mono">{id}</span>
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => handleRemoveModel(id)}
                            aria-label={`删除模型 ${id}`}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                      <div className="model-list-add">
                        <input
                          className="settings-input"
                          value={newModelId}
                          placeholder="手动补充模型 ID（网关未开放列表接口时用）"
                          onChange={(e) => setNewModelId(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddModel();
                            }
                          }}
                        />
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={handleAddModel}
                          disabled={!newModelId.trim()}
                        >
                          添加
                        </button>
                      </div>
                    </div>
                  </label>
                </div>

                {draftCheck && (
                  <div className={`conn-check ${draftCheck.ok ? "conn-check--ok" : "conn-check--err"}`}>
                    {describeCheck(draftCheck)}
                  </div>
                )}

                <div className="settings-actions">
                  <button className="btn" type="button" disabled={busy} onClick={() => void handleDraftTest()}>
                    测试连接
                  </button>
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void handleSave()}>
                    保存
                  </button>
                  <button className="btn" type="button" onClick={closeForm}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* 面板 4：诊断与支持（发布前 P1）——报障时导出，不含 Key 与正文 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>诊断与支持</h2>
              <p>导出后可直接发给支持人员；只含版本、数据规模与最近日志，不含模型 Key 与正文</p>
            </div>
          </div>
          <div className="pnl-b">
            <div className="settings-actions">
              <a className="btn" href={api.diagnosticsUrl()} download>
                导出诊断信息
              </a>
              {desktopBridge()?.openDataDir ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => void desktopBridge()?.openDataDir?.()}
                >
                  打开数据目录
                </button>
              ) : null}
              <span className="provider-item-meta">
                版本 {appInfo.data?.version ?? "浏览器版"}（升级前请自行复制数据目录）
              </span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
};

/* ══════════════ 演示模式（vite preview / 无后端：保持原型 mock 面板） ══════════════ */

interface ModelProvider {
  key: string;
  label: string;
  models: string[];
}

const PROVIDERS: ModelProvider[] = [
  { key: "talkweb", label: "Talkweb", models: ["deepseek-v4-pro", "deepseek-v4-lite", "deepseek-r1"] },
  { key: "zai-coding-cn", label: "ZAI Coding CN", models: ["qwen-max", "qwen-plus", "qwen-turbo"] },
  { key: "xiaomi-token-plan-cn", label: "Xiaomi Token Plan CN", models: ["mi-7b-chat", "mi-13b-chat", "mi-70b-chat"] },
];

interface ModelConfig {
  providerKey: string;
  defaultModel: string;
  analysisModel: string;
}

const INITIAL_CONFIG: ModelConfig = {
  providerKey: "talkweb",
  defaultModel: "deepseek-v4-pro",
  analysisModel: "deepseek-r1",
};

const SettingsViewMock: React.FC = () => {
  const { showToast } = useToast();
  const [config, setConfig] = useState<ModelConfig>(INITIAL_CONFIG);

  const provider = PROVIDERS.find((p) => p.key === config.providerKey) ?? PROVIDERS[0];

  /** 切换供应商：重置模型为该供应商第一个 */
  const handleProviderChange = (key: string) => {
    const p = PROVIDERS.find((pr) => pr.key === key) ?? PROVIDERS[0];
    setConfig({ providerKey: key, defaultModel: p.models[0], analysisModel: p.models[1] ?? p.models[0] });
  };

  const handleSave = () => {
    showToast("已保存模型配置");
  };

  return (
    <>
      {/* 页头 */}
      <div className="pgh">
        <div className="pgt">设置</div>
        <span className="pgs">原型演示数据</span>
      </div>

      {/* 工作区 */}
      <div className="ws ws-settings">
        {/* 面板 1：模型选择 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>模型选择</h2>
              <p>配置默认与分析用模型</p>
            </div>
          </div>
          <div className="pnl-b">
            <div className="settings-form">
              <label className="settings-field">
                <span className="settings-label">供应商</span>
                <select
                  className="settings-select"
                  value={config.providerKey}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </label>

              <label className="settings-field">
                <span className="settings-label">默认模型</span>
                <select
                  className="settings-select"
                  value={config.defaultModel}
                  onChange={(e) => setConfig((c) => ({ ...c, defaultModel: e.target.value }))}
                >
                  {provider.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>

              <label className="settings-field">
                <span className="settings-label">分析用模型</span>
                <select
                  className="settings-select"
                  value={config.analysisModel}
                  onChange={(e) => setConfig((c) => ({ ...c, analysisModel: e.target.value }))}
                >
                  {provider.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="settings-actions">
              <button className="btn primary" onClick={handleSave}>保存</button>
            </div>
          </div>
        </section>

        {/* 面板 2：数据管理 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>数据管理</h2>
              <p>业务数据库与导出导入</p>
            </div>
          </div>
          <div className="pnl-b">
            <div className="settings-kv-grid">
              <span className="kv-k">业务数据库</span>
              <span className="kv-v kv-mono">data/scene-master.db</span>
            </div>

            <div className="settings-actions">
              <button className="btn" onClick={() => showToast("导出完成：data/scene-master.db")}>导出数据</button>
              <button className="btn" onClick={() => showToast("请选择要导入的文件")}>导入数据</button>
              <button className="btn" onClick={() => showToast("已打开 data/ 目录")}>打开目录</button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
};
