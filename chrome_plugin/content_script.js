// 聚宽策略助手 - Content Script
// 与聚宽编辑器交互，获取和设置代码

// 全局状态
let sidebarVisible = false;
let sidebarElement = null;
let pageEditor = null;

// content_script 诊断日志缓冲区（通过 getBacktestLogs 响应带回）
let _contentScriptDebugLogs = [];

// ==========================================
// 注入页面脚本以访问页面 window
// ==========================================

function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page_bridge.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// 监听来自页面脚本的消息
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.from === 'JQUAN_PAGE_BRIDGE') {
    if (event.data.action === 'editorReady') {
      console.log('[ContentScript] [PAGE] 页面编辑器已就绪');
      pageEditor = { ready: true };
    }
  }
});

// 注入页面脚本
injectPageScript();

// ==========================================
// ACE Editor 操作
// ==========================================

/**
 * 上报诊断日志到 sidebar，由 sidebar 的 pluginLog 机制发送到 bridge
 */
function reportLogToSidebar(level, tag, message) {
  // 同时存入本地缓冲区，确保通过 getBacktestLogs 响应带回
  const entry = `[${new Date().toLocaleTimeString()}] [${level || 'INFO'}] ${tag || ''} ${String(message).substring(0, 200)}`;
  _contentScriptDebugLogs.push(entry);
  if (_contentScriptDebugLogs.length > 2048) {
    _contentScriptDebugLogs.shift();
  }

  const iframe = document.getElementById('jquan-helper-iframe');
  if (!iframe || !iframe.contentWindow) {
    console.error('[ContentScript] [pluginLog] iframe 不存在，无法上报:', tag, message);
    return;
  }
  try {
    iframe.contentWindow.postMessage({
      from: 'JQUAN_HELPER_CONTENT',
      action: 'pluginLog',
      level: level || 'INFO',
      tag: tag || '',
      msg: String(message)
    }, '*');
    console.log('[ContentScript] [pluginLog] 已上报:', tag, message.substring(0, 60));
  } catch (e) {
    console.error('[ContentScript] [pluginLog] 上报失败:', e);
  }
}

/**
 * 通过 postMessage 向页面脚本请求编辑器代码
 */
function getEditorCodeFromPage() {
  return new Promise((resolve) => {
    const requestId = Date.now().toString();

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data && event.data.from === 'JQUAN_PAGE_BRIDGE' &&
          event.data.action === 'editorCodeResponse' &&
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        resolve(event.data.result);
      }
    };

    window.addEventListener('message', handler);

    window.postMessage({
      from: 'JQUAN_CONTENT_SCRIPT',
      action: 'getEditorCode',
      requestId: requestId
    }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 5000);
  });
}

/**
 * 通过 postMessage 向页面脚本设置编辑器代码
 */
function setEditorCodeToPage(code) {
  return new Promise((resolve) => {
    const requestId = Date.now().toString();

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data && event.data.from === 'JQUAN_PAGE_BRIDGE' &&
          event.data.action === 'setEditorCodeResponse' &&
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        resolve(event.data.success);
      }
    };

    window.addEventListener('message', handler);

    window.postMessage({
      from: 'JQUAN_CONTENT_SCRIPT',
      action: 'setEditorCode',
      code: code,
      requestId: requestId
    }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(false);
    }, 5000);
  });
}

/**
 * 通用调用 page_bridge.js 的 jquanAuto 方法
 */
function callPageBridge(action, data = {}) {
  return new Promise((resolve) => {
    const requestId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5);

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data && event.data.from === 'JQUAN_PAGE_BRIDGE' &&
          event.data.action === action + 'Response' &&
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    };

    window.addEventListener('message', handler);

    window.postMessage({
      from: 'JQUAN_CONTENT_SCRIPT',
      action: action,
      requestId: requestId,
      ...data
    }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ result: null, error: 'timeout' });
    }, 10000);
  });
}

/**
 * 获取编辑器中的代码和行数
 */
async function getEditorCode() {
  try {
    const result = await getEditorCodeFromPage();
    if (result) {
      return result;
    }

    console.error('[ContentScript] [ERR] 未找到 ACE Editor 实例');
    return null;

  } catch (error) {
    console.error('[ContentScript] [ERR] 获取代码失败:', error);
    return null;
  }
}

