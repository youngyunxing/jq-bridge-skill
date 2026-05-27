# jq-bridge-skill

Claude Code Skill for JoinQuant (聚宽) 本地策略开发。

通过 WebSocket 桥接，让 Claude Code 可以直接用自然语言控制聚宽网页端的策略推送、回测触发、日志拉取等操作。

## 架构

```
┌─────────────┐     WebSocket      ┌─────────────┐     WebSocket      ┌─────────────┐
│  Claude Code │ ◄──────────────► │ jq-bridge   │ ◄──────────────► │ Chrome 插件  │
│  (本 Skill)  │                  │ (端口19523) │                  │ (聚宽页面)   │
└─────────────┘                  └─────────────┘                  └─────────────┘
```

## 安装

### 1. 安装 Skill

```bash
git clone https://github.com/you/jq-bridge-skill.git ~/.claude/skills/jq-bridge
```

### 2. 安装依赖

```bash
pip install -r ~/.claude/skills/jq-bridge/requirements.txt
```

### 3. 安装 Chrome 插件

1. 打开 Chrome → 扩展程序 → 开发者模式
2. 加载已解压的扩展 → 选择 `~/.claude/skills/jq-bridge/chrome_plugin/` 目录

### 4. 启动桥接服务

```bash
python ~/.claude/skills/jq-bridge/bridge/jq_bridge.py start
```

### 5. 使用

在 Claude Code 中打开策略项目目录，直接对话：

- "推送当前策略并运行回测"
- "看看回测结果"
- "报什么错了？"
- "设置回测时间为 2024 年全年"

## 项目结构

```
jq-bridge-skill/
├── skill.md              # Claude Code 指令文件
├── requirements.txt      # Python 依赖
├── bridge/
│   ├── jq_bridge.py      # WebSocket 桥接服务
│   └── jq_cli.py         # 命令行工具
└── chrome_plugin/        # Chrome 扩展源码
    ├── manifest.json
    ├── content_script.js
    ├── page_bridge.js
    └── sidebar/
```

## 依赖

- Python 3.8+
- `aiohttp` (桥接服务)
- `websockets` (CLI 客户端)
- Chrome 浏览器

## License

MIT
