#!/usr/bin/env python3
"""
聚宽双向桥接网关 (Step 1)
HTTP + WebSocket 混合服务，端口 94523

用法:
    python bridge/jq_bridge.py start    # 启动服务
    python bridge/jq_bridge.py stop     # 停止服务
    python bridge/jq_bridge.py status   # 查看状态
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
from datetime import datetime

# 检查依赖
try:
    import aiohttp
    from aiohttp import web
except ImportError:
    print("[Bridge] 缺少依赖 aiohttp，请执行: pip install aiohttp")
    sys.exit(1)

# 日志配置
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".jquan-bridge")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "bridge.log")


def setup_logging():
    """配置日志同时输出到终端和文件"""
    logger = logging.getLogger("jq_bridge")
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    # 控制台
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    logger.addHandler(console)
    # 文件（追加模式）
    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8", mode="a")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    return logger


logger = setup_logging()

def _find_project_root():
    """查找项目根目录（向上查找包含 strategies/ 的目录）"""
    current = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # 先尝试向上查找包含 strategies/ 的目录
    checked = current
    while True:
        if os.path.exists(os.path.join(checked, "strategies")):
            return checked
        parent = os.path.dirname(checked)
        if parent == checked:
            break
        checked = parent
    # 回退到脚本所在目录
    return current


# 固定端口
PORT = 19523

# 项目路径
PROJECT_ROOT = _find_project_root()
BRIDGE_DIR = os.path.join(PROJECT_ROOT, ".jquan-bridge")
PID_FILE = os.path.join(BRIDGE_DIR, "bridge.pid")

# 便捷打印函数（只调用 logger，logger 已配置同时输出到终端和文件）
def log_info(msg):
    logger.info(msg)

def log_error(msg):
    logger.error(msg)

def log_warn(msg):
    logger.warning(msg)


class JQuanBridge:
    def __init__(self):
        self.clients = set()  # WebSocket 连接集合（保留用于广播）
        self.client_info = {}  # ws -> {strategy_name, algorithm_id, page_url, last_seen}
        self.strategy_map = {}  # strategy_name -> ws（定向推送映射）
        self.request_senders = {}  # cmd_id -> 源 ws（用于定向回传 response）
        self.app = web.Application()
        self.app.router.add_get("/health", self.handle_health)
        self.app.router.add_get("/ws", self.handle_ws)

    async def handle_health(self, request):
        """HTTP 健康检查"""
        return web.json_response(
            {
                "status": "ok",
                "port": PORT,
                "clients": len(self.clients),
                "pages": self._list_connected_pages(),
            },
            headers={"Access-Control-Allow-Origin": "*"},
        )

    def scan_strategies(self):
        """递归扫描 strategies/ 目录，返回策略列表（跳过归档目录）"""
        strategies_dir = os.path.join(PROJECT_ROOT, "strategies")
        strategies = []
        if not os.path.exists(strategies_dir):
            return strategies
        for root, dirs, files in os.walk(strategies_dir):
            # 跳过归档目录和隐藏目录
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "归档"]
            rel_root = os.path.relpath(root, PROJECT_ROOT)
            for fname in ["main.py", "strategy.py", "index.py"]:
                if fname in files:
                    folder = os.path.basename(root)
                    strategies.append(
                        {
                            "id": folder,
                            "name": folder,
                            "path": f"{rel_root}/{fname}",
                            "folder": folder,
                            "file": fname,
                        }
                    )
                    break
        return sorted(strategies, key=lambda s: s["id"])

    def read_strategy(self, path):
        """读取策略文件内容"""
        full_path = os.path.join(PROJECT_ROOT, path)
        if not os.path.exists(full_path):
            return None
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    def save_strategy(self, save_path, code):
        """保存策略代码到本地目录"""
        if not save_path:
            return {"success": False, "error": "路径不能为空"}
        if not code:
            return {"success": False, "error": "代码不能为空"}

        # 规范化路径，防止目录遍历
        safe_path = os.path.normpath(save_path).lstrip("/")
        if safe_path.startswith("..") or "/../" in safe_path:
            return {"success": False, "error": "非法路径"}

        strategies_dir = os.path.join(PROJECT_ROOT, "strategies")
        target_dir = os.path.join(strategies_dir, safe_path)

        # 确保在 strategies/ 目录下
        try:
            real_target = os.path.realpath(target_dir)
            real_strategies = os.path.realpath(strategies_dir)
            if not real_target.startswith(real_strategies):
                return {"success": False, "error": "非法路径"}
        except Exception:
            return {"success": False, "error": "路径解析失败"}

        try:
            os.makedirs(target_dir, exist_ok=True)
            file_path = os.path.join(target_dir, "main.py")
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(code)
            rel_path = os.path.relpath(file_path, PROJECT_ROOT)
            log_info(f"[Bridge] 策略已保存: {rel_path}")
            return {"success": True, "path": rel_path}
        except Exception as e:
            log_error(f"[Bridge] 保存策略失败: {e}")
            return {"success": False, "error": str(e)}

    def save_file(self, dir_path, filename, content):
        """保存任意文件到策略目录"""
        if not dir_path or not filename:
            return {"success": False, "error": "路径或文件名不能为空"}

        safe_dir = os.path.normpath(dir_path).lstrip("/")
        if safe_dir.startswith("..") or "/../" in safe_dir:
            return {"success": False, "error": "非法路径"}

        # 防止文件名穿越
        safe_name = os.path.basename(filename)
        if not safe_name:
            return {"success": False, "error": "非法文件名"}

        strategies_dir = os.path.join(PROJECT_ROOT, "strategies")
        target_dir = os.path.join(strategies_dir, safe_dir)

        try:
            real_target = os.path.realpath(target_dir)
            real_strategies = os.path.realpath(strategies_dir)
            if not real_target.startswith(real_strategies):
                return {"success": False, "error": "非法路径"}
        except Exception:
            return {"success": False, "error": "路径解析失败"}

        try:
            os.makedirs(target_dir, exist_ok=True)
            file_path = os.path.join(target_dir, safe_name)
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)
            rel_path = os.path.relpath(file_path, PROJECT_ROOT)
            log_info(f"[Bridge] 文件已保存: {rel_path}")
            return {"success": True, "path": rel_path}
        except Exception as e:
            log_error(f"[Bridge] 保存文件失败: {e}")
            return {"success": False, "error": str(e)}

    def _update_client_mapping(self, ws, info):
        """更新客户端策略映射"""
        old_info = self.client_info.get(ws)
        is_update = old_info is not None
        if old_info and old_info.get("strategy_name"):
            old_name = old_info["strategy_name"]
            if old_name in self.strategy_map and self.strategy_map[old_name] == ws:
                del self.strategy_map[old_name]
                log_info(f"[Bridge] [MAP] 移除旧映射: '{old_name}'")

        self.client_info[ws] = {
            "strategy_name": info.get("strategyName"),
            "algorithm_id": info.get("algorithmId"),
            "page_url": info.get("pageUrl"),
            "last_seen": datetime.now().isoformat(),
        }

        strategy_name = info.get("strategyName")
        alg_id = info.get("algorithmId") or "unknown"
        tag = "[REG] 更新注册" if is_update else "[REG] 首次注册"
        if strategy_name:
            self.strategy_map[strategy_name] = ws
            log_info(f"[Bridge] {tag}: '{strategy_name}' -> {alg_id} | map_size={len(self.strategy_map)} clients={len(self.clients)}")
        else:
            log_info(f"[Bridge] {tag}: (未命名) -> {alg_id} | map_size={len(self.strategy_map)} clients={len(self.clients)}")

    def _remove_client(self, ws):
        """清理客户端映射"""
        info = self.client_info.pop(ws, None)
        removed_name = None
        if info and info.get("strategy_name"):
            name = info["strategy_name"]
            removed_name = name
            if name in self.strategy_map and self.strategy_map[name] == ws:
                del self.strategy_map[name]
        stale_count = len([cid for cid, sender in self.request_senders.items() if sender == ws])
        # 清理以该 ws 为源的待处理请求（防止 response 孤儿条目）
        stale_ids = [cid for cid, sender in self.request_senders.items() if sender == ws]
        for cid in stale_ids:
            self.request_senders.pop(cid, None)
        self.clients.discard(ws)
        log_info(f"[Bridge] [DISC] WS断开: '{removed_name or '(未命名)'}' | 清理孤儿条目={stale_count} | clients={len(self.clients)} map={len(self.strategy_map)}")

    def _get_target_ws(self, strategy_name=None, algorithm_id=None):
        """根据策略名或 algorithmId 查找目标 WebSocket"""
        if strategy_name and strategy_name in self.strategy_map:
            log_info(f"[Bridge] [MAP] 名称命中: '{strategy_name}'")
            return self.strategy_map[strategy_name]
        if algorithm_id:
            for ws, info in self.client_info.items():
                if info.get("algorithm_id") == algorithm_id:
                    log_info(f"[Bridge] [MAP] ID命中: {algorithm_id[:16]}... -> '{info.get('strategy_name', '(未命名)')}'")
                    return ws
        return None

    def _list_connected_pages(self):
        """列出所有已连接的页面"""
        pages = []
        for ws, info in self.client_info.items():
            pages.append({
                "strategyName": info.get("strategy_name") or "(未命名)",
                "algorithmId": info.get("algorithm_id") or "unknown",
                "pageUrl": info.get("page_url") or "unknown",
                "lastSeen": info.get("last_seen"),
            })
        return pages

    async def handle_ws(self, request):
        """WebSocket 连接处理"""
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.clients.add(ws)
        log_info(f"[Bridge] WS connected, clients: {len(self.clients)}")

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")
                    action = data.get("action")
                    log_info(f"[Bridge] WS recv: {msg_type}/{action}")

                    # 处理注册消息（更新策略映射）
                    if msg_type == "register":
                        self._update_client_mapping(ws, data)
                        continue

                    # 处理插件日志上报
                    if msg_type == "logReport":
                        logs = data.get("logs", [])
                        client_id = data.get("clientId", "unknown")
                        info = self.client_info.get(ws, {})
                        strategy_name = info.get("strategy_name") or "unnamed"
                        prefix = f"[PLUGIN:{client_id}:{strategy_name}]"
                        for entry in logs:
                            level = entry.get("level", "INFO")
                            tag = entry.get("tag", "")
                            msg_text = entry.get("msg", "")
                            log_line = f"{prefix} {tag} {msg_text}".strip()
                            if level in ("ERR", "ERROR"):
                                log_error(log_line)
                            elif level == "WARN":
                                log_warn(log_line)
                            else:
                                log_info(log_line)
                        continue

                    # 本地策略命令直接处理并回复发送者
                    if msg_type == "command" and action in (
                        "listStrategies",
                        "getStrategy",
                        "saveStrategy",
                        "saveFile",
                    ):
                        cmd_id = data.get("id", "unknown")
                        if action == "listStrategies":
                            resp = {
                                "type": "response",
                                "id": cmd_id,
                                "action": "listStrategies",
                                "data": {"strategies": self.scan_strategies()},
                            }
                        elif action == "getStrategy":
                            path = data.get("data", {}).get("path", "")
                            content = self.read_strategy(path)
                            resp = {
                                "type": "response",
                                "id": cmd_id,
                                "action": "getStrategy",
                                "data": {"content": content, "path": path},
                            }
                        elif action == "saveStrategy":
                            req_data = data.get("data", {})
                            save_path = req_data.get("path", "").strip()
                            code = req_data.get("code", "")
                            result = self.save_strategy(save_path, code)
                            resp = {
                                "type": "response",
                                "id": cmd_id,
                                "action": "saveStrategy",
                                "data": result,
                            }
                        elif action == "saveFile":
                            req_data = data.get("data", {})
                            dir_path = req_data.get("dirPath", "").strip()
                            filename = req_data.get("filename", "").strip()
                            content = req_data.get("content", "")
                            result = self.save_file(dir_path, filename, content)
                            resp = {
                                "type": "response",
                                "id": cmd_id,
                                "action": "saveFile",
                                "data": result,
                            }
                        await ws.send_str(json.dumps(resp))
                        continue

                    # 定向命令：需要路由到特定页面
                    if msg_type == "command" and action in (
                        "pushCode", "pullLogs", "clickCompile",
                        "getResults", "getStatus", "setBacktestParams",
                        "renameStrategy", "getPageInfo", "getBacktestErrors",
                    ):
                        cmd_id = data.get("id", "unknown")
                        target_name = data.get("data", {}).get("targetName")
                        target_id = data.get("data", {}).get("targetId")

                        target_ws = self._get_target_ws(target_name, target_id)

                        if target_ws:
                            target_info = self.client_info.get(target_ws, {})
                            target_display = target_info.get("strategy_name") or target_info.get("algorithm_id", "unknown")[:12]
                            log_info(f"[Bridge] [FWD] {action} ({cmd_id}) CLI->'{target_display}' | targetName={target_name} targetId={target_id and target_id[:12]}")
                            # 记录请求发送者，用于定向回传 response
                            self.request_senders[cmd_id] = ws
                            # 转发命令到目标客户端
                            forward_msg = {
                                "type": "command",
                                "id": cmd_id,
                                "action": action,
                                "data": data.get("data", {}),
                            }
                            try:
                                await target_ws.send_str(json.dumps(forward_msg))
                            except Exception as e:
                                log_error(f"[Bridge] [ERR] {action} ({cmd_id}) 定向发送失败: {e}")
                                self.request_senders.pop(cmd_id, None)
                                await ws.send_str(json.dumps({
                                    "type": "response", "id": cmd_id,
                                    "action": action, "error": f"目标页面离线: {e}"
                                }))
                        else:
                            # 未找到目标，返回错误
                            available = list(self.strategy_map.keys())
                            log_warn(f"[Bridge] [ERR] {action} ({cmd_id}) 未找到目标 | targetName={target_name} targetId={target_id and target_id[:12]} | 当前映射={available}")
                            error_msg = f"未找到目标页面"
                            if target_name:
                                error_msg += f": 策略名 '{target_name}'"
                            elif target_id:
                                error_msg += f": algorithmId '{target_id}'"
                            else:
                                error_msg += ": 未指定目标"
                            await ws.send_str(json.dumps({
                                "type": "response", "id": cmd_id,
                                "action": action, "error": error_msg
                            }))
                        continue

                    # 处理 response：优先定向回传给原始请求者
                    if msg_type == "response":
                        cmd_id = data.get("id")
                        sender_ws = self.request_senders.pop(cmd_id, None) if cmd_id else None
                        action_in_resp = data.get("action", "unknown")
                        if sender_ws and sender_ws in self.clients:
                            try:
                                await sender_ws.send_str(msg.data)
                                log_info(f"[Bridge] [RES] {action_in_resp} ({cmd_id}) sidebar->CLI 定向回传成功")
                                continue
                            except Exception as e:
                                log_warn(f"[Bridge] [RES] {action_in_resp} ({cmd_id}) 定向回传失败: {e}, fallback广播")
                        else:
                            log_warn(f"[Bridge] [RES] {action_in_resp} ({cmd_id}) 无发送者记录(sender={sender_ws is not None}), fallback广播")
                        # 回传失败则广播
                        await self.broadcast(msg.data)
                        continue

                    # 其他消息广播给所有客户端（保留原有行为）
                    await self.broadcast(msg.data)

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    log_error(f"[Bridge] WS error: {ws.exception()}")
        finally:
            self._remove_client(ws)
            log_info(f"[Bridge] WS disconnected, clients: {len(self.clients)}")

        return ws

    async def broadcast(self, message: str):
        """广播消息给所有 WebSocket 客户端"""
        if not self.clients:
            return
        dead = set()
        for ws in self.clients:
            try:
                await ws.send_str(message)
            except Exception:
                dead.add(ws)
        if dead:
            self.clients -= dead
            log_warn(f"[Bridge] [BCAST] 广播到 {len(self.clients)} 个客户端, 移除 {len(dead)} 个失效连接")

    def _write_pid(self):
        """写入 PID 文件，用于 stop 命令"""
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))

    def _remove_pid(self):
        """清理 PID 文件"""
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)

    async def start(self):
        """启动服务"""
        self._write_pid()

        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", PORT)
        try:
            await site.start()
        except OSError as e:
            if e.errno == 48:
                log_error(f"[Bridge] 端口 {PORT} 已被占用，服务可能已在运行")
                log_error(f"[Bridge] 检查状态: python bridge/jq_bridge.py status")
                self._remove_pid()
                return
            raise

        log_info(f"[Bridge] Server started at http://127.0.0.1:{PORT}")
        log_info(f"[Bridge] Health check: curl http://127.0.0.1:{PORT}/health")
        log_info(f"[Bridge] WebSocket: ws://127.0.0.1:{PORT}/ws")
        log_info("[Bridge] Press Ctrl+C to stop")

        try:
            while True:
                await asyncio.sleep(3600)
        except asyncio.CancelledError:
            pass
        finally:
            self._remove_pid()
            await runner.cleanup()
            log_info("[Bridge] Server stopped")


def cmd_start():
    """启动命令"""
    bridge = JQuanBridge()
    try:
        asyncio.run(bridge.start())
    except KeyboardInterrupt:
        log_info("\n[Bridge] Interrupted by user")


def cmd_stop():
    """停止命令"""
    if not os.path.exists(PID_FILE):
        log_error("[Bridge] PID file not found, server may not be running")
        return
    with open(PID_FILE) as f:
        pid = int(f.read().strip())
    try:
        os.kill(pid, signal.SIGTERM)
        log_info(f"[Bridge] Sent stop signal to PID {pid}")
    except ProcessLookupError:
        log_warn(f"[Bridge] Process {pid} not found, cleaning up")
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)


def cmd_status():
    """状态检查命令"""
    import urllib.request

    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/health")
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            print(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception as e:
        log_error(f"[Bridge] Server not running: {e}")


def main():
    parser = argparse.ArgumentParser(description="JQuan Bridge Gateway")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("start", help="Start the bridge server")
    sub.add_parser("stop", help="Stop the bridge server")
    sub.add_parser("status", help="Check server status")

    args = parser.parse_args()

    if args.command == "start":
        cmd_start()
    elif args.command == "stop":
        cmd_stop()
    elif args.command == "status":
        cmd_status()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
