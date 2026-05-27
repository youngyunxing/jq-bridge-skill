# jq-bridge-skill

Claude Code Skill for JoinQuant (聚宽) 本地策略开发。

通过 WebSocket 桥接，让 Claude Code 可以直接用自然语言控制聚宽网页端的策略推送、回测触发、日志拉取等操作。

## 架构

```
+--------------+     WebSocket      +--------------+     WebSocket      +-------------+
| Claude Code  | <---------------> | jq-bridge    | <---------------> | Chrome 插件 |
| (本 Skill)   |                   | (端口19523)  |                   | (聚宽页面)  |
+--------------+                   +--------------+                   +-------------+
```

## 项目结构

```
jq-bridge-skill/
├── skill.md                    # Claude Code 指令文件（放入 ~/.claude/skills/）
├── README.md                   # 本文档
├── requirements.txt            # Python 依赖
├── bridge/
│   ├── jq_bridge.py            # WebSocket 桥接服务
│   └── jq_cli.py               # 命令行工具
└── chrome_plugin/              # Chrome 扩展源码
    ├── manifest.json
    ├── background.js
    ├── content_script.js       # 页面交互 + 日志捕获
    ├── page_bridge.js          # 编辑器/回测控制
    ├── popup.js
    └── sidebar/
        ├── sidebar.html
        └── sidebar.js          # 侧边栏 + 策略同步
```

## 安装

### 1. 安装 Skill

```bash
# 克隆到 Claude Code skills 目录
git clone https://github.com/youngyunxing/jq-bridge-skill.git ~/.claude/skills/jq-bridge
```

### 2. 安装依赖

```bash
pip install -r ~/.claude/skills/jq-bridge/requirements.txt
```

依赖：`aiohttp`, `websockets`

### 3. 安装 Chrome 插件

1. 打开 Chrome → `chrome://extensions/` → 开启「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 选择 `~/.claude/skills/jq-bridge/chrome_plugin/` 目录
4. 插件图标会出现在 Chrome 工具栏

### 4. 启动桥接服务

```bash
python ~/.claude/skills/jq-bridge/bridge/jq_bridge.py start
```

服务运行在 `ws://127.0.0.1:19523/ws`，同时提供 HTTP health 检查：`http://127.0.0.1:19523/health`

### 5. 使用

在 Claude Code 中打开策略项目目录，直接对话：

- "推送当前策略并运行回测"
- "看看回测结果"
- "报什么错了？"
- "设置回测时间为 2024 年全年"

## CLI 命令参考

所有命令通过 `python bridge/jq_cli.py` 执行：

| 命令 | 说明 | 示例 |
|------|------|------|
| `push <file>` | 推送本地策略到编辑器 | `push strategies/我的策略/main.py` |
| `compile` | 触发编译运行 | `compile --name "羊驼策略"` |
| `pull logs` | 拉取回测日志（自动包含错误信息） | `pull logs --name "羊驼策略"` |
| `pull results` | 拉取回测结果 | `pull results --name "羊驼策略"` |
| `status` | 查看页面连接状态 | `status` |
| `params` | 设置回测参数 | `params --start 2024-01-01 --end 2024-12-31 --cash 100000` |
| `rename <name>` | 重命名页面策略 | `rename "新策略名" --name "旧策略名"` |

**全局选项**：所有命令支持 `--name <策略名>` 或 `--id <algorithmId>` 指定目标页面。不指定时按文件名自动匹配。

### 与策略项目协同

桥接服务会自动向上查找包含 `strategies/` 目录的项目根目录，因此 CLI 可以在策略项目的任意子目录下运行。

## 标准工作流

### 1. 推送并运行回测

```
1. 确定策略文件路径
2. python bridge/jq_cli.py push <文件路径> [--name <策略名>]
3. python bridge/jq_cli.py compile [--name <策略名>]
4. 等待 10-15 秒
5. python bridge/jq_cli.py pull logs [--name <策略名>]
   （自动同时拉取日志和错误信息）
6. 向用户汇报结果
```

### 2. 排查错误

当用户说"看看报什么错了"时：

1. `pull logs` 获取日志（自动包含错误信息）
2. 分析错误类型：
   - **SyntaxError / IndentationError**：Python 语法问题
   - **NameError**：变量/API 未定义（如 `get_factor_values` 不存在）
   - **avoid_future_data 报错**：盘中获取日线时 `end_date` 用了当天日期，应改为 `context.previous_date`
   - **KeyError / IndexError**：DataFrame 字段访问错误
3. 给出修复建议并重新推送

### 3. 设置回测参数

```bash
python bridge/jq_cli.py params \
  --start 2024-01-01 \
  --end 2024-12-31 \
  --cash 100000 \
  --benchmark 000300.XSHG \
  --name "羊驼策略"
```

## 策略规范检查

推送代码前应检查以下规范：

- 文件顶部必须有 `__version__ = "x.x.x"`
- 自定义函数统一加 `jq_` 前缀，防止与聚宽 API 重名
- 全局变量用 `g.xxx`，**禁止** `context.g.xxx`
- 买卖数量必须为 **100 的整数倍**
- 买入/卖出时必须打印：股票代码、名称、价格、数量
- `initialize()` 中应包含：基准、滑点、手续费、避免未来数据等基础配置
- 盘中获取历史数据时，`end_date` 必须使用 `context.previous_date`
- 避免 `df.append()`（pandas 2.0+ 已移除），改用 `pd.concat()`
- 避免 `pd.concat(..., sort=False)`（旧版 pandas 不支持 `sort` 参数）

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| "未找到目标页面" | 策略名不匹配或页面未连接 | `status` 查看已连接页面，确认名称 |
| push 成功但代码未更新 | 聚宽页面缓存 | 刷新页面后重新 push |
| compile 后无日志/结果 | 回测尚未完成或插件未捕获 | 等待更长时间；检查插件是否已重新加载 |
| pull logs 显示空但有报错 | 插件 DOM 选择器未匹配 | 更新插件后重新加载扩展 |
| WebSocket 连接失败 | 桥接服务未启动 | `python bridge/jq_bridge.py start` |
| 插件显示未连接 | 页面未注入或桥接服务未启动 | 刷新页面，确认服务状态 |
| 重命名后刷新恢复原名 | 仅修改了前端 DOM，未保存到后端 | 目前需手动在页面上保存策略名 |

## 环境变量

- `JQUAN_BRIDGE_URL` — WebSocket 地址，默认 `ws://127.0.0.1:19523/ws`

## License

MIT
