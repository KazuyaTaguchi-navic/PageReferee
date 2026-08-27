// ページレフェリー本体（通販する蔵の商品編集ページに注入される）
(function () {
  "use strict";

  // ツールバーボタン再クリック・再注入時の多重初期化防止。
  // 既存パネルがあってもそのまま使い回さない。拡張機能を chrome://extensions で
  // 再読み込みした後は、古いパネルのボタンは無効なコンテキストに紐づいたままになり
  // （Extension context invalidated エラーの原因）押しても動かなくなるため、
  // 一度取り除いてから新しく作り直す。
  const existing = document.getElementById("hinban-referee-panel");
  if (existing) {
    existing.remove();
  }
  const existingOverlay = document.querySelector(".hr-highlight-overlay");
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const storage = window.HinbanReferee && window.HinbanReferee.storage;
  const rules = window.HinbanReferee && window.HinbanReferee.rules;
  const rulebook = window.HinbanReferee && window.HinbanReferee.rulebook;
  if (!storage || !rules || !rulebook) {
    console.error("[ページレフェリー] 内部ライブラリの読み込みに失敗しました");
    return;
  }

  // 拡張機能が更新/再読み込みされた後、このページ上に残っている古いスクリプトの
  // chrome.runtime は無効になる。そのまま呼ぶと「Extension context invalidated」が
  // 発生するので、送信前に必ずこれで確認する。
  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function safeSendMessage(message, onFail) {
    if (!isExtensionContextValid()) {
      if (onFail) onFail();
      return;
    }
    try {
      // MV3のsendMessageはコールバック省略時にPromiseを返す。コンテキスト無効化の
      // エラーが同期的ではなくこのPromiseのreject経由で来ることがあり、それを
      // 拾わないと「Uncaught (in promise) Extension context invalidated」として
      // 未処理のまま表に出てしまうため、必ず.catch()しておく。
      const maybePromise = chrome.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {
          if (onFail) onFail();
        });
      }
    } catch (e) {
      if (onFail) onFail();
    }
  }

  let currentFieldMap = storage.DEFAULT_FIELD_MAP;
  let currentSkuElements = [];
  let pickerActive = false;
  let pickerTargetKey = null;
  let pickerHoverEl = null;

  // ---------- 登録ボタンのロック（設定でONの会社のみ）----------
  // 「確認する」を一度も実行していない／管理表に該当行が無い／レッドかイエローが残っている／
  // 確認後に内容が変更された、のいずれかに該当する間は登録ボタンを押せないようにするための状態。
  const registerGuard = {
    enabled: false,
    checking: false,
    hasChecked: false,
    hasManagementMatch: null,
    redCount: null,
    yellowCount: null,
    signature: null,
  };
  storage
    .getAll()
    .then((s) => {
      registerGuard.enabled = !!s.registerLockEnabled;
    })
    .catch(() => {});

  // 登録ボタンロックの変更検知用に、パネル自身の入力欄(#hinban-referee-panel配下)を除いた
  // ページ側の全入力値を連結する。厳密なハッシュである必要はなく、値が変わったかどうかだけ分かればよい。
  function computeFormSignature() {
    const panelEl = document.getElementById("hinban-referee-panel");
    return Array.from(document.querySelectorAll("input, select, textarea"))
      .filter((el) => !panelEl || !panelEl.contains(el))
      .map((el) => (el.type === "checkbox" || el.type === "radio" ? (el.checked ? "1" : "0") : el.value || ""))
      .join("");
  }

  // ---------- DOM値の取得 ----------

  function extractSingleValue(entry) {
    if (!entry || !entry.selector) return "";
    let el;
    try {
      el = document.querySelector(entry.selector);
    } catch (e) {
      return "";
    }
    if (!el) return "";
    if (entry.attr === "textContent") return (el.textContent || "").trim();
    if (entry.attr === "checked") return el.checked ? "true" : "false";
    if ("value" in el) return el.value || "";
    return el.getAttribute(entry.attr || "value") || "";
  }

  function valueOf(root, selector) {
    const el = root.querySelector(selector);
    return el && el.value ? el.value : "";
  }

  function extractSkuRows() {
    const rows = Array.from(document.querySelectorAll('tr[id^="sku_row_"]'));
    return rows.map((row) => ({
      el: row,
      dispNo: valueOf(row, '[name="disp_no[]"]'),
      skuCode: valueOf(row, '[name="sku_code[]"]'),
      janCode: valueOf(row, '[name="pd_jancode[]"]'),
      shelfNumber: valueOf(row, '[name="shelf_number[]"]'),
      asin: valueOf(row, '[name="a__asin_code[]"]'),
      makerSize: valueOf(row, '[name="pd_size_code[]"]'),
      maxPoint: valueOf(row, '[name="max_point[]"]'),
      orderPoint: valueOf(row, '[name="order_point[]"]'),
    }));
  }

  function collectDomValues(fieldMap) {
    const values = {};
    Object.keys(fieldMap).forEach((key) => {
      values[key] = extractSingleValue(fieldMap[key]);
    });
    const skuRows = extractSkuRows();
    currentSkuElements = skuRows.map((r) => r.el);
    values.__skuRows = skuRows.map(({ el, ...rest }) => rest);
    return values;
  }

  // ---------- ハイライト・スクロール ----------

  let overlayEl = null;
  function ensureOverlay() {
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.className = "hr-highlight-overlay";
      document.body.appendChild(overlayEl);
    }
    return overlayEl;
  }

  let highlightInterval = null;
  let highlightTimeouts = [];

  function stopHighlightTimers() {
    if (highlightInterval) {
      clearInterval(highlightInterval);
      highlightInterval = null;
    }
    highlightTimeouts.forEach((t) => clearTimeout(t));
    highlightTimeouts = [];
  }

  // 通販する蔵は項目グループのタグ（見出し）をクリックすると入力エリアが折りたたまれる
  // ものがある。対象要素の祖先をたどり、非表示になっている（display:noneの）箇所があれば、
  // 同じtable内の見出し（thead th）をクリックして開く。見出しが見つからなければ直接表示に戻す。
  function ensureVisible(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const cs = window.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") {
        const table = node.closest ? node.closest("table") : null;
        const header = table ? table.querySelector("thead th") : null;
        if (header) {
          header.click();
        } else {
          node.style.display = "";
          node.style.visibility = "";
        }
      }
      node = node.parentElement;
    }
  }

  function highlightElement(el, severity) {
    if (!el) return;
    // 前のハイライト（別の項目）がまだ動いていたら止めてから新しく始める。
    // これをしないと2つのアニメーションが同じオーバーレイを取り合ってちらつく。
    stopHighlightTimers();
    ensureVisible(el);

    const overlay = ensureOverlay();
    overlay.className = "hr-highlight-overlay hr-severity-" + severity + " hr-visible";

    // 折りたたみが開くアニメーション中も位置がずれないよう、スクロール込みで
    // 一定時間くり返し再計算する。
    const update = () => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();
      overlay.style.top = rect.top - 4 + "px";
      overlay.style.left = rect.left - 4 + "px";
      overlay.style.width = rect.width + 8 + "px";
      overlay.style.height = rect.height + 8 + "px";
    };

    update();
    highlightInterval = setInterval(update, 150);
    highlightTimeouts.push(
      setTimeout(() => {
        stopHighlightTimers();
        overlay.classList.remove("hr-visible");
      }, 2800)
    );
  }

  // findingは{ key, targetKey, ... }。targetKeyは重大度設定で使うキーと同じもので、
  // ほとんどの場合そのままfieldMapを引けば該当要素が見つかる（copy_residue_商品名の
  // ような合成キーはtargetKey側に元の項目名"商品名"が入っている）。
  // SKU情報だけは行ごとに要素が分かれる特殊構造のため、番号から行要素を特定する。
  function resolveTargetElement(finding, fieldMap) {
    const tryKey = (key) => {
      const entry = fieldMap[key];
      if (!entry || !entry.selector) return null;
      try {
        return document.querySelector(entry.selector);
      } catch (e) {
        return null;
      }
    };

    const targetKey = finding.targetKey || finding.key;
    if (fieldMap[targetKey]) return tryKey(targetKey);

    const findingKey = finding.key;

    if (findingKey === "シリーズ整合性") {
      return tryKey("商品名");
    }

    if (findingKey === "sku_empty") {
      return document.querySelector(".sku_tbl") || null;
    }

    const categoryTypeMatch = findingKey.match(/^category_type_mismatch_(.+)$/);
    if (categoryTypeMatch) {
      return tryKey(categoryTypeMatch[1]);
    }

    const skuMatch = findingKey.match(/^sku_.*_(\d+)$/);
    if (skuMatch) {
      const idx = Number(skuMatch[1]);
      return currentSkuElements[idx] || null;
    }

    return null;
  }

  // ---------- パネルUI ----------

  const panel = document.createElement("div");
  panel.id = "hinban-referee-panel";
  panel.innerHTML = `
    <div class="hr-header" id="hr-drag-handle">
      <span class="hr-title">
        🚩 ページレフェリー
        <button type="button" id="hr-btn-minimize" class="hr-btn-minimize" title="最小化">▸</button>
      </span>
      <span class="hr-header-btns">
        <button type="button" id="hr-btn-close" title="閉じる">✕</button>
      </span>
    </div>
    <div class="hr-body">
      <div class="hr-datastatus" id="hr-datastatus">データ未読み込み</div>
      <div class="hr-picker-banner" id="hr-picker-banner" style="display:none;"></div>
      <div class="hr-actions">
        <button type="button" id="hr-btn-check" class="hr-btn-check">🔍 確認する</button>
        <button type="button" id="hr-btn-options" class="hr-btn-secondary">⚙ 設定を開く</button>
      </div>
      <div class="hr-progress" id="hr-progress" style="display:none;">
        <div class="hr-progress-track"><div class="hr-progress-bar" id="hr-progress-bar"></div></div>
        <div class="hr-progress-label" id="hr-progress-label"></div>
      </div>
      <div class="hr-summary" id="hr-summary" style="display:none;">
        <button type="button" class="hr-card hr-card-red" id="hr-card-red">
          <span class="hr-card-label">🟥 レッドカード</span>
          <span class="hr-card-count"><span>0</span>件</span>
        </button>
        <button type="button" class="hr-card hr-card-yellow" id="hr-card-yellow">
          <span class="hr-card-label">🟨 イエローカード</span>
          <span class="hr-card-count"><span>0</span>件</span>
        </button>
      </div>
      <ul class="hr-findings" id="hr-findings"></ul>
      <div class="hr-suggestions" id="hr-suggestions" style="display:none;">
        <div class="hr-tag-status" id="hr-tag-status" style="display:none;"></div>
        <div class="hr-suggestions-title">🔎 車種別タグ候補（要確認・キーワード一致による推定です）</div>
        <ul class="hr-suggestion-list" id="hr-suggestion-list"></ul>
      </div>
      <div class="hr-chat" id="hr-chat">
        <div class="hr-suggestions-title hr-chat-header" id="hr-chat-header">
          <span class="hr-title">
            💬 質問する
            <button type="button" id="hr-chat-toggle" class="hr-btn-minimize" title="折りたたむ">▸</button>
          </span>
          <span class="hr-header-btns">
            <button type="button" id="hr-chat-copy" class="hr-btn-minimize" title="やりとりをコピー">📋</button>
          </span>
        </div>
        <div class="hr-chat-body" id="hr-chat-body">
          <ul class="hr-chat-log" id="hr-chat-log"></ul>
          <div class="hr-chat-input-row">
            <textarea id="hr-chat-input" rows="2" placeholder="例: 国産車の車種名にメーカー名は必要ですか？"></textarea>
            <button type="button" id="hr-chat-send" class="hr-btn-secondary">送信</button>
          </div>
        </div>
      </div>
    </div>
  `;
  (document.body || document.documentElement).appendChild(panel);
  safeSendMessage({ type: "panelReady" });

  // ドラッグ移動
  // mousemove/mouseupをwindowに常時貼り付けたままにすると、拡張機能を再読み込み
  // したときや🚩ボタンを何度も押したときにパネルを作り直すたびリスナーが積み重なって
  // いってしまう（前のパネルはremove()されてもwindowのリスナーは残るため）。
  // ドラッグ中だけ付け、mouseupで必ず外す方式にする。
  function setCollapsed(collapsed) {
    panel.classList.toggle("hr-collapsed", collapsed);
    const btn = panel.querySelector("#hr-btn-minimize");
    // 開いている間は「▸（押すと最小化）」、最小化中は「▾（押すと展開）」で見分けられるようにする
    btn.textContent = collapsed ? "▾" : "▸";
    btn.title = collapsed ? "展開" : "最小化";
  }

  // ヘッダーのドラッグ開始〜終了の間に実際にマウスが動いたかどうか。
  // ヘッダーのどこを押しても最小化/展開できるようにする際、ドラッグ操作の終わりに
  // 誤って最小化/展開が発火しないようにするために使う。
  let headerDragMoved = false;

  (function enableDrag() {
    const handle = panel.querySelector("#hr-drag-handle");
    let offsetX = 0;
    let offsetY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    const DRAG_THRESHOLD_PX = 4;

    function onMouseMove(e) {
      if (!headerDragMoved && (Math.abs(e.clientX - dragStartX) > DRAG_THRESHOLD_PX || Math.abs(e.clientY - dragStartY) > DRAG_THRESHOLD_PX)) {
        headerDragMoved = true;
      }
      // ブラウザの表示領域外にドラッグして見失わないよう、パネル全体が画面内に
      // 収まる範囲にクランプする。
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(e.clientX - offsetX, 0), maxLeft);
      const top = Math.min(Math.max(e.clientY - offsetY, 0), maxTop);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }
    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    handle.addEventListener("mousedown", (e) => {
      // 最小化/閉じるボタンはヘッダーの子要素なので、そこへのクリックはドラッグ開始
      // として扱わない（ボタン操作のたびにパネル位置がリセットされるのを防ぐ）。
      if (e.target.closest("button")) return;
      headerDragMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      // right/bottomをautoにするのと同じタイミングでleft/topを明示的に設定する。
      // ここでleftを未設定のままにすると、次のmousemoveが来るまでの一瞬
      // left:auto; right:auto になり、position:fixedの要素が静的位置（＝左上）に
      // 引っ張られて見た目が一瞬ジャンプすることがある。
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    // 閉じるボタン付近を誤って押すリスクを減らすため、ヘッダーのどこを押しても
    // （ボタン自体を除く）最小化/展開をトグルできるようにする。実際にドラッグした
    // 場合（headerDragMovedがtrue）はトグルしない。
    handle.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (headerDragMoved) return;
      setCollapsed(!panel.classList.contains("hr-collapsed"));
    });
  })();

  panel.querySelector("#hr-btn-minimize").addEventListener("click", () => {
    setCollapsed(!panel.classList.contains("hr-collapsed"));
  });

  // 🚩ボタンを押して手動で開いた場合は展開表示のままにするが、自動起動（URLパターン一致で
  // 勝手に開いた場合、プレビュー画面等でも毎回全開になって邪魔になるため）のときだけ
  // 最初から最小化した状態で表示する。このフラグは一度使ったら消す（消さないと、✕で閉じて
  // 🚩ボタンから手動で開き直したときにも前回の自動起動時のフラグが残ったままになり、
  // 手動で開いたときまで最小化されてしまう）。
  if (window.__hinbanRefereeAutoLaunched) {
    setCollapsed(true);
    window.__hinbanRefereeAutoLaunched = false;
  }
  panel.querySelector("#hr-btn-close").addEventListener("click", () => {
    panel.remove();
    if (overlayEl) overlayEl.remove();
    disablePicker();
    safeSendMessage({ type: "panelClosed" });
  });
  panel.querySelector("#hr-btn-options").addEventListener("click", () => {
    safeSendMessage({ type: "openOptions" }, () => {
      alert(
        "拡張機能が更新されたため、このパネルは古い状態のままになっています。\nページを再読み込み（F5）してから、もう一度🚩ボタンを押してやり直してください。"
      );
    });
  });

  function renderDataStatus(state) {
    const el = panel.querySelector("#hr-datastatus");
    const mgmt = state.managementWorkbook ? state.managementWorkbook.fileName : "未読み込み";
    const tag = state.tagWorkbook ? state.tagWorkbook.fileName : "未読み込み";
    // ファイル名が長いと1行につながって見にくいため、管理表・タグ表を別の行にする
    el.textContent = `管理表: ${mgmt}\nタグ表: ${tag}`;
  }

  function renderFindings(findings, fieldMap) {
    const redCount = findings.filter((f) => f.severity === "red").length;
    const yellowCount = findings.filter((f) => f.severity === "yellow").length;

    const summary = panel.querySelector("#hr-summary");
    summary.style.display = "flex";
    summary.querySelector("#hr-card-red .hr-card-count span").textContent = redCount;
    summary.querySelector("#hr-card-yellow .hr-card-count span").textContent = yellowCount;

    const list = panel.querySelector("#hr-findings");
    list.innerHTML = "";

    if (findings.length === 0) {
      const li = document.createElement("li");
      li.className = "hr-finding-empty";
      li.textContent = "問題は見つかりませんでした 🎉";
      list.appendChild(li);
      return;
    }

    findings
      .slice()
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1))
      .forEach((f) => {
        const li = document.createElement("li");
        li.className = "hr-finding hr-finding-" + f.severity;

        const textSpan = document.createElement("span");
        textSpan.className = "hr-finding-text";
        textSpan.textContent = (f.severity === "red" ? "🟥 " : "🟨 ") + f.message;
        li.appendChild(textSpan);

        li.addEventListener("click", () => {
          const target = resolveTargetElement(f, fieldMap);
          if (target) highlightElement(target, f.severity);
        });

        if (f.copyValue !== undefined && f.copyValue !== null && f.copyValue !== "") {
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "hr-finding-copy";
          copyBtn.title = "管理表の値をコピー";
          copyBtn.textContent = "📋";
          copyBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(String(f.copyValue)).then(() => {
              copyBtn.textContent = "✅";
              setTimeout(() => {
                copyBtn.textContent = "📋";
              }, 1200);
            });
          });
          li.appendChild(copyBtn);
        }

        list.appendChild(li);
      });

    let filterSeverity = null;
    function applyFilter() {
      Array.from(list.children).forEach((li) => {
        if (!filterSeverity) {
          li.style.display = "";
        } else {
          li.style.display = li.classList.contains("hr-finding-" + filterSeverity) ? "" : "none";
        }
      });
    }
    summary.querySelector("#hr-card-red").onclick = () => {
      filterSeverity = filterSeverity === "red" ? null : "red";
      applyFilter();
    };
    summary.querySelector("#hr-card-yellow").onclick = () => {
      filterSeverity = filterSeverity === "yellow" ? null : "yellow";
      applyFilter();
    };
  }

  // タグ候補はクリックすると商品タグ欄ではなく各説明文欄に貼り付けるためのものなので、
  // クリック時はフォーカス移動ではなくタグ文字列のクリップボードコピーを行う。
  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // クリップボードAPIが使えない環境向けのフォールバック
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      console.error("[ページレフェリー] タグのコピーに失敗しました", err);
    }
    document.body.removeChild(textarea);
  }

  // vehicleTagStatus: { rakutenOk, yahooOk, tags } (rules.getVehicleTagStatus の戻り値)
  function buildVehicleTagStatusMessage(status) {
    if (status.rakutenOk && status.yahooOk) {
      return { text: `車種別タグ${status.tags.join("、")}が設置されています。`, ok: true };
    }
    const missingMalls = [];
    if (!status.rakutenOk) missingMalls.push("楽天");
    if (!status.yahooOk) missingMalls.push("ヤフー");
    return { text: `車種別タグが設置されていません。（${missingMalls.join("・")}）`, ok: false };
  }

  function renderTagCandidates(candidates, vehicleTagStatus) {
    const container = panel.querySelector("#hr-suggestions");
    const title = panel.querySelector("#hr-suggestions .hr-suggestions-title");
    const list = panel.querySelector("#hr-suggestion-list");
    const statusEl = panel.querySelector("#hr-tag-status");
    list.innerHTML = "";

    const hasCandidates = candidates && candidates.length > 0;
    const hasStatus = !!vehicleTagStatus;

    if (!hasCandidates && !hasStatus) {
      container.style.display = "none";
      return;
    }

    container.style.display = "block";
    if (hasStatus) {
      const { text, ok } = buildVehicleTagStatusMessage(vehicleTagStatus);
      statusEl.style.display = "block";
      statusEl.textContent = text;
      statusEl.className = "hr-tag-status " + (ok ? "hr-tag-status-ok" : "hr-tag-status-missing");
    } else {
      statusEl.style.display = "none";
    }
    title.style.display = hasCandidates ? "block" : "none";
    list.style.display = hasCandidates ? "block" : "none";
    candidates.forEach((c) => {
      const li = document.createElement("li");
      li.className = "hr-suggestion";
      const categoryLabel = c.category ? `（${c.category}）` : "";
      const baseLabel = `${c.tag}${categoryLabel} ― 「${c.matchedKeyword}」に一致`;
      li.textContent = baseLabel;
      li.title = "クリックでタグをコピー";
      li.addEventListener("click", () => {
        copyTextToClipboard(c.tag);
        li.textContent = `${c.tag} をコピーしました`;
        li.classList.add("hr-suggestion-copied");
        setTimeout(() => {
          li.textContent = baseLabel;
          li.classList.remove("hr-suggestion-copied");
        }, 1200);
      });
      list.appendChild(li);
    });
  }

  // ---------- チャットボット ----------

  // ルールブックのGoogleスプレッドシートを都度取得し、「Q: .../A: ...」形式のテキストに
  // まとめてGeminiへの指示に埋め込む（URL・列マッピングが未設定の場合や取得に失敗した
  // 場合は空文字を返す＝マニュアル抜粋のみで回答させる）。ファイルの選び直しが不要な
  // 代わりに、質問のたびに毎回ネットワーク取得が発生する。
  async function buildRulebookContext(state) {
    if (!state.ruleBookSheetUrl) return "";
    const columnMap = state.ruleBookColumnMap || storage.DEFAULT_RULEBOOK_COLUMN_MAP;
    const catKey = columnMap["カテゴリ"];
    const qKey = columnMap["質問"];
    const aKey = columnMap["回答"];
    if (!qKey || !aKey) return "";
    try {
      const sheet = await rulebook.fetchRulebookSheet(state.ruleBookSheetUrl);
      return sheet.rows
        .filter((row) => row[qKey])
        .map((row) => {
          const cat = catKey && row[catKey] ? `[${row[catKey]}] ` : "";
          return `Q: ${cat}${row[qKey]}\nA: ${row[aKey]}`;
        })
        .join("\n\n");
    } catch (err) {
      console.error("[ページレフェリー] ルールブックの取得に失敗しました", err);
      return "";
    }
  }

  async function buildChatSystemInstruction(state) {
    const rulebookText = await buildRulebookContext(state);
    const lines = [
      "あなたは「通販する蔵」での商品ページ作成を担当する社外スタッフからの質問に答える、作業支援のためのアシスタントです。",
      "以下の「ページ作成ルールブック」と「マニュアル抜粋」に書かれている内容を根拠に、簡潔な日本語で回答してください。",
      "文体は「〜してください。」「〜になります。」「〜です。」のように断定・指示形で書き、「かもしれません」「〜と思われます」のような、判断を相手に委ねる曖昧な言い回しは使わないでください（このツールは担当者の代わりに判断して伝えることが目的のため）。ただし後述の2.に該当し、実際にメーカーページを確認してもらう必要がある場合はその指示自体は明確に伝えてください。",
      "回答の優先順位は次の通りです。",
      "1. ルールブック・マニュアル抜粋の中に、質問にそのまま当てはまる内容があれば、それに基づいて具体的に回答してください（自社品番やSKUの表記ルール、優先順位の原則など、社内の取り決めに関する質問はここで答えられることが多いです）。「型式」「メーカー」という単語が含まれているだけで2.に進まないでください。",
      "2. 「メーカーの公式サイトに実際にその型式・車種・純正品番の記載があるか／内容が正しいか」を確認しないと答えられない質問（表記の真偽・誤植の疑い・実在確認など）にだけ、無理に推測せず「お手数ですが、メーカーページをご確認ください。それでも判断が難しい場合は、チャット欄右上の📋ボタンでこのやりとりをコピーし、管理者にご連絡ください。」と案内してください。",
      "3. 1にも2にも当てはまらないが、カー用品（自動車パーツ・アクセサリー）を扱うECショップの実務・一般的な業界知識（用語の意味、一般的な梱包・配送・ページ作成の考え方など）として、社内ルールを断定しなくても妥当に回答できる質問であれば、一般的な知識をもとに回答して構いません。ただしその場合は必ず回答の冒頭に「（社内ルールではなく一般的な知識に基づく回答です）」と明記し、社内の正式なルールと誤解されないようにしてください。",
      "4. 1・2・3のいずれにも当てはまらず、確信を持って答えられない場合は、正直に「この内容についてはルールブックに記載がなく、確実にはお答えできません。お手数ですが、チャット欄右上の📋ボタンでこのやりとりをコピーし、管理者にご連絡ください。」と伝えてください。",
      "",
      rulebookText
        ? "【ページ作成ルールブック】\n" + rulebookText
        : "（ページ作成ルールブックは未設定です。設定画面から読み込んでください）",
      "",
      "【マニュアル抜粋】\n" + storage.CHATBOT_MANUAL_SUMMARY,
    ];
    return lines.join("\n");
  }

  function appendChatEntry(role, text) {
    const log = panel.querySelector("#hr-chat-log");
    const li = document.createElement("li");
    li.className = "hr-chat-entry hr-chat-" + role;
    li.textContent = (role === "q" ? "🙋 " : "🤖 ") + text;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
    return li;
  }

  async function sendChatQuestion() {
    const input = panel.querySelector("#hr-chat-input");
    const sendBtn = panel.querySelector("#hr-chat-send");
    const question = input.value.trim();
    if (!question) return;

    appendChatEntry("q", question);
    input.value = "";
    sendBtn.disabled = true;
    const answerEl = appendChatEntry("a", "考え中…");

    try {
      const state = await storage.getAll();
      if (!state.geminiApiKey) {
        answerEl.textContent = "🤖 Gemini APIキーが未設定です。設定画面（⑦チャットボット設定）で登録してください。";
        return;
      }
      if (!isExtensionContextValid()) {
        answerEl.textContent = "🤖 拡張機能が更新されたため通信できません。ページを再読み込みしてやり直してください。";
        return;
      }
      answerEl.textContent = "🤖 ルールブックを確認中…";
      const systemInstruction = await buildChatSystemInstruction(state);
      answerEl.textContent = "🤖 考え中…";
      // Gemini側の混雑等で応答が長引くと、待っている間にbackground.js（service worker）が
      // ブラウザに一時停止させられ「考え中…」のまま応答が返らなくなることがあるため、
      // タイムアウトを設けてはっきりしたメッセージに倒す。
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: "askChatbot", apiKey: state.geminiApiKey, systemInstruction, question }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Gemini APIの応答がタイムアウトしました（混雑している可能性があります。しばらく経ってから再度お試しください）")),
            30000
          )
        ),
      ]);
      if (!response || !response.ok) {
        answerEl.textContent = `🤖 エラー: ${(response && response.error) || "応答を取得できませんでした"}`;
        return;
      }
      answerEl.textContent = "🤖 " + response.answer;
    } catch (err) {
      console.error("[ページレフェリー] チャットボットの質問送信に失敗しました", err);
      // 拡張機能をchrome://extensionsで再読み込みした直後は、開きっぱなしのページに
      // 残っている古いcontent scriptの通信経路が切れており、isExtensionContextValid()の
      // 事前チェックをすり抜けてこの形（message channel closed等）で失敗することがある。
      // その場合は原因と対処（ページの再読み込み）が分かるようにする。
      const msg = String((err && err.message) || err);
      if (
        msg.includes("message channel closed") ||
        msg.includes("Extension context invalidated") ||
        msg.includes("Could not establish connection")
      ) {
        answerEl.textContent = "🤖 拡張機能が更新されたため通信が切れています。このページを再読み込みしてからもう一度お試しください。";
      } else if (msg.includes("タイムアウト")) {
        answerEl.textContent = "🤖 " + msg;
      } else {
        answerEl.textContent = "🤖 エラーが発生しました。コンソールを確認してください。";
      }
    } finally {
      sendBtn.disabled = false;
      const log = panel.querySelector("#hr-chat-log");
      log.scrollTop = log.scrollHeight;
    }
  }

  panel.querySelector("#hr-chat-send").addEventListener("click", () => {
    sendChatQuestion();
  });
  panel.querySelector("#hr-chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatQuestion();
    }
  });

  // レッド/イエロー一覧のエリアを圧迫しないよう、チャット欄だけ独立して折りたたみ
  // できるようにする（パネル全体の最小化とは別）。
  function setChatCollapsed(collapsed) {
    const chat = panel.querySelector("#hr-chat");
    const btn = panel.querySelector("#hr-chat-toggle");
    chat.classList.toggle("hr-chat-collapsed", collapsed);
    btn.textContent = collapsed ? "▾" : "▸";
    btn.title = collapsed ? "展開" : "折りたたむ";
  }
  panel.querySelector("#hr-chat-toggle").addEventListener("click", () => {
    setChatCollapsed(!panel.querySelector("#hr-chat").classList.contains("hr-chat-collapsed"));
  });

  // チャットボットで解決しなかった場合に、同じ内容を打ち直さずチャットワーク等へ
  // そのまま貼り付けられるよう、やりとり全体をテキストでコピーできるようにする。
  panel.querySelector("#hr-chat-copy").addEventListener("click", (btnEvent) => {
    const copyBtn = btnEvent.currentTarget;
    const entries = Array.from(panel.querySelectorAll("#hr-chat-log .hr-chat-entry")).map((li) => li.textContent);
    if (!entries.length) {
      copyBtn.title = "まだやりとりがありません";
      return;
    }
    navigator.clipboard.writeText(entries.join("\n\n")).then(() => {
      const original = copyBtn.textContent;
      copyBtn.textContent = "✅";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1200);
    });
  });
  panel.querySelector("#hr-chat-header").addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    setChatCollapsed(!panel.querySelector("#hr-chat").classList.contains("hr-chat-collapsed"));
  });

  function nextFrame() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function setProgress(percent, label) {
    const wrap = panel.querySelector("#hr-progress");
    const bar = panel.querySelector("#hr-progress-bar");
    const labelEl = panel.querySelector("#hr-progress-label");
    wrap.style.display = "block";
    bar.style.width = percent + "%";
    labelEl.textContent = label;
  }

  function hideProgress() {
    panel.querySelector("#hr-progress").style.display = "none";
  }

  // 誤字脱字チェック（Gemini API）。カー用品ショップとしての文章の誤字・脱字・変換ミスは
  // 正規表現では拾えないため、商品名・各説明文をまとめてAIに校正させる。
  // APIキー未設定、または設定④で「なし」にしている場合はAPI呼び出し自体を行わずスキップする。
  function buildTypoCheckText(domValues) {
    return storage.TAG_CANDIDATE_TEXT_KEYS.map((key) => {
      const value = domValues[key];
      if (!value || !String(value).trim()) return null;
      return `【${key}】\n${value}`;
    })
      .filter(Boolean)
      .join("\n\n");
  }

  async function runTypoCheck(domValues, apiKey, severity) {
    const text = buildTypoCheckText(domValues);
    if (!text) return null;

    const systemInstruction = [
      "あなたはカー用品（自動車パーツ・アクセサリー）を扱うオンラインショップの商品ページ校正担当です。",
      "以下は商品ページの各項目のテキストです。日本語として明らかな誤字・脱字・変換ミス・言葉の重複や欠落があれば指摘してください。",
      "車種名・型式・メーカー名など、実物を見ないと正しい表記か判断できない固有名詞的な表記ゆれは、誤字脱字ではないため指摘しないでください。",
      "問題が1つも見つからない場合は、他の文言を一切付けず「問題なし」とだけ回答してください。",
      "問題がある場合は、前置きの文章なしで「【項目名】誤 → 正（簡潔な理由）」の形式で1件ずつ改行して列挙してください。",
    ].join("\n");

    // Gemini側が混雑している等で応答が長引くと、待っている間にbackground.js
    // （service worker）がブラウザに一時停止させられ、代わりに分かりにくい
    // 「message channel closed」エラーになることがあるため、タイムアウトを設けて
    // その場合ははっきり分かるメッセージにする。
    let response;
    try {
      response = await Promise.race([
        chrome.runtime.sendMessage({ type: "askChatbot", apiKey, systemInstruction, question: text }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Gemini APIの応答がタイムアウトしました（混雑している可能性があります。しばらく経ってから再度お試しください）")),
            30000
          )
        ),
      ]);
    } catch (err) {
      console.error("[ページレフェリー] 誤字脱字チェックの応答取得に失敗しました", err);
      return null;
    }
    if (!response || !response.ok) {
      console.error("[ページレフェリー] 誤字脱字チェックの応答取得に失敗しました", response && response.error);
      return null;
    }
    const answer = (response.answer || "").trim();
    if (!answer || answer.startsWith("問題なし")) return null;

    return {
      key: "誤字脱字チェック",
      targetKey: "誤字脱字チェック",
      severity,
      message: `文章に誤字脱字の疑いがあります（AIチェック）:\n${answer}`,
    };
  }

  // 実績の記録（スクショ＋レッド/イエロー件数をスプレッドシートに送信）。
  // スクリーンショット撮影(chrome.tabs.captureVisibleTab)はcontent script側からは
  // 実行できないため、background.js側でまとめて行う。
  function formatLogTimestamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  async function logCheckResult(webhookUrl, companyCode, redCount, yellowCount) {
    // ページ全体ではなく、拡張機能のパネル部分だけを切り抜いてもらうための座標情報。
    // captureVisibleTab自体はタブの見える範囲全体を撮影するため、切り抜きはbackground.js側で行う。
    const rect = panel.getBoundingClientRect();
    const response = await chrome.runtime.sendMessage({
      type: "logCheckResult",
      webhookUrl,
      companyCode: companyCode || "",
      timestamp: formatLogTimestamp(new Date()),
      redCount,
      yellowCount,
      panelRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "記録に失敗しました");
    }
  }

  async function runCheck() {
    const checkBtn = panel.querySelector("#hr-btn-check");
    checkBtn.disabled = true;
    checkBtn.classList.add("hr-btn-check-running");
    // 実行中は前回までの結果に基づく登録ボタンのロック判定を一旦無効化する。
    // AIの誤字脱字チェック等で確認に数秒〜数十秒かかることがあり、その間に前回の
    // （古い）判定のまま登録ボタンを押せてしまう／逆に古い判定で誤ってブロックされる、
    // という食い違いを防ぐため。
    registerGuard.checking = true;

    try {
      setProgress(10, "データを読み込み中…");
      await nextFrame();
      const state = await storage.getAll();
      currentFieldMap = Object.assign({}, storage.DEFAULT_FIELD_MAP, state.domFieldMap || {});
      renderDataStatus(state);
      registerGuard.enabled = !!state.registerLockEnabled;

      setProgress(35, "ページの入力内容を取得中…");
      await nextFrame();
      const domValues = collectDomValues(currentFieldMap);
      const companyCode = domValues["自社品番"];

      if (!companyCode) {
        hideProgress();
        alert("自社品番が空です。コピー元からコピーした直後は自社品番が未入力になっているので、入力してから「確認する」を押し直してください。");
        return;
      }

      setProgress(60, "管理表・タグ表と照合中…");
      await nextFrame();
      const managementMatch = rules.findManagementRow(companyCode, state.managementWorkbook, state.productSheetConfigs);
      const requiredTags = rules.getRequiredTags(companyCode, state.tagWorkbook, state.tagSheetConfig);

      // コピー元品番の残存チェックで「品番」も突き合わせられるように、コピー元商品自体の
      // 管理表行も引いておく（無ければnullのままでよい）
      let copySourceMatch = null;
      if (managementMatch) {
        const copySourceHeader = managementMatch.columnMap["コピー元"];
        const copySourceCode = copySourceHeader ? managementMatch.row[copySourceHeader] : null;
        if (copySourceCode) {
          copySourceMatch = rules.findManagementRow(copySourceCode, state.managementWorkbook, state.productSheetConfigs);
        }
      }

      if (!managementMatch) {
        alert(
          `自社品番「${companyCode}」が管理表内に見つかりませんでした。\n設定画面で管理表ファイル・列マッピングを確認してください。`
        );
      }

      // 管理表の「コピー元」列が実際のコピー元と食い違っていても検出できるように、
      // 同じメーカー（自社品番の接頭辞が同じ）の他商品の品番一覧も引いておく
      const siblingPartNumbers = rules.findSiblingPartNumbers(
        companyCode,
        state.managementWorkbook,
        state.productSheetConfigs
      );

      setProgress(85, "判定中…");
      await nextFrame();

      // 車種別タグは#item_tag欄ではなく各説明文・フリースペースの本文に手打ちで挿入する
      // 運用のため、本文から実際のタグを抽出しておく（tag_missing/tag_extra・推奨候補との
      // 突き合わせ・候補提案での除外の両方に使う）
      const actualVehicleTags = rules.findActualVehicleTags(domValues);
      const candidateText = storage.TAG_CANDIDATE_TEXT_KEYS.map((k) => domValues[k] || "").join("\n");
      // 表示用（車種別タグ候補パネル）は上位3件に絞るが、既存タグが「妥当か」の判定には
      // 上位3件だけでなく一致する全候補を使う必要がある（表示用に絞ると、同じ車種名で
      // 系違いのタグ等に競り負けて本来正しいタグまで「候補にない」と誤検知するため）。
      const tagCandidates = rules.getTagCandidates(
        candidateText,
        state.tagWorkbook,
        state.tagDictionaryConfig,
        actualVehicleTags
      );
      const allTagCandidates = rules.findAllTagCandidates(candidateText, state.tagWorkbook, state.tagDictionaryConfig, []);

      const findings = rules.runChecks({
        domValues,
        managementMatch,
        copySourceMatch,
        siblingPartNumbers,
        requiredTags,
        actualVehicleTags,
        tagCandidateCodes: allTagCandidates.map((c) => c.tag),
        severityMap: state.severity,
        equalityPairs: storage.EQUALITY_PAIRS,
        fixedRuleChecks: storage.FIXED_RULE_CHECKS,
        freeTextKeys: storage.FREE_TEXT_KEYS,
        copySourceLogicalKeys: storage.COPY_SOURCE_CHECK_KEYS,
        urlTemplates: state.urlTemplates,
      });

      const typoSeverity = (state.severity && state.severity["誤字脱字チェック"]) || "none";
      if (state.geminiApiKey && typoSeverity !== "none" && isExtensionContextValid()) {
        setProgress(92, "文章の誤字脱字をAIチェック中…");
        await nextFrame();
        try {
          const typoFinding = await runTypoCheck(domValues, state.geminiApiKey, typoSeverity);
          if (typoFinding) findings.push(typoFinding);
        } catch (err) {
          console.error("[ページレフェリー] 誤字脱字チェックに失敗しました", err);
        }
      }

      renderFindings(findings, currentFieldMap);

      const vehicleTagStatus = rules.getVehicleTagStatus(domValues);
      renderTagCandidates(tagCandidates, vehicleTagStatus);

      setProgress(100, "完了");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const redCount = findings.filter((f) => f.severity === "red").length;
      const yellowCount = findings.filter((f) => f.severity === "yellow").length;

      registerGuard.hasChecked = true;
      registerGuard.hasManagementMatch = !!managementMatch;
      registerGuard.redCount = redCount;
      registerGuard.yellowCount = yellowCount;
      registerGuard.signature = computeFormSignature();

      if (state.logWebhookUrl) {
        logCheckResult(state.logWebhookUrl, companyCode, redCount, yellowCount).catch((err) => {
          console.error("[ページレフェリー] 実績の記録に失敗しました", err);
        });
      }
    } finally {
      hideProgress();
      checkBtn.disabled = false;
      checkBtn.classList.remove("hr-btn-check-running");
      registerGuard.checking = false;
    }
  }

  panel.querySelector("#hr-btn-check").addEventListener("click", () => {
    runCheck().catch((err) => {
      console.error("[ページレフェリー] 確認処理でエラーが発生しました", err);
      alert("確認処理でエラーが発生しました。詳細はコンソールを確認してください。");
    });
  });

  // ---------- 登録ボタンのロック ----------
  // する蔵側の独自onclick（chkInputSkucode()）より先に横取りする必要があるため、
  // documentのキャプチャフェーズで拾ってstopImmediatePropagationする（バブリングフェーズや
  // ボタン自身へのリスナーでは、既にページ側が登録済みのonclickより後にしか実行されない）。
  function handleRegisterGuardClick(e) {
    if (!registerGuard.enabled) return;
    const btn = e.target.closest && e.target.closest('input[name="entry"].entry_btn');
    if (!btn) return;

    const reasons = [];
    if (registerGuard.checking) {
      reasons.push("現在「確認する」を実行中です。完了してから登録してください。");
    } else if (!registerGuard.hasChecked) {
      reasons.push("まだ一度も「確認する」を実行していません。");
    } else {
      if (registerGuard.hasManagementMatch === false) {
        reasons.push("自社品番が管理表に見つかりませんでした（正しく確認できていません）。");
      }
      if (registerGuard.redCount > 0) {
        reasons.push(`レッドカードが${registerGuard.redCount}件残っています。`);
      }
      if (computeFormSignature() !== registerGuard.signature) {
        reasons.push("「確認する」の実行後に内容が変更されたため、再確認が必要です。");
      }
    }

    if (!reasons.length) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    alert(
      "ページレフェリー: レッドカードが0件になるまで登録できません（イエローカードのみが残っている場合は登録できます）。\n\n" +
        reasons.join("\n") +
        "\n\n「確認する」を押して内容を確認してください。"
    );
    setCollapsed(false);
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // 拡張機能を再読み込みした後の多重注入時に、古いコンテキストに紐づいたリスナーが
  // 残り続けないよう、既存のものがあれば先に外してから登録し直す（ファイル冒頭の
  // 既存パネル削除処理と同じ考え方）。
  if (window.__hinbanRefereeRegisterGuardHandler) {
    document.removeEventListener("click", window.__hinbanRefereeRegisterGuardHandler, true);
  }
  window.__hinbanRefereeRegisterGuardHandler = handleRegisterGuardClick;
  document.addEventListener("click", handleRegisterGuardClick, true);

  // ---------- 項目マッピング（照準）モード ----------

  function generateSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.getAttribute("name")) {
      const name = el.getAttribute("name");
      if (el.type === "checkbox" || el.type === "radio") {
        return `[name="${name}"]:checked`;
      }
      return `[name="${name}"]`;
    }
    // フォールバック: 祖先まで辿ってnth-of-typeパスを組み立てる
    const parts = [];
    let node = el;
    for (let depth = 0; depth < 5 && node && node.nodeType === 1 && node !== document.body; depth++) {
      let part = node.tagName.toLowerCase();
      if (node.className && typeof node.className === "string") {
        const cls = node.className.trim().split(/\s+/)[0];
        if (cls) part += "." + CSS.escape(cls);
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function detectAttr(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return "value";
    return "textContent";
  }

  function onPickerKeyDown(e) {
    if (e.key === "Escape") {
      disablePicker();
    }
  }

  function showPickerBanner(text) {
    const banner = panel.querySelector("#hr-picker-banner");
    banner.textContent = text;
    banner.style.display = "block";
  }

  function hidePickerBanner() {
    const banner = panel.querySelector("#hr-picker-banner");
    banner.style.display = "none";
  }

  function enablePicker(logicalKey) {
    pickerActive = true;
    pickerTargetKey = logicalKey;
    document.body.classList.add("hr-picker-active");
    document.addEventListener("mousemove", onPickerMouseMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerKeyDown, true);
    showPickerBanner(`🎯「${logicalKey}」の指定モード中… 対象の入力欄をクリック（Escでキャンセル）`);
  }

  function disablePicker() {
    pickerActive = false;
    pickerTargetKey = null;
    document.body.classList.remove("hr-picker-active");
    document.removeEventListener("mousemove", onPickerMouseMove, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("keydown", onPickerKeyDown, true);
    if (pickerHoverEl) {
      pickerHoverEl.classList.remove("hr-picker-hover");
      pickerHoverEl = null;
    }
    hidePickerBanner();
  }

  function onPickerMouseMove(e) {
    if (panel.contains(e.target)) return;
    if (pickerHoverEl && pickerHoverEl !== e.target) {
      pickerHoverEl.classList.remove("hr-picker-hover");
    }
    pickerHoverEl = e.target;
    pickerHoverEl.classList.add("hr-picker-hover");
  }

  async function onPickerClick(e) {
    if (panel.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    const selector = generateSelector(el);
    const attr = detectAttr(el);
    const key = pickerTargetKey;
    const state = await storage.getAll();
    const nextMap = Object.assign({}, state.domFieldMap, {
      [key]: { type: "single", selector, attr },
    });
    await storage.setPatch({ domFieldMap: nextMap });
    disablePicker();
    showPickerBanner(`✅「${key}」を割り当てました（設定画面に戻って確認してください）`);
    setTimeout(hidePickerBanner, 3000);
  }

  // 設定画面（options）から「項目マッピング」を遠隔操作で指定できるようにする
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "enterPickerMode" && message.key) {
      enablePicker(message.key);
    }
  });

  // 初期表示用にデータ状況だけ先に読み込んでおく
  storage.getAll().then(renderDataStatus);
})();
