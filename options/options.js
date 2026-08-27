(function () {
  "use strict";

  const storage = window.HinbanReferee.storage;
  const workbookLib = window.HinbanReferee.workbook;

  const mgmtFileInput = document.getElementById("mgmt-file");
  const mgmtStatus = document.getElementById("mgmt-status");
  const mgmtSheetsEl = document.getElementById("mgmt-sheets");
  const mgmtSaveBtn = document.getElementById("mgmt-save");
  const mgmtSaveStatus = document.getElementById("mgmt-save-status");

  const tagFileInput = document.getElementById("tag-file");
  const tagStatus = document.getElementById("tag-status");
  const tagSheetConfigEl = document.getElementById("tag-sheet-config");
  const tagDictConfigEl = document.getElementById("tagdict-sheet-config");
  const tagSaveBtn = document.getElementById("tag-save");
  const tagSaveStatus = document.getElementById("tag-save-status");

  const fieldmapListEl = document.getElementById("fieldmap-list");
  const severityListEl = document.getElementById("severity-list");

  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const exportArea = document.getElementById("export-area");
  const importStatus = document.getElementById("import-status");

  const MGMT_COLUMN_KEYS = storage.MANAGEMENT_LOGICAL_KEYS;
  const TAG_COLUMN_KEYS = ["自社品番", "タグ", "メーカー", "車種名", "カテゴリ"];
  const TAG_DICT_COLUMN_KEYS = ["車種", "車種正式名称", "カテゴリ", "タグ"];

  function guessHeader(headers, logicalKey) {
    const rules = {
      自社品番: (h) => h.includes("自社品番"),
      品番: (h) => h.includes("品番") && !h.includes("自社品番"),
      定価税抜: (h) => h.includes("定価") && !h.includes("税込"),
      定価税込: (h) => h.includes("定価") && h.includes("税込"),
      売価税抜: (h) => h.includes("売価") && !h.includes("税込"),
      売価税込: (h) => h.includes("売価") && h.includes("税込"),
      原価: (h) => h.includes("原価") && !h.includes("掛率"),
      送料: (h) => h.includes("送料") && !h.includes("特別"),
      特別加算金: (h) => h.includes("特別加算金"),
      SKU: (h) => h.toUpperCase().includes("SKU"),
      シリーズ: (h) => h.includes("シリーズ"),
      車種名: (h) => h.includes("車種") && !h.includes("画像") && !h.includes("補記"),
      コピー元: (h) => h.includes("コピー元"),
      タグ: (h) => h === "タグ" || h.includes("タグ"),
      メーカー: (h) => h === "メーカー",
      車種名: (h) => h.includes("車種"),
      車種: (h) => h.replace(/[\s　]/g, "") === "車種",
      車種正式名称: (h) => h.includes("正式名称"),
      カテゴリ: (h) => h.includes("カテゴリ"),
      質問: (h) => h.includes("質問"),
      回答: (h) => h.includes("ルール") || h.includes("回答") || h.includes("対応方法"),
    };
    const test = rules[logicalKey];
    if (!test) return "";
    let candidates = headers.filter(test);
    if (candidates.length === 0) return "";
    if (candidates.length > 1 && logicalKey === "自社品番") {
      // 「【RV】自社品番」のような代表コード（バリエーション親）より、
      // 実際の一意な品番列（例:「自社品番\n※自動」）を優先する
      const withoutBracket = candidates.filter((h) => !h.includes("【"));
      if (withoutBracket.length) candidates = withoutBracket;
    }
    return candidates[0];
  }

  function buildSelect(headers, selected) {
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "（未設定）";
    select.appendChild(blank);
    headers.forEach((h) => {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h;
      if (h === selected) opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }

  // ---------- ① 管理表 ----------

  const DEFAULT_MGMT_SHEET_NAME = "管理表";

  async function renderManagementSheets(workbook, existingConfigs) {
    mgmtSheetsEl.innerHTML = "";
    const configByName = {};
    (existingConfigs || []).forEach((c) => (configByName[c.sheetName] = c));
    // まだ何も保存されていない場合は「管理表」シートを既定でONにする
    const isFirstTime = !existingConfigs || existingConfigs.length === 0;

    workbook.sheetNames.forEach((sheetName) => {
      const sheet = workbook.sheets[sheetName];
      const details = document.createElement("details");
      details.className = "sheet-card";
      details.dataset.sheetName = sheetName;
      const existing = configByName[sheetName];
      const isDefaultChecked = isFirstTime && sheetName === DEFAULT_MGMT_SHEET_NAME;
      if (existing || isDefaultChecked) details.open = true;

      const summary = document.createElement("summary");
      summary.textContent = `${sheetName}（${sheet.rows.length}行）`;
      details.appendChild(summary);

      const checkboxLabel = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "sheet-enable";
      checkbox.checked = !!existing || isDefaultChecked;
      checkboxLabel.appendChild(checkbox);
      checkboxLabel.append(" この表を商品シートとして管理表検索の対象にする");
      details.appendChild(checkboxLabel);

      const grid = document.createElement("div");
      grid.className = "map-grid";
      MGMT_COLUMN_KEYS.forEach((key) => {
        const label = document.createElement("label");
        label.textContent = key;
        const selected = (existing && existing.columnMap && existing.columnMap[key]) || guessHeader(sheet.headers, key);
        const select = buildSelect(sheet.headers, selected);
        select.dataset.logicalKey = key;
        grid.appendChild(label);
        grid.appendChild(select);
      });
      details.appendChild(grid);
      mgmtSheetsEl.appendChild(details);
    });

    mgmtSaveBtn.style.display = "inline-block";
  }

  mgmtFileInput.addEventListener("change", async () => {
    const file = mgmtFileInput.files[0];
    if (!file) return;
    mgmtStatus.textContent = "読み込み中...";
    try {
      const parsed = await workbookLib.parseWorkbookFile(file);
      await storage.setPatch({ managementWorkbook: parsed });
      mgmtStatus.textContent = `読み込み完了: ${parsed.fileName}（シート${parsed.sheetNames.length}件） / 読み込み日時: ${new Date(parsed.importedAt).toLocaleString("ja-JP")}`;
      const state = await storage.getAll();
      renderManagementSheets(parsed, state.productSheetConfigs);
    } catch (err) {
      console.error(err);
      mgmtStatus.textContent = "読み込みに失敗しました。ファイル形式(.xlsx)を確認してください。";
    }
  });

  mgmtSaveBtn.addEventListener("click", async () => {
    const configs = [];
    mgmtSheetsEl.querySelectorAll(".sheet-card").forEach((details) => {
      const checkbox = details.querySelector(".sheet-enable");
      if (!checkbox.checked) return;
      const sheetName = details.dataset.sheetName;
      const columnMap = {};
      details.querySelectorAll("select[data-logical-key]").forEach((select) => {
        if (select.value) columnMap[select.dataset.logicalKey] = select.value;
      });
      configs.push({ sheetName, columnMap });
    });
    await storage.setPatch({ productSheetConfigs: configs });
    mgmtSaveStatus.textContent = `${configs.length}件の商品シートを保存しました。（${new Date().toLocaleTimeString("ja-JP")}）`;
  });

  // ---------- ② 車種別タグ表 ----------

  // container内にシート選択＋列マッピングのUIを組み立てる共通処理。
  // 保存時に読み取れるよう、選択中のシート名を返す関数をcontainerに生やしておく。
  function renderSheetColumnConfig(container, workbook, existingConfig, columnKeys, defaultSheetName, selectIdSuffix) {
    container.innerHTML = "";

    const sheetSelectLabel = document.createElement("label");
    const sheetSelect = document.createElement("select");
    sheetSelect.id = "sheet-select-" + selectIdSuffix;
    workbook.sheetNames.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if ((existingConfig && existingConfig.sheetName) === name || (!existingConfig && name === defaultSheetName)) {
        opt.selected = true;
      }
      sheetSelect.appendChild(opt);
    });
    sheetSelectLabel.appendChild(document.createTextNode("対象シート: "));
    sheetSelectLabel.appendChild(sheetSelect);
    container.appendChild(sheetSelectLabel);

    const grid = document.createElement("div");
    grid.className = "map-grid";
    container.appendChild(grid);

    function renderColumnGrid() {
      grid.innerHTML = "";
      const sheetName = sheetSelect.value;
      const sheet = workbook.sheets[sheetName];
      if (!sheet) return;
      columnKeys.forEach((key) => {
        const label = document.createElement("label");
        label.textContent = key;
        const selected =
          (existingConfig && existingConfig.sheetName === sheetName && existingConfig.columnMap[key]) ||
          guessHeader(sheet.headers, key);
        const select = buildSelect(sheet.headers, selected);
        select.dataset.logicalKey = key;
        grid.appendChild(label);
        grid.appendChild(select);
      });
    }
    sheetSelect.addEventListener("change", renderColumnGrid);
    renderColumnGrid();

    container.getCurrentConfig = () => {
      const sheetName = sheetSelect.value;
      const columnMap = {};
      grid.querySelectorAll("select[data-logical-key]").forEach((select) => {
        if (select.value) columnMap[select.dataset.logicalKey] = select.value;
      });
      return { sheetName, columnMap };
    };
  }

  function renderTagSheetConfig(workbook, existingConfig) {
    renderSheetColumnConfig(tagSheetConfigEl, workbook, existingConfig, TAG_COLUMN_KEYS, "★リスト", "list");
    tagSaveBtn.style.display = "inline-block";
  }

  function renderTagDictConfig(workbook, existingConfig) {
    renderSheetColumnConfig(tagDictConfigEl, workbook, existingConfig, TAG_DICT_COLUMN_KEYS, "★タグ一覧", "dict");
    tagSaveBtn.style.display = "inline-block";
  }

  tagFileInput.addEventListener("change", async () => {
    const file = tagFileInput.files[0];
    if (!file) return;
    tagStatus.textContent = "読み込み中...";
    try {
      const parsed = await workbookLib.parseWorkbookFile(file);
      await storage.setPatch({ tagWorkbook: parsed });
      tagStatus.textContent = `読み込み完了: ${parsed.fileName}（シート${parsed.sheetNames.length}件） / 読み込み日時: ${new Date(parsed.importedAt).toLocaleString("ja-JP")}`;
      const state = await storage.getAll();
      renderTagSheetConfig(parsed, state.tagSheetConfig);
      renderTagDictConfig(parsed, state.tagDictionaryConfig);
    } catch (err) {
      console.error(err);
      tagStatus.textContent = "読み込みに失敗しました。ファイル形式(.xlsx)を確認してください。";
    }
  });

  tagSaveBtn.addEventListener("click", async () => {
    const tagSheetConfig = tagSheetConfigEl.getCurrentConfig ? tagSheetConfigEl.getCurrentConfig() : null;
    const tagDictionaryConfig = tagDictConfigEl.getCurrentConfig ? tagDictConfigEl.getCurrentConfig() : null;
    const patch = {};
    if (tagSheetConfig) patch.tagSheetConfig = tagSheetConfig;
    if (tagDictionaryConfig) patch.tagDictionaryConfig = tagDictionaryConfig;
    await storage.setPatch(patch);
    tagSaveStatus.textContent = `タグ表設定を保存しました。（${new Date().toLocaleTimeString("ja-JP")}）`;
  });

  // ---------- ③ ページ側の項目マッピング ----------

  const fieldmapTargetEl = document.getElementById("fieldmap-target");

  function listPanelTabs() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "listPanelTabs" }, (list) => resolve(list || []));
    });
  }

  async function requestPickerFor(key) {
    const tabs = await listPanelTabs();
    if (tabs.length === 0) {
      fieldmapTargetEl.textContent =
        "対象のページが見つかりません。通販する蔵のページを開いて🚩ボタンでパネルを表示してから、もう一度押してください。";
      return;
    }
    const target = tabs[tabs.length - 1]; // 直近でパネルを開いたタブを対象にする
    fieldmapTargetEl.textContent = `「${target.title}」に切り替えました。そのページ上で対象の入力欄をクリックしてください（Escでキャンセル）。`;
    chrome.runtime.sendMessage({ type: "enterPickerMode", tabId: target.tabId, key });
  }

  function renderFieldMapList(state) {
    const merged = Object.assign({}, storage.DEFAULT_FIELD_MAP, state.domFieldMap || {});
    fieldmapListEl.innerHTML = "";
    // ④重大度設定と同じ「[カテゴリ]項目名」表記・並び順に揃える
    sortSeverityKeys(Object.keys(merged))
      .filter((key) => merged[key])
      .forEach((key) => {
        const entry = merged[key];
        const category = SEVERITY_KEY_CATEGORY[key] || "その他";
        const row = document.createElement("div");
        row.className = "field-row";
        const label = document.createElement("span");
        label.className = "field-key";
        label.textContent = `[${category}]${key}`;
        const sel = document.createElement("span");
        sel.className = "field-sel";
        sel.textContent = entry.selector;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "field-pick";
        btn.textContent = "指定する";
        btn.addEventListener("click", () => requestPickerFor(key));
        row.appendChild(label);
        row.appendChild(sel);
        row.appendChild(btn);
        fieldmapListEl.appendChild(row);
      });
  }

  document.getElementById("fieldmap-new-btn").addEventListener("click", () => {
    const input = document.getElementById("fieldmap-new-key");
    const key = input.value.trim();
    if (!key) return;
    input.value = "";
    requestPickerFor(key);
  });

  // ページ側で項目が割り当てられたら一覧を自動更新する
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.hinbanReferee) return;
    storage.getAll().then((state) => {
      renderFieldMapList(state);
      renderSeverityList(state);
    });
  });

  // ---------- ④ 重大度設定 ----------

  // する蔵の実ページのDOM順（する蔵ページソースで各input/selectが実際に現れる順番）に
  // 基づいたグループ分け。ページ内の項目を漏れなく列挙する（追加機能は無し・一覧のみ）。
  // 「Yahoo」はページ側の項目名がヤフー/Yahoo表記で混在しているため、表示上のカテゴリ名は
  // 「Yahoo」で統一する（ヤフオク・新ヤフオクもYahoo系サービスのためここに含める）。
  // SKU情報は行単位の繰り返し項目のため個別の項目名ではなく1つのまとまりとして扱う。
  const SEVERITY_CATEGORIES = [
    {
      // する蔵の実項目ではなく、Gemini APIによるAIチェック機能のため、他と混ざらないよう
      // 一番上に離して表示する（renderSeverityListでこのカテゴリだけ強調スタイルを当てる）。
      label: "AIチェック（する蔵の項目ではありません）",
      keys: ["誤字脱字チェック"],
    },
    {
      label: "基本情報",
      keys: [
        "自社品番",
        "メーカー品番",
        "商品名",
        "商品名略称",
        "メーカー品名",
        "シリーズ整合性",
        "メーカー希望小売価格",
        "販売価格",
        "原価",
        "個別送料",
        "送料特別加算金額",
        "商品タグ",
      ],
    },
    {
      label: "楽天",
      keys: [
        "楽天掲載",
        "楽天サイトカテゴリ1",
        "楽天サイトカテゴリ2",
        "楽天サイトカテゴリ3",
        "楽天サイトカテゴリ4",
        "楽天サイトカテゴリ5",
        "楽天サイトカテゴリ整合性",
        "楽天商品管理番号",
        "楽天商品番号",
        "楽天ジャンルID",
        "楽天非製品属性タグ",
        "楽天商品名",
        "楽天表示価格",
        "楽天販売価格",
        "楽天送料区分",
        "楽天カタログID",
        "楽天注文ボタン",
        "楽天配送方法セット管理番号",
        "楽天PC用商品説明文",
        "楽天モバイル用商品説明文",
        "楽天スマホ用商品説明文",
        "楽天動画",
        "楽天ポイント変倍率",
      ],
    },
    {
      label: "Yahoo",
      keys: [
        "Yahoo掲載",
        "ヤフー商品コード",
        "Yahooプロダクトカテゴリ",
        "Yahooサイトカテゴリ1",
        "Yahooサイトカテゴリ2",
        "Yahooサイトカテゴリ3",
        "Yahooサイトカテゴリ4",
        "Yahooサイトカテゴリ5",
        "Yahooサイトカテゴリ整合性",
        "ヤフーページ公開",
        "Yahoo商品名",
        "ヤフー定価",
        "ヤフー通常販売価格",
        "Yahoo特価",
        "Yahoo会員向け価格",
        "Yahooショッピング製品コード",
        "ヤフーJANコード",
        "Yahoo製品コード",
        "Yahoo重量",
        "Yahoo送料無料",
        "Yahoo一律ポイント区分",
        "Yahoo商品別倍率指定",
        "ヤフーキャッチコピー",
        "ヤフー商品説明",
        "ヤフー商品情報",
        "Yahooフリースペース1",
        "Yahooフリースペース2",
        "Yahooフリースペース3",
        "Yahooスマートフォン用フリースペース",
        "ヤフオク掲載",
        "新ヤフオク掲載",
      ],
    },
    {
      label: "Amazon",
      keys: [
        "Amazon掲載",
        "Amazon発送日数",
        "Amazon配送パターン",
        "Amazon販売価格",
        "Amazonポイント",
        "Amazonメーカー希望小売価格",
        "Amazon法人価格",
        "Amazon不要入力",
      ],
    },
    {
      label: "SKU情報",
      keys: ["SKU情報"],
    },
  ];

  const SEVERITY_KEY_CATEGORY = {};
  const SEVERITY_KEY_ORDER = [];
  SEVERITY_CATEGORIES.forEach((group) => {
    group.keys.forEach((key) => {
      SEVERITY_KEY_CATEGORY[key] = group.label;
      SEVERITY_KEY_ORDER.push(key);
    });
  });

  function sortSeverityKeys(keys) {
    const known = SEVERITY_KEY_ORDER.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !SEVERITY_KEY_ORDER.includes(k)).sort();
    return known.concat(rest);
  }

  const SEVERITY_VALUE_LABELS = { red: "レッドカード", yellow: "イエローカード", none: "－（なし）" };

  function renderSeverityList(state) {
    // 一覧に出す項目はSEVERITY_KEY_ORDER（=する蔵の全項目）を正とする。保存済みの
    // severityに無いキーは「なし」扱いで表示する（初回や新項目追加直後でも一覧に出る）。
    const merged = Object.assign({}, state.severity || {});
    severityListEl.innerHTML = "";
    sortSeverityKeys(Array.from(new Set(SEVERITY_KEY_ORDER.concat(Object.keys(merged)))))
      .forEach((key) => {
        const row = document.createElement("div");
        row.className = "severity-row";
        const label = document.createElement("span");
        label.className = "field-key";
        const category = SEVERITY_KEY_CATEGORY[key] || "その他";
        if (category.startsWith("AIチェック")) {
          row.classList.add("severity-row-ai");
        }
        label.textContent = `[${category}]${key}`;
        const select = document.createElement("select");
        const currentValue = merged[key] || "none";
        ["red", "yellow", "none"].forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = SEVERITY_VALUE_LABELS[v];
          if (currentValue === v) opt.selected = true;
          select.appendChild(opt);
        });
        select.addEventListener("change", async () => {
          const s = await storage.getAll();
          const nextSeverity = Object.assign({}, s.severity, { [key]: select.value });
          await storage.setPatch({ severity: nextSeverity });
        });
        row.appendChild(label);
        row.appendChild(select);
        severityListEl.appendChild(row);
      });
  }

  // ---------- ⑤ モールURLのひな形 ----------

  const urlTemplateRakutenInput = document.getElementById("url-template-rakuten");
  const urlTemplateYahooInput = document.getElementById("url-template-yahoo");
  const urlTemplateStatus = document.getElementById("url-template-status");

  document.getElementById("url-template-save").addEventListener("click", async () => {
    await storage.setPatch({
      urlTemplates: {
        rakuten: urlTemplateRakutenInput.value.trim(),
        yahoo: urlTemplateYahooInput.value.trim(),
      },
    });
    urlTemplateStatus.textContent = "保存しました。";
  });

  // ---------- ⑥ 自動起動設定 ----------
  // アカウントごとに管理画面のURLが違うため、指定したURLで始まるページでは
  // 🚩ボタンを押さなくても自動的にパネルを表示できるようにする。ブラウザの権限モデル上、
  // 新しいサイトへのアクセス許可はユーザー操作（クリック）を起点に要求する必要があるため、
  // 保存ボタン押下時にchrome.permissions.requestを呼ぶ。

  const autoLaunchUrlInput = document.getElementById("auto-launch-url");
  const autoLaunchStatus = document.getElementById("auto-launch-status");

  // 入力されたURLを「https://host/path/*」形式のマッチパターンに正規化する
  function buildAutoLaunchPattern(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || "").trim());
    } catch (e) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let path = url.pathname || "/";
    if (!path.endsWith("/")) path += "/";
    return `${url.protocol}//${url.host}${path}*`;
  }

  document.getElementById("auto-launch-save").addEventListener("click", async () => {
    const pattern = buildAutoLaunchPattern(autoLaunchUrlInput.value);
    if (!pattern) {
      autoLaunchStatus.textContent = "URLの形式が正しくありません（例: https://sv300.suruzo.biz/creer-1437/）。";
      return;
    }
    autoLaunchStatus.textContent = "権限を確認しています…";
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        autoLaunchStatus.textContent = "許可されなかったため、自動起動は設定されませんでした。";
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: "registerAutoLaunch", pattern });
      if (!response || !response.ok) {
        autoLaunchStatus.textContent = "登録に失敗しました。時間をおいて再度お試しください。";
        return;
      }
      await storage.setPatch({ autoLaunchUrlPattern: pattern });
      autoLaunchStatus.textContent = `「${pattern}」で自動起動するように設定しました。`;
    } catch (e) {
      console.error("[ページレフェリー] 自動起動の設定に失敗しました", e);
      autoLaunchStatus.textContent = "設定に失敗しました。コンソールを確認してください。";
    }
  });

  document.getElementById("auto-launch-clear").addEventListener("click", async () => {
    const state = await storage.getAll();
    const oldPattern = state.autoLaunchUrlPattern;
    try {
      await chrome.runtime.sendMessage({ type: "unregisterAutoLaunch" });
      if (oldPattern) {
        await chrome.permissions.remove({ origins: [oldPattern] }).catch(() => {});
      }
    } catch (e) {
      console.error("[ページレフェリー] 自動起動の解除に失敗しました", e);
    }
    await storage.setPatch({ autoLaunchUrlPattern: null });
    autoLaunchUrlInput.value = "";
    autoLaunchStatus.textContent = "自動起動を解除しました。";
  });

  // ---------- ⑦ チャットボット設定 ----------

  const geminiApiKeyInput = document.getElementById("gemini-apikey");
  const geminiApiKeyStatus = document.getElementById("gemini-apikey-status");
  const rulebookUrlInput = document.getElementById("rulebook-url");
  const rulebookStatus = document.getElementById("rulebook-status");
  const rulebookSheetConfigEl = document.getElementById("rulebook-sheet-config");
  const rulebookSaveBtn = document.getElementById("rulebook-save");

  const RULEBOOK_COLUMN_KEYS = ["カテゴリ", "質問", "回答"];

  document.getElementById("gemini-apikey-save").addEventListener("click", async () => {
    const key = geminiApiKeyInput.value.trim();
    await storage.setPatch({ geminiApiKey: key || null });
    geminiApiKeyStatus.textContent = key ? "APIキーを保存しました。" : "APIキーを削除しました。";
  });

  // 管理表・タグ表用のrenderSheetColumnConfig（複数シートからの選択）とは異なり、
  // ルールブックはURLのgidで既に1タブ分に絞られているので、シート選択UIなしで
  // 列マッピングのプルダウンだけを出す。
  function renderRulebookColumnConfig(sheet, existingMap) {
    rulebookSheetConfigEl.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "map-grid";
    RULEBOOK_COLUMN_KEYS.forEach((key) => {
      const label = document.createElement("label");
      label.textContent = key;
      const selected = (existingMap && existingMap[key]) || guessHeader(sheet.headers, key);
      const select = buildSelect(sheet.headers, selected);
      select.dataset.logicalKey = key;
      grid.appendChild(label);
      grid.appendChild(select);
    });
    rulebookSheetConfigEl.appendChild(grid);
    rulebookSheetConfigEl.getCurrentMap = () => {
      const map = {};
      grid.querySelectorAll("select[data-logical-key]").forEach((select) => {
        if (select.value) map[select.dataset.logicalKey] = select.value;
      });
      return map;
    };
    rulebookSaveBtn.style.display = "inline-block";
  }

  document.getElementById("rulebook-url-save").addEventListener("click", async () => {
    const url = rulebookUrlInput.value.trim();
    if (!url) return;
    rulebookStatus.textContent = "読み込み中...";
    try {
      const sheet = await window.HinbanReferee.rulebook.fetchRulebookSheet(url);
      await storage.setPatch({ ruleBookSheetUrl: url });
      rulebookStatus.textContent = `読み込み完了（${sheet.rows.length}行） / ${new Date().toLocaleString("ja-JP")}`;
      const state = await storage.getAll();
      renderRulebookColumnConfig(sheet, state.ruleBookColumnMap);
    } catch (err) {
      console.error(err);
      rulebookStatus.textContent = "読み込みに失敗しました: " + (err && err.message ? err.message : String(err));
    }
  });

  rulebookSaveBtn.addEventListener("click", async () => {
    const map = rulebookSheetConfigEl.getCurrentMap ? rulebookSheetConfigEl.getCurrentMap() : null;
    if (!map) return;
    await storage.setPatch({ ruleBookColumnMap: map });
    rulebookStatus.textContent += "　→ 列マッピングを保存しました。";
  });

  // ---------- ⑧ 実績記録設定 ----------

  const logWebhookUrlInput = document.getElementById("log-webhook-url");
  const logWebhookStatus = document.getElementById("log-webhook-status");

  document.getElementById("log-webhook-save").addEventListener("click", async () => {
    const url = logWebhookUrlInput.value.trim();
    if (!url) {
      await storage.setPatch({ logWebhookUrl: null });
      logWebhookStatus.textContent = "URLが空のため、記録は無効のままです。";
      return;
    }
    // スクショ撮影(chrome.tabs.captureVisibleTab)は、自動起動用に許可した特定サイトの
    // 権限だけでは動作せず、「すべてのサイト」への権限が必要（Chromeの仕様）。
    // 🚩ボタン経由（activeTab）ではなく自動起動経由でパネルを開いた場合は特にこれが必要になる。
    logWebhookStatus.textContent = "権限を確認しています…";
    try {
      const granted = await chrome.permissions.request({ origins: ["*://*/*"] });
      if (!granted) {
        logWebhookStatus.textContent =
          "スクリーンショット撮影には「すべてのサイトへのアクセス」の許可が必要です。許可されなかったため、URLは保存しませんでした。";
        return;
      }
      await storage.setPatch({ logWebhookUrl: url });
      logWebhookStatus.textContent = "保存しました。次回の「確認する」完了時から記録されます。";
    } catch (e) {
      console.error("[ページレフェリー] 実績記録設定の保存に失敗しました", e);
      logWebhookStatus.textContent = "設定に失敗しました。コンソールを確認してください。";
    }
  });

  document.getElementById("log-webhook-clear").addEventListener("click", async () => {
    logWebhookUrlInput.value = "";
    await storage.setPatch({ logWebhookUrl: null });
    logWebhookStatus.textContent = "記録を無効化しました。";
  });

  // ---------- ⑨ 登録ボタンのロック ----------

  const registerLockCheckbox = document.getElementById("register-lock-enabled");
  const registerLockStatus = document.getElementById("register-lock-status");

  registerLockCheckbox.addEventListener("change", async () => {
    await storage.setPatch({ registerLockEnabled: registerLockCheckbox.checked });
    registerLockStatus.textContent = registerLockCheckbox.checked
      ? "登録ボタンのロックを有効にしました。"
      : "登録ボタンのロックを無効にしました。";
  });

  // ---------- ⑩ エクスポート・インポート ----------

  exportBtn.addEventListener("click", async () => {
    const json = await storage.exportConfig();
    exportArea.value = json;
    try {
      await navigator.clipboard.writeText(json);
      importStatus.textContent = "クリップボードにコピーしました。";
    } catch (e) {
      importStatus.textContent = "テキストエリアに出力しました（コピーは手動で行ってください）。";
    }
  });

  importBtn.addEventListener("click", async () => {
    try {
      await storage.importConfig(exportArea.value);
      importStatus.textContent = "インポートしました。ページを再読み込みします...";
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      console.error(err);
      importStatus.textContent = "インポートに失敗しました。JSON形式を確認してください。";
    }
  });

  document.getElementById("close-tab-btn").addEventListener("click", () => {
    window.close();
  });

  // ---------- 初期化 ----------

  async function init() {
    const state = await storage.getAll();

    if (state.managementWorkbook) {
      mgmtStatus.textContent = `読み込み済み: ${state.managementWorkbook.fileName} / 読み込み日時: ${new Date(state.managementWorkbook.importedAt).toLocaleString("ja-JP")}`;
      renderManagementSheets(state.managementWorkbook, state.productSheetConfigs);
    }
    if (state.tagWorkbook) {
      tagStatus.textContent = `読み込み済み: ${state.tagWorkbook.fileName} / 読み込み日時: ${new Date(state.tagWorkbook.importedAt).toLocaleString("ja-JP")}`;
      renderTagSheetConfig(state.tagWorkbook, state.tagSheetConfig);
      renderTagDictConfig(state.tagWorkbook, state.tagDictionaryConfig);
    }
    renderFieldMapList(state);
    renderSeverityList(state);

    const urlTemplates = state.urlTemplates || storage.DEFAULT_URL_TEMPLATES;
    urlTemplateRakutenInput.value = urlTemplates.rakuten || "";
    urlTemplateYahooInput.value = urlTemplates.yahoo || "";

    if (state.autoLaunchUrlPattern) {
      autoLaunchUrlInput.value = state.autoLaunchUrlPattern.replace(/\*$/, "");
      autoLaunchStatus.textContent = `現在「${state.autoLaunchUrlPattern}」で自動起動する設定です。`;
    }

    if (state.geminiApiKey) {
      geminiApiKeyInput.value = state.geminiApiKey;
      geminiApiKeyStatus.textContent = "APIキーを設定済みです。";
    }
    if (state.ruleBookSheetUrl) {
      rulebookUrlInput.value = state.ruleBookSheetUrl;
      rulebookStatus.textContent = "読み込み中...";
      try {
        const sheet = await window.HinbanReferee.rulebook.fetchRulebookSheet(state.ruleBookSheetUrl);
        rulebookStatus.textContent = `読み込み済み（${sheet.rows.length}行）`;
        renderRulebookColumnConfig(sheet, state.ruleBookColumnMap);
      } catch (err) {
        console.error(err);
        rulebookStatus.textContent = "前回保存したURLの読み込みに失敗しました: " + (err && err.message ? err.message : String(err));
      }
    }
    if (state.logWebhookUrl) {
      logWebhookUrlInput.value = state.logWebhookUrl;
      logWebhookStatus.textContent = "実績記録は有効です。";
    }
    registerLockCheckbox.checked = !!state.registerLockEnabled;
  }

  init();
})();
