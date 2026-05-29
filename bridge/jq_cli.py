#!/usr/bin/env python3
"""
聚宽策略 CLI — 通过 WebSocket 桥接控制浏览器编辑器

用法:
    python bridge/jq_cli.py push <strategy.py>              # 按文件夹名自动匹配
    python bridge/jq_cli.py push <strategy.py> --name "羊驼策略"  # 指定策略名匹配
    python bridge/jq_cli.py push <strategy.py> --id xxx      # 按 algorithmId 推送
    python bridge/jq_cli.py pull logs                        # 拉取回测日志
    python bridge/jq_cli.py pull results                     # 拉取回测结果
    python bridge/jq_cli.py status                           # 查看页面状态
    python bridge/jq_cli.py compile                          # 触发编译运行
    python bridge/jq_cli.py params --start 2024-01-01 --end 2024-12-31

环境变量:
    JQUAN_BRIDGE_URL  — WebSocket 地址 (默认: ws://127.0.0.1:19523/ws)
"""

import argparse
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime

WS_URL = os.environ.get("JQUAN_BRIDGE_URL", "ws://127.0.0.1:19523/ws")
DEFAULT_TIMEOUT = 300

# 聚宽默认策略名（未命名策略）- 支持前缀匹配
DEFAULT_STRATEGY_PREFIXES = ("这是一个简单的策略", "新建策略", "未命名策略")


def log_ts(tag, message):
    """带时间戳的 CLI 日志"""
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {tag} {message}")


def is_default_strategy_name(name):
    """判断是否为默认/未命名策略"""
    if not name or not isinstance(name, str):
        return True
    name = name.strip()
    if not name:
        return True
    for prefix in DEFAULT_STRATEGY_PREFIXES:
        if name.startswith(prefix):
            return True
    return False


try:
    import websockets
except ImportError:
    print("[CLI] 请先安装 websockets: .venv/bin/pip install websockets")
    sys.exit(1)


class JQuanClient:
    """WebSocket 客户端，发送命令并等待响应"""

    def __init__(self, url: str):
        self.url = url
        self.ws = None

    async def __aenter__(self):
        print(f"[CLI] 连接桥接服务: {self.url}")
        last_error = None
        for attempt in range(1, 4):
            try:
                self.ws = await websockets.connect(self.url, max_size=16 * 1024 * 1024)
                if attempt > 1:
                    print(f"[CLI] 第 {attempt} 次连接成功")
                return self
            except Exception as e:
                last_error = e
                print(f"[CLI] 第 {attempt} 次连接失败: {e}")
                if attempt < 3:
                    wait = 2 ** (attempt - 1)
                    print(f"[CLI] 等待 {wait}s 后重试...")
                    await asyncio.sleep(wait)
        print("[CLI] 请确保桥接服务已启动: .venv/bin/python bridge/jq_bridge.py start")
        raise last_error

    async def __aexit__(self, *args):
        if self.ws:
            await self.ws.close()

    async def send_command(self, action: str, data: dict = None, timeout: int = DEFAULT_TIMEOUT):
        """发送命令并等待响应"""
        cmd_id = str(uuid.uuid4())[:8]
        msg = {
            "type": "command",
            "id": cmd_id,
            "action": action,
            "data": data or {}
        }

        await self.ws.send(json.dumps(msg))
        print(f"[CLI] [SEND] {action} (id={cmd_id} timeout={timeout}s)")

        # 等待响应（过滤掉广播中的无关消息）
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                remaining = deadline - asyncio.get_event_loop().time()
                raw = await asyncio.wait_for(self.ws.recv(), timeout=max(remaining, 0.1))
                resp = json.loads(raw)

                # 忽略注册消息和自环广播
                if resp.get("type") == "register":
                    continue
                if resp.get("type") == "response" and resp.get("id") == cmd_id:
                    if resp.get("error"):
                        print(f"[CLI] [RECV] {action} (id={cmd_id}) error={resp.get('error')}")
                    else:
                        print(f"[CLI] [RECV] {action} (id={cmd_id}) success")
                    return resp.get("data"), resp.get("error")
            except asyncio.TimeoutError:
                break

        print(f"[CLI] [ERR] {action} (id={cmd_id}) 超时 ({timeout}s 无响应)")
        return None, "timeout"


def extract_strategy_name(file_path: str) -> str:
    """从文件路径提取策略名称（文件夹名）"""
    abs_path = os.path.abspath(file_path)
    # 获取文件所在目录名
    dir_name = os.path.basename(os.path.dirname(abs_path))
    # 如果目录是 main.py 同级，取上一级
    if dir_name in ("strategies", "."):
        parent = os.path.dirname(os.path.dirname(abs_path))
        dir_name = os.path.basename(parent)
    return dir_name


