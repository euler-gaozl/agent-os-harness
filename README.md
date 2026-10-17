# Agent OS Harness

## guarded-v6 参数校验候选

`pnpm build:guarded` / `pnpm test:guarded` 构建及验证独立的 `dsh-source-639ed015-guarded-v6`。绑定工具、工作状态与原文交付工具均在 RPC 前按冻结 JSON Schema 校验；参数无效由 DSH 返回普通工具错误，允许模型纠正。不会夹紧分页、转换类型或代改参数；RPC、权限、未知效果及落盘失败仍保持原有失败屏障。

校验器固定 Ajv 8.20.0 / ajv-formats 3.0.1，支持无声明的 2020-12 及明确声明的 2020-12/draft-07；无法编译、未知关键字/格式、外部引用和异步 schema 在初始化时拒绝。每个工具独立编译，不加载网络 schema。部署前仍需固定 Worker pin、Runtime 协议、发布/回滚守卫及真实业务验收；这个候选不会自动替换已安装 final-v5。

本地 29 项检查通过：真实 DSH/Node 配合合成宿主，覆盖超限→纠正→原文交付、坏参数零工具 RPC、错误落盘前后杀进程重放、远端错误仍终止，以及原文选择既有故障用例。原 Windows 实际研究冻结的 15 个工具 schema 均可编译。独立静态评审无阻断；未据此宣称真实模型成功。旧 runner、kernel、上游文件和正式 v5 产物未改，历史产物按原提交和依赖锁重建，不能用新依赖锁替换旧 manifest。

从固定的 DeepSeek Harness（DSH）官方源码构建 Agent 内核，并维护平台的持久化与上下文适配。AgentLoop 仍由 DSH 执行；Go Worker 负责实际模型/工具传输，Runtime 是租约、回执、检查点和工作状态的持久化权威。

## 源码来源与版本

上游 `dsh-v0.2.0-rc.2` 固定到 `639ed015397290b3745d163aafe02ffee4aa3f84`。[upstream-lock.json](upstream-lock.json) 记录官方压缩包及每个导入文件哈希；导入内核依赖图涉及的 21 个完整包目录，不包含官方 CLI、桌面端、Web、Python SDK 或其他无关服务。

`upstream/` 保留原始字节和 MIT 声明，平台代码放 `src/`，明确的构建变换放 `patches/`。同版本源码不等于与 npm 发布产物字节一致，也不能据此认定历史任务可直接换引擎。

