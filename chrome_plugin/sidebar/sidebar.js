// 聚宽策略助手 - 侧边栏逻辑（精简版）
// 本地策略同步 + 编辑器代码读取 + 回测日志获取

// ==========================================
// 本地策略配置（动态加载）
// ==========================================
let STRATEGIES_CONFIG = {
  strategies: []
};

// ==========================================
// 状态
// ==========================================
let currentCode = '';

// ==========================================
// WebSocket 桥接
// ==========================================
const WS_URL = 'ws://127.0.0.1:19523/ws';
const WS_RECONNECT_INTERVAL = 3000;
const WS_MAX_RECONNECT_ATTEMPTS = 0; // 0 = 无限重试

let ws = null;
let wsState = {
  connected: false,
  connecting: false,
  reconnectAttempts: 0,
  reconnectTimer: null
};

// 待处理请求（用于 sendWsRequest 响应匹配）
const pendingRequests = new Map();

// ==========================================
// 插件日志上报（供 bridge 侧排查使用）
// ==========================================
const PLUGIN_LOG_MAX = 1024;
const PLUGIN_LOG_BATCH_MS = 3000;
let _pluginLogBuffer = [];
let _pluginLogTimer = null;
let _pluginClientId = 'sb-' + Math.random().toString(36).substr(2, 6);

function pluginLog(level, tag, message) {
  const entry = {
    ts: Date.now(),
    level: level || 'INFO',
    tag: tag || '',
    msg: String(message)
  };
  _pluginLogBuffer.push(entry);
  if (_pluginLogBuffer.length > PLUGIN_LOG_MAX) {
    _pluginLogBuffer.shift();
  }
  // ERR 级别立即上报，其他批量
  if (level === 'ERR' || level === 'ERROR') {
    _flushPluginLogs();
  } else {
    _schedulePluginLogFlush();
  }
}

function _schedulePluginLogFlush() {
  if (_pluginLogTimer) return;
  _pluginLogTimer = setTimeout(() => {
    _pluginLogTimer = null;
    _flushPluginLogs();
  }, PLUGIN_LOG_BATCH_MS);
}

function _flushPluginLogs() {
  if (!wsState.connected || _pluginLogBuffer.length === 0) return;
  const batch = _pluginLogBuffer.slice(); // 复制，发送成功后再清空
  const ok = wsSend({
    type: 'logReport',
    clientId: _pluginClientId,
    logs: batch
  });
  if (ok) {
    _pluginLogBuffer.length = 0; // 发送成功才清空
  }
}

// 包装 console，同时输出到浏览器控制台和日志缓冲区
function _sidebar_log(tag, ...args) {
  console.log(`[Sidebar] ${tag}`, ...args);
  const msg = args.length ? args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : '';
  pluginLog('INFO', tag, msg);
}
function _sidebar_logWarn(tag, ...args) {
  console.warn(`[Sidebar] ${tag}`, ...args);
  const msg = args.length ? args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : '';
  pluginLog('WARN', tag, msg);
}
function _sidebar_logErr(tag, ...args) {
  console.error(`[Sidebar] ${tag}`, ...args);
  const msg = args.length ? args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : '';
  pluginLog('ERR', tag, msg);
}

