# JQuan Bridge — 聚宽双向桥接脚本

聚宽浏览器插件与本地 Claude Code 之间的双向通信网关。

## 依赖

使用项目虚拟环境：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Step 1: 启动桥接网关

```bash
.venv/bin/python bridge/jq_bridge.py start
```

服务启动后：
- HTTP 健康检查：`http://127.0.0.1:19523/health`
- WebSocket 连接：`ws://127.0.0.1:19523/ws`

```bash
# 检查状态
.venv/bin/python bridge/jq_bridge.py status

# 停止服务
.venv/bin/python bridge/jq_bridge.py stop
```

## Step 2: 页面桥接脚本 (CDP 接口)

`chrome_plugin/page_bridge.js` 注入页面上下文，暴露 `window.jquanAuto` 全局接口：

- `getEditorCode()` — 读取编辑器代码
- `setEditorCode(code)` — 写入编辑器
- `getBacktestStatus()` — 获取回测状态 (`idle`/`running`/`completed`)
- `getBacktestResults()` — 提取收益/回撤/Sharpe 等指标
- `getStrategyName()` — 获取当前策略名称
- `getAlgorithmId()` — 获取当前页面 algorithmId
- `renameStrategyName(newName)` — 重命名页面策略
- `clickCompile()` — 触发编译运行
- `setBacktestParams({startDate, endDate, ...})` — 修改回测参数

## Step 3: 插件接入 WebSocket

`chrome_plugin/sidebar/sidebar.js` 连接本地桥接服务 `ws://127.0.0.1:19523/ws`：

- 自动重连机制
- 连接状态指示器（头部显示 🟢/🟡/⚪）
- **策略名自动同步**：连接时上报 `{strategyName, algorithmId, pageUrl}`，每 3 秒检查名称变化
- 支持命令：
  - `ping` — 心跳检测
  - `getStatus` — 获取编辑器+回测状态
  - `pushCode` — Claude Code 推送代码到编辑器
  - `pullLogs` — 拉取回测日志
  - `clickCompile` — 触发编译
  - `getResults` — 获取回测结果
  - `setBacktestParams` — 设置回测参数
  - `renameStrategy` — 重命名页面策略
  - `getPageInfo` — 获取页面策略信息

协议格式：
```json
// Claude Code → Sidebar (command)
{"type": "command", "id": "uuid", "action": "pushCode", "data": {"code": "..."}}

// Sidebar → Claude Code (response)
{"type": "response", "id": "uuid", "action": "pushCode", "data": {"success": true}}
```

## Step 4: CLI 命令

`bridge/jq_cli.py` 提供命令行接口，通过 WebSocket 向浏览器发送指令。

### 全局选项（适用于 push/pull/compile/rename/params）

```bash
--name "策略名"   # 按策略名称匹配页面
--id xxx          # 按 algorithmId 精确推送
```

### 查看连接的页面

```bash
.venv/bin/python bridge/jq_cli.py status
```

输出示例：
```
已连接页面 (1个):
----------------------------------------------------------------------
策略名                 algorithmId          页面URL
----------------------------------------------------------------------
羊驼策略               ce3f7c546f03a73f...  https://www.joinquant.com/...
----------------------------------------------------------------------
```

### 推送代码

```bash
# 按文件夹名自动匹配（strategies/羊驼策略/main.py → 匹配"羊驼策略"）
.venv/bin/python bridge/jq_cli.py push strategies/羊驼策略/main.py

# 手动指定策略名
.venv/bin/python bridge/jq_cli.py push strategies/羊驼策略/main.py --name "羊驼策略"

# 按 algorithmId 精确推送
.venv/bin/python bridge/jq_cli.py push strategies/羊驼策略/main.py --id ce3f7c546f03a73f3e8da9e48b35b5a9

# 遇到默认名页面时不自动重命名
.venv/bin/python bridge/jq_cli.py push strategies/羊驼策略/main.py --no-rename
```

> **自动重命名**：如果页面策略名是默认名（如"这是一个简单的策略"），push 时会**交互式提示**是否重命名为本地策略名。
> 
> **⚠️ 注意**：此交互需要用户在终端手动输入 `Y` 确认，AI 不应自动代替用户确认。如需静默跳过重命名，请使用 `--no-rename`；如需推送到特定页面，请使用 `--id` 精确指定。

### 重命名页面策略

```bash
# 按 algorithmId 重命名
.venv/bin/python bridge/jq_cli.py rename "羊驼策略" --id ce3f7c546f03a73f3e8da9e48b35b5a9

# 按当前策略名重命名
.venv/bin/python bridge/jq_cli.py rename "羊驼策略" --name "这是一个简单的策略"
```

### 编译运行

```bash
.venv/bin/python bridge/jq_cli.py compile --name "羊驼策略"
```

### 拉取数据

```bash
# 拉取回测日志（输出到终端）
.venv/bin/python bridge/jq_cli.py pull logs --name "羊驼策略"

# 拉取回测日志（保存到文件）
.venv/bin/python bridge/jq_cli.py pull logs -o /tmp/backtest.log --name "羊驼策略"

# 拉取回测结果
.venv/bin/python bridge/jq_cli.py pull results --name "羊驼策略"
```

### 设置回测参数

```bash
.venv/bin/python bridge/jq_cli.py params \
  --name "羊驼策略" \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --cash 100000
```

## Step 5: 状态检测

`sidebar.js` 自动监控回测状态：

