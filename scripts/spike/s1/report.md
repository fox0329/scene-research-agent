# Spike S1 · DSH 客户端底座验证

日期：2026-09-22

## 结论

| 路线 | 结论 | 理由 |
|---|---|---|
| ① npm 发布版 | ❌ 不可行 | 传递依赖 dsh-type-meta@^0.0.1-rc.1 返回 404，与故障 #1 同根因 |
| ② vendor workspace 挂载 | ✅ 有条件可行 | remotes 包已构建（lib/ 含 exports），需将 vendor 子树加入 pnpm-workspace.yaml + 3 个 workspace deps |
| ③ 直连 OpenAI 兼容 API | ✅ 可行 | 3 个 provider 均已配置（talkweb/zai/xiaomi），标准 openai-completions 格式 |

## 推荐

② 首选 → ③ 兜底 → ① 放弃

- ② 保持 Agent 会话能力（prompt/follow 事件流）+ 与现有 vendor 构建路线一致
- ③ 在 ② 的 workspace 依赖冲突难收敛时可快速跑通 M0
