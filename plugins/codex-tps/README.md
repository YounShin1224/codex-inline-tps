# Codex TPS 原生侧栏插件

通过官方 MCP Apps `thread` 入口，在聊天右侧打开 TPS 面板。由 Codex 加载本地 stdio MCP 服务，不需要调试端口、页面注入、独立启动助手或 API Key，也不改变模型请求链路。

## 安装和使用

需要 Node.js 24+，以及支持 MCP Apps 会话侧栏入口的 Codex 桌面版。在预构建包的根目录运行（源码仓库先完成下方构建）：

```sh
codex plugin marketplace add .
codex plugin add codex-tps@codex-tps-local
```

重启 Codex 后，在插件目录的「Codex TPS 本地插件」来源中确认安装状态。打开聊天右侧的新标签页/内容面板入口，选择 **Codex TPS**。入口的具体位置由宿主版本决定；CLI 本身不会渲染面板。

第一次打开时，在面板中选择一个本地会话，或粘贴完整会话 ID。也可以在聊天中要求「在右侧打开本对话的 TPS 面板」，让 Codex 用 `open_codex_tps` 工具传入准确的 `threadId`。Codex 执行环境中的 `CODEX_THREAD_ID` 可用于确认本对话 ID。每个面板独立绑定，不会自动拿最近活跃的聊天冒充当前聊天。

官方 `thread` 入口目前向工具传入 `{}`，没有保证传入本地会话 ID。因此，从静态入口打开时需要明确选择；这个限制不是通过页面注入绕过的。模型下拉框可以跟随日志中的最新请求，或只看某个已记录模型；它不表示尚未发出请求的模型选择器状态。

绑定后每秒自动刷新；切换会话或模型会立即清空旧值。支持暂停、深浅主题、本次面板打开后的实测样本曲线。刷新由面板直接调用只读工具，不需要模型持续调用，也不会向聊天追加状态消息。

若工具可用但没有侧栏入口，当前宿主可能不支持此 UI 扩展；升级到支持官方会话入口的桌面版后再试。不要把普通浏览器网页预览当成原生插件已加载的证明。

## 从源码构建

在仓库根目录执行：

```sh
npm ci
npm run build:plugin
npm run test:plugin
```

再按上面的命令把仓库根目录添加为本地 marketplace 并安装。`dist/` 不提交到 Git，必须先构建。打包可用：

```sh
node scripts/package-plugin.mjs /absolute/path/to/package-folder
```

预构建包包含 MCP SDK 和 UI 依赖，无需在安装目录执行 npm install；只需要已有 Node.js。安装后可用 `codex plugin list --json` 验证启用状态。更新本地插件源码后，重新构建并安装，再按宿主要求重启。

## 数据和读数

默认只读 `~/.codex/sessions` 和 `archived_sessions`，遵循 `CODEX_HOME`。会话列表只返回 UUID 和更新时间；不读取认证文件，不向面板传递标题、提示词、回复、工具参数或路径，不向外部服务发送数据。MCP 只走 stdio，面板所有资源都包含在包内，没有 HTTP 监听端口。

TPS = 官方输出 token（含思考）÷ 已完成模型输出区间的合并时长；工具执行耗时排除。生成中的数值是本会话同模型最近五次有效响应的加权估算。均值只统计有效实测，缓存率按本轮主会话的输入 token 加权计算。缺少可靠计时或不支持的日志格式显示 `—`，不使用字符数推算 token。

本版本复用原仓库的 `metrics.mjs`，支持带 `token_usage_record` 和模型输出计时的未压缩 JSONL。较旧版本或压缩日志可能没有可用速度。关闭面板停止刷新；停止/卸载插件不会影响 Codex 的模型连接。

## 官方接口参考

- [插件扩展与会话右侧入口](https://developers.openai.com/plugins/build/extensions)
- [本地 stdio 插件](https://developers.openai.com/plugins/deploy/desktop-only)
- [插件打包与本地 marketplace](https://developers.openai.com/plugins/build/plugins)

MIT。依赖许可见预构建包的 `dist/THIRD_PARTY_NOTICES.txt`。
