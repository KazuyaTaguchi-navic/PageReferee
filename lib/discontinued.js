// 廃盤処理モード。
// メイン画面の入力内容が、廃盤処理で決まっている値になっているかを確認する。
// 管理表・重大度設定は使わない（指摘は固定でレッド。手順②の案内だけイエロー）。
(function (global) {
  "use strict";

  const root = (global.HinbanReferee = global.HinbanReferee || {});
  const storage = root.storage;

  const OUT_SUFFIX = "-out";
  const CATCHCOPY = "<B>【メーカー生産終了いたしました】</B>";
  const SOLD_OUT_TIMING_NO = "12"; // 在庫切れ時納期情報「大好評につき完売しました！」の管理番号（楽天・Yahoo!共通）
  const STANDARD_LIST_URL = "https://docs.google.com/spreadsheets/d/16eyFsnJOD6rmDvw292_z4UaU-Qe_Qyi-/edit?gid=1270282900#gid=1270282900";

  // 廃盤処理で追加で読む項目（通常のページ作成では使わない）。DOM取得・クリック時の移動先に使うため、
  // 既定のフィールドマップに足しておく（content.js側は既定のマップを使うので、読み込み順はstorage.jsの後）。
  const EXTRA_FIELDS = {
    商品種別: { type: "single", selector: "#hin_kind", attr: "value" },
    楽天在庫切れ時注文受付: { type: "single", selector: '[name="no_stock_order"]:checked', attr: "value" },
    楽天PC用キャッチコピー: { type: "single", selector: "#pc_catchcopy", attr: "value" },
  };
  if (storage && storage.DEFAULT_FIELD_MAP) {
    Object.assign(storage.DEFAULT_FIELD_MAP, EXTRA_FIELDS);
  }

  const GOODS_KIND_LABELS = { "0": "通常", "1": "限定商品", "2": "廃盤商品" };
  const NO_STOCK_ORDER_LABELS = { "0": "受付けない", "1": "受付ける" };
  const ORDER_BUTTON_LABELS = { "0": "ボタンをつけない", "1": "ボタンをつける" };
  const YAHOO_DISPLAY_LABELS = { "0": "非公開", "1": "公開" };

  const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
  const shown = (v) => (text(v) === "" ? "(空欄)" : text(v));
  const labelOf = (labels, v) => (text(v) === "" ? "(未選択)" : labels[text(v)] || text(v));
  const isChecked = (v) => v === true || v === "true";

  function red(key, message, extra) {
    return Object.assign({ key, severity: "red", message }, extra || {});
  }

  // domValues: content.jsのcollectDomValuesの戻り値（__skuRowsを含む）
  // 戻り値: findingの配列（{ key, targetKey?, severity, message, copyValue?, linkUrl? }）
  function runChecks(domValues) {
    const findings = [];
    const add = (f) => findings.push(f);

    // --- item data ---
    const makerCode = text(domValues["メーカー品番"]);
    if (!makerCode.endsWith(OUT_SUFFIX)) {
      add(
        red(
          "discontinued_maker_code",
          `「メーカー品番」の末尾に「${OUT_SUFFIX}」がついていません（現在: ${shown(makerCode)}）。廃盤処理では末尾に「${OUT_SUFFIX}」をつけます`,
          { targetKey: "メーカー品番", copyValue: OUT_SUFFIX }
        )
      );
    }

    if (text(domValues["商品種別"]) !== "2") {
      add(
        red(
          "discontinued_goods_kind",
          `「商品種別」が「廃盤商品」になっていません（現在: ${labelOf(GOODS_KIND_LABELS, domValues["商品種別"])}）`,
          { targetKey: "商品種別" }
        )
      );
    }

    [
      ["楽天掲載", "楽天", true],
      ["Yahoo掲載", "Yahoo!", true],
      ["Amazon掲載", "Amazon", false],
      ["ヤフオク掲載", "ヤフオク", false],
      ["新ヤフオク掲載", "新ヤフオク", false],
    ].forEach(([key, label, expected]) => {
      if (isChecked(domValues[key]) !== expected) {
        add(
          red(
            "discontinued_flag_" + key,
            `サイト掲載フラグ「${label}」は${expected ? "チェックが必要です（楽天とYahoo!のみチェックします）" : "チェックを外す必要があります（楽天とYahoo!のみチェックします）"}`,
            { targetKey: key }
          )
        );
      }
    });

    // --- 楽天 ---
    if (text(domValues["楽天在庫切れ時注文受付"]) !== "0") {
      add(
        red(
          "discontinued_rakuten_no_stock_order",
          `楽天の「在庫切れ時の注文受付」が「受付けない」になっていません（現在: ${labelOf(NO_STOCK_ORDER_LABELS, domValues["楽天在庫切れ時注文受付"])}）`,
          { targetKey: "楽天在庫切れ時注文受付" }
        )
      );
    }

    if (text(domValues["楽天在庫切れ時納期"]) !== SOLD_OUT_TIMING_NO) {
      add(
        red(
          "discontinued_rakuten_outstock_timing",
          `楽天の「在庫切れ時納期情報」が「大好評につき完売しました！」になっていません（現在: ${shown(domValues["楽天在庫切れ時納期文言"])}）`,
          { targetKey: "楽天在庫切れ時納期" }
        )
      );
    }

    if (text(domValues["楽天注文ボタン"]) !== "0") {
      add(
        red(
          "discontinued_rakuten_order_button",
          `楽天の「注文ボタン」が「ボタンをつけない」になっていません（現在: ${labelOf(ORDER_BUTTON_LABELS, domValues["楽天注文ボタン"])}）`,
          { targetKey: "楽天注文ボタン" }
        )
      );
    }

    if (text(domValues["楽天PC用キャッチコピー"]) !== CATCHCOPY) {
      add(
        red(
          "discontinued_rakuten_catchcopy",
          `楽天の「PC用キャッチコピー」が ${CATCHCOPY} になっていません（現在: ${shown(domValues["楽天PC用キャッチコピー"])}）`,
          { targetKey: "楽天PC用キャッチコピー", copyValue: CATCHCOPY }
        )
      );
    }

    // --- ヤフー ---
    if (text(domValues["ヤフーページ公開"]) !== "0") {
      add(
        red(
          "discontinued_yahoo_display",
          `ヤフーの「ページ公開」が「非公開」になっていません（現在: ${labelOf(YAHOO_DISPLAY_LABELS, domValues["ヤフーページ公開"])}）`,
          { targetKey: "ヤフーページ公開" }
        )
      );
    }

    if (text(domValues["Yahoo在庫切れ時納期"]) !== SOLD_OUT_TIMING_NO) {
      add(
        red(
          "discontinued_yahoo_outstock_timing",
          `ヤフーの「在庫なし時発送日情報（管理番号）」が「${SOLD_OUT_TIMING_NO}」になっていません（現在: ${shown(domValues["Yahoo在庫切れ時納期"])}）`,
          { targetKey: "Yahoo在庫切れ時納期", copyValue: SOLD_OUT_TIMING_NO }
        )
      );
    }

    // --- sku data（行ごと。キーを sku_..._行番号 にすると、クリックでその行へ移動する） ---
    const skuRows = domValues.__skuRows || [];
    const nonZeroOrderPoints = [];
    skuRows.forEach((row, idx) => {
      const rowLabel = `SKU情報 ${idx + 1}行目`;
      // 発注種別の欄は発注機能が有効なときだけ画面にあるため、欄が無い（undefined）場合は確認しない
      if (row.orderType !== undefined && text(row.orderType) !== "") {
        add(red(`sku_discontinued_ordertype_${idx}`, `${rowLabel}の「発注種別」が空白になっていません（現在: ${shown(row.orderTypeText || row.orderType)}）`));
      }
      if (text(row.maxPoint) !== "0") {
        add(red(`sku_discontinued_maxpoint_${idx}`, `${rowLabel}の「最高点」が0になっていません（現在: ${shown(row.maxPoint)}）`, { copyValue: "0" }));
      }
      if (text(row.orderPoint) !== "0") {
        add(red(`sku_discontinued_orderpoint_${idx}`, `${rowLabel}の「発注点」が0になっていません（現在: ${shown(row.orderPoint)}）`, { copyValue: "0" }));
      }
      if (text(row.orderPoint) !== "" && text(row.orderPoint) !== "0") nonZeroOrderPoints.push({ idx, value: text(row.orderPoint) });
    });

    // --- 手順②: 発注点が0でない場合は、定番更新リストへ記載する ---
    if (nonZeroOrderPoints.length) {
      const detail = nonZeroOrderPoints.map((p) => `${p.idx + 1}行目: ${p.value}`).join(" / ");
      add({
        key: `sku_standard_list_${nonZeroOrderPoints[0].idx}`,
        severity: "yellow",
        message: `発注点が0ではありません（${detail}）。手順②: 発注点が0でない商品は、発注点を0に直す前に「定番更新リスト」へ記載してください`,
        linkUrl: STANDARD_LIST_URL,
        linkLabel: "定番更新リストを開く",
      });
    }

    return findings;
  }

  root.discontinued = { runChecks, EXTRA_FIELDS, STANDARD_LIST_URL, CATCHCOPY, OUT_SUFFIX };
})(typeof window !== "undefined" ? window : globalThis);