async def get_connected_pages(client: JQuanClient) -> list:
    """获取所有已连接的页面信息"""
    import urllib.request
    try:
        req = urllib.request.Request(f"http://127.0.0.1:19523/health")
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read())
            return data.get("pages", [])
    except Exception as e:
        print(f"[CLI] 无法获取页面列表: {e}")
        return []


async def cmd_push(args):
    """推送本地策略代码到编辑器"""
    file_path = args.file
    if not os.path.exists(file_path):
        print(f"[CLI] [ERR] 文件不存在: {file_path}")
        return False

    # 确定目标策略名
    if args.name:
        target_name = args.name
    elif args.id:
        target_name = None  # 用 ID 匹配
    else:
        target_name = extract_strategy_name(file_path)

    print(f"[CLI] [PUSH] 文件={file_path} 推导策略名='{target_name}'")

    with open(file_path, "r", encoding="utf-8") as f:
        code = f.read()

    async with JQuanClient(WS_URL) as client:
        # 如果指定了名称，先检查是否有未命名的页面
        if target_name and not args.id and not args.no_rename:
            pages = await get_connected_pages(client)
            print(f"[CLI] [PUSH] 当前连接页面: {[p.get('strategyName','(未命名)') for p in pages]}")
            # 查找默认名页面
            unnamed_pages = [p for p in pages if is_default_strategy_name(p.get("strategyName"))]
            if unnamed_pages and not any(p.get("strategyName") == target_name for p in pages):
                print(f"\n[CLI] 检测到未命名策略页面:")
                for i, p in enumerate(unnamed_pages, 1):
                    print(f"  {i}. {p.get('strategyName', '(未命名)')} | {p.get('algorithmId', 'unknown')[:12]}...")
                print(f"\n[CLI] [PUSH] 注意: 以下操作需要您在终端手动确认")
                answer = input(f"是否将页面重命名为 '{target_name}' 并推送代码? [Y/n] ").strip().lower()
                if answer in ("", "y", "yes"):
                    # 重命名第一个未命名页面
                    unnamed_id = unnamed_pages[0].get("algorithmId")
                    print(f"[CLI] [PUSH] 自动重命名: '{unnamed_pages[0].get('strategyName')}' -> '{target_name}' (id={unnamed_id[:12]}...)")
                    rename_result, rename_err = await client.send_command(
                        "renameStrategy",
                        {"targetId": unnamed_id, "newName": target_name},
                        timeout=10
                    )
                    if rename_err:
                        print(f"[CLI] [ERR] 重命名失败: {rename_err}")
                        return False
                    print(f"[CLI] [PUSH] 重命名结果: {rename_result}")
                    # 使用重命名后的名称推送
                    args.id = unnamed_id
                    target_name = None

        # 发送推送命令
        push_data = {"code": code}
        if target_name:
            push_data["targetName"] = target_name
        if args.id:
            push_data["targetId"] = args.id

        print(f"[CLI] [PUSH] 发送 pushCode targetName={target_name} targetId={args.id and args.id[:12]}")
        result, error = await client.send_command("pushCode", push_data)
        if error:
            print(f"[CLI] [ERR] pushCode 失败: {error}")
            return False

        success = result.get("success") if result else False
        length = result.get("codeLength", 0) if result else 0
        if success:
            print(f"[CLI] [PUSH] 成功: {length} 字符")
            return True
        else:
            print(f"[CLI] [ERR] pushCode 返回失败")
            return False