/**
 * 设置编辑器代码
 */
async function setEditorCode(code) {
  try {
    const success = await setEditorCodeToPage(code);
    if (success) {
      return true;
    }

    console.error('[ContentScript] [ERR] 未找到编辑器');
    return false;

  } catch (error) {
    console.error('[ContentScript] [ERR] 设置代码失败:', error);
    return false;
  }
}

/**
 * 追加代码到编辑器
 */
async function appendEditorCode(code) {
  try {
    const result = await getEditorCode();
    if (result !== null && result.code) {
      return await setEditorCode(result.code + '\n' + code);
    }
    return false;
  } catch (error) {
    console.error('[ContentScript] [ERR] 追加代码失败:', error);
    return false;
  }
}

/**
 * 判断文本是否是明显的UI元素（而非日志内容）
 * 返回 true 表示是UI元素，应排除；返回 false 表示可能是日志
 */
function isUIElement(text) {
  if (!text) return true;

  // 排除明显的UI元素文本
  const uiKeywords = [
    '快捷键', 'Modal', 'Close', 'Save changes', '×Close',
    '折叠当前', '折叠所有', '展开所有', '注释',
    '块缩进', '选择全部', '跳转到', '查找', '替换',
    '上移行', '下移行', '删除当前行', '复制并粘贴当前行',
    '正在加载日志...', '结束.', 'One fine body'
  ];

  for (const keyword of uiKeywords) {
    if (text.includes(keyword)) return true;
  }

  return false;
}

/**
 * 自动滚动日志容器以加载所有内容（处理虚拟滚动）
 * @param {HTMLElement} scrollContainer - 可滚动的日志容器
 * @param {HTMLElement} contentContainer - 包含日志内容的容器
 * @returns {Promise<string>} - 完整日志内容
 */
async function autoScrollAndCollectLogs(scrollContainer, contentContainer) {
  const seenLines = new Map();
  const debugInfo = [];

  function logDebug(msg) {
    debugInfo.push(msg);
    console.log('[ContentScript] [LOGS] ' + msg);
    reportLogToSidebar('INFO', '[LOGS]', msg);
  }

  function collectLogs(label) {
    const selectors = ['.log-line', '.log-item', '.line', '.log-row', '#log > pre > p', 'p', '.output-line'];
    let lines;
    let matchedSelector = null;
    for (const selector of selectors) {
      lines = contentContainer.querySelectorAll(selector);
      if (lines.length > 0) {
        matchedSelector = selector;
        break;
      }
    }
    const isFallback = !lines || lines.length === 0;
    if (isFallback) lines = contentContainer.children;

    let newCount = 0;
    for (const line of lines) {
      const text = (line.innerText || line.textContent || '').trim();
      if (text && text.length > 5 && !seenLines.has(text)) {
        seenLines.set(text, true);
        newCount++;
      }
    }
    return { total: lines.length, newCount, matchedSelector, isFallback };
  }

  logDebug(`容器初始: scrollHeight=${scrollContainer.scrollHeight}, clientHeight=${scrollContainer.clientHeight}, scrollTop=${scrollContainer.scrollTop}`);

  // 阶段1: 反复滚动到底部
  // 结束条件：连续3次滚动后 scrollHeight 和收集到的日志数都不再变化
  let lastScrollHeight = scrollContainer.scrollHeight;
  let lastSeenCount = seenLines.size;
  let stableCount = 0;
  let scrollAttempts = 0;

  while (stableCount < 3) {
    scrollAttempts++;
    const beforeCount = seenLines.size;
    const result = collectLogs(`阶段1#${scrollAttempts}`);
    logDebug(`阶段1#${scrollAttempts} 收集前: ${beforeCount}条, selector=${result.matchedSelector}, fallback=${result.isFallback}, lines=${result.total}, new=${result.newCount}`);

    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await sleep(150);

    const afterResult = collectLogs(`阶段1#${scrollAttempts}-after`);
    const currentScrollHeight = scrollContainer.scrollHeight;
    const currentSeenCount = seenLines.size;
    logDebug(`阶段1#${scrollAttempts} 滚动后: scrollTop=${scrollContainer.scrollTop}, scrollHeight=${currentScrollHeight}, new=${afterResult.newCount}, total=${currentSeenCount}`);

    // 只有当 scrollHeight 和已收集日志数都完全不变时，才认为稳定
    if (currentScrollHeight === lastScrollHeight && currentSeenCount === lastSeenCount) {
      stableCount++;
      logDebug(`阶段1#${scrollAttempts} 稳定计数: ${stableCount}/3 (scrollHeight=${currentScrollHeight}, seen=${currentSeenCount})`);
    } else {
      lastScrollHeight = currentScrollHeight;
      lastSeenCount = currentSeenCount;
      stableCount = 0;
      logDebug(`阶段1#${scrollAttempts} 发现变化，稳定计数重置 (scrollHeight=${currentScrollHeight}, seen=${currentSeenCount})`);
    }
  }
  logDebug(`阶段1结束: 共${scrollAttempts}次滚动, 收集${seenLines.size}条日志`);

  // 阶段2: 逐步向上滚动确保收集完整
  scrollContainer.scrollTop = 0;
  await sleep(200);
  collectLogs('阶段2-顶部');

  const scrollStep = Math.max(scrollContainer.clientHeight * 0.8, 100);
  let currentScroll = 0;
  let upwardAttempts = 0;
  const maxUpwardAttempts = Math.min(Math.ceil(scrollContainer.scrollHeight / scrollStep) + 10, 100);

  while (upwardAttempts < maxUpwardAttempts) {
    const beforeCount = seenLines.size;
    currentScroll += scrollStep;
    scrollContainer.scrollTop = Math.min(currentScroll, scrollContainer.scrollHeight);
    await sleep(100);
    const result = collectLogs(`阶段2#${upwardAttempts + 1}`);

    if (result.newCount > 0) {
      logDebug(`阶段2#${upwardAttempts + 1}: scrollTop=${scrollContainer.scrollTop}, new=${result.newCount}, total=${seenLines.size}`);
    }

    if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 50) {
      break;
    }
    upwardAttempts++;
  }

  return {
    logs: Array.from(seenLines.keys()).join('\n'),
    debugInfo: debugInfo.join('\n')
  };
}

