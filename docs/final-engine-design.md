# 确定性交付候选 final-v5

2026-10-17：候选引擎 `dsh-source-639ed015-final-v5`，**未安装**。Runtime / Worker / 资源登记及正式发布仍待集成。本项属于完整单机交付，不替代其他验收。

## 协议

配置来自冻结的 `Agent.final_output`（SDK rc.4），指定 `receipt-field-v1`、候选工具、原始输入字符串字段及响应中的布尔就绪路径。Runtime 必须验证本任务的最新已提交候选，返回 `receipt.final_output.sha256`；模型只引用回执，不计算摘要。

`final_output_commit(operation_id, sha256)` 是保留的 DSH 工具。它只能独占一批工具调用，检查发生在任何模型块交给 DSH 前，因为上游 `concludeTurn()` 不阻止同批后续工具。它通过 `final_output_select` 提交引用，收到匹配的选择回执后调用官方 `concludeTurn()`。不修改上游源码，不创建另一个 Agent 循环。

成功回执包含 `selected:true`、`selection_id`、`operation_id`、`sha256`、`policy_sha256`、`rule_revision`。确定性拒绝为 `selected:false,continue`，DSH 可继续修订。参数由执行器再次校验；模型参数错误是可恢复工具错误，不得污染可信事件观察器。

结束时必须观察到同一轮、同一步、同一调用的真实成功 `tool/result` 及 `completed` 的 `turn/end`。仅 execute 中的内存标志不够，因为后续渲染/校验、取消或迟到输入可能改变结果。工具结果、步和轮次结束经过现有持久化屏障确认后，才发送 `finish_ref({selection_id})`。Runtime 原子保存原字符串、完成状态和引用回执；这部分不能由本候选的协议夹具证明。

`finish_ref` 成功需返回匹配的 `done:true,selection_id,sha256`；约束变化拒绝为 `done:false,continue`，丢弃旧选择并重新交给 DSH。配置策略的任务没有普通文本 `finish` 兜底；未配置策略的 v5 任务保留普通交付。后续选择和完成都必须由 Runtime 重新核对冻结配置、最新候选、约束、租约、取消及未决调用。

## 验证范围

`node scripts/build-final.mjs` 和 `node --test tests/final/*.test.mjs`：19 项通过、零 skip。使用真实源码构建 DSH 和独立 Node 子进程，supervisor / 模型为合成协议夹具，没有付费调用。

- 约 240 KB 的 Unicode、组合字符、CRLF 和末尾空白只在送检时传送；结束只发送短引用。
- 批中提交前后夹杂工具均在调度前拒绝；错误参数后可修正继续；拒绝选稿/结束可重新检查。
- 提交选择、工具结果持久化、结束三个位置分别在回复丢失/发送后强杀，重启按固定帧重放，不产生额外供应商请求。发送回复不等于证明子进程已处理回复。
- 工具结果持久化失败不越过屏障；错误回执/直接文本不能误完成；官方压力 Compact 后仍可交付和重放。
- 失败工具结果、后续步骤和轮次不匹配不能沿用内存选择；无策略任务可普通结束。

独立评审找出错误模型参数造成永久失败的问题，修复后加了真实 DSH 回归。历史 native-v4 的 17 项回归通过；上游、补丁、native runner/kernel/build 和依赖锁未修改，重建 v4 kernel SHA-256 仍为 `f5b97bfb19e95713d33182b71d859b2f3fbf6db0c69076c1e694590faaaca983`。

这些测试没有证明 Runtime SQL 原子性、正式进程接管、资源注册兼容或研究内容正确。正式发布前仍须 Owner 数据库故障测试、SDK writer 快照回读、Worker 固定版本、发布兼容和业务验收。Actions 日常关闭。
