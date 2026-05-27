// 聚宽策略助手 - Popup 控制脚本
// 点击插件图标时切换侧边栏显示/隐藏

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      showMessage('无法获取当前页面');
      return;
    }

    // 检查是否在聚宽策略编辑页面
    if (!tab.url || !tab.url.includes('joinquant.com/algorithm/index/edit')) {
      showMessage('请在聚宽策略编辑页面使用此插件<br><small>https://www.joinquant.com/algorithm/index/edit</small>');
      return;
    }

    // 显示加载状态
    showLoading();

    // 尝试发送消息给 content script
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount <= maxRetries) {
      try {
        const response = await sendMessageToContentScript(tab.id, { action: 'toggleSidebar' });

        if (response && response.success) {
          // 成功，关闭 popup
          window.close();
          return;
        }

        // 如果失败，可能是 content script 还没准备好，尝试注入
        if (retryCount === 0) {
          console.log('[Popup] 尝试注入 content script...');
          await injectContentScript(tab.id);
          await sleep(1000); // 等待注入完成
        }

        retryCount++;
        if (retryCount <= maxRetries) {
          await sleep(500);
        }

      } catch (error) {
        console.error(`[Popup] 尝试 ${retryCount + 1} 失败:`, error);
        retryCount++;
        if (retryCount <= maxRetries) {
          await sleep(500);
        }
      }
    }

    // 所有尝试都失败了
    showError();

  } catch (error) {
    console.error('[Popup] 错误:', error);
    showMessage('发生错误: ' + error.message);
  }
});

// 发送消息给 content script
function sendMessageToContentScript(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Popup] sendMessage 错误:', chrome.runtime.lastError.message);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve({ success: true, response });
      }
    });
  });
}

// 注入 content script
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content_script.js']
    });
    console.log('[Popup] content script 注入成功');
  } catch (error) {
    console.error('[Popup] content script 注入失败:', error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showLoading() {
  document.body.innerHTML = `
    <div style="
      padding: 30px 20px;
      text-align: center;
      font-size: 14px;
      color: #666;
    ">
      <div style="
        width: 24px;
        height: 24px;
        border: 2px solid #e2e8f0;
        border-top-color: #667eea;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin: 0 auto 12px;
      "></div>
      <style>
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div>正在启动...</div>
    </div>
  `;
}

function showError() {
  document.body.innerHTML = `
    <div style="
      padding: 20px;
      text-align: center;
      font-size: 13px;
      color: #666;
    ">
      <div style="margin-bottom: 10px; font-size: 24px;">⚠️</div>
      <div style="margin-bottom: 12px; font-weight: 500;">插件连接失败</div>
      <div style="font-size: 12px; color: #999; line-height: 1.5;">
        请尝试以下步骤：<br>
        1. 刷新聚宽页面<br>
        2. 重新点击插件图标<br>
        3. 确保在策略编辑页面
      </div>
      <button onclick="window.close()" style="
        margin-top: 15px;
        padding: 6px 16px;
        background: #667eea;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      ">关闭</button>
    </div>
  `;
}

function showMessage(text) {
  document.body.innerHTML = `
    <div style="
      padding: 20px;
      text-align: center;
      font-size: 14px;
      color: #666;
    ">
      <div style="margin-bottom: 10px; font-size: 24px;">ℹ️</div>
      <div>${text}</div>
    </div>
  `;
}
