// 比較ルールエンジン（プレーンスクリプト。content.js から window.HinbanReferee.rules として利用する）
(function (global) {
  "use strict";

  const WIDE_DIGITS = "０１２３４５６７８９";

  // PC版/スマホ版の内容比較用: HTMLタグ・エンティティを除いた「見た目のテキスト」だけを
  // 取り出す。PC版とスマホ版はリンクの貼り方等HTMLの書き方自体は違ってもよいが、表示したい
  // 内容（車種名・型式・年式・注意書き等）は同じになるはずなので、タグを無視して比較する。
  function stripHtmlTags(html) {
    if (!html) return "";
    return String(html)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  // PC版はテーブル、スマホ版は箇条書き（■・《》・：などの記号付き）で同じ内容を書く運用の
  // ため、記号や語順（テーブルは見出し→値の順に並ぶがスマホは見出し：値の対で並ぶ、等）が
  // 違うだけで実際の内容は同じ、というケースが多い。そのため文字列としての完全一致ではなく、
  // 装飾記号を無視して単語単位に分解し、「同じ単語が両方にあるか」の集合として比較する。
  const DECORATIVE_SYMBOLS_RE = /[■□●○◆◇▲△▽▼★☆※《》〈〉「」『』【】：:]/g;
  const TEXT_TOKEN_SPLIT_RE = /[\s、,，。.\/／～~・]+/;

  // text中の単語を「正規化キー→元の表記」のMapにする（表示用に元の表記を残しつつ、
  // 大文字小文字・全角半角の違いなどは正規化キー側で吸収して比較する）。
  function buildTextTokenMap(text) {
    const map = new Map();
    String(text)
      .replace(DECORATIVE_SYMBOLS_RE, " ")
      .split(TEXT_TOKEN_SPLIT_RE)
      .forEach((raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return;
        const norm = normalizeForCompare(trimmed);
        if (norm && !map.has(norm)) map.set(norm, trimmed);
      });
    return map;
  }

  // 説明文全体を比較すると、ページごとに書き方の違う長い宣伝文・スペック表がノイズとして
  // 大量に引っかかり、判断が難しい差分ばかりになる。実際にコピー元から更新し忘れやすいのは
  // 「品番・型式・年式」が入った適合車両情報欄と「※〜」の注意書きなので、比較対象をその
  // 2箇所だけに絞り込む。
  // PC版は「適合車両情報」、スマホ版は「適合情報」のように、同じ欄でもテンプレートにより
  // 見出しの表記が微妙に違う（車両/車種の有無等）ため、両方拾えるよう複数パターンを許容する。
  const FITMENT_HEADING_RE = /(適合車両情報|適合車種情報|適合情報|適合車種)/;
  // 見出しの後、テーブル/箇条書き1ブロック分だけを拾う目安の文字数（保険的な上限）。
  // 「※」の注意書きは実物では常に適合車両情報テーブル/箇条書きの直後に始まり、
  // window外でも別途extractCautionLinesで拾うため、windowは最初の「※」が出てくる
  // 手前までで打ち切る（テーブル/箇条書き形式の違いに影響されず、次の別セクション
  // 〈対応可能シート表等〉まで拾ってしまうのを避けられる）。「※」が見つからない場合の
  // 保険として文字数上限も設ける。
  const FITMENT_WINDOW_SIZE = 700;

  // PC版のテーブルは列幅が狭いため、見出しセル内で「<b>アタッチメント<br>取付可能寸法</b>」
  // のように<br>で見出しラベルを折り返し表示することが多いが、スマホ版の同じラベルは
  // 「アタッチメント取付可能寸法」と1行で（<br>なしで）書かれる。stripHtmlTagsは<br>を
  // 単語の区切り（半角スペース）に変換するため、このままだとPC版だけラベルが2語に
  // 分かれてしまい、内容は同じなのに差分として誤検知していた（ページ作成担当者からの
  // フィードバックより）。<b>タグの中の<br>に限り区切りなしで連結することで、見出しラベルの
  // 折り返しを無視できるようにする（<b>の外側、値と値の間の改行などは従来通り区切りとして扱う）。
  // ただし値セル（例:「約89.0cm（フロント側）<br>約81.5cm（リア側）」）まで<b>で囲まれている
  // テンプレートもあり、そこまで連結してしまうと本来別々であるべき値同士が結合され、
  // 「0cm（フロント側）約81」のような数値の断片が誤って生まれてしまう。見出しラベルは
  // 数字を含まないのに対し値は数字を含むことを手がかりに、数字を含む（＝値と判断できる）
  // ブロックは対象から除外する。
  function mergeBoldLineBreaks(html) {
    if (!html) return "";
    return String(html).replace(/<b[^>]*>[\s\S]*?<\/b>/gi, (boldBlock) => {
      if (/\d/.test(boldBlock)) return boldBlock;
      return boldBlock.replace(/<br\s*\/?>/gi, "");
    });
  }

  // テンプレートによっては「<b>■適合情報</b>」「<b>■装着データ</b>」「<b>■注記</b>」のように、
  // スマホ版側の各セクションに「■見出し」形式の小見出しを入れる運用になっている。PC版の
  // テーブルにはこのような見出し自体は存在しないため、比較するとスマホ側にしかない語として
  // 毎回誤検知してしまう。見出しの中身（実際のデータ）は見出しの後ろの行で既に比較している
  // ため、「■」で始まる小見出し（<b>■◯◯</b>）はまるごと比較対象から除外する
  // （ページ作成担当者からのフィードバックより）。
  function removeBulletHeadings(html) {
    if (!html) return "";
    return String(html).replace(/<b[^>]*>\s*■([^<]*)<\/b>/gi, (whole, headingText) => {
      // 「■適合情報」等、extractFitmentWindowが窓の起点として検索する見出しまで消して
      // しまうと、見出し自体が見つからずスマホ側の窓が丸ごと空になってしまう。この見出しは
      // 元々見出しの後ろだけを取り出す仕組みで比較対象からは除かれるので、ここでは「■」と
      // 太字だけ外してテキストとして残す。それ以外の小見出し（■装着データ・■注記等）は、
      // 内容比較の上では無関係な構造上のラベルのためまるごと除去する。
      if (FITMENT_HEADING_RE.test(headingText)) return headingText;
      return "";
    });
  }

  function extractFitmentWindow(html) {
    if (!html) return "";
    // 生のHTMLのまま固定文字数で窓を切り出すと、タグの途中（例:
    // 「<div style="width: 100%; font-size: 10pt; text-align: left;">」の閉じ`>`の
    // 手前）で文字列が途切れることがある。そうなるとstripHtmlTagsの
    // `/<[^>]*>/g`が対応する`>`を見つけられず、タグの断片がそのまま比較対象の
    // 文字列として残ってしまい、PC/スマホで無関係な差分として誤検知していた
    // （2026年8月のフィードバックより）。タグを除去した後のプレーンテキストに
    // 対して見出し検索・窓の切り出しを行うことで、この途中切れを起こさないようにする。
    const plain = stripHtmlTags(mergeBoldLineBreaks(removeBulletHeadings(html)));
    const m = plain.match(FITMENT_HEADING_RE);
    if (!m) return "";
    // 見出し自体の表記（「適合車両情報」「適合情報」等）はPC/スマホで揺れがちで、
    // 内容の違いとしては無関係なので比較対象からは除き、見出しの後ろだけを取り出す。
    const rest = plain.slice(m.index + m[0].length);
    const noteIdx = rest.search(/※/);
    const cut = noteIdx === -1 ? FITMENT_WINDOW_SIZE : Math.min(noteIdx, FITMENT_WINDOW_SIZE);
    return rest.slice(0, cut);
  }

  // 行区切り（<br>タグ、またはテキストエリア内に直接入っている改行）ごとに分割し、
  // 「※」で始まる注意書きの行だけを抜き出す
  function extractCautionLines(html) {
    if (!html) return "";
    return String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .split(/\r?\n/)
      .map((line) => stripHtmlTags(line))
      .filter((line) => line.startsWith("※"))
      .join("\n");
  }

  // PC版/スマホ版の比較対象を「適合車両情報欄＋※注意書き」だけに絞り込んで連結する
  function extractRelevantMismatchText(html) {
    const fitment = extractFitmentWindow(html);
    const caution = extractCautionLines(html);
    return [fitment, caution].filter(Boolean).join("\n");
  }

  function truncateForDisplay(text, maxLen) {
    if (!text) return "(空欄)";
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  }

  // タグ候補の絞り込み用: ★リストの「カテゴリ」列の値ごとに、商品名・説明文でよく使われる
  // キーワードを対応付ける（自作の簡易辞書。APIなしのローカル推定のため、完全網羅は狙わない）。
  // 商品名等にこのキーワードが含まれていれば、そのカテゴリのタグを「近い候補」として優先する。
  const CATEGORY_KEYWORDS = {
    ルーフキャリア: ["ルーフキャリア", "ルーフラック", "ルーフレール", "キャリア"],
    ワイパー: ["ワイパー"],
    外装用品: ["外装", "エアロ", "バンパー", "ミラー", "フェンダー", "グリル", "スポイラー", "マフラー", "リアゲート", "ボンネット"],
    "ナビ・オーディオ": ["ナビ", "オーディオ", "スピーカー", "モニター", "デッキ", "オーディオレス"],
    内装用品: ["内装", "シートレール", "シートカバー", "シート", "フロアマット", "パネル", "ステアリング", "ハンドル", "コンソール"],
    ボディ補強: ["補強", "タワーバー", "ロールバー", "ブレース", "スタビライザー"],
    足回り: ["足回り", "サスペンション", "ショック", "スプリング", "アーム", "車高調", "ブッシュ"],
    ブレーキ: ["ブレーキ", "パッド", "ローター", "キャリパー", "ディスク"],
    エンジン: ["エンジン", "ピストン", "タービン", "マニホールド", "プラグ", "ベルト"],
    エアコンフィルター: ["エアコンフィルター", "エアコン"],
    オイル: ["オイルフィルター", "オイルパン", "オイル"],
  };

  // textの中にCATEGORY_KEYWORDSのキーワードが含まれていればそのカテゴリ名を返す（優先順に判定）
  function guessCategoryFromText(haystack) {
    for (const category of Object.keys(CATEGORY_KEYWORDS)) {
      for (const kw of CATEGORY_KEYWORDS[category]) {
        if (haystack.includes(kw.toLowerCase())) return category;
      }
    }
    return null;
  }

  // サイトカテゴリの選択ミス検知用: 商品名によく出るが互いに矛盾する「商品タイプ」の
  // キーワードグループ。同じグループ内の別キーワードがサイトカテゴリ側に入っていれば、
  // コピー元テンプレートのカテゴリを消し忘れている等の選択ミスの可能性が高い。
  // グループ内のどれとも一致しない場合は判定材料が無いのでスルーする（誤検知回避のため）。
  // 他の商品ジャンルでも同様のミスが見つかれば、ここにグループを追加していく想定。
  const PRODUCT_TYPE_KEYWORD_GROUPS = [
    ["フルバケット", "セミバケット", "ノーマルシート", "リクライニング"], // シートレール等のシート形状
  ];

  // 商品名テキストの中の商品タイプキーワードと、サイトカテゴリテキストの中の別キーワードが
  // 矛盾していないか調べる。戻り値: { nameKeyword, categoryKeyword } か、矛盾なしならnull。
  function findProductTypeKeywordConflict(nameText, categoryText) {
    for (const group of PRODUCT_TYPE_KEYWORD_GROUPS) {
      const nameKeyword = group.find((kw) => nameText.includes(kw.toLowerCase()));
      if (!nameKeyword) continue;
      if (categoryText.includes(nameKeyword.toLowerCase())) continue; // 一致しているのでOK
      const conflictKeyword = group.find((kw) => kw !== nameKeyword && categoryText.includes(kw.toLowerCase()));
      if (conflictKeyword) return { nameKeyword, categoryKeyword: conflictKeyword };
    }
    return null;
  }

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

  // 管理表の「コピー元」列は、実際にする蔵でコピーした商品と食い違っていることがある
  // （似た別商品からコピーしたのに、コピー元列は更新されず古いままのケース）。
  // その場合でもコピー元品番の残存を見つけられるよう、自社品番の接頭辞（メーカー部分）が
  // 同じ「兄弟商品」を管理表から総当たりし、それらの品番一覧を返す（自分自身は除く）。
  // 戻り値: [{ code: 自社品番, partNo: 品番 }, ...]
  function findSiblingPartNumbers(companyCode, managementWorkbook, productSheetConfigs) {
    const results = [];
    if (!managementWorkbook || !productSheetConfigs || !companyCode) return results;
    const raw = String(companyCode);
    const hyphenIdx = raw.indexOf("-");
    if (hyphenIdx <= 0) return results;
    const prefix = normalizeForCompare(raw.slice(0, hyphenIdx + 1));
    const selfNorm = normalizeForCompare(companyCode);
    const seen = new Set();

    for (const cfg of productSheetConfigs) {
      const sheet = managementWorkbook.sheets && managementWorkbook.sheets[cfg.sheetName];
      const codeHeader = cfg.columnMap && cfg.columnMap["自社品番"];
      const partHeader = cfg.columnMap && cfg.columnMap["品番"];
      if (!sheet || !codeHeader) continue;

      for (const row of sheet.rows) {
        const rowCode = row[codeHeader];
        const rowCodeNorm = normalizeForCompare(rowCode);
        if (!rowCodeNorm || rowCodeNorm === selfNorm || !rowCodeNorm.startsWith(prefix)) continue;
        const partNo = partHeader ? row[partHeader] : null;
        if (!partNo) continue;
        const dedupeKey = normalizeForCompare(partNo);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        results.push({ code: rowCode, partNo });
      }
    }
    return results;
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
  // マッチした候補を（絞り込み・表示件数の制限をせず）すべて返す。UI表示用の上位3件への
  // 絞り込みはgetTagCandidatesが行う。ページ上の実際のタグが妥当かどうかの判定
  // （tag_unexpectedチェック）では、上位3件だけでなくこの全件と突き合わせる必要がある
  // （表示用に絞り込んだ3件だけと比べると、同じ車種名で系違いのタグ等に競り負けて
  // 本来正しいタグまで「候補にない」と誤検知してしまうため）。
  function findAllTagCandidates(text, tagWorkbook, dictConfig, excludeTags) {
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

      // 一致判定は「車種正式名称」（例: "ノア/ヴォクシー"）ベースで行う。
      // 「アルファード/ヴェルファイア」のような複合名は区切りごとに分けて、
      // どちらか一方の車種名だけが商品名に出てくる場合も拾えるようにする。
      // （車種正式名称の列がない表では、代わりに「車種」列で一致判定する）
      const matchSource = carFormalHeader ? row[carFormalHeader] : carHeader ? row[carHeader] : null;
      if (!matchSource) continue;
      // 表示用の一致ラベルは「車種」列（例: "10系シエンタ"）を使う。同じ車種正式名称
      // （例: "シエンタ"）でも系（世代）が違えば車種列の値が変わるため、どの系にヒットした
      // タグ行かをユーザーが判別できるようにする。車種列がない場合は一致した断片で代用する。
      const carLabel = carHeader ? row[carHeader] : null;

      const keywords = String(matchSource)
        .split(/[\/／・,、]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2);

      for (const kw of keywords) {
        const needle = normalizeText(kw).toLowerCase();
        if (!needle || !haystack.includes(needle)) continue;
        const displayLabel = carLabel || kw;
        const dedupeKey = normalizeForCompare(tag) + "|" + normalizeForCompare(displayLabel);
        if (seenTagKeyword.has(dedupeKey)) continue;
        seenTagKeyword.add(dedupeKey);
        candidates.push({
          tag: String(tag).trim(),
          category: categoryHeader ? row[categoryHeader] || "" : "",
          matchedKeyword: displayLabel,
        });
        break; // 同じタグ行につき1回計上すれば十分
      }
    }

    return candidates;
  }

  // dictConfig: { sheetName, columnMap: { 車種, 車種正式名称, カテゴリ, タグ } }
  // activeTags: ページに既に設置されている実際のタグ（除外はせず、むしろ「合っている
  // かどうかの確認」がしやすいよう候補の先頭に出す）。
  // findAllTagCandidatesの結果を、UI表示用に「近い候補」上位3件へ絞り込む
  // （APIなしの簡易推定。最終判断は人が行う前提）。
  function getTagCandidates(text, tagWorkbook, dictConfig, activeTags) {
    const candidates = findAllTagCandidates(text, tagWorkbook, dictConfig, []);
    if (!candidates.length) return candidates;

    const activeSet = new Set((activeTags || []).map((t) => normalizeForCompare(t)));
    const haystack = normalizeText(text).toLowerCase();
    const guessedCategory = guessCategoryFromText(haystack);

    candidates.sort((a, b) => {
      // 1. 既にページに設置されているタグを最優先で先頭に出す（合っているか一目で確認できるように）
      const aActive = activeSet.has(normalizeForCompare(a.tag)) ? 0 : 1;
      const bActive = activeSet.has(normalizeForCompare(b.tag)) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      // 2. 車種名一致だけだと車種内の全カテゴリ（10件以上）が候補に出て多すぎるため、
      // 商品名・説明文の中にカテゴリを推測できるキーワード（「シートレール」→内装用品 等）が
      // あればそのカテゴリを優先する。
      if (guessedCategory) {
        const aMatch = normalizeForCompare(a.category) === normalizeForCompare(guessedCategory) ? 0 : 1;
        const bMatch = normalizeForCompare(b.category) === normalizeForCompare(guessedCategory) ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      return 0;
    });
    return candidates.slice(0, 3);
  }

  function parseItemTags(rawValue) {
    if (!rawValue) return [];
    return String(rawValue)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 車種別タグ（★リストの「タグ」列、"【SBT00137】"のような表記）は、実際には
  // 非製品属性タグ／商品タグの入力欄ではなく、各説明文・フリースペースの本文に
  // 「タグ1：【SBT00137】」のように手打ちで挿入する運用になっている。そのため
  // 【】で囲まれた英数字コードを本文からキーワードとして拾う。
  const TAG_TOKEN_RE = /【([A-Za-z0-9]+)】/g;

  function extractTagTokens(text) {
    if (!text) return [];
    const tokens = [];
    const re = new RegExp(TAG_TOKEN_RE.source, "g");
    let m;
    while ((m = re.exec(text))) {
      tokens.push(m[0]);
    }
    return tokens;
  }

  // 車種別タグが手打ちで挿入される可能性のある項目一覧（楽天・Yahoo!それぞれ）
  const VEHICLE_TAG_RAKUTEN_KEYS = ["楽天PC用商品説明文", "楽天スマホ用商品説明文"];
  const VEHICLE_TAG_YAHOO_KEYS = [
    "ヤフー商品情報",
    "Yahooフリースペース1",
    "Yahooフリースペース2",
    "Yahooフリースペース3",
    "ヤフー商品説明",
    "Yahooスマートフォン用フリースペース",
  ];

  // ページ本文（楽天・Yahoo!の各説明文/フリースペース）に実際に書かれている車種別タグを
  // 重複なく抽出する。tag_missing/tag_extra・推奨候補との突き合わせチェックで使う。
  function findActualVehicleTags(domValues) {
    const keys = VEHICLE_TAG_RAKUTEN_KEYS.concat(VEHICLE_TAG_YAHOO_KEYS);
    const text = keys.map((k) => domValues[k] || "").join("\n");
    return Array.from(new Set(extractTagTokens(text)));
  }

  // 車種別タグが最低限入っているかの案内表示用ステータス（レッド/イエロー判定はしない、
  // 単なる情報メッセージ用）。楽天はPC用商品説明文とスマホ用商品説明文の両方に、Yahoo!は
  // 商品情報／フリースペース1〜3／商品説明／スマートフォン用フリースペースのいずれか1つに
  // タグが書かれていればOKとする（同じタグが両方の欄に書いてあるだけでも構わない。
  // 大事なのは「必要な欄それぞれにタグが入っているか」であって、別々のタグが2種類
  // 必要という意味ではない）。★リストはすべての車種を網羅しているわけではないため、
  // 満たさない場合でもエラー扱いにはしない。
  function getVehicleTagStatus(domValues) {
    const rakutenFieldsWithTag = VEHICLE_TAG_RAKUTEN_KEYS.filter((k) => extractTagTokens(domValues[k]).length > 0).length;
    const yahooFieldsWithTag = VEHICLE_TAG_YAHOO_KEYS.filter((k) => extractTagTokens(domValues[k]).length > 0).length;
    return {
      rakutenOk: rakutenFieldsWithTag >= VEHICLE_TAG_RAKUTEN_KEYS.length,
      yahooOk: yahooFieldsWithTag >= 1,
      tags: findActualVehicleTags(domValues),
    };
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

  // する蔵側の「制限文字数」は半角=1バイト・全角=2バイト換算のバイト数で判定されている
  // （実際のエラー: Yahoo!商品名131バイト/楽天商品名279バイトの実測値と一致することを
  // 確認済み）。半角の範囲はASCII全域(コードポイント0x7E以下)と半角カタカナ(U+FF61〜U+FF9F)。
  function calcDisplayByteLength(text) {
    let bytes = 0;
    for (const ch of String(text || "")) {
      const code = ch.codePointAt(0);
      bytes += code <= 0x7e || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
    }
    return bytes;
  }

  function isZeroOrEmpty(value) {
    if (value === undefined || value === null || value === "") return true;
    const n = normalizeForCompare(value);
    return n === "" || n === "0";
  }

  // セット商品（1.通販する蔵の商品マスター作成マニュアル [3]セットフラグが「セット」="1"の
  // 商品）は、以下の項目が単品商品と入力ルールが異なるため、管理表の「SKU」「品番」列との
  // 完全一致チェックの対象から外す（2026年8月のページ作成担当者からのフィードバック、および
  // 各マニュアルより確認済み）:
  //  - 楽天カタログID: 3-1.楽天市場ページ作成マニュアル[19]/[1]より、セット構成のメインである
  //    「単品」のJANコードを入力する運用のため、管理表の「SKU」（セット全体を表す値）とは
  //    そもそも一致しない
  //  - ヤフーJANコード: 4-1.Yahoo!ショッピングページ作成マニュアル[11]より、セット商品は
  //    正規JANコードが無いため空白で登録する
  //  - Yahoo製品コード: 4-1.Yahoo!ショッピングページ作成マニュアル[13]より、セットの場合は
  //    空白で登録する
  const SET_EXEMPT_EQUALITY_KEYS = new Set(["楽天カタログID", "ヤフーJANコード", "Yahoo製品コード"]);

  function isSetProduct(domValues) {
    return !!domValues && domValues["セットフラグ"] === "1";
  }

  // SKU情報の「メーカーサイズ」に入れる登録日（YYYY/MM/DD）を今日の日付で作る
  // （1.通販する蔵の商品マスター作成マニュアル sku_data [9]メーカーサイズより）
  function formatTodayForMakerSize() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
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
      siblingPartNumbers,
      requiredTags,
      actualVehicleTags,
      tagCandidateCodes,
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
    const isSet = isSetProduct(domValues);
    if (managementMatch) {
      for (const pair of equalityPairs || []) {
        if (isSet && SET_EXEMPT_EQUALITY_KEYS.has(pair.domKey)) continue;
        const header = managementMatch.columnMap[pair.mgmtKey];
        if (!header) continue; // 列マッピング未設定の項目はスキップ
        const expected = managementMatch.row[header];
        const actual = domValues[pair.domKey];

        if (isZeroOrEmpty(expected)) {
          // オープン価格等で管理表の定価税抜/定価税込自体が空欄/0の場合、対応する
          // 「メーカー希望小売価格」「ヤフー定価」がページ上でも空欄なのは正しい状態
          // （要確認の対象ではない）。3-1.楽天市場ページ作成マニュアル/4-1.Yahoo!ショッピング
          // ページ作成マニュアルの[5]定価より。
          if (
            (pair.domKey === "メーカー希望小売価格" || pair.domKey === "ヤフー定価") &&
            isZeroOrEmpty(actual)
          ) {
            continue;
          }
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

      // 1a-2. 送料区分（税込3980円以上で送料無料、未満で送料別になっている必要がある）。
      // 管理表の「売価税込」を判定基準にする（楽天・Yahoo!とも同じ実売価を前提とする）。
      const shippingSaleTaxHeader = managementMatch.columnMap["売価税込"];
      const shippingSaleTaxValue = shippingSaleTaxHeader ? managementMatch.row[shippingSaleTaxHeader] : null;
      if (!isZeroOrEmpty(shippingSaleTaxValue)) {
        const salePrice = Number(normalizeForCompare(shippingSaleTaxValue));
        const isFreeShipping = salePrice >= 3980;

        // 楽天: postage_flg（0=送料別 / 1=送料込）
        const rakutenPostageFlg = domValues["楽天送料区分"];
        const expectedRakutenFlg = isFreeShipping ? "1" : "0";
        if (rakutenPostageFlg !== expectedRakutenFlg) {
          const rakutenLabel =
            rakutenPostageFlg === "1" ? "送料込" : rakutenPostageFlg === "0" ? "送料別" : "(未設定)";
          addFinding(
            "楽天送料区分",
            `税込売価${salePrice}円は「${isFreeShipping ? "3980円以上" : "3980円未満"}」のため、楽天の送料は「${isFreeShipping ? "送料込" : "送料別"}」にする必要があります（現在: ${rakutenLabel}）`,
            "red"
          );
        }

        // Yahoo!: 重量（実際は送料コード。0=送料別扱い/1=送料無料扱い）と送料無料（delivery。0=なし/1=送料無料）
        const expectedYahooWeight = isFreeShipping ? "1" : "0";
        if (normalizeForCompare(domValues["Yahoo重量"]) !== expectedYahooWeight) {
          addFinding(
            "Yahoo重量",
            `税込売価${salePrice}円は「${isFreeShipping ? "3980円以上" : "3980円未満"}」のため、Yahoo!の「重量」は${expectedYahooWeight}にする必要があります（現在の値: ${domValues["Yahoo重量"] || "(空欄)"}）`,
            "red"
          );
        }
        const expectedYahooDelivery = isFreeShipping ? "1" : "0";
        if (domValues["Yahoo送料無料"] !== expectedYahooDelivery) {
          const yahooDeliveryLabel = domValues["Yahoo送料無料"] === "1" ? "送料無料" : domValues["Yahoo送料無料"] === "0" ? "なし" : "(未設定)";
          addFinding(
            "Yahoo送料無料",
            `税込売価${salePrice}円は「${isFreeShipping ? "3980円以上" : "3980円未満"}」のため、Yahoo!の「送料無料」は「${isFreeShipping ? "送料無料" : "なし"}」にチェックする必要があります（現在: ${yahooDeliveryLabel}）`,
            "red"
          );
        }
      }

      // ルールブックNo.6/17: 商品名が文字数（バイト数）制限を超える場合、型式（最低1つを残す）や
      // 取付位置・原産国などの付随情報は「■検索ワード」として商品説明欄に移してよいことになって
      // いる。一方、車種名・メーカー名自体は文字数オーバーだろうと商品名（タイトル）に必須で、
      // 移動は認められていない。そのため1b/1cでは、型式・付随情報（60系・4WD・RN105等、半角
      // 英数字を含む語）だけ商品名側に加えて同じモールの説明文（検索ワードの置き場所）も検索範囲に
      // 含めて許容し、車種名・メーカー名（半角英数字を含まない全角カナ・漢字表記の語）は商品名側
      // だけを見て、説明文にあっても見逃さないようにする。まとめて含まれているかだけでなく語単位で
      // 判定するのは、「ハイラックス 30系 40系...150系」のような複数の型式のうち一部だけを検索
      // ワード欄に移した場合でも対応できるようにするため。
      // （既知の限界: 車種名自体が半角英数字表記のみのメーカー（例:アウディのA3等）で、かつ他に
      // 型式が併記されていない場合は、この判定では車種名側も移動許容扱いになってしまう。現状の
      // 実データは車種名が全角カナ表記のメーカーのみのため問題にならないが、該当メーカーを扱う
      // ようになった場合は別途対応が必要）
      function findMissingWords(needle, mainText, freeText) {
        const words = normalizeText(needle).toLowerCase().split(/[\s　]+/).filter(Boolean);
        const mainSpace = normalizeText(mainText).toLowerCase();
        const searchSpace = mainSpace + " " + normalizeText(freeText).toLowerCase();
        return words.filter((w) => {
          const isRelocatable = /[0-9a-zA-Z]/.test(w);
          return !(isRelocatable ? searchSpace : mainSpace).includes(w);
        });
      }

      // 1b. シリーズ整合性（ソフトチェック）: 管理表のシリーズ名が商品名（＋各モールの説明文）に
      // 含まれているか
      const seriesHeader = managementMatch.columnMap["シリーズ"];
      const seriesValue = seriesHeader ? managementMatch.row[seriesHeader] : null;
      if (seriesValue && String(seriesValue).trim()) {
        const allFreeText = [
          ...((freeTextKeys && freeTextKeys.rakuten) || []),
          ...((freeTextKeys && freeTextKeys.yahoo) || []),
        ]
          .map((k) => domValues[k] || "")
          .join(" ");
        const missingWords = findMissingWords(seriesValue, domValues["商品名"] || "", allFreeText);
        if (missingWords.length) {
          addFinding(
            "シリーズ整合性",
            `商品名に管理表のシリーズ「${seriesValue}」の一部（${missingWords.join("、")}）が見当たりません。本当にその商品名でよいか管理表を確認してください（文字数の都合で検索ワード欄等に移した場合は、そちらに含まれているか確認してください）`,
            "yellow"
          );
        }
      }

      // 1c. 車種名整合性（ソフトチェック）: 管理表の車種名が各モールの商品名（＋同じモールの
      // 説明文）に含まれているか。楽天・Yahoo!それぞれ実際のページタイトルになる項目
      // （楽天商品名／Yahoo商品名）は個別に編集されるため、片方だけ車種名の更新を忘れている
      // ケース（コピー元の車種のまま）を見つけられるよう、モールごとに別々にチェックする。
      // （PC版/スマホ版の説明文同士は、車種名という1キーワードだけでは型式・年式・注意書き等の
      // 更新漏れまでは拾えないため、下の2d.でHTMLタグを除いたテキスト全体を比較する方式にした）
      const modelHeader = managementMatch.columnMap["車種名"];
      const modelValue = modelHeader ? managementMatch.row[modelHeader] : null;
      if (modelValue && String(modelValue).trim()) {
        // 楽天商品名／Yahoo商品名は「商品名をコピー」ボタンで商品名を初期値にしてから個別編集する
        // 欄のため、編集不要な商品では空欄のまま運用されていることがある。空欄の場合はこのチェック
        // 自体が丸ごとスキップされ、管理表の車種名を何に変えても検知できなくなってしまうため、
        // 2c（商品タイプ整合性チェック）と同様に商品名へフォールバックする。
        const modelTargets = [
          { key: "楽天商品名", nameKeys: ["楽天商品名", "商品名"], label: "楽天の商品名", freeTextGroup: "rakuten" },
          { key: "Yahoo商品名", nameKeys: ["Yahoo商品名", "商品名"], label: "Yahoo!の商品名", freeTextGroup: "yahoo" },
        ];
        for (const target of modelTargets) {
          const text = target.nameKeys.map((k) => domValues[k] || "").find((v) => v) || "";
          if (!text) continue;
          const freeText = ((freeTextKeys && freeTextKeys[target.freeTextGroup]) || [])
            .map((k) => domValues[k] || "")
            .join(" ");
          const missingWords = findMissingWords(modelValue, text, freeText);
          if (missingWords.length) {
            addFinding(
              `model_name_mismatch_${target.key}`,
              `${target.label}に管理表の車種名「${modelValue}」の一部（${missingWords.join("、")}）が見当たりません。コピー元の車種のまま更新し忘れていないか確認してください（文字数の都合で検索ワード欄等に移した場合は、そちらに含まれているか確認してください）`,
              "yellow",
              {},
              target.key
            );
          }
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
      const copyResidueFlaggedKeys = new Set();
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
              copyResidueFlaggedKeys.add(key);
              break; // 同じ項目で複数のneedleが一致しても1件にまとめる
            }
          }
        }
      }

      // 2b. 同じメーカー（自社品番の接頭辞が同じ）の他商品の品番残存チェック
      // 管理表の「コピー元」列は実際にする蔵でコピーした商品と食い違っていることがある
      // （似た別商品からコピーしたのに、コピー元列が更新されていないケース）。
      // その場合でも、同じメーカーの他商品の品番が誤って残っていればここで見つけられる。
      // 上のコピー元照合で既に見つかっている項目は二重に報告しない。
      const ownPartNoHeader = managementMatch.columnMap["品番"];
      const ownPartNo = ownPartNoHeader ? managementMatch.row[ownPartNoHeader] : null;
      if (siblingPartNumbers && siblingPartNumbers.length) {
        for (const key of copySourceLogicalKeys || []) {
          if (copyResidueFlaggedKeys.has(key)) continue;
          const text = normalizeText(domValues[key] || "").toLowerCase();
          if (!text) continue;
          for (const sibling of siblingPartNumbers) {
            if (!sibling.partNo || String(sibling.partNo).length < 4) continue;
            if (ownPartNo && valuesEqual(sibling.partNo, ownPartNo)) continue;
            // セット商品は自社の「品番」自体が構成単品の品番を「+」で連結した値になっている
            // （例: 自社品番="sankei-se-1751rl-set"の品番="SE-1751L+SE-1751R"）。この場合、
            // 構成単品側の品番（例:"SE-1751L"）が商品名・説明文に含まれるのは正しいセット内容の
            // 表記であり、コピー元取り違えの残存ではないためスルーする。
            if (ownPartNo && normalizeText(ownPartNo).toLowerCase().includes(normalizeText(sibling.partNo).toLowerCase())) continue;
            const n = normalizeText(sibling.partNo).toLowerCase();
            if (!n || !text.includes(n)) continue;
            // 兄弟商品自身の自社品番（例: 右用/左用リンクのhref中の"bride-t386mo"）が
            // 本文に含まれる場合は、ラインナップ間の意図的な案内リンク（右用/左用・年式違い等）
            // とみなしスルーする。コピー元取り違えの残存であれば、通常リンク先の自社品番までは
            // 一致しないため、この条件で誤検知を避けられる。
            const siblingCode = normalizeText(sibling.code || "").toLowerCase();
            if (siblingCode && text.includes(siblingCode)) continue;
            addFinding(
              `sibling_residue_${key}`,
              `「${key}」内に別商品「${sibling.code}」の品番「${sibling.partNo}」らしき文字列が含まれています。コピー元が実際には別の商品だった可能性があります`,
              "yellow",
              {},
              key
            );
            break;
          }
        }
      }
    }

    // 2c. 商品タイプ整合性チェック（サイトカテゴリの選択ミス検知）: 商品名に含まれる
    // 「フルバケット」等の商品タイプキーワードと矛盾する別キーワード（「リクライニング」等）が
    // サイトカテゴリ側に残っていないか調べる。コピー元テンプレートのカテゴリを消し忘れた
    // ケースで検知できる。楽天・Yahoo!のサイトカテゴリはそれぞれ別に選択されるため、
    // モールごとに個別にチェックする（managementMatchが無くても実行できる）。
    {
      const categoryCheckTargets = [
        {
          nameKeys: ["楽天商品名", "商品名"],
          categoryKeys: ["楽天サイトカテゴリ1", "楽天サイトカテゴリ2", "楽天サイトカテゴリ3", "楽天サイトカテゴリ4", "楽天サイトカテゴリ5"],
          label: "楽天のサイトカテゴリ",
          severityKey: "楽天サイトカテゴリ整合性",
        },
        {
          nameKeys: ["Yahoo商品名", "商品名"],
          categoryKeys: ["Yahooサイトカテゴリ1", "Yahooサイトカテゴリ2", "Yahooサイトカテゴリ3", "Yahooサイトカテゴリ4", "Yahooサイトカテゴリ5"],
          label: "Yahoo!のサイトカテゴリ",
          severityKey: "Yahooサイトカテゴリ整合性",
        },
      ];
      for (const target of categoryCheckTargets) {
        const rawName = target.nameKeys.map((k) => domValues[k] || "").find((v) => v);
        const nameText = normalizeText(rawName || "").toLowerCase();
        if (!nameText) continue;
        const categoryText = normalizeText(target.categoryKeys.map((k) => domValues[k] || "").join(" ")).toLowerCase();
        if (!categoryText) continue;
        const conflict = findProductTypeKeywordConflict(nameText, categoryText);
        if (conflict) {
          addFinding(
            `category_type_mismatch_${target.categoryKeys[0]}`,
            `商品名は「${conflict.nameKeyword}」なのに、${target.label}に「${conflict.categoryKeyword}」が設定されています。コピー元のカテゴリのまま変更し忘れていないか確認してください`,
            "yellow",
            {},
            target.severityKey
          );
        }
      }
    }

    // 2d. PC版／スマホ版の内容不一致チェック: 説明文全体を比較すると、書き方の違う長い
    // 宣伝文・スペック表がノイズとして引っかかり判断が難しくなるため、実際に更新し忘れやすい
    // 「適合車両情報（品番・型式・年式）」欄と「※〜」の注意書きだけに絞って比較する。
    // PC版はテーブル、スマホ版は■《》：などの記号付き箇条書きで同じ内容を書く運用のため、
    // 記号や語順の違いは無視し、単語単位の集合として比較する。片方に絞り込み対象が
    // 一つも見つからない場合は比較材料が無いので何もしない（managementMatchが無くても
    // 実行できる）。
    {
      // スマホ版は箇条書きの見出しとして「■注記」を書くが、PC版（テーブル形式）では
      // この見出し語自体を書かない運用（見出しの後ろの実際の注記内容は※行として別途
      // extractCautionLinesで拾う）。そのため「注記」という見出し語だけが毎回PC/スマホの
      // 差分として検出されてしまっていた。過去に作成したページも同じ運用のため、この
      // 単語だけは比較対象から除外する（ページ作成担当者からのフィードバックより）。
      const PC_MOBILE_DIFF_IGNORE_WORDS = new Set([normalizeForCompare("注記")]);
      const pcMobileTargets = [
        {
          pcKey: "楽天PC用商品説明文",
          mobileKey: "楽天スマホ用商品説明文",
          label: "楽天のPC用商品説明文とスマホ用商品説明文",
        },
        {
          pcKey: "ヤフー商品説明",
          mobileKey: "Yahooスマートフォン用フリースペース",
          label: "Yahoo!の商品説明とスマートフォン用フリースペース",
        },
      ];
      for (const target of pcMobileTargets) {
        const pcRelevant = extractRelevantMismatchText(domValues[target.pcKey]);
        const mobileRelevant = extractRelevantMismatchText(domValues[target.mobileKey]);
        if (!pcRelevant && !mobileRelevant) continue;
        const pcDisplay = stripHtmlTags(pcRelevant);
        const mobileDisplay = stripHtmlTags(mobileRelevant);
        const pcMap = buildTextTokenMap(pcDisplay);
        const mobileMap = buildTextTokenMap(mobileDisplay);
        const onlyPc = Array.from(pcMap.keys())
          .filter((k) => !mobileMap.has(k) && !PC_MOBILE_DIFF_IGNORE_WORDS.has(k))
          .map((k) => pcMap.get(k));
        const onlyMobile = Array.from(mobileMap.keys())
          .filter((k) => !pcMap.has(k) && !PC_MOBILE_DIFF_IGNORE_WORDS.has(k))
          .map((k) => mobileMap.get(k));
        if (onlyPc.length || onlyMobile.length) {
          addFinding(
            `pc_mobile_mismatch_${target.pcKey}`,
            `${target.label}の適合車両情報・注意書きに違いがあるようです。PC版にしかない語:「${truncateForDisplay(onlyPc.join("、") || "(なし)", 80)}」／スマホ版にしかない語:「${truncateForDisplay(onlyMobile.join("、") || "(なし)", 80)}」`,
            "yellow",
            {},
            target.pcKey
          );
        }
      }
    }

    // 2e. 商品名のスペース表記チェック（ページ作成担当者からのフィードバックより）:
    // 半角スペースが2つ以上連続しているもの、末尾に半角/全角スペースが余分に残っているものは
    // 見た目上不自然なためイエロー扱いとする（managementMatchが無くても実行できる）。
    {
      const DOUBLE_HALFWIDTH_SPACE_RE = / {2,}/;
      const TRAILING_SPACE_RE = /[ 　]$/;
      const productNameSpaceTargets = [
        { key: "楽天商品名", label: "楽天の商品名" },
        { key: "Yahoo商品名", label: "Yahoo!の商品名" },
      ];
      for (const target of productNameSpaceTargets) {
        const raw = domValues[target.key];
        if (!raw) continue;
        if (DOUBLE_HALFWIDTH_SPACE_RE.test(raw)) {
          addFinding(
            `product_name_double_space_${target.key}`,
            `${target.label}に半角スペースが2つ以上連続して入っています`,
            "yellow",
            {},
            target.key
          );
        }
        if (TRAILING_SPACE_RE.test(raw)) {
          addFinding(
            `product_name_trailing_space_${target.key}`,
            `${target.label}の末尾に不要なスペースが入っています`,
            "yellow",
            {},
            target.key
          );
        }
      }
    }

    // 2f. 商品名の文字数（バイト数）チェック: する蔵側の制限文字数を超えていると、
    // レフェリー上は何も問題なく見えても実際にはする蔵側で登録エラーになってしまう
    // （ページ作成担当者からのフィードバックより。楽天255バイト・Yahoo!128バイトが上限）。
    {
      const productNameByteLimits = [
        { key: "楽天商品名", label: "楽天の商品名", maxBytes: 255 },
        { key: "Yahoo商品名", label: "Yahoo!の商品名", maxBytes: 128 },
      ];
      for (const target of productNameByteLimits) {
        const raw = domValues[target.key];
        if (!raw) continue;
        const byteLength = calcDisplayByteLength(raw);
        if (byteLength > target.maxBytes) {
          addFinding(
            `product_name_byte_overflow_${target.key}`,
            `${target.label}が制限文字数を超えています（最大: ${target.maxBytes}バイト、現在: ${byteLength}バイト）。この状態ではする蔵に登録できません`,
            "yellow",
            {},
            target.key
          );
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

    // 4. 車種別タグ照合: 車種別タグは実際には#item_tag（商品タグ欄）ではなく、各説明文・
    // フリースペースの本文に「タグ1：【SBT00137】」のように手打ちで挿入する運用のため、
    // actualVehicleTags（本文から抽出済みの実際のタグ）を実データとして扱う。
    // - 自社品番がそのまま★リストに載っている場合は、そこに書かれたタグ一覧を正解として
    //   過不足をチェックする（従来のtag_missing/tag_extra）。
    // - ★リストに直接の行が無い新規商品などの場合は、代わりにキーワード一致による推奨候補
    //   （tagCandidateCodes、タグ候補上位3件）と比べて、それ以外のタグが本文にあれば
    //   コピー元のタグの残存を疑って警告する。
    const actualTags = actualVehicleTags || [];
    if (requiredTags && requiredTags.length) {
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
          `管理表にない車種別タグが設定されています: ${extra.join(", ")}。コピー元のタグが残っていないか確認してください`,
          "yellow",
          {},
          "商品タグ"
        );
      }
    } else if (actualTags.length && tagCandidateCodes && tagCandidateCodes.length) {
      const candidateSet = new Set(tagCandidateCodes);
      const unexpected = actualTags.filter((t) => !candidateSet.has(t));
      if (unexpected.length) {
        addFinding(
          "tag_unexpected",
          `ページ上のタグ「${unexpected.join("、")}」は、商品名等から車種一致するタグ候補（${truncateForDisplay(tagCandidateCodes.join("、"), 120)}）に含まれていません。コピー元のタグが残っていないか確認してください`,
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
      // 「発送日数」は0が正しい値になり得る項目（基本は0）のため、isZeroOrEmpty（0も
      // 空欄扱いする）ではなく、文字列として本当に空欄かどうかだけを見る。
      if (domValues["Amazon発送日数"] === undefined || domValues["Amazon発送日数"] === null || domValues["Amazon発送日数"] === "") {
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
    } else {
      // ASINが1件も入力されていない＝まだAmazonに出品しない状態。Amazon側の各項目は
      // 出品時（ASIN・金額を入力するタイミング）まで初期値のままにしておく必要があるため、
      // コピー元の値が残っている等で初期値から外れていないか確認する。
      const amazonUnusedSeverityKey = "Amazon不要入力";

      if (normalizeForCompare(domValues["Amazon発送日数"]) !== "0") {
        addFinding(
          "amazon_leadtime_not_zero",
          `ASIN未登録のため、Amazonの「発送日数」は0である必要があります（現在の値: ${domValues["Amazon発送日数"] || "(空欄)"}）`,
          "red",
          { targetKey: "Amazon発送日数" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazon配送パターン"])) {
        addFinding(
          "amazon_shipping_pattern_not_empty",
          `ASIN未登録のため、Amazonの「配送パターン」は「---（未選択）」である必要があります（現在の値: ${domValues["Amazon配送パターン"]}）`,
          "red",
          { targetKey: "Amazon配送パターン" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazon販売価格"])) {
        addFinding(
          "amazon_price_not_empty",
          `ASIN未登録のため、Amazonの「販売価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazon販売価格"]}）`,
          "red",
          { targetKey: "Amazon販売価格" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazonポイント"])) {
        addFinding(
          "amazon_point_not_empty",
          `ASIN未登録のため、Amazonの「ポイント」は空欄である必要があります（現在の値: ${domValues["Amazonポイント"]}）`,
          "red",
          { targetKey: "Amazonポイント" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazonメーカー希望小売価格"])) {
        addFinding(
          "amazon_msrp_not_empty",
          `ASIN未登録のため、Amazonの「メーカー希望小売価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazonメーカー希望小売価格"]}）`,
          "red",
          { targetKey: "Amazonメーカー希望小売価格" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazon法人価格"])) {
        addFinding(
          "amazon_business_price_not_empty",
          `ASIN未登録のため、Amazonの「法人価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazon法人価格"]}）`,
          "red",
          { targetKey: "Amazon法人価格" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazonセール価格"])) {
        addFinding(
          "amazon_saleprice_not_empty",
          `ASIN未登録のため、Amazonの「セール価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazonセール価格"]}）`,
          "red",
          { targetKey: "Amazonセール価格" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazonセール期間開始"]) || !isZeroOrEmpty(domValues["Amazonセール期間終了"])) {
        addFinding(
          "amazon_sale_period_not_empty",
          "ASIN未登録のため、Amazonの「セール期間」は空欄である必要があります",
          "red",
          { targetKey: "Amazonセール期間開始" },
          amazonUnusedSeverityKey
        );
      }
      if (domValues["Amazonギフト包装"] === "true") {
        addFinding(
          "amazon_giftwrap_checked",
          "ASIN未登録のため、Amazonの「ギフト（ギフト包装を行う）」のチェックは外す必要があります",
          "red",
          { targetKey: "Amazonギフト包装" },
          amazonUnusedSeverityKey
        );
      }
      if (domValues["Amazonギフトメッセージ"] === "true") {
        addFinding(
          "amazon_giftmessage_checked",
          "ASIN未登録のため、Amazonの「ギフト（ギフトメッセージを行う）」のチェックは外す必要があります",
          "red",
          { targetKey: "Amazonギフトメッセージ" },
          amazonUnusedSeverityKey
        );
      }
      if (domValues["Amazon並行輸入品"] === "true") {
        addFinding(
          "amazon_parallel_import_checked",
          "ASIN未登録のため、Amazonの「販売形態（並行輸入品）」のチェックは外す必要があります",
          "red",
          { targetKey: "Amazon並行輸入品" },
          amazonUnusedSeverityKey
        );
      }
    }

    // 5. セット整合性（簡易チェック＋管理表SKUとの一致確認）
    const skuRows = domValues.__skuRows || [];
    const mgmtSkuHeader = managementMatch ? managementMatch.columnMap["SKU"] : null;
    const mgmtSkuValue = mgmtSkuHeader ? managementMatch.row[mgmtSkuHeader] : null;

    const todayForMakerSize = formatTodayForMakerSize();

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

        // 1.通販する蔵の商品マスター作成マニュアル sku_data [9]メーカーサイズ:
        // 新規作成時は「登録日」だけが入っているはず。コピー元の日付がそのまま
        // 残っている（今日の日付になっていない）場合は更新し忘れの可能性がある。
        if (sku.makerSize && !normalizeText(sku.makerSize).trim().startsWith(`${todayForMakerSize}登録`)) {
          addFinding(
            `sku_makersize_stale_${idx}`,
            `SKU情報 ${idx + 1}行目の「メーカーサイズ」が今日の日付になっていません（コピー元の日付「${sku.makerSize}」が残っている可能性があります。新規作成時は「${todayForMakerSize}登録」のように今日の日付を入力してください）`,
            "yellow",
            { copyValue: `${todayForMakerSize}登録` },
            "SKU情報"
          );
        }

        // sku_data [19]最高点・[20]発注点: 新規作成時はどちらも「0」（空欄）である必要がある
        if (!isZeroOrEmpty(sku.maxPoint)) {
          addFinding(
            `sku_maxpoint_nonzero_${idx}`,
            `SKU情報 ${idx + 1}行目の「最高点」が「0」になっていません。新規作成時は「0」にする必要があります`,
            "red",
            {},
            "SKU情報"
          );
        }
        if (!isZeroOrEmpty(sku.orderPoint)) {
          addFinding(
            `sku_orderpoint_nonzero_${idx}`,
            `SKU情報 ${idx + 1}行目の「発注点」が「0」になっていません。新規作成時は「0」にする必要があります`,
            "red",
            {},
            "SKU情報"
          );
        }
      });
    }

    // 6. 新規登録時の固定ルールチェック（管理表とは無関係の業務ルール）
    // メーカー直送品（商品名/商品名略称に「【直送】」が入っている）は、どの配送業者に
    // なるか不明なため配送方法セット管理番号を選択できない。未設定でも問題ないため
    // このチェックだけ対象外にする。
    const isDirectShipProduct =
      /【直送】/.test(domValues["商品名"] || "") || /【直送】/.test(domValues["商品名略称"] || "");
    for (const rule of fixedRuleChecks || []) {
      if (rule.domKey === "楽天配送方法セット管理番号" && isDirectShipProduct) continue;
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
    findSiblingPartNumbers,
    getRequiredTags,
    getTagCandidates,
    findAllTagCandidates,
    parseItemTags,
    getVehicleTagStatus,
    findActualVehicleTags,
    findUrlsMatching,
    runChecks,
  };
})(typeof window !== "undefined" ? window : globalThis);