/**
 * 辅助函数：延迟等待
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取聚宽回测日志
 * 从页面上的日志区域提取日志内容，支持滚动加载完整日志
 */
async function getBacktestLogs() {
  try {
    // 查找 daily-logs-container（真正的滚动容器）
    const dailyLogsContainer = document.querySelector('#daily-logs-tab #daily-logs-container');

    if (dailyLogsContainer && dailyLogsContainer.scrollHeight > dailyLogsContainer.clientHeight) {
      const result = await autoScrollAndCollectLogs(dailyLogsContainer, dailyLogsContainer);
      const debugInfo = { source: 'daily-logs-container', scrollDebug: result.debugInfo, contentScriptLogs: _contentScriptDebugLogs.slice() };
      _contentScriptDebugLogs.length = 0;
      return { logs: result.logs, debugInfo };
    }

    // 备选：查找其他日志容器（尽量获取所有内容，不再区分正常/错误）
    const selectors = [
      '#daily-logs-tab',
      '.log-container',
      '.backtest-log',
      '.console-output',
      '#output-pane',
      '#result-pane',
      '.result-panel',
      '.backtest-result-panel',
      '[class*="log"]',
      '[class*="console"]',
      '[class*="output"]'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const text = el.innerText || '';
      // 只要不是纯UI元素，就尝试获取
      if (!isUIElement(text) && text.trim().length > 10) {
        if (el.scrollHeight > el.clientHeight + 50) {
          const result = await autoScrollAndCollectLogs(el, el);
          const debugInfo = { source: selector, scrollDebug: result.debugInfo, contentScriptLogs: _contentScriptDebugLogs.slice() };
          _contentScriptDebugLogs.length = 0;
          return { logs: result.logs, debugInfo };
        }
        // 无滚动条但内容多，直接获取
        const debugInfo = { source: selector, direct: true, contentScriptLogs: _contentScriptDebugLogs.slice() };
        _contentScriptDebugLogs.length = 0;
        return { logs: text.trim(), debugInfo };
      }
    }

    const debugInfo = { error: '未找到日志容器', contentScriptLogs: _contentScriptDebugLogs.slice() };
    _contentScriptDebugLogs.length = 0;
    return { logs: null, debugInfo };
  } catch (error) {
    console.error('[ContentScript] [ERR] 获取日志失败:', error);
    reportLogToSidebar('ERR', '[LOGS]', '获取日志失败: ' + String(error));
    const debugInfo = { error: error.message, contentScriptLogs: _contentScriptDebugLogs.slice() };
    _contentScriptDebugLogs.length = 0;
    return { logs: null, debugInfo };
  }
}