// 命令处理器映射
const commandHandlers = {
  ping: async () => ({ pong: true, timestamp: Date.now() }),

  getStatus: async () => {
    const editorResult = await sendMessageToParent({ action: 'getEditorCode' });
    const status = await getBacktestStatusFromPage();
    const pageUrl = await sendMessageToParent({ action: 'getPageUrl' });
    return {
      editor: editorResult || null,
      backtestStatus: status,
      pageUrl: pageUrl || 'unknown'
    };
  },

  pushCode: async (data) => {
    const { code } = data || {};
    if (!code || typeof code !== 'string') {
      throw new Error('缺少 code 参数');
    }
    const success = await sendMessageToParent({ action: 'setEditorCode', code });
    if (success) {
      currentCode = code;
      const lineCount = code.split('\n').length;
      if (elements.codeStatus) {
        elements.codeStatus.textContent = `当前策略共${lineCount}行`;
      }
    }
    return { success, codeLength: code.length };
  },

  pullLogs: async () => {
    const result = await requestBacktestLogs();
    return {
      logs: result?.logs || null,
      logLength: result?.logs ? result.logs.length : 0,
      debugInfo: result?.debugInfo || null
    };
  },

  clickCompile: async () => {
    // 通过 content script 执行编译点击
    const success = await sendMessageToParent({ action: 'clickCompile' });
    return { success };
  },

  getResults: async () => {
    const result = await getBacktestResultsFromPage();
    return result;
  },

  getBacktestErrors: async () => {
    const result = await getBacktestErrorsFromPage();
    return result;
  },

  setBacktestParams: async (data) => {
    const { startDate, endDate, initialCash, benchmark } = data || {};
    const success = await sendMessageToParent({
      action: 'setBacktestParams',
      startDate,
      endDate,
      initialCash,
      benchmark
    });
    return { success, params: { startDate, endDate, initialCash, benchmark } };
  },

  renameStrategy: async (data) => {
    const { newName } = data || {};
    if (!newName) {
      throw new Error('缺少 newName 参数');
    }
    const result = await sendMessageToParent({ action: 'renameStrategyName', newName });
    // 重命名后立即同步一次
    const info = await fetchPageStrategyInfo();
    pageStrategyInfo = info;
    wsSend({
      type: 'register',
      client: 'joinquant-sidebar',
      version: '1.0',
      strategyName: info.strategyName,
      algorithmId: info.algorithmId,
      pageUrl: info.pageUrl
    });
    return result || { success: false, error: '重命名失败' };
  },

  getPageInfo: async () => {
    const info = await fetchPageStrategyInfo();
    pageStrategyInfo = info;
    return info;
  }
};

async function getBacktestStatusFromPage() {
  try {
    const result = await sendMessageToParent({ action: 'getBacktestStatus' });
    return result || 'unknown';
  } catch (e) {
    return 'error';
  }
}

async function getBacktestResultsFromPage() {
  try {
    const result = await sendMessageToParent({ action: 'getBacktestResults' });
    return result || {};
  } catch (e) {
    return { error: e.message };
  }
}

async function getBacktestErrorsFromPage() {
  try {
    const result = await sendMessageToParent({ action: 'getBacktestErrors' });
    return result || { hasError: false, errors: [], count: 0 };
  } catch (e) {
    return { hasError: false, errors: [], count: 0, error: e.message };
  }
}

function updateWsStatus() {
  const el = elements.wsStatus;
  if (!el) return;
  if (wsState.connected) {
    el.textContent = '🟢 已连接';
    el.className = 'ws-status connected';
    el.title = `Claude Code 桥接已连接 (${WS_URL})`;
  } else if (wsState.connecting) {
    el.textContent = '🟡 连接中';
    el.className = 'ws-status connecting';
    el.title = '正在连接 Claude Code...';
  } else {
    el.textContent = '⚪ 未连接';
    el.className = 'ws-status';
    el.title = `点击重连 (${WS_URL})`;
  }
}

function connectWebSocket() {
  if (wsState.connected || wsState.connecting) return;

  wsState.connecting = true;
  updateWsStatus();

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      wsState.connected = true;
      wsState.connecting = false;
      wsState.reconnectAttempts = 0;
      updateWsStatus();
      _sidebar_log('[CONN] WebSocket 已连接');
      // 重连后 flush 断线期间积累的日志
      _flushPluginLogs();

      // 先发送基本注册（确保 bridge 立即知道有客户端连接）
      wsSend({
        type: 'register',
        client: 'joinquant-sidebar',
        version: '1.0',
        strategyName: null,
        algorithmId: null,
        pageUrl: window.location.href
      });
      _sidebar_log('[REG] 发送基本注册 (strategyName=null)');

      // 异步获取页面策略信息并更新注册
      try {
        const info = await fetchPageStrategyInfo();
        pageStrategyInfo = info;
        wsSend({
          type: 'register',
          client: 'joinquant-sidebar',
          version: '1.0',
          strategyName: info.strategyName,
          algorithmId: info.algorithmId,
          pageUrl: info.pageUrl
        });
        _sidebar_log('[REG] 更新注册:', info.strategyName || '(未命名)', 'algId=', info.algorithmId);
      } catch (e) {
        _sidebar_logErr('[ERR] 获取页面信息失败:', e);
      }

      showStatus('✓ 桥接已连接');

      // 连接成功后加载策略列表
      await loadStrategiesIndex();
      initializeStrategySelector();

      // 启动策略名同步定时器
      startStrategyNameSync();
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        _sidebar_logErr('WebSocket 消息解析失败:', e);
        return;
      }

      // 处理响应（sendWsRequest 的回调）
      if (msg.type === 'response' && msg.id && pendingRequests.has(msg.id)) {
        const action = pendingRequests.get(msg.id)?.action || msg.action || 'unknown';
        const { resolve } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        _sidebar_log(`[RECV] 响应 ${action} (id=${msg.id})`);
        resolve(msg.data);
        return;
      }

      // 处理命令
      if (msg.type === 'command' && msg.action) {
        _sidebar_log(`[RECV] 命令 ${msg.action} (id=${msg.id || 'none'})`);
        await handleWsCommand(msg);
      }
    };

    ws.onclose = () => {
      wsState.connected = false;
      wsState.connecting = false;
      updateWsStatus();
      _sidebar_log('[CONN] WebSocket 已断开, 准备重连');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      _sidebar_logErr('WebSocket 错误:', err);
      wsState.connecting = false;
      updateWsStatus();
    };
  } catch (e) {
    _sidebar_logErr('WebSocket 连接失败:', e);
    wsState.connecting = false;
    updateWsStatus();
    scheduleReconnect();
  }
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const type = data.type || 'unknown';
    const action = data.action || '';
    const id = data.id || '';
    // logReport 不记日志，避免无限循环
    if (type !== 'logReport') {
      const logAction = action ? `${type}/${action}` : type;
      _sidebar_log(`[WS] 发送 ${logAction} (id=${id})`);
    }
    ws.send(JSON.stringify(data));
    return true;
  }
  _sidebar_logWarn(`[ERR] wsSend 失败: WebSocket 未连接 (readyState=${ws ? ws.readyState : 'null'})`);
  return false;
}

