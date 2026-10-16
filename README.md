# DSH 会话自动重试

`@oheco/dsh-session-retry` 是一个精简的 DSH 插件：模型请求失败后持续重试，流长时间无响应时结束本次等待，并在同一个会话步骤重新请求。用户点击停止后，正在进行的等待会立即取消。

面向已包含官方 `llm-retry` 的 DSH base profile。当前验证基线为 HarmonyOS aarch64、Node 24.21.0-ohos.1、DSH 0.2.0-rc.2-ohos.1，运行库 0.2.0-rc.2。DSH 扩展接口仍在变化，升级后应重新运行本仓库测试。

## 安装

通过 DSH **插件管理页 → 从本地目录安装**，选择这个仓库的绝对路径。本机路径为：

```text
/storage/Users/currentUser/dev/ohos/dsh-session-retry
```

也可以使用官方 CLI：

```sh
dsh plugin --profile web add /storage/Users/currentUser/dev/ohos/dsh-session-retry
```

如果已经安装 `dsh-session-robustness`（会话鲁棒性），先在插件管理页卸载或禁用旧插件，避免两个插件同时接管；CLI 卸载命令如下：

```sh
dsh plugin --profile web remove dsh-session-robustness
```

安装完成后，重启当前 DSH 并刷新原来的 GUI，使 Host 载入新插件。仓库不发布 npm 包、GitHub Release 或 `oo` 软件包，不修改 DSH 核心和已有提供方配置。

## 使用和配置

安装后默认开启。DSH 原有重试先处理失败；原有策略没有处理、或次数耗尽后，本插件继续无限重试。请求头、用户消息和会话上下文沿用当前步骤，失败尝试的内容不会加入模型可见的成功回复历史。

重试提示直接使用 DSH 原有聊天卡片，显示无限标志、次数、等待时间和错误原因。插件接管后的计数从 1 开始，与官方有限重试分别记录。停止操作使用 DSH 本来的停止按钮。

所有参数都通过 DSH 原生插件配置表单保存，也可以在 web profile 的 `cordis.patch.yml` 添加对应条目：

```yaml
- id: oheco-session-retry
  name: '@oheco/dsh-session-retry'
  config:
    enabled: true
    idleTimeoutMs: 300000
    requestTimeoutMs: 1800000
    initialDelayMs: 1000
    maxDelayMs: 30000
    jitterRatio: 0.2
```

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用本插件；关闭后仍保留提供方原有重试策略 |
| `idleTimeoutMs` | `300000` | 连续 5 分钟没有流数据时，结束本次等待并重试 |
| `requestTimeoutMs` | `1800000` | 单次尝试最长 30 分钟，即使持续有数据也会到期；`0` 表示不设此上限 |
| `initialDelayMs` | `1000` | 接管后第一次等待 1 秒，此后指数增加；大于最大间隔时按最大间隔计算 |
| `maxDelayMs` | `30000` | 本插件接管后的最大重试间隔 30 秒 |
| `jitterRatio` | `0.2` | 重试间隔的随机抖动比例，范围 `0..1` |

时长均为整数毫秒，除 `requestTimeoutMs` 可为 `0` 外，其余时长必须大于 `0`，且不超过 Node 定时器上限 `2147483647`。配置从下一次请求或插件接管的下一次等待起生效；已开始的等待使用原先的时间。提供方返回合法且不超过最大间隔的 `Retry-After` 时，插件优先采用它。

本插件不维护错误白名单。进入模型请求恢复流程的认证失败、额度不足、错误请求和未知错误也会持续尝试，直到成功、用户停止、关闭插件或卸载。它不会自动修复密钥、补充额度或调整模型配置。上下文压缩等已有恢复器优先处理。

## 恢复范围

| 情况 | 行为 |
| --- | --- |
| 模型请求报错、断流、没有终止事件、空响应 | 由现有恢复器或本插件重试 |
| 首次响应卡住、输出中途卡住 | 超时后让 DSH 收到 `TIMEOUT`，在同一步重试 |
| `next()`、`return()` 不响应取消 | 不再等待其完成，隔离旧尝试的迟到结果 |
| 用户在请求或退避中点击停止 | 会话退出等待，不再发送下一次重试 |
| 正常结束或到达输出 token 上限 | 保留 DSH 原有结束行为 |
| 标题、摘要、压缩等辅助调用 | 不主动接管；仅保护带有 DSH agent-loop 标记的模型请求 |
| 模型准备阶段报错、工具本身失败或卡住、DSH 进程退出 | 不由本插件恢复 |

**超时退出等待不等于强制关闭底层连接。** 当前 `llm/stream` 接口提供冻结的请求和无参数 `next()`，插件不能把新的取消信号传给原适配器。插件会请求关闭旧流并丢弃其后续结果，但真正释放连接取决于适配器自身超时或取消实现。不响应关闭的旧请求可能仍占用资源；无法保证任意底层实现都只有一个网络请求在执行。用户停止会触发原会话取消信号。

## 实现

Host 代码分为 [index.js](./index.js)、[stream.js](./stream.js) 和 [config.js](./config.js)。没有自建 HTTP API、浏览器轮询、前端 bundle、错误码分类表、提供方切换或自动发送“继续”消息。

`agent/request-error` 监听器先委托现有恢复器，再补充可取消的无限重试。它记录官方 `llm/retry` 和 `llm/retry-started` 事件，并通过官方 `llmRetry` 投影读取计数；计数随步骤或回合结束而重置。卸载或重载会取消本插件接管中的等待，不保证自动恢复正在执行的任务。流保护器逐次等待 `next()`，竞争空闲超时、总时限和取消，转发第一个 `finish` 后立即结束；异步清理不阻塞会话。

模型请求的内容、token 上限和缓存参数不被改写；失败重试本身会产生额外请求，是否计费取决于提供方。插件不新增模型可见提示。

## 开发与验证

不需要构建或下载开发依赖；测试复用本机安装的 DSH 运行库：

```sh
npm run check
npm test
```

测试默认在 Node 安装前缀下查找 `lib/node_modules/@deepseek-ai/dsh/runtime`。若 DSH 安装在其他位置，显式指定包含 `node_modules` 的 runtime 目录：

```sh
DSH_TEST_RUNTIME=/absolute/path/to/dsh/runtime npm test
```

测试使用真实 Cordis、LlmRuntime、AgentLoop、Session、官方重试执行器，以及隔离 profile 的 Loader、ConfigEditor 和 Settings。故障来自内存适配器和本地 HTTP/SSE 服务，不调用付费模型，不读取用户凭据，不修改用户 profile。临时目录只在 `$TMPDIR` 下创建并清理。结果和验证限制见 [VERIFICATION.md](./VERIFICATION.md)。

许可证：[MIT](./LICENSE)。
