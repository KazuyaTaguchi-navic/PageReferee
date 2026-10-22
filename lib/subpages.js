// 楽天「SKU別 商品情報」「商品属性設定」画面（メイン画面のボタンから別タブで開く画面）の
// 読み取り処理。メイン画面からは中身が見えないため、content.js側で同じURLをfetchして
// 保存済みの内容を取得し、ここでDocumentから判定用のプレーンなデータに変換する
// （DOMParser/jsdomどちらのDocumentでも動くよう、DOM APIだけを使う）。
(function (global) {
  "use strict";

  // メイン画面（{テナント}/master/goods/goods_control.php）からの相対パス。
  // メイン画面のナビゲーション自体が「../../master/…」形式でリンクしているのに合わせる。
  function buildSubpageUrls(companyCode, baseHref) {
    const code = encodeURIComponent(companyCode);
    const query = `searchType=dataCall&entryType=shw&company_product_code=${code}`;
    return {
      skuUrl: new URL(`../../master/rakuten_sku/rakuten_sku_control.php?job=rakutenSkuEntry&${query}`, baseHref).href,
      genreUrl: new URL(`../../master/rakuten_genre/rakuten_genre_control.php?job=rakutenGenreEntry&${query}`, baseHref).href,
    };
  }

  function pageCompanyCode(doc) {
    const hidden = doc.querySelector('input[name="company_product_code"]');
    return hidden ? (hidden.getAttribute("value") || "").trim() : "";
  }

  // ログイン切れ等で別の画面（ログイン画面・エラー画面）が返ってきた場合に、空欄扱いで
  // 誤ってレッドにしないよう、想定した画面かどうかを確かめてから読み取る。
  function checkExpectedPage(doc, formId, expectedCompanyCode) {
    if (!doc.getElementById(formId)) {
      return "想定した画面が返ってきませんでした（ログインが切れている可能性があります）";
    }
    const code = pageCompanyCode(doc);
    if (expectedCompanyCode && code && code !== expectedCompanyCode) {
      return `別の商品（${code}）の画面が返ってきました`;
    }
    return null;
  }

  // 今開いている画面がどのサブ画面か（どれでもなければnull）。
  // "set"はセット構成の一覧・編集画面（どちらもset_control.phpへ送信するフォームを持つ）。
  function detectSubpageType(doc) {
    if (doc.getElementById("rakutenGenreEntryForm")) return "genre";
    if (doc.getElementById("rakutenSkuEntryForm")) return "sku";
    if (doc.querySelector('form#searchForm[action*="set_control.php"], form#entryForm[action*="set_control.php"]')) {
      return "set";
    }
    return null;
  }

  // メイン画面（商品情報の登録画面）かどうか。セット構成の編集画面もフォームのidは同じ
  // 「entryForm」で、登録ボタンも同じname/classのため、送信先で見分ける。
  function isGoodsEntryPage(doc) {
    return !!doc.querySelector('form#entryForm[action*="goods_control.php"]');
  }

  // 入力欄の値の読み方。fetchで読み込んだ画面（保存済みの内容）はHTMLの属性を読む。
  // 今開いている画面そのもの（options.live）は、まだ「更新」していない入力中の内容で
  // 判定したいので、入力欄の現在の値（value・checked・選択中の項目）を読む。
  const SAVED_VALUE_READER = {
    text: (el) => (el.tagName.toLowerCase() === "textarea" ? el.textContent : el.getAttribute("value") || ""),
    selected: (el) => {
      const opt = el.querySelector("option[selected]");
      return opt ? opt.getAttribute("value") || "" : "";
    },
    checked: (el) => el.hasAttribute("checked"),
  };
  const LIVE_VALUE_READER = {
    text: (el) => el.value || "",
    selected: (el) => el.value || "",
    checked: (el) => !!el.checked,
  };

  // 戻り値: { ok: true, skus: [{ skuCode, skuManageNo }] } / { ok: false, error }
  // options.liveのときは、指摘から入力欄へ移動できるよう各SKUに入力欄のname（targetName）も付ける。
  function parseSkuPage(doc, expectedCompanyCode, options) {
    const live = !!(options && options.live);
    const error = checkExpectedPage(doc, "rakutenSkuEntryForm", expectedCompanyCode);
    if (error) return { ok: false, error };
    const skus = [];
    doc.querySelectorAll('input[name^="r__sku_id||"]').forEach((el) => {
      if ((el.getAttribute("type") || "").toLowerCase() === "hidden") return;
      const name = el.getAttribute("name");
      const sku = {
        skuCode: name.slice("r__sku_id||".length),
        skuManageNo: (live ? LIVE_VALUE_READER : SAVED_VALUE_READER).text(el).trim(),
      };
      if (live) sku.targetName = name;
      skus.push(sku);
    });
    return { ok: true, skus };
  }

  // 1つのセル（1SKU分）の入力欄群から「入力済みか」を判定する。
  // 数値＋単位のように1セルに複数の欄がある場合、単位のプルダウンは初期値が選ばれている
  // ことがあるため、テキスト系の欄があればそちらを優先して判定する。
  // live（今開いている画面）のときは、指摘から移動する先として判定に使った最初の入力欄の
  // name（targetName）も返す。
  function summarizeCellControls(controls, live) {
    const reader = live ? LIVE_VALUE_READER : SAVED_VALUE_READER;
    const withTarget = (summary, el) => (live && el ? Object.assign(summary, { targetName: el.getAttribute("name") }) : summary);
    const textLike = controls.filter((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return tag === "textarea" || (tag === "input" && !["radio", "checkbox"].includes(type));
    });
    if (textLike.length) {
      const values = textLike
        .map((el) => reader.text(el))
        .map((v) => v.trim())
        .filter(Boolean);
      return withTarget({ filled: values.length > 0, value: values.join(" ") }, textLike[0]);
    }
    const selects = controls.filter((el) => el.tagName.toLowerCase() === "select");
    const selected = selects.map((el) => reader.selected(el).trim()).filter(Boolean);
    const checked = controls
      .filter((el) => el.tagName.toLowerCase() === "input" && reader.checked(el))
      .map((el) => (el.getAttribute("value") || "").trim())
      .filter(Boolean);
    const values = selected.concat(checked);
    return withTarget({ filled: values.length > 0, value: values.join(" ") }, controls[0]);
  }

  // 戻り値: { ok: true, genres: [{ genreId, genreName, rows: [{ label, required, bySku: { [sku]: { filled, value } } }] }] }
  //        / { ok: false, error }
  // 「※過去に紐付けがあったジャンル」（タブにgenreDisabledが付いたもの）は現在使われて
  // いないため対象外にする。options.liveについてはparseSkuPage・summarizeCellControlsを参照。
  function parseGenrePage(doc, expectedCompanyCode, options) {
    const live = !!(options && options.live);
    const error = checkExpectedPage(doc, "rakutenGenreEntryForm", expectedCompanyCode);
    if (error) return { ok: false, error };

    const disabledPaneIds = new Set();
    doc.querySelectorAll(".nav-link[data-bs-target]").forEach((link) => {
      if (link.classList.contains("genreDisabled")) {
        disabledPaneIds.add(link.getAttribute("data-bs-target").replace(/^#/, ""));
      }
    });

    const genres = [];
    doc.querySelectorAll(".tab-pane[data-genre-id]").forEach((pane) => {
      if (disabledPaneIds.has(pane.id)) return;
      const genreNameEl = pane.querySelector(".genreName");
      const genreName = genreNameEl ? genreNameEl.textContent.replace(/^\s*ジャンル名：/, "").trim() : "";
      const rows = [];
      pane.querySelectorAll("table tbody tr").forEach((tr) => {
        const th = tr.querySelector("th");
        if (!th) return;
        const label = th.textContent.replace(/\s+/g, " ").trim();
        if (!label) return;
        const controlsBySku = {};
        tr.querySelectorAll("input, select, textarea").forEach((el) => {
          if ((el.getAttribute("type") || "").toLowerCase() === "hidden") return;
          const m = (el.getAttribute("name") || "").match(/^g\d+__[^|]+\|\|(.+)$/);
          if (!m) return;
          (controlsBySku[m[1]] = controlsBySku[m[1]] || []).push(el);
        });
        const bySku = {};
        Object.keys(controlsBySku).forEach((sku) => {
          bySku[sku] = summarizeCellControls(controlsBySku[sku], live);
        });
        if (!Object.keys(bySku).length) return;
        rows.push({ label, required: th.classList.contains("required"), bySku });
      });
      genres.push({ genreId: pane.getAttribute("data-genre-id"), genreName, rows });
    });
    return { ok: true, genres };
  }

  // ---------- セット構成（メイン画面の「セット構成の登録」ボタンから開く画面）----------
  // 一覧（setSearch）で登録の有無と、親SKUごとの編集画面へのリンクを読む。
  // 構成品の突き合わせには、子商品のメーカー品番がそのまま載っている編集画面（setEntry）を使う
  // （一覧には子商品名しか無く、名前から品番を探すとXB130とXB130BKのような色違いを取り違えるため）。

  // ボタンと同じ一覧画面のURL（メイン画面のボタンは「../set/set_control.php?…」）
  function buildSetSearchUrl(companyCode, baseHref) {
    const code = encodeURIComponent(companyCode);
    return new URL(
      `../../master/set/set_control.php?job=setSearch&searchType=normal&seek_company_product_code=${code}&seek_company_product_code2=${code}`,
      baseHref
    ).href;
  }

  function cellText(cell) {
    return cell ? cell.textContent.replace(/\s+/g, " ").trim() : "";
  }

  // 一覧の見出しは並べ替え用のボタン（value）か、ラベルの文字。全角の「ＳＫＵ」「／」はそろえる。
  function headerLabel(th) {
    const button = th.querySelector('input[type="button"]');
    const text = button ? button.getAttribute("value") || "" : th.textContent;
    return text.normalize("NFKC").replace(/\s+/g, "");
  }

  // onclick="window.open('set_control.php?job=setEntry&…')" の中のURL
  function windowOpenUrl(el) {
    const m = ((el && el.getAttribute("onclick")) || "").match(/window\.open\(\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  }

  function toQuantity(text) {
    const t = String(text || "").normalize("NFKC").trim();
    return /^\d+$/.test(t) ? parseInt(t, 10) : null;
  }

  // 一覧の表は、親の列（有効・親自社品番・親SKU…）が子の行数分rowspanでまとめられている。
  // rowspanを展開して、どの行でも見出しと同じ数のセルがそろうようにする。
  function expandRowspans(trs, columnCount) {
    const carried = [];
    return trs.map((tr) => {
      const tds = Array.from(tr.children).filter((el) => el.tagName.toLowerCase() === "td");
      const cells = [];
      for (let c = 0; c < columnCount; c++) {
        if (carried[c] && carried[c].remaining > 0) {
          cells[c] = carried[c].cell;
          carried[c].remaining -= 1;
          continue;
        }
        const cell = tds.shift();
        if (!cell) break;
        cells[c] = cell;
        const span = parseInt(cell.getAttribute("rowspan") || "1", 10);
        carried[c] = span > 1 ? { cell, remaining: span - 1 } : null;
      }
      return cells;
    });
  }

  // 戻り値: { ok: true, groups: [{ parentCode, parentSku, entryUrl, children: [{ code, sku, name, qty }] }] }
  //        / { ok: false, error }
  // 検索は部分一致になる場合もあるため、親自社品番が一致するものだけを返す（1件も無ければ未登録）。
  // baseHrefは一覧画面のURL（編集画面へのリンクが相対パスのため）。
  function parseSetSearchPage(doc, expectedCompanyCode, baseHref) {
    if (!doc.querySelector('form#searchForm[action*="set_control.php"]')) {
      return { ok: false, error: "想定した画面が返ってきませんでした（ログインが切れている可能性があります）" };
    }
    const table = doc.querySelector("#resultForm table.resultTable");
    if (!table) return { ok: true, groups: [] };
    const trs = Array.from(table.querySelectorAll("tr"));
    const headerRow = trs.find((tr) => tr.querySelector("th"));
    if (!headerRow) return { ok: true, groups: [] };
    const labels = Array.from(headerRow.children).map(headerLabel);
    const cols = {
      parentCode: labels.indexOf("親自社品番"),
      parentSku: labels.indexOf("親SKU"),
      childCode: labels.indexOf("子自社品番"),
      childSku: labels.indexOf("子SKU"),
      childName: labels.findIndex((label) => label.startsWith("子商品名")),
      qty: labels.indexOf("セット数"),
    };
    const missingColumn = Object.keys(cols).find((k) => cols[k] < 0);
    if (missingColumn) {
      return { ok: false, error: "セット構成の一覧の見出しが想定と違うため読み取れませんでした" };
    }

    const expected = String(expectedCompanyCode || "").trim().toLowerCase();
    const groups = [];
    const dataRows = trs.filter((tr) => tr !== headerRow && !tr.querySelector("th"));
    expandRowspans(dataRows, labels.length).forEach((cells) => {
      const parentCode = cellText(cells[cols.parentCode]);
      const parentSku = cellText(cells[cols.parentSku]);
      if (!parentCode || (expected && parentCode.toLowerCase() !== expected)) return;
      let group = groups.find((g) => g.parentCode === parentCode && g.parentSku === parentSku);
      if (!group) {
        const href = windowOpenUrl(cells[cols.parentSku] && cells[cols.parentSku].querySelector("a[onclick]"));
        group = { parentCode, parentSku, entryUrl: href ? new URL(href, baseHref).href : null, children: [] };
        groups.push(group);
      }
      const childCode = cellText(cells[cols.childCode]);
      if (!childCode) return;
      group.children.push({
        code: childCode,
        sku: cellText(cells[cols.childSku]),
        name: cellText(cells[cols.childName]),
        qty: toQuantity(cellText(cells[cols.qty])),
      });
    });
    return { ok: true, groups };
  }

  // 戻り値: { ok: true, parentCode, parentSku, children: [{ code, sku, name, makerCode, qty, qtyText }] }
  //        / { ok: false, error }
  // 子商品の行はhiddenの入力欄（set_product_code[]等）と数量の入力欄（set_su[]）で構成される。
  // 先頭の中身が空の行は「商品追加」で使うひな形なので対象外。qtyは数字以外・空欄ならnull。
  function parseSetEntryPage(doc, expectedParentSku) {
    const form = doc.querySelector('form#entryForm[action*="set_control.php"]');
    if (!form || !doc.getElementById("detailsTable")) {
      return { ok: false, error: "想定した画面が返ってきませんでした（ログインが切れている可能性があります）" };
    }
    const valueIn = (root, name) => {
      const el = root.querySelector(`input[name="${name}"]`);
      return el ? SAVED_VALUE_READER.text(el).trim() : "";
    };
    const parentSku = valueIn(form, "sku_code");
    if (expectedParentSku && parentSku && parentSku !== expectedParentSku) {
      return { ok: false, error: `別のセット（親SKU: ${parentSku}）の画面が返ってきました` };
    }
    const children = [];
    doc.querySelectorAll("#detailsTable tr").forEach((tr) => {
      const code = valueIn(tr, "set_product_code[]");
      if (!code) return;
      const qtyText = valueIn(tr, "set_su[]");
      children.push({
        code,
        sku: valueIn(tr, "set_sku_code[]"),
        name: valueIn(tr, "product_name[]"),
        makerCode: valueIn(tr, "maker_product_code[]"),
        qty: toQuantity(qtyText),
        qtyText,
      });
    });
    return { ok: true, parentCode: valueIn(form, "company_product_code"), parentSku, children };
  }

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.subpages = {
    buildSubpageUrls,
    buildSetSearchUrl,
    detectSubpageType,
    isGoodsEntryPage,
    pageCompanyCode,
    parseSkuPage,
    parseGenrePage,
    parseSetSearchPage,
    parseSetEntryPage,
  };
})(typeof window !== "undefined" ? window : globalThis);