async function sendWsRequest(action, data = null, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      _sidebar_logWarn(`[ERR] sendWsRequest ${action}: WebSocket 未连接`);
      reject(new Error('WebSocket 未连接'));
      return;
    }
    const reqId = 'req-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    pendingRequests.set(reqId, { resolve, reject, action });
    _sidebar_log(`[REQ] ${action} (reqId=${reqId}) -> bridge, timeout=${timeout}ms`);
    wsSend({
      type: 'command',
      id: reqId,
      action: action,
      data: data
    });
    setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        _sidebar_logWarn(`[TIMEOUT] ${action} (reqId=${reqId}) ${timeout}ms 超时`);
        reject(new Error('请求超时'));
      }
    }, timeout);
  });
}

async function handleWsCommand(msg) {
  const { id, action, data } = msg;
  const handler = commandHandlers[action];
  _sidebar_log(`[CMD] 收到: ${action} (id=${id})`);

  if (!handler) {
    _sidebar_logWarn(`[ERR] 未知命令: ${action}`);
    wsSend({ type: 'response', id, action, error: `未知命令: ${action}` });
    return;
  }

  try {
    const result = await handler(data);
    _sidebar_log(`[CMD] 完成: ${action} (id=${id})`);
    wsSend({ type: 'response', id, action, data: result });
  } catch (err) {
    _sidebar_logErr(`[ERR] 命令 ${action} (id=${id}) 执行失败:`, err);
    wsSend({ type: 'response', id, action, error: err.message || String(err) });
  }
}