// ==========================================
// 侧边栏控制
// ==========================================

function toggleSidebar() {
  if (sidebarVisible) {
    hideSidebar();
  } else {
    showSidebar();
  }
}

function showSidebar() {
  if (!sidebarElement) {
    createSidebar();
  }

  if (sidebarElement) {
    sidebarElement.style.display = 'flex';
    sidebarVisible = true;
    document.body.classList.add('jquan-helper-sidebar-open');
    document.documentElement.classList.add('jquan-helper-sidebar-open');
    console.log('[ContentScript] 侧边栏已显示');

    chrome.storage.local.set({ sidebarVisible: true });
  }
}

function hideSidebar() {
  if (sidebarElement) {
    sidebarElement.style.display = 'none';
    sidebarVisible = false;
    document.body.classList.remove('jquan-helper-sidebar-open');
    document.documentElement.classList.remove('jquan-helper-sidebar-open');
    console.log('[ContentScript] 侧边栏已隐藏');

    chrome.storage.local.set({ sidebarVisible: false });
  }
}

function createSidebar() {
  if (document.getElementById('jquan-helper-sidebar')) {
    sidebarElement = document.getElementById('jquan-helper-sidebar');
    return;
  }

  const sidebar = document.createElement('div');
  sidebar.id = 'jquan-helper-sidebar';

  const iframe = document.createElement('iframe');
  iframe.id = 'jquan-helper-iframe';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'jquan-sidebar-content';
  contentDiv.appendChild(iframe);
  sidebar.appendChild(contentDiv);

  const style = document.createElement('style');
  style.textContent = `
    #jquan-helper-sidebar {
      position: fixed;
      right: 0;
      top: 0;
      width: 420px;
      height: 100vh;
      background: #fff;
      border-left: 1px solid #e2e8f0;
      box-shadow: -2px 0 8px rgba(0, 0, 0, 0.1);
      z-index: 99999;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .jquan-sidebar-content {
      flex: 1;
      overflow: hidden;
      display: flex;
    }

    #jquan-helper-iframe {
      width: 100%;
      height: 100%;
      border: none;
    }

    /* 侧边栏打开时：给 body 添加右边距，让页面内容自然重排 */
    /* 像浏览器窗口变窄一样，页面会自适应新的宽度 */
    body.jquan-helper-sidebar-open {
      margin-right: 420px !important;
      position: relative !important;
    }

    /* 固定头部调整宽度和位置 */
    body.jquan-helper-sidebar-open header#kk_nav,
    body.jquan-helper-sidebar-open .kk_nav,
    body.jquan-helper-sidebar-open .fixed-top {
      width: calc(100% - 420px) !important;
      right: 420px !important;
      left: 0 !important;
    }

    /* 主容器宽度调整 */
    body.jquan-helper-sidebar-open .kk_main,
    body.jquan-helper-sidebar-open .kk_body,
    body.jquan-helper-sidebar-open .content-area {
      width: 100% !important;
      max-width: 100% !important;
    }

    /* 编辑器区域关键调整：splitter容器使用vw计算实际可用宽度 */
    body.jquan-helper-sidebar-open #splitter-outer-container,
    body.jquan-helper-sidebar-open #splitter-container {
      width: calc(100vw - 420px) !important;
      right: 0 !important;
      left: 0 !important;
    }

    /* 调整代码区和输出区比例，给代码区更多空间 (55% / 45%) */
    body.jquan-helper-sidebar-open #code-area {
      width: 55% !important;
    }

    body.jquan-helper-sidebar-open #output-pane {
      left: 55% !important;
      width: calc(45% - 10px) !important;
    }

    /* 防止横向滚动条 */
    body.jquan-helper-sidebar-open {
      overflow-x: hidden !important;
    }

    /* 确保 html 也没有横向滚动 */
    html.jquan-helper-sidebar-open,
    body.jquan-helper-sidebar-open {
      overflow-x: hidden !important;
    }
`;

  document.head.appendChild(style);
  document.body.appendChild(sidebar);
  sidebarElement = sidebar;

  iframe.addEventListener('load', () => {
    console.log('[ContentScript] [IFRAME] 侧边栏 iframe 已加载');
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'contentScriptReady'
      }, '*');
    }
  });

  iframe.src = chrome.runtime.getURL('sidebar/sidebar.html');

  console.log('[ContentScript] [UI] 侧边栏已创建');
}

