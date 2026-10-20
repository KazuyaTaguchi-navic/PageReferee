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

  // 今開いている画面がどちらのサブ画面か（どちらでもなければnull）
  function detectSubpageType(doc) {
    if (doc.getElementById("rakutenGenreEntryForm")) return "genre";
    if (doc.getElementById("rakutenSkuEntryForm")) return "sku";
    return null;
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

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.subpages = { buildSubpageUrls, detectSubpageType, pageCompanyCode, parseSkuPage, parseGenrePage };
})(typeof window !== "undefined" ? window : globalThis);