function scheduleReconnect() {
  if (wsState.reconnectTimer) return;
  if (WS_MAX_RECONNECT_ATTEMPTS > 0 && wsState.reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
    _sidebar_log('WebSocket 重试次数已达上限');
    return;
  }

  wsState.reconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_INTERVAL * Math.pow(1.5, wsState.reconnectAttempts - 1), 30000);
  _sidebar_log(`${delay}ms 后重连 WebSocket...`);

  wsState.reconnectTimer = setTimeout(() => {
    wsState.reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function disconnectWebSocket() {
  if (wsState.reconnectTimer) {
    clearTimeout(wsState.reconnectTimer);
    wsState.reconnectTimer = null;
  }
  if (wsState.nameSyncTimer) {
    clearInterval(wsState.nameSyncTimer);
    wsState.nameSyncTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  wsState.connected = false;
  wsState.connecting = false;
  updateWsStatus();
}

// 当前页面的策略信息（用于同步）
let pageStrategyInfo = {
  strategyName: null,
  algorithmId: null,
  pageUrl: null
};

/**
 * 获取页面策略信息
 */
async function fetchPageStrategyInfo() {
  try {
    const [nameResult, idResult, urlResult] = await Promise.all([
      sendMessageToParent({ action: 'getStrategyName' }),
      sendMessageToParent({ action: 'getAlgorithmId' }),
      sendMessageToParent({ action: 'getPageUrl' })
    ]);
    _sidebar_log(`[INFO] 策略信息: name='${nameResult}' algId=${idResult && idResult.slice(0,12)}...`);
    return {
      strategyName: nameResult || null,
      algorithmId: idResult || null,
      pageUrl: urlResult || window.location.href
    };
  } catch (e) {
    _sidebar_logErr('[ERR] 获取页面策略信息失败:', e);
    return { strategyName: null, algorithmId: null, pageUrl: window.location.href };
  }
}

/**
 * 启动策略名同步定时器
 */
function startStrategyNameSync() {
  if (wsState.nameSyncTimer) {
    clearInterval(wsState.nameSyncTimer);
  }
  // 每 3 秒检查一次策略名是否变化
  wsState.nameSyncTimer = setInterval(async () => {
    if (!wsState.connected) return;
    const info = await fetchPageStrategyInfo();
    if (info.strategyName !== pageStrategyInfo.strategyName) {
      _sidebar_log(`[SYNC] 策略名变化: '${pageStrategyInfo.strategyName}' -> '${info.strategyName}'`);
      pageStrategyInfo = info;
      wsSend({
        type: 'register',
        client: 'joinquant-sidebar',
        version: '1.0',
        strategyName: info.strategyName,
        algorithmId: info.algorithmId,
        pageUrl: info.pageUrl
      });
    }
  }, 3000);
}

// ==========================================
// 回测状态
// ==========================================

async function checkBacktestStatus() {
  if (!wsState.connected) return;
  const status = await getBacktestStatusFromPage();
  _sidebar_log(`回测状态: ${status}`);
}

// ==========================================
// DOM 元素
// ==========================================
const elements = {
  codeStatus: document.getElementById('codeStatus'),
  refreshCodeBtn: document.getElementById('refreshCodeBtn'),
  pullLogsBtn: document.getElementById('pullLogsBtn'),
  saveBtn: document.getElementById('saveBtn'),
  strategySelect: document.getElementById('strategySelect'),
  syncStrategyBtn: document.getElementById('syncStrategyBtn'),
  strategyInfo: document.getElementById('strategyInfo'),
  versionInfo: document.getElementById('versionInfo'),
  wsStatus: document.getElementById('wsStatus'),
  saveArea: document.getElementById('saveArea'),
  saveCategorySelect: document.getElementById('saveCategorySelect'),
  saveNameInput: document.getElementById('saveNameInput'),
  confirmSaveBtn: document.getElementById('confirmSaveBtn'),
  cancelSaveBtn: document.getElementById('cancelSaveBtn'),
  logSaveArea: document.getElementById('logSaveArea'),
  logSaveDirSelect: document.getElementById('logSaveDirSelect'),
  logFileName: document.getElementById('logFileName'),
  confirmLogSaveBtn: document.getElementById('confirmLogSaveBtn'),
  cancelLogSaveBtn: document.getElementById('cancelLogSaveBtn')
};

// ==========================================
// 初始化
// ==========================================
let contentScriptReady = false;

document.addEventListener('DOMContentLoaded', async () => {
  initializeEventListeners();
  elements.codeStatus.textContent = '--行';

  // 初始化版本显示
  initializeVersion();

  // 加载策略索引
  await loadStrategiesIndex();

  // 初始化策略选择器
  initializeStrategySelector();

  // 初始化 WebSocket 连接
  updateWsStatus();
  connectWebSocket();

  // 监听来自 content script 的就绪信号
  window.addEventListener('message', (event) => {
    if (event.data && event.data.from === 'JQUAN_HELPER_CONTENT' &&
        event.data.action === 'contentScriptReady') {
      _sidebar_log('收到 content script 就绪信号');
      contentScriptReady = true;
      startCodeMonitoring();
    }
  });

  // 备用方案：如果 3 秒内没有收到就绪信号，主动尝试通信
  setTimeout(() => {
    if (!contentScriptReady) {
      _sidebar_log('未收到就绪信号，主动检查...');
      checkContentScriptReady();
    }
  }, 3000);
});

function initializeEventListeners() {
  // 刷新代码 + 策略列表
  elements.refreshCodeBtn.addEventListener('click', async () => {
    await fetchEditorCode();
    await loadStrategiesIndex();
    initializeStrategySelector();
  });

  // 保存到本地
  elements.saveBtn.addEventListener('click', () => {
    showSaveForm();
  });

  // 拉取日志
  elements.pullLogsBtn.addEventListener('click', () => {
    pullAllLogs();
  });

  // 保存表单按钮
  elements.confirmSaveBtn.addEventListener('click', confirmSave);
  elements.cancelSaveBtn.addEventListener('click', hideSaveForm);

  // 日志保存表单按钮
  elements.confirmLogSaveBtn.addEventListener('click', confirmLogSave);
  elements.cancelLogSaveBtn.addEventListener('click', hideLogSaveForm);

  // WebSocket 状态点击重连
  if (elements.wsStatus) {
    elements.wsStatus.addEventListener('click', () => {
      if (!wsState.connected) {
        connectWebSocket();
      }
    });
  }

  // 策略选择变更
  elements.strategySelect.addEventListener('change', () => {
    const selected = elements.strategySelect.value;
    elements.syncStrategyBtn.disabled = !selected;
    if (selected) {
      showStatus(`已选择: ${elements.strategySelect.options[elements.strategySelect.selectedIndex].text}`);
    }
  });

  // 同步策略按钮
  elements.syncStrategyBtn.addEventListener('click', syncSelectedStrategy);
}

async function checkContentScriptReady() {
  _sidebar_log('主动检查 content script 是否就绪...');

  const result = await sendMessageToParent({ action: 'getEditorCode' });

  if (result === null || result.code === null) {
    _sidebar_logErr('content script 未就绪');
    elements.codeStatus.textContent = '--行';
  } else {
    _sidebar_log('content script 已就绪');
    startCodeMonitoring();
  }
}

// ==========================================
// 策略索引加载
// ==========================================

async function loadStrategiesIndex() {
  if (!wsState.connected) {
    _sidebar_logWarn('WebSocket 未连接，无法加载策略列表');
    STRATEGIES_CONFIG.strategies = [];
    return;
  }
  try {
    const data = await sendWsRequest('listStrategies');
    const strategies = data?.strategies || [];
    STRATEGIES_CONFIG.strategies = strategies;
    _sidebar_log(`策略列表加载成功: ${strategies.length} 个策略`);
  } catch (error) {
    _sidebar_logErr('加载策略列表失败:', error);
    STRATEGIES_CONFIG.strategies = [];
  }
}

// ==========================================
// 策略选择器初始化
// ==========================================

function initializeStrategySelector() {
  try {
    _sidebar_log('初始化策略选择器...');

    // 清空现有选项（保留默认选项）
    elements.strategySelect.innerHTML = '<option value="">选择本地策略...</option>';

    // 加载策略列表
    for (const strategy of STRATEGIES_CONFIG.strategies) {
      const option = document.createElement('option');
      option.value = strategy.id;
      option.textContent = strategy.name;
      option.dataset.path = strategy.path;
      elements.strategySelect.appendChild(option);
    }

    _sidebar_log(`策略选择器初始化完成，共 ${STRATEGIES_CONFIG.strategies.length} 个策略`);
  } catch (error) {
    _sidebar_logErr('初始化策略选择器失败:', error);
    elements.strategyInfo.innerHTML = '<span class="error">加载策略列表失败</span>';
  }
}

async function syncSelectedStrategy() {
  const selectedId = elements.strategySelect.value;
  if (!selectedId) return;

  const strategy = STRATEGIES_CONFIG.strategies.find(s => s.id === selectedId);
  if (!strategy) {
    _sidebar_logErr('未找到策略配置:', selectedId);
    return;
  }

  // 清除之前的定时器
  if (window.strategyInfoTimeout) {
    clearTimeout(window.strategyInfoTimeout);
  }

  try {
    elements.syncStrategyBtn.disabled = true;
    elements.syncStrategyBtn.classList.add('syncing');
    elements.syncStrategyBtn.textContent = '加载中...';
    elements.strategyInfo.textContent = `正在加载: ${strategy.name}...`;

    const strategyContent = await loadStrategyFile(strategy.path);
    if (!strategyContent) {
      throw new Error('策略文件内容为空');
    }

    const success = await sendMessageToParent({
      action: 'setEditorCode',
      code: strategyContent
    });

    if (success) {
      showStatus(`✓ ${strategy.name} 已同步 (${strategyContent.length} 字符)`);
      currentCode = strategyContent;
      const lineCount = strategyContent.split('\n').length;
      elements.codeStatus.textContent = `${lineCount}行`;
    } else {
      throw new Error('同步到编辑器失败');
    }
  } catch (error) {
    _sidebar_logErr('同步策略失败:', error);
    showStatus('❌ 同步失败: ' + error.message);
  } finally {
    elements.syncStrategyBtn.disabled = false;
    elements.syncStrategyBtn.classList.remove('syncing');
    elements.syncStrategyBtn.textContent = '同步到编辑器';

    window.strategyInfoTimeout = setTimeout(() => {
      elements.strategyInfo.textContent = '';
    }, 3000);
  }
}

async function loadStrategyFile(filePath) {
  if (!wsState.connected) {
    throw new Error('WebSocket 未连接');
  }
  try {
    const data = await sendWsRequest('getStrategy', { path: filePath });
    const content = data?.content;
    if (content === null || content === undefined) {
      throw new Error('策略文件内容为空或不存在');
    }
    return content;
  } catch (error) {
    _sidebar_logErr(`加载策略文件失败 ${filePath}:`, error);
    throw error;
  }
}

// ==========================================
// 代码监控（自动获取）
// ==========================================
const MAX_RETRIES = 3;

async function startCodeMonitoring() {
  let retryCount = 0;

  // 首次获取，带重试
  while (retryCount < MAX_RETRIES) {
    const success = await fetchEditorCode();
    if (success) {
      break;
    }
    retryCount++;
    await sleep(2000);
  }

  // 被动模式：不再自动轮询，由用户手动点击刷新按钮获取
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchEditorCode() {
  try {
    const result = await sendMessageToParent({ action: 'getEditorCode' });

    if (result !== null && result.code !== null) {
      currentCode = result.code;
      const lineCount = result.lineCount || 0;
      elements.codeStatus.textContent = `${lineCount}行`;
      return true;
    }
    return false;
  } catch (error) {
    _sidebar_logErr('获取代码失败:', error);
    elements.codeStatus.textContent = '--行';
    return false;
  }
}

// ==========================================
// 回测日志操作
// ==========================================

async function pullAllLogs() {
  try {
    showStatus('🔄 正在获取回测日志...');

    const result = await requestBacktestLogs();
    const { logs, debugInfo } = result || {};

    if (!logs || logs.length === 0) {
      if (debugInfo) {
        showStatus(`⚠️ 未找到回测日志，请确保页面已运行回测`);
      } else {
        showStatus('⚠️ 未找到回测日志，请确保页面已运行回测');
      }
      return;
    }

    // 缓存日志，显示保存表单
    window._pendingLogs = logs;
    showLogSaveForm();

  } catch (error) {
    _sidebar_logErr('拉取日志失败:', error);
    showStatus('❌ 拉取日志失败: ' + error.message);
  }
}

function generateLogFileName() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const timeStr = beijingTime.toISOString().slice(0, 19).replace(/:/g, '-');
  return `backtest_log_${timeStr}.txt`;
}

function fillLogSaveDirSelect() {
  const select = elements.logSaveDirSelect;
  select.innerHTML = '<option value="">选择策略目录...</option>';
  for (const s of STRATEGIES_CONFIG.strategies) {
    const parts = s.path?.split('/');
    if (parts && parts.length >= 3) {
      const display = `${parts[1]} / ${parts[2]}`;
      const dirPath = `${parts[1]}/${parts[2]}`;
      const option = document.createElement('option');
      option.value = dirPath;
      option.textContent = display;
      select.appendChild(option);
    }
  }
}

function showLogSaveForm() {
  fillLogSaveDirSelect();
  elements.logSaveDirSelect.value = '';
  elements.logFileName.textContent = generateLogFileName();
  elements.logSaveArea.style.display = 'block';
}

function hideLogSaveForm() {
  elements.logSaveArea.style.display = 'none';
  elements.logSaveDirSelect.value = '';
  elements.logFileName.textContent = '';
  window._pendingLogs = null;
}

async function confirmLogSave() {
  const dirPath = elements.logSaveDirSelect.value;
  const logs = window._pendingLogs;

  if (!dirPath) {
    showStatus('⚠️ 请选择策略目录');
    elements.logSaveDirSelect.focus();
    return;
  }
  if (!logs) {
    showStatus('⚠️ 日志已失效，请重新获取');
    hideLogSaveForm();
    return;
  }

  const filename = generateLogFileName();
  showStatus('🔄 正在保存日志...');
  try {
    const result = await sendWsRequest('saveFile', {
      dirPath: dirPath,
      filename: filename,
      content: logs
    }, 10000);

    if (result?.success) {
      showStatus(`✅ 日志已保存到 ${result.path}`);
      hideLogSaveForm();
    } else {
      showStatus('❌ 保存失败: ' + (result?.error || '未知错误'));
    }
  } catch (error) {
    _sidebar_logErr('保存日志失败:', error);
    showStatus('❌ 保存失败: ' + error.message);
  }
}

function requestBacktestLogs() {
  return new Promise((resolve) => {
    const requestId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5);
    let timeoutId = null;
    let resolved = false;

    const handler = (event) => {
      if (event.data && event.data.from === 'JQUAN_HELPER_CONTENT' &&
          event.data.action === 'backtestLogsResponse' &&
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        if (timeoutId) clearTimeout(timeoutId);
        if (resolved) return;
        resolved = true;

        const logs = event.data.logs;
        const debugInfo = event.data.debugInfo;
        _sidebar_log('收到日志响应, 长度:', logs ? logs.length : 0);
        resolve({ logs, debugInfo });
      }
    };

    window.addEventListener('message', handler);

    try {
      window.parent.postMessage({
        action: 'getBacktestLogs',
        from: 'JQUAN_HELPER_SIDEBAR',
        requestId
      }, '*');
    } catch (e) {
      window.removeEventListener('message', handler);
      if (timeoutId) clearTimeout(timeoutId);
      if (!resolved) {
        resolved = true;
        resolve({ logs: null, debugInfo: { error: e.message } });
      }
    }

    timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      if (!resolved) {
        resolved = true;
        resolve({ logs: null, debugInfo: { error: 'timeout' } });
      }
    }, 300000);
  });
}

