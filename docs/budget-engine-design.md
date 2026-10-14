# budget-v3 候选：输出上限、计量与上下文拒绝

2026-10-14。本增量保持官方 DSH AgentLoop，复用 resident-v2 的七个明确内核变换，
另建 `dsh-source-639ed015-budget-v3`。`source-runner.mjs`、v1 产物与 v2 候选均不覆盖。

## 协议

- init 必须提供固定任务快照的 `model_max_tokens` 和 `context_tokens`。
  普通生成采用配置上限，压缩采用 `min(2048, model_max_tokens)`；配置非法直接失败。
- 最终请求包含 Runtime 追加的约束和子任务结果，由 Worker 校验。Node 不再用不同的
  逐消息估算直接终止；预检仍是启发式，不能声称等同于供应商分词器。
- `model` RPC 带 `purpose=generation|compaction`。Runtime 返回版本为 1 的正常结果：
  已提交的 `completion`，或在未登记任何供应商调用的条件下提交的 `context_rejected`。
- 拒绝必须正常穿过 SourcePersistence 的持久化确认，随后才转成官方
  `CONTEXT_WINDOW_EXCEEDED`。传输、取消、fence、数据库和总预算错误不能走这条路径。
- 使用官方恢复钩子，最多两次 overflow 恢复；需要有效的 surface 替换推进。
  压缩完成后的 checkpoint 必须成功，失败状态会阻止随后所有外部动作。
  摘要请求本身超限、无可压缩内容或持续超限时有界失败。
- 供应商计量从 Runtime 已提交回执取得，Node 在 finish 前发送独立 `usage` chunk。
  prompt 已包含缓存：DSH 的非缓存输入是 `prompt - cached`；缓存单独计数，reasoning
  不额外累加。缺失计量保持缺失，不能伪造零用量；重放采用同一冻结值。

## 本机验证及边界

```powershell
pnpm build:budget
pnpm test:budget
pnpm test
pnpm test:resident
```

15 项候选测试、16 项历史测试和 19 项 resident 测试通过，零跳过。
实际启动独立 Node 进程并执行源码 DSH，测试包括：6144 输出配置及合成 5000-token
回执、usage 驱动压力、拒绝后压缩及工作状态保留、初始不可压缩请求、摘要拒绝、
持续溢出、传输失败、checkpoint 失败屏障，以及拒绝和压缩替换处丢回复/强杀重放。

最初 usage 压力测试失败，是合成历史全部落在默认保留范围内，没有可压缩的旧片段。
改为有旧片段的历史后，同样文本在普通估算下不压缩、计入较高的供应商计量后压缩；
未放宽断言或替换官方压缩策略。

本轮证据：`local/evidence/p25-budget-harness-d826a2cae0b54a428096d87f92115329`。
这里的监督器、模型和回执都是明确夹具；并非真实 PostgreSQL、Worker 或付费模型。
候选尚未安装。后续必须完成 Runtime/Worker 联合中断、独立版本 pin、包选择与回退，
再做有界供应商和研究成稿验收，不能把合成输出长度算成真实模型验证。
