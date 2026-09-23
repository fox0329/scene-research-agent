import React, { useState } from "react";
import { useToast } from "../components/Toast";

/* ── Mock 数据 ── */

interface ModelProvider {
  key: string;
  label: string;
  models: string[];
}

const PROVIDERS: ModelProvider[] = [
  {
    key: "talkweb",
    label: "Talkweb",
    models: ["deepseek-v4-pro", "deepseek-v4-lite", "deepseek-r1"],
  },
  {
    key: "zai-coding-cn",
    label: "ZAI Coding CN",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
  },
  {
    key: "xiaomi-token-plan-cn",
    label: "Xiaomi Token Plan CN",
    models: ["mi-7b-chat", "mi-13b-chat", "mi-70b-chat"],
  },
];

/** 模型配置（mock 初始值） */
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

/* ── 视图 ── */

/**
 * 设置页视图（视图 4）
 * - 面板 1：DSH 连接
 * - 面板 2：模型选择
 * - 面板 3：数据管理
 */
export const SettingsView: React.FC = () => {
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
        <span className="pgs">.dsh/settings.yaml</span>
      </div>

      {/* 工作区 */}
      <div className="ws">
        {/* 面板 1：DSH 连接 */}
        <section className="pnl">
          <div className="pnl-h">
            <div>
              <h2>DSH 连接</h2>
              <p>DeepSeek Harness 实例状态</p>
            </div>
            <span className="status-dot status-dot--ok" title="运行中" />
          </div>
          <div className="pnl-b">
            <div className="settings-kv-grid">
              <span className="kv-k">状态</span>
              <span className="kv-v">
                <span className="badge success">运行中</span>
              </span>

              <span className="kv-k">服务地址</span>
              <span className="kv-v kv-mono">http://127.0.0.1:3081</span>

              <span className="kv-k">实例隔离</span>
              <span className="kv-v">项目独立（与本地 3080 不冲突）</span>

              <span className="kv-k">数据目录</span>
              <span className="kv-v kv-mono">.dsh/</span>
            </div>

            <div className="settings-actions">
              <button className="btn" onClick={() => showToast("已发送重启请求")}>重启服务</button>
              <button className="btn" onClick={() => showToast("日志路径：.dsh/dsh-web.log")}>查看日志</button>
            </div>
          </div>
        </section>

        {/* 面板 2：模型选择 */}
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

        {/* 面板 3：数据管理 */}
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