// ==========================================
// 与父窗口通信
// ==========================================
function sendMessageToParent(message) {
  return new Promise((resolve) => {
    const requestId = generateSessionId();
    let timerId = null;

    const handler = (event) => {
      if (event.data && event.data.from === 'JQUAN_HELPER_CONTENT' &&
          event.data.requestId === requestId) {
        if (timerId) clearTimeout(timerId);
        window.removeEventListener('message', handler);

        _sidebar_log(`[RES] ${message.action} content_script 响应收到`);

        if (message.action === 'getEditorCode') {
          resolve({
            code: event.data.code,
            lineCount: event.data.lineCount
          });
        } else if (message.action === 'setEditorCode') {
          resolve(event.data.success);
        } else if (message.action === 'getBacktestStatus') {
          resolve(event.data.status);
        } else if (message.action === 'getBacktestResults') {
          resolve(event.data.results);
        } else if (message.action === 'clickCompile') {
          resolve(event.data.result);
        } else if (message.action === 'setBacktestParams') {
          resolve(event.data.result);
        } else if (message.action === 'getPageUrl') {
          resolve(event.data.url);
        } else if (message.action === 'getStrategyName') {
          resolve(event.data.name);
        } else if (message.action === 'getAlgorithmId') {
          resolve(event.data.algorithmId);
        } else if (message.action === 'renameStrategyName') {
          resolve(event.data.result);
        } else {
          resolve(event.data);
        }
      }
    };

    window.addEventListener('message', handler);

    try {
      _sidebar_log(`[SEND] ${message.action} -> content_script (reqId=${requestId})`);
      window.parent.postMessage({
        ...message,
        from: 'JQUAN_HELPER_SIDEBAR',
        requestId
      }, '*');
    } catch (e) {
      _sidebar_logErr(`[ERR] ${message.action} 发送消息失败:`, e);
      window.removeEventListener('message', handler);
      resolve(null);
      return;
    }

    timerId = setTimeout(() => {
      window.removeEventListener('message', handler);
      if (message.action) {
        _sidebar_logWarn(`[TIMEOUT] ${message.action} 5s 无响应`);
      }
      resolve(null);
    }, 5000);
  });
}

