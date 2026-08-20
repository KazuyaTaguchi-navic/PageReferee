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
  if (!storage || !rules) {
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
      <span class="hr-title">🚩 ページレフェリー</span>
      <span class="hr-header-btns">
        <button type="button" id="hr-btn-minimize" title="最小化">▾</button>
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
        <div class="hr-suggestions-title">🔎 タグ候補（要確認・キーワード一致による推定です）</div>
        <ul class="hr-suggestion-list" id="hr-suggestion-list"></ul>
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
  (function enableDrag() {
    const handle = panel.querySelector("#hr-drag-handle");
    let offsetX = 0;
    let offsetY = 0;

    function onMouseMove(e) {
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
  })();

  panel.querySelector("#hr-btn-minimize").addEventListener("click", (e) => {
    const collapsed = panel.classList.toggle("hr-collapsed");
    const btn = e.currentTarget;
    // 開いている間は「▾（押すと最小化）」、最小化中は「▸（押すと展開）」で見分けられるようにする
    btn.textContent = collapsed ? "▸" : "▾";
    btn.title = collapsed ? "展開" : "最小化";
  });
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
    const mgmt = state.managementWorkbook
      ? `管理表: ${state.managementWorkbook.fileName}`
      : "管理表: 未読み込み";
    const tag = state.tagWorkbook ? `／タグ表: ${state.tagWorkbook.fileName}` : "／タグ表: 未読み込み";
    el.textContent = mgmt + tag;
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

  function renderTagCandidates(candidates) {
    const container = panel.querySelector("#hr-suggestions");
    const list = panel.querySelector("#hr-suggestion-list");
    list.innerHTML = "";

    if (!candidates || candidates.length === 0) {
      container.style.display = "none";
      return;
    }

    container.style.display = "block";
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

  async function runCheck() {
    const checkBtn = panel.querySelector("#hr-btn-check");
    checkBtn.disabled = true;
    checkBtn.classList.add("hr-btn-check-running");

    try {
      setProgress(10, "データを読み込み中…");
      await nextFrame();
      const state = await storage.getAll();
      currentFieldMap = Object.assign({}, storage.DEFAULT_FIELD_MAP, state.domFieldMap || {});
      renderDataStatus(state);

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
      const findings = rules.runChecks({
        domValues,
        managementMatch,
        copySourceMatch,
        siblingPartNumbers,
        requiredTags,
        severityMap: state.severity,
        equalityPairs: storage.EQUALITY_PAIRS,
        fixedRuleChecks: storage.FIXED_RULE_CHECKS,
        freeTextKeys: storage.FREE_TEXT_KEYS,
        copySourceLogicalKeys: storage.COPY_SOURCE_CHECK_KEYS,
        urlTemplates: state.urlTemplates,
      });

      renderFindings(findings, currentFieldMap);

      const actualTags = rules.parseItemTags(domValues["商品タグ"]);
      const candidateText = storage.TAG_CANDIDATE_TEXT_KEYS.map((k) => domValues[k] || "").join("\n");
      const candidates = rules.getTagCandidates(candidateText, state.tagWorkbook, state.tagDictionaryConfig, actualTags);
      renderTagCandidates(candidates);

      setProgress(100, "完了");
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      hideProgress();
      checkBtn.disabled = false;
      checkBtn.classList.remove("hr-btn-check-running");
    }
  }

  panel.querySelector("#hr-btn-check").addEventListener("click", () => {
    runCheck().catch((err) => {
      console.error("[ページレフェリー] 確認処理でエラーが発生しました", err);
      alert("確認処理でエラーが発生しました。詳細はコンソールを確認してください。");
    });
  });

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
