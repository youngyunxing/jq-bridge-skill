// 聚宽策略助手 - 页面桥接脚本
// 此脚本在页面上下文中运行，可以访问页面的 window.ace

(function() {
  'use strict';

  console.log('[PageBridge] [INIT] 已加载');

  let editorInstance = null;

  // ==========================================
  // 编辑器操作
  // ==========================================

  const getLineCount = (editor) => {
    try {
      if (editor.session && typeof editor.session.getLength === 'function') {
        return editor.session.getLength();
      }
      if (editor.getSession && typeof editor.getSession === 'function') {
        const session = editor.getSession();
        if (session && typeof session.getLength === 'function') {
          return session.getLength();
        }
      }
    } catch (e) {}
    return 0;
  };

  function findEditor() {
    if (editorInstance) return editorInstance;

    if (window.ace && window.ace.edit) {
      try {
        const editor = window.ace.edit("ide-container");
        if (editor && typeof editor.getValue === 'function') {
          editorInstance = editor;
          console.log('[PageBridge] [EDITOR] 通过 window.ace.edit 找到编辑器');
          return editor;
        }
      } catch (e) {
        console.warn('[PageBridge] [EDITOR] window.ace.edit("ide-container") 失败:', e.message);
      }
    }

    const ideContainer = document.getElementById('ide-container');
    if (ideContainer && ideContainer.env && ideContainer.env.editor) {
      editorInstance = ideContainer.env.editor;
      console.log('[PageBridge] [EDITOR] 通过 ide-container.env 找到编辑器');
      return editorInstance;
    }

    const aceEditors = document.querySelectorAll('.ace_editor');
    for (const el of aceEditors) {
      if (el.env && el.env.editor && typeof el.env.editor.getValue === 'function') {
        editorInstance = el.env.editor;
        console.log('[PageBridge] [EDITOR] 通过 .ace_editor 找到编辑器');
        return editorInstance;
      }
    }

    console.warn('[PageBridge] [EDITOR] [ERR] 未找到 ACE Editor');
    return null;
  }

  function waitForEditor(callback, maxRetries = 60) {
    let retries = 0;
    const checkInterval = setInterval(() => {
      const editor = findEditor();
      if (editor) {
        clearInterval(checkInterval);
        callback(editor);
        return;
      }
      retries++;
      if (retries >= maxRetries) {
        clearInterval(checkInterval);
        console.log('[PageBridge] [TIMEOUT] 等待编辑器超时');
      }
    }, 500);
  }

  // ==========================================
  // 回测控制
  // ==========================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 关闭提示弹窗
   */
  function closeModal() {
    const btns = [...document.querySelectorAll('button')];
    for (const btn of btns) {
      const text = btn.innerText?.trim();
      if (text === '确定' || text === '确认' || text === 'OK') {
        btn.click();
        return true;
      }
    }
    return false;
  }

  /**
   * 触发编译运行
   */
  function clickCompile() {
    closeModal();
    console.log('[PageBridge] [COMPILE] 开始查找编译运行按钮...');

    const allEls = document.querySelectorAll('button, a, span, div');
    for (const el of allEls) {
      const text = el.innerText?.trim();
      if (text === '编译运行') {
        console.log('[PageBridge] [COMPILE] 点击"编译运行"按钮');
        el.click();
        return { success: true, triggered: 'compile' };
      }
    }
    for (const el of allEls) {
      const text = el.innerText?.trim();
      if (text === '运行回测') {
        console.log('[PageBridge] [COMPILE] 点击"运行回测"按钮');
        el.click();
        return { success: true, triggered: 'backtest' };
      }
    }
    console.warn('[PageBridge] [COMPILE] [ERR] 未找到编译运行或运行回测按钮');
    return { success: false, error: '未找到编译运行或运行回测按钮' };
  }

  /**
   * 修改回测参数
   */
  function setBacktestParams({ startDate, endDate, initialCash, benchmark }) {
    const results = {};

    const setInput = (selectors, value) => {
      if (!value) return false;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      return false;
    };

    results.startDate = setInput([
      'input[placeholder*="开始"]',
      'input[name*="start"]',
      'input.start-date',
      '[placeholder*="开始日期"]'
    ], startDate);

    results.endDate = setInput([
      'input[placeholder*="结束"]',
      'input[name*="end"]',
      'input.end-date',
      '[placeholder*="结束日期"]'
    ], endDate);

    results.initialCash = setInput([
      'input[placeholder*="资金"]',
      'input[name*="cash"]',
      'input[name*="capital"]',
      '[placeholder*="初始"]'
    ], initialCash);

    results.benchmark = setInput([
      'input[placeholder*="基准"]',
      'input[name*="benchmark"]',
      '[placeholder*="沪深300"]'
    ], benchmark);

    return results;
  }

  /**
   * 获取当前策略名称
   */
  function getStrategyName() {
    // 优先读取页面 h2 标题（聚宽编辑器明确显示的策略名）
    const h2 = document.querySelector('h2');
    if (h2) {
      const text = h2.textContent.trim();
      if (text) return text;
    }

    // fallback: document.title
    const title = document.title;
    if (title) return title.trim();

    return null;
  }

  /**
   * 获取当前页面的 algorithmId
   */
  function getAlgorithmId() {
    const url = new URL(window.location.href);
    return url.searchParams.get('algorithmId') || null;
  }

  /**
   * 重命名策略（模拟点击页面上的重命名按钮）
   * 返回 Promise，等待 MutationObserver 检测到输入框并完成操作
   */
  function renameStrategyName(newName) {
    return new Promise((resolve) => {
      if (!newName) {
        console.warn('[PageBridge] [RENAME] [ERR] 名称不能为空');
        resolve({ success: false, error: '名称不能为空' });
        return;
      }
      console.log(`[PageBridge] [RENAME] 尝试重命名为: '${newName}'`);

      const h2 = document.querySelector('h2');
      if (!h2) {
        console.warn('[PageBridge] [RENAME] 未找到 h2 元素');
        resolve({ success: false, error: '未找到策略名元素' });
        return;
      }

      const parent = h2.parentElement;
      if (!parent) {
        console.warn('[PageBridge] [RENAME] h2 无父元素');
        resolve({ success: false, error: '未找到编辑按钮' });
        return;
      }

      // 查找 h2 附近的编辑按钮
      const editBtn = parent.querySelector('i.el-icon-edit, i.icon-edit, button.edit-btn, .edit-icon, [title*="编辑"], [title*="重命名"], .rename-icon, .name-edit');
      if (!editBtn) {
        console.warn('[PageBridge] [RENAME] h2 父元素内未找到编辑按钮，降级为 DOM 修改');
        h2.textContent = newName;
        resolve({ success: true, method: 'dom-update', warning: '仅修改了前端展示，刷新后恢复' });
        return;
      }

      console.log('[PageBridge] [RENAME] 找到编辑按钮，点击...');
      editBtn.click();

      // 使用 MutationObserver 等待输入框出现
      const observer = new MutationObserver((mutations, obs) => {
        const input = document.querySelector('input.strategy-name-input, .el-input__inner, input[type="text"], .rename-input');
        if (input) {
          obs.disconnect();
          console.log('[PageBridge] [RENAME] 找到输入框，设置值...');

          // 方式1: 直接设置 value + InputEvent
          input.value = newName;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: newName }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          // 方式2: 尝试通过 Vue 组件设置（Element UI / Vue 2）
          const vueComp = input.__vue__ || (input._vnode && input._vnode.componentInstance);
          if (vueComp) {
            console.log('[PageBridge] [RENAME] 通过 Vue 组件设置值');
            vueComp.$emit('input', newName);
            if (vueComp.model && vueComp.model.callback) {
              vueComp.model.callback(newName);
            }
          }

          // 方式3: 使用 property descriptor 绕过 Vue 的 setter
          try {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (descriptor && descriptor.set) {
              descriptor.set.call(input, newName);
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch (e) {
            console.warn('[PageBridge] [RENAME] property descriptor 失败:', e);
          }

          // 等待确认按钮出现并点击
          setTimeout(() => {
            const confirmBtn = document.querySelector('button.el-button--primary, button.confirm, .save-btn, [class*="confirm"], .el-dialog__footer button');
            if (confirmBtn) {
              console.log('[PageBridge] [RENAME] 点击确认按钮');
              confirmBtn.click();
            } else {
              console.log('[PageBridge] [RENAME] 未找到确认按钮，尝试回车');
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
            }

            // 等待并检查结果
            setTimeout(() => {
              const currentName = document.querySelector('h2')?.textContent?.trim();
              if (currentName === newName) {
                console.log('[PageBridge] [RENAME] 重命名成功');
                resolve({ success: true, method: 'edit-button', name: currentName });
              } else {
                console.warn(`[PageBridge] [RENAME] 重命名可能未保存，当前名称: '${currentName}'`);
                resolve({ success: true, method: 'edit-button', warning: '操作已触发，但请确认页面是否已保存' });
              }
            }, 500);
          }, 200);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // 超时处理
      setTimeout(() => {
        observer.disconnect();
        const input = document.querySelector('input.strategy-name-input, .el-input__inner, input[type="text"]');
        if (!input) {
          console.warn('[PageBridge] [RENAME] 超时：未找到输入框');
          resolve({ success: false, error: '超时：未找到输入框' });
        }
      }, 3000);
    });
  }

  /**
   * 获取回测状态
   */
  function getBacktestStatus() {
    const bodyText = document.body.innerText || '';

    // 检查运行中标识
    if (/运行中|回测中|正在编译|计算中|Loading/.test(bodyText)) {
      return 'running';
    }

    // 检查结果面板是否有数字（从 -- 变成有值）
    const panel = document.querySelector('#dailybars-results, .backtest-result-panel, .result-panel');
    if (panel) {
      const text = panel.innerText || '';
      if (/策略收益|总收益|年化收益/.test(text) && /[\d\.]+%?/.test(text)) {
        // 进一步确认不是全 --
        if (!/^\s*[-\s]*\s*$/.test(text.replace(/[^\d\.\-]/g, ''))) {
          return 'completed';
        }
      }
    }

    // 检查日志区域有实质内容
    const logsTab = document.querySelector('#daily-logs-tab, .log-container');
    if (logsTab && logsTab.innerText.length > 500) {
      const hasTimestamp = /\d{4}-\d{2}-\d{2}/.test(logsTab.innerText);
      if (hasTimestamp) return 'completed';
    }

    return 'idle';
  }

  /**
   * 获取回测结果摘要
   */
  function getBacktestResults() {
    const result = {};
    const panel = document.querySelector('#dailybars-results, .backtest-result-panel, .result-panel');
    if (!panel) return result;

    const text = panel.innerText || '';
    const m = (regex) => {
      const r = text.match(regex);
      return r ? r[1] : null;
    };

    result.totalProfit = m(/策略收益\s*([-\d\.]+%?)/);
    result.benchmarkReturn = m(/基准收益\s*([-\d\.]+%?)/);
    result.alpha = m(/Alpha\s*([-\d\.]+)/i);
    result.beta = m(/Beta\s*([-\d\.]+)/i);
    result.sharpe = m(/Sharpe\s*([-\d\.]+)/i);
    result.maxDrawdown = m(/最大回撤\s*([-\d\.]+%?)/);
    result.annualReturn = m(/年化收益\s*([-\d\.]+%?)/);
    result.volatility = m(/收益波动率\s*([-\d\.]+%?)/);
    result._rawText = text;

    return result;
  }

  /**
   * 获取回测错误信息（编译/运行时错误）
   * 不再严格区分正常/错误，尽量拉取所有内容
   */
  function getBacktestErrors() {
    const errors = [];

    // 方法1: 查找错误提示元素（增加更多选择器）
    const errorSelectors = [
      '.error', '.compile-error', '.el-message--error', '.el-message--warning',
      '.backtest-error', '.result-error', '.log-error', '.runtime-error',
      '.ant-message-error', '.ant-notification-notice', '.toast-error',
      '[class*="error"]', '[class*="Error"]'
    ];
    for (const sel of errorSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = (el.innerText || '').trim();
        if (text && text.length > 2 && text.length < 5000) {
          errors.push(text);
        }
      }
    }

    // 方法2: 从结果面板文本中匹配 Traceback / Error / 异常
    const panelSelectors = [
      '#dailybars-results', '.backtest-result-panel', '.result-panel',
      '#output-pane', '.output-pane', '[class*="result"]'
    ];
    for (const sel of panelSelectors) {
      const panel = document.querySelector(sel);
      if (panel) {
        const text = panel.innerText || '';
        // 匹配 Traceback
        if (/Traceback|AttributeError|SyntaxError|TypeError|NameError|ImportError|RuntimeError|KeyError|IndexError|ValueError|ModuleNotFoundError|Exception/.test(text)) {
          const match = text.match(/(Traceback[\s\S]*?)(?=\n\n\n|$)/);
          if (match) errors.push(match[0].trim());
        }
        // 匹配中文报错
        if (/报错|错误|失败|异常|无法|不能/.test(text) && text.length > 20 && text.length < 3000) {
          errors.push(text.trim());
        }
        break; // 只取第一个匹配的面板
      }
    }

    // 方法3: 从日志区域提取 Python 错误和中文报错
    const logSelectors = [
      '#daily-logs-tab', '.log-container', '.log-area', '.console-output',
      '#daily-logs-container', '[class*="log"]', '[class*="console"]'
    ];
    for (const sel of logSelectors) {
      const logsTab = document.querySelector(sel);
      if (logsTab) {
        const text = logsTab.innerText || '';
        // 匹配 Traceback
        const errorMatches = text.match(/Traceback \(most recent call last\):[\s\S]*?(?=\n\n\n|\n\d{4}-\d{2}-\d{2}|$)/g);
        if (errorMatches) {
          errors.push(...errorMatches);
        }
        // 匹配普通 Error 行
        const lineMatches = text.match(/.*?(Error|Exception|SyntaxError|TypeError|NameError|AttributeError|ImportError|RuntimeError|KeyError|IndexError|ValueError|ModuleNotFoundError):.*/g);
        if (lineMatches) {
          errors.push(...lineMatches);
        }
        break; // 只取第一个匹配的日志容器
      }
    }

    // 去重
    const uniqueErrors = [...new Set(errors)];

    return {
      hasError: uniqueErrors.length > 0,
      errors: uniqueErrors,
      count: uniqueErrors.length
    };
  }

  // ==========================================
  // 监听来自 content script 的消息
  // ==========================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.from !== 'JQUAN_CONTENT_SCRIPT') return;

    const { action, requestId } = event.data;

    if (action === 'getEditorCode') {
      const editor = findEditor();
      if (editor) {
        const code = editor.getValue();
        const lineCount = getLineCount(editor);
        console.log(`[PageBridge] [CMD] getEditorCode: ${lineCount} 行`);
        window.postMessage({
          from: 'JQUAN_PAGE_BRIDGE',
          action: 'editorCodeResponse',
          requestId: requestId,
          result: { code, lineCount }
        }, '*');
      } else {
        console.warn('[PageBridge] [CMD] getEditorCode: 编辑器未就绪');
        window.postMessage({
          from: 'JQUAN_PAGE_BRIDGE',
          action: 'editorCodeResponse',
          requestId: requestId,
          result: null
        }, '*');
      }
    }

    if (action === 'setEditorCode') {
      const editor = findEditor();
      if (editor && typeof editor.setValue === 'function') {
        editor.setValue(event.data.code, -1);
        if (typeof editor.clearSelection === 'function') {
          editor.clearSelection();
        }
        console.log(`[PageBridge] [CMD] setEditorCode: ${event.data.code.length} 字符写入成功`);
        window.postMessage({
          from: 'JQUAN_PAGE_BRIDGE',
          action: 'setEditorCodeResponse',
          requestId: requestId,
          success: true
        }, '*');
      } else {
        console.warn('[PageBridge] [CMD] setEditorCode: 编辑器未就绪');
        window.postMessage({
          from: 'JQUAN_PAGE_BRIDGE',
          action: 'setEditorCodeResponse',
          requestId: requestId,
          success: false
        }, '*');
      }
    }

    // 通用 jquanAuto 方法调用
    const autoActions = ['getBacktestStatus', 'getBacktestResults', 'getBacktestErrors', 'clickCompile', 'getStrategyName', 'getAlgorithmId'];
    if (autoActions.includes(action)) {
      const result = window.jquanAuto[action]();
      console.log(`[PageBridge] [CMD] ${action}:`, typeof result === 'object' ? JSON.stringify(result).slice(0,120) : result);
      window.postMessage({
        from: 'JQUAN_PAGE_BRIDGE',
        action: action + 'Response',
        requestId: requestId,
        result: result
      }, '*');
    }

    if (action === 'renameStrategyName') {
      window.jquanAuto.renameStrategyName(event.data.newName).then(result => {
        console.log(`[PageBridge] [CMD] renameStrategyName 结果:`, result);
        window.postMessage({
          from: 'JQUAN_PAGE_BRIDGE',
          action: 'renameStrategyNameResponse',
          requestId: requestId,
          result: result
        }, '*');
      }).catch(err => {
        console.error(`[PageBridge] [CMD] renameStrategyName 异常:`, err);
        window.postMessage({
          from: 'JQUAN_PAGE_BRIDGE',
          action: 'renameStrategyNameResponse',
          requestId: requestId,
          result: { success: false, error: err.message || String(err) }
        }, '*');
      });
      return;
    }

    if (action === 'setBacktestParams') {
      const params = {
        startDate: event.data.startDate,
        endDate: event.data.endDate,
        initialCash: event.data.initialCash,
        benchmark: event.data.benchmark
      };
      const result = window.jquanAuto.setBacktestParams(params);
      console.log(`[PageBridge] [CMD] setBacktestParams:`, result);
      window.postMessage({
        from: 'JQUAN_PAGE_BRIDGE',
        action: 'setBacktestParamsResponse',
        requestId: requestId,
        result: result
      }, '*');
    }

  });

  // ==========================================
  // 暴露全局接口给外部调用（CDP / 插件）
  // ==========================================
  window.jquanAuto = {
    // 编辑器操作
    getEditorCode: () => {
      const editor = findEditor();
      return editor ? { code: editor.getValue(), lineCount: getLineCount(editor) } : null;
    },
    setEditorCode: (code) => {
      const editor = findEditor();
      if (editor && typeof editor.setValue === 'function') {
        editor.setValue(code, -1);
        if (typeof editor.clearSelection === 'function') editor.clearSelection();
        return true;
      }
      return false;
    },

    // 回测控制
    clickCompile,
    setBacktestParams,
    getBacktestStatus,
    getBacktestResults,
    getBacktestErrors,
    getStrategyName,
    getAlgorithmId,
    renameStrategyName,

    // 工具
    sleep,
  };

  // 通知 content script 编辑器就绪
  waitForEditor((editor) => {
    window.postMessage({
      from: 'JQUAN_PAGE_BRIDGE',
      action: 'editorReady'
    }, '*');
  });

  console.log('[PageBridge] [INIT] 初始化完成，CDP 接口已暴露: window.jquanAuto');
})();