function generateSessionId() {
  return 'jquan-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// ==========================================
// UI 辅助函数
// ==========================================
function showStatus(text) {
  if (!elements.strategyInfo) return;
  elements.strategyInfo.innerHTML = text;
}

async function compileStrategy() {
  try {
    showStatus('🔄 正在触发编译...');
    const success = await sendMessageToParent({ action: 'clickCompile' });
    if (success) {
      showStatus('✅ 编译已触发');
    } else {
      showStatus('❌ 编译触发失败');
    }
  } catch (error) {
    _sidebar_logErr('编译失败:', error);
    showStatus('❌ 编译失败: ' + error.message);
  }
}

async function pullResults() {
  try {
    showStatus('🔄 正在获取回测结果...');
    const result = await getBacktestResultsFromPage();
    if (!result || Object.keys(result).length === 0) {
      showStatus('⚠️ 暂无回测结果');
      return;
    }
    // 格式化为可读文本
    const lines = [];
    if (result.totalReturns !== undefined) lines.push(`总收益: ${result.totalReturns}`);
    if (result.annualizedReturns !== undefined) lines.push(`年化收益: ${result.annualizedReturns}`);
    if (result.maxDrawdown !== undefined) lines.push(`最大回撤: ${result.maxDrawdown}`);
    if (result.sharpe !== undefined) lines.push(`Sharpe: ${result.sharpe}`);
    if (result.beta !== undefined) lines.push(`Beta: ${result.beta}`);
    if (result.alpha !== undefined) lines.push(`Alpha: ${result.alpha}`);
    const text = lines.join('\n');
    downloadTextAsFile(text, 'backtest_results.txt');
    showStatus(`✅ 结果已下载 (${lines.length} 项指标)`);
  } catch (error) {
    _sidebar_logErr('获取结果失败:', error);
    showStatus('❌ 获取结果失败: ' + error.message);
  }
}

function extractCategories() {
  const categories = new Set();
  for (const s of STRATEGIES_CONFIG.strategies) {
    const parts = s.path?.split('/');
    if (parts && parts.length >= 2 && parts[0] === 'strategies') {
      categories.add(parts[1]);
    }
  }
  return Array.from(categories).sort();
}

function fillCategorySelect() {
  const categories = extractCategories();
  const select = elements.saveCategorySelect;
  select.innerHTML = '<option value="">选择分类...</option>';
  for (const cat of categories) {
    const option = document.createElement('option');
    option.value = cat;
    option.textContent = cat;
    select.appendChild(option);
  }
}

async function showSaveForm() {
  try {
    const editorResult = await sendMessageToParent({ action: 'getEditorCode' });
    const code = editorResult?.code;
    if (!code || code.length === 0) {
      showStatus('⚠️ 编辑器代码为空');
      return;
    }

    // 缓存代码到全局，confirmSave 时直接用
    window._pendingSaveCode = code;

    // 获取策略名
    let strategyName = await sendMessageToParent({ action: 'getStrategyName' });
    if (!strategyName) strategyName = '';

    // 填充表单
    fillCategorySelect();
    elements.saveCategorySelect.value = '';
    elements.saveNameInput.value = strategyName.replace(/[\\/:*?"<>|]/g, '_').trim();

    elements.saveArea.style.display = 'block';
    elements.saveCategorySelect.focus();
  } catch (error) {
    _sidebar_logErr('显示保存表单失败:', error);
    showStatus('❌ 无法读取编辑器内容');
  }
}

function hideSaveForm() {
  elements.saveArea.style.display = 'none';
  elements.saveCategorySelect.value = '';
  elements.saveNameInput.value = '';
  window._pendingSaveCode = null;
}

async function confirmSave() {
  const category = elements.saveCategorySelect.value.trim();
  const strategyName = elements.saveNameInput.value.trim();
  const code = window._pendingSaveCode;

  if (!category) {
    showStatus('⚠️ 请选择分类');
    elements.saveCategorySelect.focus();
    return;
  }
  if (!strategyName) {
    showStatus('⚠️ 请输入策略名');
    elements.saveNameInput.focus();
    return;
  }
  if (!code) {
    showStatus('⚠️ 代码已失效，请重新打开保存对话框');
    hideSaveForm();
    return;
  }

  showStatus('🔄 正在保存...');
  try {
    const result = await sendWsRequest('saveStrategy', {
      path: `${category}/${strategyName}`,
      code: code
    }, 10000);

    if (result?.success) {
      showStatus(`✅ 已保存到 ${result.path}`);
      hideSaveForm();
      await loadStrategiesIndex();
      initializeStrategySelector();
    } else {
      showStatus('❌ 保存失败: ' + (result?.error || '未知错误'));
    }
  } catch (error) {
    _sidebar_logErr('保存策略失败:', error);
    showStatus('❌ 保存失败: ' + error.message);
  }
}

function downloadTextAsFile(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const timeStr = beijingTime.toISOString().slice(0, 19).replace(/:/g, '-');
  a.download = filename.replace('.txt', `_${timeStr}.txt`);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==========================================
// 版本管理
// ==========================================
async function initializeVersion() {
  const manifest = chrome.runtime.getManifest();
  if (elements.versionInfo) {
    elements.versionInfo.textContent = 'v' + manifest.version;
  }
}