- WebSocket 连接后自动启动监控
- 策略名每 3 秒同步一次到 bridge
- 回测完成后请手动使用 `pull logs` / `pull results` 获取数据

## 多页面定向推送原理

当浏览器打开多个聚宽编辑页面时，代码推送**不会广播到所有页面**，而是精确推送到目标页面：

1. **Sidebar 注册**：每个页面加载时，sidebar 上报 `{strategyName, algorithmId, pageUrl}`
2. **Bridge 维护映射**：`strategy_name → websocket` 映射表
3. **CLI 定向发送**：`push` 命令根据策略名或 algorithmId 找到目标 websocket
4. **Response 定向回传**：bridge 记录请求发送者，response 直接回复给 CLI 而非广播

## 查看诊断日志

所有日志写入 `.jquan-bridge/bridge.log`，按标签过滤查看：

```bash
# 查看全部日志（最近 50 行）
tail -50 .jquan-bridge/bridge.log

# 只看连接/断开
grep '\[CONN\]' .jquan-bridge/bridge.log

# 只看注册/映射更新
grep '\[REG\]' .jquan-bridge/bridge.log

# 只看命令转发
grep '\[FWD\]' .jquan-bridge/bridge.log

# 只看 response 回传
grep '\[RES\]' .jquan-bridge/bridge.log

# 只看错误
grep '\[ERR\]' .jquan-bridge/bridge.log

# 只看插件上报日志（sidebar 自动上报）
grep '\[PLUGIN\]' .jquan-bridge/bridge.log

# 追踪某个页面的插件日志（按 clientId）
grep '\[PLUGIN:a1b2c3\]' .jquan-bridge/bridge.log

# 追踪一次完整 push 流程（按 cmd_id）
grep 'a1b2c3d4' .jquan-bridge/bridge.log
```

### 日志时间戳说明

- **bridge 日志**（`.jquan-bridge/bridge.log`）：Python logging 自动包含 `YYYY-MM-DD HH:MM:SS` 完整时间戳
- **CLI 输出**：关键诊断日志带 `[HH:MM:SS]` 时间前缀，交互输出（如表格、日志内容）不带前缀
- **插件日志**（Chrome DevTools 控制台）：浏览器 `console.log` 自动显示时间，无需额外添加

### Chrome 插件日志查看方法

插件日志在浏览器端，不在 `.jquan-bridge/bridge.log` 中，需要通过 Chrome 开发者工具查看：

```bash
# 方法1: 聚宽页面右键 → 检查 → Console 标签页
# 过滤 ContentScript 日志:
[ContentScript]

# 过滤 PageBridge 日志:
[PageBridge]

# 过滤 Sidebar 日志（iframe 内，需要切换执行上下文）:
# 在 Console 面板左上角的下拉框中选择 iframe 上下文，然后过滤:
[Sidebar]

# 方法2: 扩展管理页 → 开发者模式 → 查看 Service Worker 的 Console
# chrome://extensions/ → 找到"聚宽策略助手" → Service Worker
```

### 日志标签速查

| 标签 | 位置 | 含义 |
|------|------|------|
| `[CONN]` | bridge + sidebar | WebSocket 连接/断开 |
| `[REG]` | bridge + sidebar | 策略注册/映射更新 |
| `[MAP]` | bridge | 映射表查询命中/未命中 |
| `[FWD]` | bridge | 命令从 CLI 转发到 sidebar |
| `[RES]` | bridge + sidebar | response 回传（bridge 定向回传 / sidebar 收到响应） |
| `[BCAST]` | bridge | 广播消息（fallback） |
| `[DISC]` | bridge | 客户端断开清理 |
| `[ERR]` | bridge + CLI + sidebar + content_script + page_bridge | 错误 |
| `[SEND]` | CLI + sidebar | 发送命令到 bridge / sidebar 发送消息到 content_script |
| `[RECV]` | CLI + sidebar | 收到 bridge 响应 / sidebar 收到 WebSocket 命令 |
| `[REQ]` | sidebar | 发送请求到 bridge（带 reqId） |
| `[PUSH]` | CLI | push 命令决策过程 |
| `[RENAME]` | CLI + page_bridge | rename 命令 / 页面重命名操作 |
| `[CMD]` | sidebar + content_script + page_bridge | 收到/完成命令 |
| `[SYNC]` | sidebar | 策略名变化同步 |
| `[TIMEOUT]` | sidebar + page_bridge | content_script / page_bridge 通信超时 |
| `[INIT]` | content_script | 插件初始化 |
| `[UI]` | content_script | 侧边栏 UI 操作 |
| `[IFRAME]` | content_script | iframe 加载 |
| `[PAGE]` | content_script | 页面桥接就绪 |
| `[EDITOR]` | page_bridge | 编辑器查找/操作 |
| `[COMPILE]` | page_bridge | 编译运行按钮查找/点击 |
| `[INFO]` | sidebar | 策略信息获取 |
| `[PLUGIN]` | bridge | 插件日志上报（sidebar 通过 WebSocket 上报到 bridge） |

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `未找到目标页面` | 策略名不匹配或页面未刷新 | 先用 `status` 查看已连接页面，用 `--id` 精确指定 |
| 推送到了错误的页面 | 多个页面策略名相同 | 使用 `--id` 精确推送 |
| 页面显示"未命名" | sidebar 还没获取到策略名 | 等待 3-5 秒后重试，或刷新页面 |
| 插件代码没更新 | Chrome 缓存了旧版本 | `chrome://extensions/` 中重新加载扩展 |