// ==========================================
// 消息处理
// ==========================================

window.addEventListener('message', async (event) => {
  if (!event.data || !event.data.from) return;

  const { from, action, requestId } = event.data;

  if (from === 'JQUAN_HELPER_SIDEBAR') {
    const iframe = document.getElementById('jquan-helper-iframe');
    if (!iframe || !iframe.contentWindow) {
      console.error('[ContentScript] [ERR] iframe 未找到');
      return;
    }
    console.log(`[ContentScript] [CMD] 收到 sidebar 请求: ${action} (reqId=${requestId})`);
    reportLogToSidebar('INFO', '[CMD]', `收到请求: ${action}`);

    // 处理 copyToClipboard 请求
    if (action === 'copyToClipboard') {
      const { text } = event.data;
      console.log('[ContentScript] 处理复制请求, 文本长度:', text ? text.length : 0);

      // 使用 execCommand 复制
      let success = false;
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        success = document.execCommand('copy');
        document.body.removeChild(textarea);
        console.log('[ContentScript] 复制结果:', success);
      } catch (err) {
        console.error('[ContentScript] 复制失败:', err);
        success = false;
      }

      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'copyToClipboardResponse',
        requestId,
        success
      }, '*');
      return;
    }

    if (action === 'getEditorCode') {
      const result = await getEditorCode();
      console.log(`[ContentScript] [RES] getEditorCode 响应: lines=${result?.lineCount || 0}`);

      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'editorCodeResponse',
        requestId,
        code: result?.code || null,
        lineCount: result?.lineCount || 0
      }, '*');
    }

    if (action === 'setEditorCode') {
      const success = await setEditorCode(event.data.code);
      console.log(`[ContentScript] [RES] setEditorCode 响应: success=${success}`);

      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'setEditorCodeResponse',
        requestId,
        success
      }, '*');
    }

    if (action === 'getBacktestLogs') {
      const result = await getBacktestLogs();
      console.log(`[ContentScript] [RES] getBacktestLogs 响应: length=${result?.logs ? result.logs.length : 0}`);
      reportLogToSidebar('INFO', '[RES]', `getBacktestLogs 响应: length=${result?.logs ? result.logs.length : 0}`);

      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'backtestLogsResponse',
        requestId,
        logs: result.logs,
        debugInfo: result.debugInfo
      }, '*');
      return;
    }

    if (action === 'getPageUrl') {
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'getPageUrlResponse',
        requestId,
        url: window.location.href
      }, '*');
      return;
    }

    if (action === 'getBacktestStatus') {
      const resp = await callPageBridge('getBacktestStatus');
      console.log(`[ContentScript] [RES] getBacktestStatus 响应: status=${resp.result || 'unknown'}`);
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'getBacktestStatusResponse',
        requestId,
        status: resp.result || 'unknown'
      }, '*');
      return;
    }

    if (action === 'getBacktestResults') {
      const resp = await callPageBridge('getBacktestResults');
      console.log(`[ContentScript] [RES] getBacktestResults 响应: keys=${Object.keys(resp.result || {}).join(',') || 'empty'}`);
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'getBacktestResultsResponse',
        requestId,
        results: resp.result || {}
      }, '*');
      return;
    }

    if (action === 'clickCompile') {
      const resp = await callPageBridge('clickCompile');
      console.log(`[ContentScript] [RES] clickCompile 响应:`, resp.result || { success: false });
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'clickCompileResponse',
        requestId,
        result: resp.result || { success: false }
      }, '*');
      return;
    }

    if (action === 'getStrategyName') {
      const resp = await callPageBridge('getStrategyName');
      console.log(`[ContentScript] [RES] getStrategyName 响应: name=${resp.result || 'null'}`);
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'getStrategyNameResponse',
        requestId,
        name: resp.result || null
      }, '*');
      return;
    }

    if (action === 'getAlgorithmId') {
      const resp = await callPageBridge('getAlgorithmId');
      console.log(`[ContentScript] [RES] getAlgorithmId 响应: id=${resp.result ? resp.result.slice(0,12) : 'null'}`);
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'getAlgorithmIdResponse',
        requestId,
        algorithmId: resp.result || null
      }, '*');
      return;
    }

    if (action === 'renameStrategyName') {
      const resp = await callPageBridge('renameStrategyName', { newName: event.data.newName });
      console.log(`[ContentScript] [RES] renameStrategyName 响应:`, resp.result || { success: false, error: 'unknown' });
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'renameStrategyNameResponse',
        requestId,
        result: resp.result || { success: false, error: 'unknown' }
      }, '*');
      return;
    }

    if (action === 'setBacktestParams') {
      const resp = await callPageBridge('setBacktestParams', {
        startDate: event.data.startDate,
        endDate: event.data.endDate,
        initialCash: event.data.initialCash,
        benchmark: event.data.benchmark
      });
      console.log(`[ContentScript] [RES] setBacktestParams 响应:`, resp.result || {});
      iframe.contentWindow.postMessage({
        from: 'JQUAN_HELPER_CONTENT',
        action: 'setBacktestParamsResponse',
        requestId,
        result: resp.result || {}
      }, '*');
      return;
    }
  }

  if (from === 'JQUAN_HELPER_POPUP' && event.source === window) {
    if (action === 'toggleSidebar') {
      toggleSidebar();
    }
    if (action === 'showSidebar') {
      showSidebar();
    }
    if (action === 'hideSidebar') {
      hideSidebar();
    }
  }
});

