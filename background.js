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

// ---------- 自動起動（指定したURLで開いたら🚩ボタン無しで自動的にパネルを表示） ----------
// アカウントごとに管理画面のURLが違うため、設定画面でユーザーが指定したURLパターンだけに
// 動的content scriptを登録する（manifestでmatchesを固定しないため、他ユーザーには
// 一切影響しない）。

const AUTO_LAUNCH_SCRIPT_ID = "hinban-referee-auto-launch";
const STORAGE_KEY = "hinbanReferee";

async function registerAutoLaunch(pattern) {
  const scriptDef = {
    id: AUTO_LAUNCH_SCRIPT_ID,
    matches: [pattern],
    css: ["content/content.css"],
    js: ["lib/storage.js", "lib/rules.js", "content/content.js"],
    runAt: "document_idle",
  };
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_LAUNCH_SCRIPT_ID] });
  if (existing.length) {
    await chrome.scripting.updateContentScripts([scriptDef]);
  } else {
    await chrome.scripting.registerContentScripts([scriptDef]);
  }

  // 登録は以後の新しいページ読み込みにしか効かないため、既に開いている該当タブには
  // その場でパネルを注入して即座に反映させる。
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      injectPanel(tab);
    }
  } catch (err) {
    console.error("[ページレフェリー] 既存タブへの自動起動反映に失敗しました", err);
  }
}

async function unregisterAutoLaunch() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_LAUNCH_SCRIPT_ID] });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [AUTO_LAUNCH_SCRIPT_ID] });
    }
  } catch (err) {
    console.error("[ページレフェリー] 自動起動の解除に失敗しました", err);
  }
}

// 拡張機能の更新・ブラウザ再起動時に、保存済みの設定から自動起動の登録を復元する
// （動的content scriptの登録はブラウザ再起動をまたいで保持されるはずだが、念のための保険）
async function syncAutoLaunchFromStorage() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const pattern = result[STORAGE_KEY] && result[STORAGE_KEY].autoLaunchUrlPattern;
    if (pattern) {
      await registerAutoLaunch(pattern);
    }
  } catch (err) {
    console.error("[ページレフェリー] 自動起動設定の復元に失敗しました", err);
  }
}

chrome.runtime.onStartup.addListener(syncAutoLaunchFromStorage);
chrome.runtime.onInstalled.addListener(syncAutoLaunchFromStorage);

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

  if (message.type === "registerAutoLaunch") {
    (async () => {
      try {
        await registerAutoLaunch(message.pattern);
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[ページレフェリー] 自動起動の登録に失敗しました", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "unregisterAutoLaunch") {
    (async () => {
      try {
        await unregisterAutoLaunch();
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[ページレフェリー] 自動起動の解除に失敗しました", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
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
