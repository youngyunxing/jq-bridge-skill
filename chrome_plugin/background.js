// 聚宽策略助手 - Background Service Worker
// 精简版：仅保留扩展生命周期管理和剪贴板操作

chrome.runtime.onInstalled.addListener(() => {
  console.log('[聚宽策略助手] 扩展已安装/更新');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'copyToClipboard') {
    (async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(request.text);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'clipboard API not available' });
        }
      } catch (error) {
        console.error('[Background] 复制失败:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
});
