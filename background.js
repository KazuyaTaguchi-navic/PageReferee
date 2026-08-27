// ツールバーアイコンがクリックされたら、今開いているタブに確認パネルを注入する。
// content_scripts の matches でドメインを固定しないための方式（通販する蔵のURLが
// 変わっても壊れない・他ページで誤動作しない）。

async function injectPanel(tab, opts) {
  if (!tab || !tab.id || !tab.url || !/^https?:/.test(tab.url)) {
    return;
  }

  try {
    if (opts && opts.auto) {
      // 自動起動で開く場合は、content.js側が最初から最小化表示にできるよう先に目印を立てる
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.__hinbanRefereeAutoLaunched = true;
        },
      });
    }
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/storage.js", "lib/rules.js", "lib/rulebook.js", "content/content.js"],
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
    js: ["content/auto-flag.js", "lib/storage.js", "lib/rules.js", "lib/rulebook.js", "content/content.js"],
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
      injectPanel(tab, { auto: true });
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

// ---------- チャットボット（Gemini API） ----------
// APIキーの発行元(Google AI Studio)を問わず、content.js側はプロンプトの組み立てだけを
// 行い、実際の外部通信はここ(background.js)でまとめて行う（content.js側はサイトの
// CSPやhost_permissionsの都合でfetchできない場合があるため）。
// gemini-flash-lite-latestはGoogleが管理する「常に最新のFlash-Liteモデルを指す」エイリアス。
// 通常のFlashは無料枠のRPM(1分あたりのリクエスト数)が5件と少なく、このツールの利用だけで
// すぐ上限に達してしまったため、無料枠のRPMが3倍（15件）あるFlash-Liteに変更した。
// v1beta/interactionsエンドポイントは応答が返らず固まる不具合があったため、Google AI
// Studio（実際に問題なく動作することを確認済み）と同じ、昔からある標準の
// generateContentエンドポイントに変更した。
const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function askGemini({ apiKey, systemInstruction, question }) {
  if (!apiKey) {
    throw new Error("Gemini APIキーが設定されていません。設定画面でAPIキーを入力してください。");
  }
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: question }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 無料枠のレート制限（429/RESOURCE_EXHAUSTED）は、他社スタッフ等が見ても分かるように
    // 生の英語エラーではなく日本語の案内にする。それ以外のエラーはそのままメッセージを出す。
    const errorStatus = data && data.error && data.error.status;
    if (res.status === 429 || errorStatus === "RESOURCE_EXHAUSTED") {
      throw new Error("Gemini APIの利用上限（無料枠）に達しました。しばらく時間をおいてから、もう一度お試しください。");
    }
    if (res.status === 503 || errorStatus === "UNAVAILABLE") {
      throw new Error("Gemini APIが現在混雑しています。しばらく時間をおいてから、もう一度お試しください。");
    }
    const message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  const candidate = data && data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const textPart = parts && parts.find((p) => p.text);
  if (!textPart || !textPart.text) {
    throw new Error("回答を取得できませんでした（想定外のレスポンス形式です）");
  }
  return textPart.text;
}

// captureVisibleTabはタブの見える範囲全体を撮影するため、実績記録用のスクショは
// パネル部分の座標（CSS px）とdevicePixelRatioを使って切り抜く。
async function cropToPanel(dataUrl, rect, devicePixelRatio) {
  if (!rect) return dataUrl;
  const scale = devicePixelRatio || 1;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = Math.max(0, Math.round(rect.left * scale));
  const sy = Math.max(0, Math.round(rect.top * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * scale));
  if (sw <= 0 || sh <= 0) {
    bitmap.close();
    return dataUrl;
  }
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = await blob.arrayBuffer();
  return `data:image/png;base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

  if (message.type === "askChatbot") {
    (async () => {
      try {
        const answer = await askGemini({
          apiKey: message.apiKey,
          systemInstruction: message.systemInstruction,
          question: message.question,
        });
        sendResponse({ ok: true, answer });
      } catch (err) {
        console.error("[ページレフェリー] チャットボットの応答取得に失敗しました", err);
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (message.type === "logCheckResult") {
    (async () => {
      try {
        if (!message.webhookUrl) {
          throw new Error("実績記録用のWebアプリURLが設定されていません");
        }
        if (!sender.tab || sender.tab.windowId === undefined) {
          throw new Error("スクリーンショットを撮影できませんでした（タブ情報を取得できません）");
        }
        let fullImageDataUrl;
        try {
          fullImageDataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
        } catch (err) {
          // captureVisibleTabは「activeTab」(🚩ボタン経由)か「すべてのサイト」への権限が
          // 必要で、自動起動用に許可した特定サイトの権限だけでは足りない（Chromeの仕様）。
          if (String((err && err.message) || err).includes("permission")) {
            throw new Error(
              "スクリーンショット撮影の権限がありません。設定画面⑧でWebアプリURLを保存し直し、「すべてのサイトへのアクセス」を許可してください。"
            );
          }
          throw err;
        }
        const imageDataUrl = await cropToPanel(fullImageDataUrl, message.panelRect, message.devicePixelRatio);
        const res = await fetch(message.webhookUrl, {
          method: "POST",
          // Apps ScriptのWebアプリはCORSのプリフライト(OPTIONS)に応答しないため、
          // text/plainで送ってプリフライトを発生させない（doPost側はcontent-typeに関わらず
          // e.postData.contentsからJSONをパースできる）。
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            companyCode: message.companyCode,
            timestamp: message.timestamp,
            redCount: message.redCount,
            yellowCount: message.yellowCount,
            image: imageDataUrl,
          }),
        });
        const text = await res.text().catch(() => "");
        let data = null;
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = null;
        }
        if (!res.ok || (data && data.ok === false)) {
          throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[ページレフェリー] 実績の記録に失敗しました", err);
        sendResponse({ ok: false, error: String((err && err.message) || err) });
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