async def cmd_pull_logs(args):
    """拉取回测日志（同时拉取错误信息）"""
    async with JQuanClient(WS_URL) as client:
        pull_data = {}
        if args.id:
            pull_data["targetId"] = args.id
        elif args.name:
            pull_data["targetName"] = args.name

        # 同时拉取日志和错误
        logs_result, logs_error = await client.send_command("pullLogs", pull_data)
        errors_result, errors_error = await client.send_command("getBacktestErrors", pull_data)

        if logs_error:
            print(f"[CLI] 拉取日志失败: {logs_error}")
            return False

        logs = logs_result.get("logs") if logs_result else None
        debug_info = logs_result.get("debugInfo") if logs_result else None
        has_error = errors_result.get("hasError") if errors_result else False
        errors = errors_result.get("errors", []) if errors_result else []

        if not logs and not has_error:
            print("[CLI] 暂无日志")
            if debug_info:
                print(f"[CLI] debugInfo: {json.dumps(debug_info, ensure_ascii=False)[:500]}")
            return True

        # 组装输出内容
        output_lines = []
        if logs:
            output_lines.append("=" * 40)
            output_lines.append("回测日志")
            output_lines.append("=" * 40)
            output_lines.append(logs)

        if has_error and errors:
            output_lines.append("")
            output_lines.append("=" * 40)
            output_lines.append(f"检测到 {len(errors)} 条错误")
            output_lines.append("=" * 40)
            for i, err in enumerate(errors, 1):
                output_lines.append(f"\n--- 错误 {i} ---")
                output_lines.append(err)

        full_output = "\n".join(output_lines)

        # 输出滚动诊断信息
        if debug_info:
            scroll_debug = debug_info.get("scrollDebug")
            if scroll_debug:
                print("[CLI] 滚动诊断:")
                for line in str(scroll_debug).split("\n")[:30]:
                    print(f"  {line}")
            content_script_logs = debug_info.get("contentScriptLogs")
            if content_script_logs:
                print("[CLI] content_script 诊断日志:")
                for line in content_script_logs[-50:]:
                    print(f"  {line}")
            elif not scroll_debug:
                print(f"[CLI] debugInfo: {json.dumps(debug_info, ensure_ascii=False)[:500]}")

        # 输出到 stdout 或文件
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(full_output)
            print(f"[CLI] 日志已保存: {args.output} ({len(full_output)} 字符)")
        else:
            print(full_output)
            print("")
            print("=" * 40)
            print(f"共 {len(full_output)} 字符")
        return True


async def cmd_pull_results(args):
    """拉取回测结果"""
    async with JQuanClient(WS_URL) as client:
        pull_data = {}
        if args.id:
            pull_data["targetId"] = args.id
        elif args.name:
            pull_data["targetName"] = args.name

        result, error = await client.send_command("getResults", pull_data)
        if error:
            print(f"[CLI] 失败: {error}")
            return False

        if not result:
            print("[CLI] 暂无结果")
            return True

        print(json.dumps(result, indent=2, ensure_ascii=False))
        return True


async def cmd_pull_errors(args):
    """拉取回测错误信息（编译/运行时错误）"""
    async with JQuanClient(WS_URL) as client:
        pull_data = {}
        if args.id:
            pull_data["targetId"] = args.id
        elif args.name:
            pull_data["targetName"] = args.name

        result, error = await client.send_command("getBacktestErrors", pull_data)
        if error:
            print(f"[CLI] 失败: {error}")
            return False

        if not result or not result.get("hasError"):
            print("[CLI] 未检测到错误")
            return True

        errors = result.get("errors", [])
        print("=" * 50)
        print(f"检测到 {len(errors)} 条错误信息")
        print("=" * 50)
        for i, err in enumerate(errors, 1):
            print(f"\n--- 错误 {i} ---")
            print(err)
        print("\n" + "=" * 50)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                for err in errors:
                    f.write(err + "\n\n")
            print(f"[CLI] 错误信息已保存: {args.output}")
        return True


async def cmd_status(args):
    """获取页面状态"""
    async with JQuanClient(WS_URL) as client:
        # 获取桥接 health 信息
        pages = await get_connected_pages(client)

        print(f"[CLI] [STATUS] 连接页面数: {len(pages)}")
        if not pages:
            print("[CLI] 暂无连接的页面")
            return True

        print(f"\n已连接页面 ({len(pages)}个):")
        print("-" * 70)
        print(f"{'策略名':<20} {'algorithmId':<20} {'页面URL':<30}")
        print("-" * 70)
        for p in pages:
            name = p.get("strategyName", "(未命名)")[:18]
            alg_id = (p.get("algorithmId", "unknown") or "unknown")[:18]
            url = (p.get("pageUrl", "") or "")[:28]
            print(f"{name:<20} {alg_id:<20} {url:<30}")
        print("-" * 70)

        # 同时获取编辑器状态（如果有目标）
        if args.id:
            result, error = await client.send_command("getStatus", {"targetId": args.id})
            if result:
                editor = result.get("editor") or {}
                backtest = result.get("backtestStatus", "unknown")
                print(f"\n目标页面状态:")
                print(f"  回测状态: {backtest}")
                if editor.get("code") is not None:
                    lines = editor.get("lineCount", 0)
                    print(f"  编辑器: {lines} 行")
                else:
                    print("  编辑器: 未就绪")

        return True


async def cmd_compile(args):
    """触发编译运行"""
    async with JQuanClient(WS_URL) as client:
        compile_data = {}
        if args.id:
            compile_data["targetId"] = args.id
        elif args.name:
            compile_data["targetName"] = args.name

        result, error = await client.send_command("clickCompile", compile_data)
        if error:
            print(f"[CLI] 失败: {error}")
            return False

        triggered = result.get("triggered") if result else None
        success = result.get("success") if result else False
        if success:
            print(f"[CLI] 编译已触发: {triggered}")
            return True
        else:
            err = result.get("error", "未知错误") if result else "未知错误"
            print(f"[CLI] 触发失败: {err}")
            return False


