// ツールバーアイコンがクリックされたら、今開いているタブに確認パネルを注入する。
// content_scripts の matches でドメインを固定しないための方式（通販する蔵のURLが
// 変わっても壊れない・他ページで誤動作しない）。

async function injectPanel(tab) {
  if (!tab || !tab.id || !tab.url || !/^https?:/.test(tab.url)) {
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/storage.js", "lib/rules.js", "content/content.js"],
    });
  } catch (err) {
    console.error("[ページレフェリー] パネルの注入に失敗しました", err);
  }
}

chrome.action.onClicked.addListener((tab) => {
  injectPanel(tab);
});

// 設定画面（options）から、実際にパネルが開いているページ上で項目マッピングの
// 照準モードを遠隔操作するためのタブ一覧管理。
const panelTabs = new Map(); // tabId -> { title, url }

chrome.tabs.onRemoved.addListener((tabId) => {
  panelTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;

  if (message.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    return undefined;
  }

  if (message.type === "panelReady" && sender.tab) {
    panelTabs.set(sender.tab.id, { title: sender.tab.title || sender.tab.url, url: sender.tab.url });
    return undefined;
  }

  if (message.type === "panelClosed" && sender.tab) {
    panelTabs.delete(sender.tab.id);
    return undefined;
  }

  if (message.type === "listPanelTabs") {
    const list = Array.from(panelTabs.entries()).map(([tabId, info]) => ({ tabId, ...info }));
    sendResponse(list);
    return true;
  }

  if (message.type === "enterPickerMode") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.tabs.update(message.tabId, { active: true });
        if (tab && tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        await chrome.tabs.sendMessage(message.tabId, { type: "enterPickerMode", key: message.key });
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[ページレフェリー] 照準モードの開始に失敗しました", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
