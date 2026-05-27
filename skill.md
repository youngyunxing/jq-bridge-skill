# JoinQuant 本地开发助手

帮助用户在 Claude Code 中通过自然语言操作聚宽（JoinQuant）策略开发环境。

## 前提条件

1. **Chrome 浏览器** 已安装 `chrome_plugin/` 扩展（开发者模式加载已解压扩展）
2. **Python 依赖** 已安装：`pip install -r requirements.txt`
3. **桥接服务** 已启动：`python bridge/jq_bridge.py start`
4. **聚宽网页** 已打开并登录，插件已连接桥接服务

## 可用命令

所有命令通过 `python bridge/jq_cli.py` 执行。桥接服务会自动向上查找包含 `strategies/` 目录的项目根目录，因此 CLI 可以在策略项目的任意子目录下运行。

### 核心命令

| 命令 | 说明 |
|------|------|
| `push <file>` | 推送本地策略代码到聚宽编辑器 |
| `compile` | 触发编译运行（回测） |
| `pull logs` | 拉取回测日志（自动包含错误信息） |
| `pull results` | 拉取回测结果（JSON） |
| `status` | 查看页面连接状态 |
| `params --start YYYY-MM-DD --end YYYY-MM-DD --cash 100000` | 设置回测参数 |
| `rename <new_name>` | 重命名页面策略 |

### 全局选项

所有命令支持 `--name <策略名>` 或 `--id <algorithmId>` 指定目标页面。不指定时按策略文件名自动匹配。

## 标准工作流

### 1. 推送并运行回测

当用户要求"推送策略并运行回测"时，按以下顺序执行：

1. **确定策略文件**：询问或确认用户要推送的 `.py` 文件路径
2. **推送代码**：`python bridge/jq_cli.py push <文件路径> --name <策略名>`
3. **触发编译**：`python bridge/jq_cli.py compile --name <策略名>`
4. **等待回测完成**：等待 10-15 秒（或轮询 `status` 查看回测状态）
5. **拉取结果**：`python bridge/jq_cli.py pull logs --name <策略名>`
   - 自动同时拉取回测日志和错误信息
   - 分析日志中的收益率、交易记录等；如有错误会自动追加显示
6. **向用户汇报**：总结回测结果或错误信息

### 2. 排查错误

当用户说"看看报什么错了"或"排查错误"时：

1. `python bridge/jq_cli.py pull logs --name <策略名>`（自动包含错误信息）
2. 分析错误类型：
   - **SyntaxError / IndentationError**：Python 语法问题，指出具体行号
   - **NameError**：变量/API 未定义，检查拼写或是否需额外导入（如 `get_factor_values` 不存在时应改用基础 API）
   - **KeyError / IndexError**：数据访问越界，检查 DataFrame 字段
   - **聚宽 API 错误**：检查 API 入参格式
   - **avoid_future_data 报错**：盘中获取日线数据时 `end_date` 用了当天日期，应改为 `context.previous_date`
   - **pandas 兼容性问题**：`df.append()` 已移除改用 `pd.concat()`；`pd.concat(..., sort=False)` 旧版不支持
3. 给出修复建议

### 3. 设置回测参数

当用户要求调整回测时间/资金时：

```bash
python bridge/jq_cli.py params --start 2024-01-01 --end 2024-12-31 --cash 100000 --name <策略名>
```

### 4. 查看状态

当用户问"连接正常吗"或"页面状态"时：

```bash
python bridge/jq_cli.py status
```

分析输出中的连接页面数、策略名、algorithmId 等信息。

## 策略规范（执行 push 前检查）

推送代码前应提醒用户或自动检查以下规范：

- 文件顶部必须有 `__version__ = "x.x.x"`
- 自定义函数统一加 `yy_` 前缀，防止与聚宽 API 重名
- 全局变量用 `g.xxx`，**禁止** `context.g.xxx`
- 买卖数量必须为 **100 的整数倍**
- 买入/卖出时必须打印：股票代码、名称、价格、数量
- `initialize()` 中应包含：基准、滑点、手续费、避免未来数据等基础配置
- 盘中获取历史数据时，`end_date` 必须使用 `context.previous_date`（非当天）
- 避免 `df.append()`（pandas 2.0+ 已移除），改用 `pd.concat([df, temp_df])`
- 避免 `pd.concat(..., sort=False)`（聚宽旧版 pandas 不支持 `sort` 参数）

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| "未找到目标页面" | 策略名不匹配或页面未连接 | 检查 `status` 输出，确认策略名或 algorithmId |
| push 成功但代码未更新 | 聚宽页面缓存 | 刷新页面或重新 push |
| compile 后无日志 | 回测尚未完成或插件未捕获 | 等待更长时间再 pull logs；更新插件后重新加载扩展 |
| pull logs 显示空但有报错 | 插件 DOM 选择器未匹配 | 更新插件后重新加载扩展 |
| WebSocket 连接失败 | 桥接服务未启动 | 先执行 `python bridge/jq_bridge.py start` |
| 插件显示未连接 | 页面未注入或桥接服务未启动 | 刷新页面，确认服务状态 |
| 重命名后刷新恢复原名 | 仅修改了前端 DOM，未保存到后端 | 目前需手动在页面上保存策略名 |

## 环境变量

- `JQUAN_BRIDGE_URL` — WebSocket 地址，默认 `ws://127.0.0.1:19523/ws`