// ==========================================
// 初始化
// ==========================================

function initialize() {
  console.log('[ContentScript] [INIT] 初始化插件...');

  chrome.storage.local.get(['sidebarVisible'], (result) => {
    if (result.sidebarVisible !== false) {
      showSidebar();
    }
  });

  console.log('[ContentScript] [INIT] 插件初始化完成');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[ContentScript] 收到 chrome.runtime.onMessage:', request.action);

  if (request.action === 'toggleSidebar') {
    try {
      toggleSidebar();
      sendResponse({ visible: sidebarVisible, success: true });
    } catch (e) {
      console.error('[ContentScript] toggleSidebar 失败:', e);
      sendResponse({ error: e.message, success: false });
    }
    return true;
  }

  if (request.action === 'getEditorCode') {
    (async () => {
      try {
        const result = await getEditorCode();
        sendResponse({
          code: result?.code || null,
          lineCount: result?.lineCount || 0,
          success: result !== null
        });
      } catch (e) {
        console.error('[ContentScript] getEditorCode 失败:', e);
        sendResponse({ code: null, lineCount: 0, success: false, error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'setEditorCode') {
    (async () => {
      try {
        const success = await setEditorCode(request.code);
        sendResponse({ success });
      } catch (e) {
        console.error('[ContentScript] setEditorCode 失败:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
});

// 页面加载完成后初始化
function waitForAceEditor(callback, maxRetries = 120) {
  let retries = 0;
  console.log('[ContentScript] [INIT] 开始等待 ACE Editor 加载...');

  const checkInterval = setInterval(() => {
    retries++;

    // 检查页面桥接是否就绪
    if (pageEditor && pageEditor.ready) {
      clearInterval(checkInterval);
      console.log('[ContentScript] [INIT] ACE Editor 已就绪');
      callback();
      return;
    }

    if (retries >= maxRetries) {
      clearInterval(checkInterval);
      console.warn('[ContentScript] [TIMEOUT] 等待 ACE Editor 超时 (60秒)，继续初始化');
      callback();
    }
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    waitForAceEditor(initialize);
  });
} else {
  waitForAceEditor(initialize);
}

// 暴露接口给页面（用于调试）
window.jquanHelper = {
  getCode: () => getEditorCode(),
  setCode: setEditorCode,
  appendCode: appendEditorCode,
  toggleSidebar,
  showSidebar,
  hideSidebar
};

console.log('[ContentScript] [INIT] 初始化完成，可用接口:', Object.keys(window.jquanHelper));
