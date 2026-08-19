// 比較ルールエンジン（プレーンスクリプト。content.js から window.HinbanReferee.rules として利用する）
(function (global) {
  "use strict";

  const WIDE_DIGITS = "０１２３４５６７８９";

  function toHalfWidthDigits(str) {
    return String(str).replace(/[０-９]/g, (ch) => String(WIDE_DIGITS.indexOf(ch)));
  }

  // 価格・品番などの正規化比較用: 全角数字→半角、カンマ・空白除去、大文字小文字統一
  function normalizeForCompare(value) {
    if (value === null || value === undefined) return "";
    let s = String(value);
    s = toHalfWidthDigits(s);
    s = s.replace(/[，,]/g, "");
    s = s.replace(/\s+/g, "");
    s = s.trim().toLowerCase();
    return s;
  }

  // 説明文などの自由テキスト走査用: 改行・全角スペースは残しつつ軽く正規化
  function normalizeText(value) {
    if (value === null || value === undefined) return "";
    return toHalfWidthDigits(String(value));
  }

  function valuesEqual(a, b) {
    const na = normalizeForCompare(a);
    const nb = normalizeForCompare(b);
    if (na === "" && nb === "") return true;
    return na === nb;
  }

  // productSheetConfigs: [{ sheetName, columnMap: { logicalKey: headerName } }]
  // managementWorkbook.sheets: { [sheetName]: { headers: [...], rows: [ {header: value, ...} ] } }
  function findManagementRow(companyCode, managementWorkbook, productSheetConfigs) {
    if (!managementWorkbook || !productSheetConfigs) return null;
    const target = normalizeForCompare(companyCode);
    if (!target) return null;

    for (const cfg of productSheetConfigs) {
      const sheet = managementWorkbook.sheets[cfg.sheetName];
      const codeHeader = cfg.columnMap && cfg.columnMap["自社品番"];
      if (!sheet || !codeHeader) continue;

      for (const row of sheet.rows) {
        if (normalizeForCompare(row[codeHeader]) === target) {
          return { sheetName: cfg.sheetName, columnMap: cfg.columnMap, row };
        }
      }
    }
    return null;
  }

  // tagSheetConfig: { sheetName, columnMap: { 自社品番, タグ, メーカー, 車種名, カテゴリ } }
  function getRequiredTags(companyCode, tagWorkbook, tagSheetConfig) {
    if (!tagWorkbook || !tagSheetConfig) return [];
    const sheet = tagWorkbook.sheets[tagSheetConfig.sheetName];
    const codeHeader = tagSheetConfig.columnMap && tagSheetConfig.columnMap["自社品番"];
    const tagHeader = tagSheetConfig.columnMap && tagSheetConfig.columnMap["タグ"];
    if (!sheet || !codeHeader || !tagHeader) return [];

    const target = normalizeForCompare(companyCode);
    const tags = [];
    for (const row of sheet.rows) {
      if (normalizeForCompare(row[codeHeader]) === target) {
        const tag = row[tagHeader];
        if (tag) tags.push(String(tag).trim());
      }
    }
    return Array.from(new Set(tags));
  }

  // dictConfig: { sheetName, columnMap: { 車種, 車種正式名称, カテゴリ, タグ } }
  // 商品名・説明文などの自由テキストに車種名が含まれるかをキーワード一致で調べ、
  // 該当しそうなタグを候補として返す（APIなしの簡易推定。最終判断は人が行う前提）。
  function getTagCandidates(text, tagWorkbook, dictConfig, excludeTags) {
    if (!tagWorkbook || !dictConfig) return [];
    const sheet = tagWorkbook.sheets[dictConfig.sheetName];
    const columnMap = dictConfig.columnMap || {};
    const tagHeader = columnMap["タグ"];
    const carHeader = columnMap["車種"];
    const carFormalHeader = columnMap["車種正式名称"];
    const categoryHeader = columnMap["カテゴリ"];
    if (!sheet || !tagHeader || (!carHeader && !carFormalHeader)) return [];

    const haystack = normalizeText(text).toLowerCase();
    if (!haystack) return [];
    const exclude = new Set((excludeTags || []).map((t) => normalizeForCompare(t)));
    const seenTagKeyword = new Set();
    const candidates = [];

    for (const row of sheet.rows) {
      const tag = row[tagHeader];
      if (!tag) continue;
      if (exclude.has(normalizeForCompare(tag))) continue;

      // 「アルファード/ヴェルファイア」のような複合名は区切りごとに分けて、
      // どちらか一方の車種名だけが商品名に出てくる場合も拾えるようにする
      const rawKeywords = [carHeader ? row[carHeader] : null, carFormalHeader ? row[carFormalHeader] : null].filter(
        Boolean
      );
      const keywords = [];
      rawKeywords.forEach((raw) => {
        String(raw)
          .split(/[\/／・,、]+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 2)
          .forEach((s) => keywords.push(s));
      });

      for (const kw of keywords) {
        const needle = normalizeText(kw).toLowerCase();
        if (!needle || !haystack.includes(needle)) continue;
        const dedupeKey = normalizeForCompare(tag) + "|" + needle;
        if (seenTagKeyword.has(dedupeKey)) continue;
        seenTagKeyword.add(dedupeKey);
        candidates.push({
          tag: String(tag).trim(),
          category: categoryHeader ? row[categoryHeader] || "" : "",
          matchedKeyword: kw,
        });
        break; // 同じタグ行につき1回計上すれば十分
      }
    }
    return candidates;
  }

  function parseItemTags(rawValue) {
    if (!rawValue) return [];
    return String(rawValue)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const RAKUTEN_HOST_RE = /rakuten\.(co\.jp|ne\.jp)/i;
  const YAHOO_HOST_RE = /(yahoo\.co\.jp|yimg\.jp)/i;

  function findUrlsMatching(text, hostRe) {
    if (!text) return [];
    const urlRe = /https?:\/\/[^\s"'<>)]+/g;
    const found = [];
    let m;
    while ((m = urlRe.exec(text))) {
      if (hostRe.test(m[0])) found.push(m[0]);
    }
    return found;
  }

  function isZeroOrEmpty(value) {
    if (value === undefined || value === null || value === "") return true;
    const n = normalizeForCompare(value);
    return n === "" || n === "0";
  }

  // urlTemplates: { rakuten: "https://.../{code}", yahoo: "https://.../{code}" }
  function buildMallUrl(template, companyCode) {
    if (!template || !companyCode) return null;
    return template.replace("{code}", companyCode);
  }

  // domValues: { logicalKey: string値 }（フィールドマッピングに従いcontent.js側で取得済み）
  // copySourceMatch: managementMatchの「コピー元」列の値（コピー元商品の自社品番）で
  //   findManagementRowを引いた結果（コピー元商品自体の管理表行）。無ければnull。
  // equalityPairs: [{ domKey, mgmtKey, isAmount }] DOM項目と管理表の列論理名の対応
  // fixedRuleChecks: [{ domKey, expectedValue, expectedChecked, message }] 新規登録時の固定ルール
  // freeTextKeys: { rakuten: [logicalKey...], yahoo: [logicalKey...] } 自由テキスト系の論理キー
  // urlTemplates: { rakuten, yahoo } 正しいモールURLのひな形（{code}が自社品番に置き換わる）
  function runChecks(params) {
    const {
      domValues,
      managementMatch,
      copySourceMatch,
      requiredTags,
      severityMap,
      equalityPairs,
      fixedRuleChecks,
      freeTextKeys,
      copySourceLogicalKeys,
      urlTemplates,
    } = params;

    const findings = [];

    // severityKeyは重大度設定（severityMap）を引くためのキー。copy_residue_商品名のような
    // 合成キー（key）は一覧表示や該当箇所へのスクロールのために別々にしているだけなので、
    // 重大度は元の項目名（severityKey、省略時はkeyそのもの）で引く。
    // severityMap[severityKey]が"none"の場合はユーザーがこのチェックを無効化しているので
    // 検出結果自体を出さない。
    // targetKey（=severityKey||key）はcontent.js側で該当箇所へスクロールする際、
    // fieldMapを直接引くためのキーとしても使う（合成キーからの逆算に頼らないようにする）。
    function addFinding(key, message, fallbackSeverity, extra, severityKey) {
      const resolvedSeverityKey = severityKey || key;
      const configured = severityMap && severityMap[resolvedSeverityKey];
      if (configured === "none") return;
      findings.push(
        Object.assign(
          {
            key,
            targetKey: resolvedSeverityKey,
            severity: configured || fallbackSeverity || "yellow",
            message,
          },
          extra || {}
        )
      );
    }

    // 1. 完全一致（正規化比較・管理表の列マッピングに基づく明示的な組み合わせ）
    if (managementMatch) {
      for (const pair of equalityPairs || []) {
        const header = managementMatch.columnMap[pair.mgmtKey];
        if (!header) continue; // 列マッピング未設定の項目はスキップ
        const expected = managementMatch.row[header];
        const actual = domValues[pair.domKey];

        if (isZeroOrEmpty(expected)) {
          if (pair.isAmount) {
            // 金額は超重要項目。管理表が空欄/0の場合は差異チェックではなく要確認として報告する
            addFinding(
              pair.domKey,
              `「${pair.domKey}」に対応する管理表「${pair.mgmtKey}」が空欄または0です。金額は超重要項目のため管理者に確認してください`,
              "red"
            );
          }
          continue;
        }

        // 4-1.Yahoo!ショッピングページ作成マニュアル [5]定価より:
        // 「定価よりも売価のほうが高い場合やオープン価格の場合は空白で登録をする」ため、
        // ヤフー定価がページ上で空欄なのは、管理表の売価税込が定価税込以上であれば正しい状態。
        // その場合は不一致として報告しない。
        if (pair.domKey === "ヤフー定価" && isZeroOrEmpty(actual)) {
          const saleHeader = managementMatch.columnMap["売価税込"];
          const saleValue = saleHeader ? managementMatch.row[saleHeader] : null;
          if (!isZeroOrEmpty(saleValue) && Number(normalizeForCompare(saleValue)) >= Number(normalizeForCompare(expected))) {
            continue;
          }
        }

        if (!valuesEqual(actual, expected)) {
          addFinding(
            pair.domKey,
            `「${pair.domKey}」が管理表の「${pair.mgmtKey}」と一致しません（ページ: ${actual === undefined || actual === null || actual === "" ? "(空欄)" : actual} / 管理表: ${expected}）`,
            "red",
            { copyValue: expected }
          );
        }
      }

      // 1b. シリーズ整合性（ソフトチェック）: 管理表のシリーズ名が商品名に含まれているか
      const seriesHeader = managementMatch.columnMap["シリーズ"];
      const seriesValue = seriesHeader ? managementMatch.row[seriesHeader] : null;
      if (seriesValue && String(seriesValue).trim()) {
        const seriesNeedle = normalizeText(seriesValue).toLowerCase();
        const productNameText = normalizeText(domValues["商品名"] || "").toLowerCase();
        if (seriesNeedle && !productNameText.includes(seriesNeedle)) {
          addFinding(
            "シリーズ整合性",
            `商品名に管理表のシリーズ「${seriesValue}」が含まれていないようです。本当にその商品名でよいか管理表を確認してください`,
            "yellow"
          );
        }
      }

      // 2. 残存チェック（コピー元照合）
      // 管理表の「コピー元」列にはコピー元商品の自社品番が入っている。それだけでなく、
      // コピー元商品自体の管理表行を引いて「品番」も突き合わせる（自社品番の文字列だけでなく
      // 「R147RO」のように品番だけが単独で残っているケースもあるため）。
      // 管理表は毎月更新されるため、コピー元が数年前に作られた商品だと最新の管理表には
      // 存在しないことが多い（copySourceMatchがnullになる）。その場合でも、自社品番は
      // 基本的に「メーカー名-品番」の形式（1.通販する蔵の商品マスター作成マニュアル [2]）
      // で作られているため、ハイフン以降の部分を品番の推定値として使う。
      const copySourceHeader = managementMatch.columnMap["コピー元"];
      const copySource = copySourceHeader ? managementMatch.row[copySourceHeader] : null;
      if (copySource) {
        const needles = [{ label: "自社品番", value: copySource }];
        let mgmtPartNo = null;
        if (copySourceMatch) {
          const partNoHeader = copySourceMatch.columnMap["品番"];
          mgmtPartNo = partNoHeader ? copySourceMatch.row[partNoHeader] : null;
        }
        if (mgmtPartNo && !valuesEqual(mgmtPartNo, copySource)) {
          needles.push({ label: "品番", value: mgmtPartNo });
        } else {
          // 管理表にコピー元が見つからない場合の推定: 自社品番の最初のハイフン以降を
          // 品番候補とする（例: "bride-r147ro" → "R147RO"）。数字を含み4文字以上のときのみ
          // 採用し、短すぎる/一般的すぎる文字列による誤検出を避ける。
          const hyphenIdx = String(copySource).indexOf("-");
          if (hyphenIdx > 0) {
            const guessedPartNo = String(copySource).slice(hyphenIdx + 1);
            if (guessedPartNo.length >= 4 && /\d/.test(guessedPartNo)) {
              needles.push({ label: "品番（推定）", value: guessedPartNo.toUpperCase() });
            }
          }
        }
        for (const key of copySourceLogicalKeys || []) {
          const text = normalizeText(domValues[key] || "").toLowerCase();
          for (const needle of needles) {
            const n = normalizeText(needle.value).toLowerCase();
            if (n && text.includes(n)) {
              addFinding(
                `copy_residue_${key}`,
                `「${key}」内にコピー元の${needle.label}「${needle.value}」がそのまま残っています`,
                "yellow",
                {},
                key
              );
              break; // 同じ項目で複数のneedleが一致しても1件にまとめる
            }
          }
        }
      }
    }

    // 3. クロスモールURL混入チェック（正しいURLをコピーできるようにcopyValueを添える）
    const companyCodeForUrl = domValues["自社品番"];
    const correctYahooUrl = buildMallUrl(urlTemplates && urlTemplates.yahoo, companyCodeForUrl);
    const correctRakutenUrl = buildMallUrl(urlTemplates && urlTemplates.rakuten, companyCodeForUrl);

    for (const key of (freeTextKeys && freeTextKeys.yahoo) || []) {
      const urls = findUrlsMatching(domValues[key], RAKUTEN_HOST_RE);
      if (urls.length) {
        addFinding(
          `cross_url_yahoo_${key}`,
          `「${key}」（ヤフー側）に楽天のURLが混入しています: ${urls[0]}` +
            (correctYahooUrl ? `（正しいヤフーのURL: ${correctYahooUrl}）` : ""),
          "yellow",
          correctYahooUrl ? { copyValue: correctYahooUrl } : {},
          key
        );
      }
    }
    for (const key of (freeTextKeys && freeTextKeys.rakuten) || []) {
      const urls = findUrlsMatching(domValues[key], YAHOO_HOST_RE);
      if (urls.length) {
        addFinding(
          `cross_url_rakuten_${key}`,
          `「${key}」（楽天側）にヤフーのURLが混入しています: ${urls[0]}` +
            (correctRakutenUrl ? `（正しい楽天のURL: ${correctRakutenUrl}）` : ""),
          "yellow",
          correctRakutenUrl ? { copyValue: correctRakutenUrl } : {},
          key
        );
      }
    }

    // 4. 車種別タグ照合
    if (requiredTags && requiredTags.length) {
      const actualTags = parseItemTags(domValues["商品タグ"]);
      const actualSet = new Set(actualTags);
      const requiredSet = new Set(requiredTags);
      const missing = requiredTags.filter((t) => !actualSet.has(t));
      const extra = actualTags.filter((t) => !requiredSet.has(t));
      if (missing.length) {
        addFinding(
          "tag_missing",
          `車種別タグが不足しています: ${missing.join(", ")}`,
          "yellow",
          {},
          "商品タグ"
        );
      }
      if (extra.length) {
        addFinding(
          "tag_extra",
          `管理表にない車種別タグが設定されています: ${extra.join(", ")}`,
          "yellow",
          {},
          "商品タグ"
        );
      }
    }

    // 4b. 自社品番の形式チェック（1.通販する蔵の商品マスター作成マニュアル [2]自社品番）
    // 半角英数字とハイフンのみ・大文字/アンダーバー不可・2〜32文字
    const companyCode = domValues["自社品番"];
    if (companyCode && !/^[a-z0-9-]{2,32}$/.test(companyCode)) {
      addFinding(
        "company_code_format",
        `自社品番「${companyCode}」の形式が不正です（半角小文字英数字とハイフンのみ・大文字/アンダーバー不可・2〜32文字）`,
        "red",
        {},
        "自社品番"
      );
    }

    // 4c. Yahoo!の送料設定と送料無料アイコンの整合性
    // （4-1.Yahoo!ショッピングページ作成マニュアル [16]重量・[23]送料無料より）
    const shipCode = normalizeForCompare(domValues["Yahoo重量"]);
    const freeFlag = normalizeForCompare(domValues["Yahoo送料無料"]);
    if (shipCode && freeFlag) {
      if (shipCode === "0" && freeFlag === "1") {
        addFinding(
          "yahoo_shipping_mismatch_free_but_separate",
          "Yahoo!の「重量」が「0」（送料別）なのに「送料無料」が設定されています。表示に相違が出るため確認してください",
          "red",
          {},
          "Yahoo送料無料"
        );
      } else if (shipCode === "1" && freeFlag === "0") {
        addFinding(
          "yahoo_shipping_mismatch_included_but_none",
          "Yahoo!の「重量」が「1」（送料込み）なのに「送料無料」が「なし」になっています。表示に相違が出るため確認してください",
          "red",
          {},
          "Yahoo送料無料"
        );
      } else if ((shipCode === "5000" || shipCode === "6000") && freeFlag === "1") {
        addFinding(
          "yahoo_shipping_mismatch_hitch_but_free",
          `Yahoo!の「重量」が「${shipCode}」（ヒッチメンバー等・実際には送料が別途発生）なのに「送料無料」が設定されています。表示に相違が出るため確認してください`,
          "red",
          {},
          "Yahoo送料無料"
        );
      }
    }

    // 4d. Amazon用編集項目（発送日数・配送パターン・販売価格）
    // 5-1.Amazonページ作成マニュアルでは「ASINが存在する場合、する蔵の入力する項目は
    // 1.ASIN 2.発送日数 3.配送パターン 4.販売価格(税込) 5.ポイント 6.法人価格」とされており、
    // これらはAmazon掲載フラグではなく「SKU情報にASINが入っているか」で判断すべき項目のため、
    // ASINが1件でも入力されているSKU行があるかどうかをゲート条件にする。
    const anyAsinFilled = (domValues.__skuRows || []).some((r) => r && r.asin);
    if (anyAsinFilled) {
      // 4.「販売価格(税込)」＝管理表の売価税込
      const amazonPrice = domValues["Amazon販売価格"];
      const mgmtSaleTaxHeader = managementMatch ? managementMatch.columnMap["売価税込"] : null;
      const mgmtSaleTaxValue = mgmtSaleTaxHeader ? managementMatch.row[mgmtSaleTaxHeader] : null;
      if (!isZeroOrEmpty(mgmtSaleTaxValue)) {
        if (isZeroOrEmpty(amazonPrice)) {
          addFinding(
            "amazon_price_missing",
            `Amazonの「販売価格（税込）」が空欄です（管理表の売価税込「${mgmtSaleTaxValue}」を入力してください）`,
            "red",
            { copyValue: mgmtSaleTaxValue },
            "Amazon販売価格"
          );
        } else if (!valuesEqual(amazonPrice, mgmtSaleTaxValue)) {
          addFinding(
            "amazon_price_mismatch",
            `Amazonの「販売価格（税込）」が管理表の売価税込と一致しません（Amazon: ${amazonPrice} / 管理表: ${mgmtSaleTaxValue}）`,
            "red",
            { copyValue: mgmtSaleTaxValue },
            "Amazon販売価格"
          );
        }
      }

      // 2.発送日数・3.配送パターン
      if (isZeroOrEmpty(domValues["Amazon発送日数"])) {
        addFinding(
          "amazon_leadtime_empty",
          "Amazonの「発送日数」が空欄です。空欄のまま登録すると自動的に「3」に設定されてしまうため、意図した値（基本は「0」、西濃運輸は「7」）か確認してください",
          "yellow",
          {},
          "Amazon発送日数"
        );
      }
      if (isZeroOrEmpty(domValues["Amazon配送パターン"])) {
        addFinding(
          "amazon_shipping_pattern_empty",
          "Amazonの「配送パターン」が未設定です。Yahoo!の送料設定に合わせて設定してください",
          "red",
          {},
          "Amazon配送パターン"
        );
      }
    }

    // 5. セット整合性（簡易チェック＋管理表SKUとの一致確認）
    const skuRows = domValues.__skuRows || [];
    const mgmtSkuHeader = managementMatch ? managementMatch.columnMap["SKU"] : null;
    const mgmtSkuValue = mgmtSkuHeader ? managementMatch.row[mgmtSkuHeader] : null;

    if (skuRows.length === 0) {
      addFinding("sku_empty", "SKU情報が1件も登録されていません", "red", {}, "SKU情報");
    } else {
      const dispNos = new Set();
      skuRows.forEach((sku, idx) => {
        if (!sku.skuCode) {
          addFinding(
            `sku_code_empty_${idx}`,
            `SKU情報 ${idx + 1}行目のSKUコードが空欄です`,
            "red",
            {},
            "SKU情報"
          );
        } else if (!isZeroOrEmpty(mgmtSkuValue) && !valuesEqual(sku.skuCode, mgmtSkuValue)) {
          addFinding(
            `sku_code_mismatch_${idx}`,
            `SKU情報 ${idx + 1}行目のSKU「${sku.skuCode}」が管理表のSKU「${mgmtSkuValue}」と一致しません`,
            "red",
            { copyValue: mgmtSkuValue },
            "SKU情報"
          );
        }

        if (sku.janCode && !/^\d{8}(\d{5})?$/.test(sku.janCode.replace(/\s/g, ""))) {
          addFinding(
            `sku_jan_format_${idx}`,
            `SKU情報 ${idx + 1}行目の正規JAN「${sku.janCode}」の桁数が不自然です`,
            "yellow",
            {},
            "SKU情報"
          );
        } else if (sku.janCode && !isZeroOrEmpty(mgmtSkuValue) && !valuesEqual(sku.janCode, mgmtSkuValue)) {
          addFinding(
            `sku_jan_mismatch_${idx}`,
            `SKU情報 ${idx + 1}行目の正規JAN「${sku.janCode}」が管理表のSKU「${mgmtSkuValue}」と一致しません`,
            "red",
            { copyValue: mgmtSkuValue },
            "SKU情報"
          );
        }

        if (sku.dispNo) {
          if (dispNos.has(sku.dispNo)) {
            addFinding(
              `sku_dispno_dup_${idx}`,
              `SKU情報の表示順「${sku.dispNo}」が重複しています`,
              "yellow",
              {},
              "SKU情報"
            );
          }
          dispNos.add(sku.dispNo);
        }

        // 5-1.Amazonページ作成マニュアル 1.「ASIN」: Amazon掲載時はASINが必須
        if (domValues["Amazon掲載"] === "true" && !sku.asin) {
          addFinding(
            `sku_asin_empty_${idx}`,
            `SKU情報 ${idx + 1}行目のASINが空欄です（Amazon掲載時は必須です）`,
            "red",
            {},
            "SKU情報"
          );
        }
      });
    }

    // 6. 新規登録時の固定ルールチェック（管理表とは無関係の業務ルール）
    for (const rule of fixedRuleChecks || []) {
      const actual = domValues[rule.domKey];
      if (rule.expectedValue !== undefined) {
        if (!valuesEqual(actual, rule.expectedValue)) {
          addFinding(rule.domKey, rule.message, "red");
        }
      } else if (rule.expectedChecked !== undefined) {
        const isChecked = actual === "true" || actual === true;
        if (isChecked !== rule.expectedChecked) {
          addFinding(rule.domKey, rule.message, "red");
        }
      } else if (rule.expectedNotEmpty) {
        if (isZeroOrEmpty(actual)) {
          addFinding(rule.domKey, rule.message, "yellow");
        }
      } else if (rule.reminderIfNotEmpty) {
        if (!isZeroOrEmpty(actual)) {
          addFinding(rule.domKey, rule.message, "yellow");
        }
      }
    }

    return findings;
  }

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.rules = {
    normalizeForCompare,
    normalizeText,
    valuesEqual,
    findManagementRow,
    getRequiredTags,
    getTagCandidates,
    parseItemTags,
    findUrlsMatching,
    runChecks,
  };
})(typeof window !== "undefined" ? window : globalThis);