async def cmd_rename(args):
    """重命名页面策略"""
    new_name = args.new_name
    if not new_name:
        print("[CLI] 请指定新名称")
        return False

    async with JQuanClient(WS_URL) as client:
        rename_data = {"newName": new_name}
        if args.id:
            rename_data["targetId"] = args.id
        elif args.name:
            rename_data["targetName"] = args.name
        else:
            print("[CLI] [ERR] 请指定 --id 或 --name 定位目标页面")
            return False

        print(f"[CLI] [RENAME] '{args.name or args.id[:12]}' -> '{new_name}'")
        result, error = await client.send_command("renameStrategy", rename_data, timeout=15)
        if error:
            print(f"[CLI] [ERR] renameStrategy 失败: {error}")
            return False

        success = result.get("success") if result else False
        method = result.get("method") if result else "unknown"
        if success:
            print(f"[CLI] [RENAME] 成功 (method={method}): {new_name}")
            return True
        else:
            err = result.get("error", "未知错误") if result else "未知错误"
            print(f"[CLI] [ERR] 重命名失败: {err}")
            return False


async def cmd_params(args):
    """设置回测参数"""
    params = {}
    if args.start:
        params["startDate"] = args.start
    if args.end:
        params["endDate"] = args.end
    if args.cash:
        params["initialCash"] = str(args.cash)
    if args.benchmark:
        params["benchmark"] = args.benchmark

    if not params:
        print("[CLI] 至少指定一个参数: --start, --end, --cash, --benchmark")
        return False

    if args.id:
        params["targetId"] = args.id
    elif args.name:
        params["targetName"] = args.name

    async with JQuanClient(WS_URL) as client:
        result, error = await client.send_command("setBacktestParams", params)
        if error:
            print(f"[CLI] 失败: {error}")
            return False

        print(f"[CLI] 参数设置结果: {json.dumps(result, ensure_ascii=False)}")
        return True


def main():
    parser = argparse.ArgumentParser(description="聚宽策略 CLI")
    sub = parser.add_subparsers(dest="command")

    # 全局选项
    target_group = argparse.ArgumentParser(add_help=False)
    target_group.add_argument("--name", help="指定目标策略名称（用于匹配页面）")
    target_group.add_argument("--id", help="指定目标 algorithmId（精确推送）")

    # push
    push_parser = sub.add_parser("push", help="推送策略代码到编辑器", parents=[target_group])
    push_parser.add_argument("file", help="策略文件路径 (.py)")
    push_parser.add_argument("--no-rename", action="store_true", help="遇到未命名页面时不自动重命名")

    # pull
    pull_parser = sub.add_parser("pull", help="拉取数据", parents=[target_group])
    pull_parser.add_argument("target", choices=["logs", "results", "errors"], help="拉取目标")
    pull_parser.add_argument("-o", "--output", help="输出文件路径")

    # status
    status_parser = sub.add_parser("status", help="查看页面状态", parents=[target_group])

    # compile
    compile_parser = sub.add_parser("compile", help="触发编译运行", parents=[target_group])

    # rename
    rename_parser = sub.add_parser("rename", help="重命名页面策略", parents=[target_group])
    rename_parser.add_argument("new_name", help="新策略名称")

    # params
    params_parser = sub.add_parser("params", help="设置回测参数", parents=[target_group])
    params_parser.add_argument("--start", help="开始日期 YYYY-MM-DD")
    params_parser.add_argument("--end", help="结束日期 YYYY-MM-DD")
    params_parser.add_argument("--cash", type=float, help="初始资金")
    params_parser.add_argument("--benchmark", help="基准指数")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    def get_handler():
        if args.command == "push":
            return cmd_push
        if args.command == "pull":
            target = getattr(args, "target", None)
            if target == "logs":
                return cmd_pull_logs
            if target == "results":
                return cmd_pull_results
            if target == "errors":
                return cmd_pull_errors
            return None
        if args.command == "status":
            return cmd_status
        if args.command == "compile":
            return cmd_compile
        if args.command == "rename":
            return cmd_rename
        if args.command == "params":
            return cmd_params
        return None

    handler = get_handler()
    if not handler:
        parser.print_help()
        sys.exit(1)

    try:
        ok = asyncio.run(handler(args))
        sys.exit(0 if ok else 1)
    except KeyboardInterrupt:
        print("\n[CLI] 已取消")
        sys.exit(130)
    except Exception as e:
        print(f"[CLI] 错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