2026-10-13 Windows 已激活由 `ec21432` / `v0.1.0-rc.1` 构建的 `dsh-source-639ed015-state-v1`；真实模型、发布与恢复记录在 [源码引擎激活验收](https://github.com/euler-gaozl/agent-os/blob/main/docs/source-engine-activation-20261013.md)。后续候选不会因本仓重建而自动上线。

## 构建与产物

需要 Node 24 和固定 pnpm 依赖。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test
```

构建逐个校验上游文件，编译真实 TypeScript，拒绝仓库外导入和 Node 内建之外的运行时外部依赖。`dist/manifest.json` 固定源码/依赖锁、构建工具、输入和产物哈希；构建依赖是 esbuild/Zod，不使用预编译 DSH npm 内核。

`patches/inline-package-version.mjs` 将上游归因模块的运行时 package.json 读取变成固定版本值，原始/变换字节及脚本都进入清单；原文件不变。测试把产物移到无 node_modules/package.json 祖先的目录并禁用全局搜索；可用 `HARNESS_TEST_ARTIFACT_ROOT` 指定外部临时目录。导入列表验证不构成完整文件系统隔离证明。

## 落盘、工作集与 Compact

- 每个 session 的构造前缀只收集一次，后续事件排入最大 16 MiB 的传输队列，通过持久化 Exchange flush。只释放已确认事件，等待确认时新增的事件不丢失；空批次也有检查点，保持重放帧顺序。
- flush 失败保持失败状态，后续模型、工具、状态更新和结束操作必须先通过 flush。自动 Compact 完成替换和结束标记后也 flush；即使上游吞掉观察器错误，后续外部动作仍被屏障阻止。
- 每次普通提示词组装读取冻结的工作状态，包含原始任务、当时约束、修订/过期标记和完整工作集。引用文字以字面 JSON 注入，不能展开成模板或覆盖用户指令。
- `working_state_update` 是保留的 DSH 原生工具，经专用 Runtime 协议执行，不能被配置工具遮蔽。Runtime 负责验证、CAS 和成功/拒绝回执。
- Compact 只总结收到的片段，下一次普通请求重新读取权威工作状态，避免摘要遗漏重要事实。上下文估算是启发式，最终供应商请求仍需 Worker 校验。

Node 没有模型 Key、数据库账号、宿主执行工具、原生 JSONL 日志或第二套本地会话写入器。16 MiB 只约束传输队列，**不代表上游 Session 历史或进程 RSS 有界**。影响重放的顺序/投影变化必须使用新引擎版本。

## 长历史内存与 resident-v2 候选

```powershell
node benchmarks/source-memory.mjs <新的绝对证据目录> 128,512,2048
pnpm build:resident
pnpm test:resident
node benchmarks/source-memory.mjs <另一个新证据目录> 128,512,2048,4096 <仓库绝对路径>/.work/resident-candidate
```

基准使用固定 Node、合成模型/状态协议、实际 DSH Compact 和新进程重放，不访问供应商。v1 在 128/512/2,048 步后的堆内存约 13.1/19.7/48.1 MiB，模型窗口不变仍增长。192 MiB V8 old-space 上限不是进程 RSS 上限。

`dsh-source-639ed015-resident-v2` 在单独目录构建，七个显式内核变换保持绝对事件位置，只在归档确认和消费者检查后释放不再需要的常驻历史；保留上游 AgentLoop 与固定 source runner，拒绝不支持的投影/迟到插件，不覆盖 v1。

本地候选 19 项、历史 16 项测试通过且未跳过；2,048 步最终堆约 11.4 MB，4,096 步约 12.8 MB，但 RSS 更大、完整重放约 22.6 秒。这是强制 GC 的单次夹具测量，不代表生产延迟、全部缓存或快速原生恢复已验收。详见 [常驻历史设计](docs/resident-history-design.md)。

## 输出与预算修复候选

`pnpm build:budget` / `pnpm test:budget` 构建和验证独立的 budget-v3。
它使用固定输出配置，将持久化的预发送拒绝交给官方压缩恢复钩子，并以独立 usage
事件反馈已提交用量。15 项候选检查及 v1/v2 的 16/19 项回归通过；监督器和模型是
夹具，尚未安装。完整契约和验证边界见 [budget-v3 设计](docs/budget-engine-design.md)。

## 模型原生长度候选

`pnpm build:native` / `pnpm test:native` 构建独立 native-v4，普通回答和压缩均使用
已冻结的模型官方能力。实际 Node/DSH 合成协议 17 项通过，包括大文本和强杀重放；
历史 50 项回归通过。正式 Runtime/Worker 尚未接入，没有部署或供应商调用。
具体协议、失败记录和边界见 [native-v4 设计](docs/native-engine-design.md)。

## 当前未完成项

同日更新：native-v4 已在 Windows 安装，真实研究已经运行；前面的“候选/未安装”为早期开发记录。正式状态以集成仓 [Windows 研究记录](https://github.com/euler-gaozl/agent-os/blob/main/docs/maintainer/windows-research-20261017.md) 为准，内容质量仍未验收通过。

新 `final-v5` 候选让 DSH 调用官方 `concludeTurn()`，引用已保存候选结束，避免最后一步改写已检查原文。`pnpm build:final` / `pnpm test:final` 的 19 项协议检查及 native-v4 的 17 项回归通过；Runtime / Worker 集成和正式安装未完成。见 [确定性交付协议与证据边界](docs/final-engine-design.md)。

完整内存/恢复、缓存生命周期及平台交付仍未完成。Actions 日常关闭。

[历史详细记录](docs/history/service-notes-20261014.en.md) 保留失败证据、测试范围和不可外推的结论；生产状态以集成仓库为准。
