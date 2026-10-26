// 比較ルールエンジン（プレーンスクリプト。content.js から window.HinbanReferee.rules として利用する）
(function (global) {
  "use strict";

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
  const FITMENT_HEADING_WORDS = ["適合車両情報", "適合車種情報", "適合情報", "適合車種"];
  const FITMENT_HEADING_RE = new RegExp(`(${FITMENT_HEADING_WORDS.join("|")})`);
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

  // テンプレートによっては、上のmergeBoldLineBreaksが対象とする<b>タグではなく、
  // 素の<td>/<th>セル内で直接<br>を使って見出しラベルを折り返し表示することがある
  // （例:「<td>最大積載<br>重量(kg)</td>」）。考え方はmergeBoldLineBreaksと同じで、
  // 数字を含まない（＝見出しラベルと判断できる）セルに限り内部の<br>を区切りなしで
  // 連結する（値セルまで連結して数値が分断されてしまうのを防ぐため）。
  function mergeCellLineBreaks(html) {
    if (!html) return "";
    return String(html).replace(/<(td|th)[^>]*>[\s\S]*?<\/\1>/gi, (cell) => {
      if (/\d/.test(cell)) return cell;
      return cell.replace(/<br\s*\/?>/gi, "");
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
    const plain = stripHtmlTags(mergeBoldLineBreaks(mergeCellLineBreaks(removeBulletHeadings(html))));
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

  // BRIDEのシートレールのタイプ記号（https://brideseats.com/seatrail/ の一覧、2026-10-23時点）。
  // シートレールのメーカー品番は「車種コード＋タイプ記号」（例: N112BT＝BTタイプ）。
  // HRタイプのように品番の末尾がタイプ記号にならないもの（T407H1）もあるため、末尾がこの一覧に
  // ある場合だけメーカー品番からタイプを判断する。
  const BRIDE_RAIL_TYPES = {
    フルバケット: ["LF", "FO", "FB", "FK", "FG", "BG", "BT", "IG", "LG", "FT", "XL", "ZF", "FX", "HR"],
    リクライニング: ["LR", "RO", "RB", "RK", "MO", "MB", "MK", "LY", "LZ", "YZ", "MZ", "LB", "XR"],
  };
  const BRIDE_SEAT_LABELS = { フルバケット: "フルバケットシート用", リクライニング: "リクライニングシート用" };
  // サイトカテゴリ側でそのシート形状を表す語（リクライニングシート用のレールはセミバケットシートにも
  // 使うため、「セミバケット」はリクライニング側として扱う）
  const BRIDE_SEAT_KEYWORDS = { フルバケット: ["フルバケット"], リクライニング: ["リクライニング", "セミバケット"] };

  function brideRailSeatKind(code) {
    return Object.keys(BRIDE_RAIL_TYPES).find((kind) => BRIDE_RAIL_TYPES[kind].includes(code)) || null;
  }

  const TYPE_CODE_PATTERN = "[A-Z0-9][A-Z0-9\\-]{0,9}";
  const GLUED_CODE_TYPE_RE = new RegExp(`^(.*?)(${TYPE_CODE_PATTERN})タイプ$`);
  const GLUED_TYPE_CODE_RE = new RegExp(`^(.*?)タイプ(${TYPE_CODE_PATTERN})$`);
  const BARE_CODE_RE = new RegExp(`^${TYPE_CODE_PATTERN}$`);
  // サイトカテゴリの1階層がタイプの表記だけでできているもの（「BGタイプ」「タイプRS」「LSD タイプRS」等）。
  // 「シビックタイプR」のような車種名の階層を拾わないよう、前に語がある場合はスペースで区切られたものに限る。
  const CATEGORY_CODE_TYPE_RE = new RegExp(`^(?:\\S.*?\\s+)?(${TYPE_CODE_PATTERN})\\s*タイプ$`);
  const CATEGORY_TYPE_CODE_RE = new RegExp(`^(?:\\S.*?\\s+)?タイプ\\s*(${TYPE_CODE_PATTERN})$`);

  function trimSymbols(word) {
    return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  // 商品名・管理表のシリーズ等から「BGタイプ」「タイプRS」「タイプ RS」のような商品タイプの表記を取り出す。
  // 戻り値: [{ code: "BG", expr: "BGタイプ", words: ["シートレール"] }]
  // wordsは表記の直前の語（何のタイプかの手がかり）。サイトカテゴリと関係があるかの判定に使う。
  function extractTypeExpressions(text) {
    const tokens = normalizeText(text)
      .toUpperCase()
      .split(/[\s/／]+/)
      .map(trimSymbols)
      .filter(Boolean);
    const found = [];
    const add = (code, expr, word) => {
      const w = trimSymbols(word || "");
      if (w) found.push({ code, expr, words: [w] });
    };
    tokens.forEach((token, i) => {
      const prev = tokens[i - 1] || "";
      let m = token.match(GLUED_CODE_TYPE_RE);
      if (m) return add(m[2], `${m[2]}タイプ`, trimSymbols(m[1]) || prev);
      m = token.match(GLUED_TYPE_CODE_RE);
      if (m) return add(m[2], `タイプ${m[2]}`, trimSymbols(m[1]) || prev);
      if (token !== "タイプ") return;
      const next = tokens[i + 1] || "";
      if (BARE_CODE_RE.test(next)) return add(next, `タイプ${next}`, prev);
      if (BARE_CODE_RE.test(prev)) return add(prev, `${prev}タイプ`, tokens[i - 2]);
    });
    return found;
  }

  // サイトカテゴリ（「≫」区切りの階層）を、タイプ表記の階層（types）とそれ以外の階層に分ける。
  // othersは比較用の大文字表記、otherTextsは表示用の元の表記。
  function splitCategoryPath(path) {
    const segments = normalizeText(path)
      .split(/[≫»]/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const types = [];
    const others = [];
    const otherTexts = [];
    segments.forEach((segment) => {
      const upper = segment.toUpperCase();
      const m = upper.match(CATEGORY_CODE_TYPE_RE) || upper.match(CATEGORY_TYPE_CODE_RE);
      if (m) {
        types.push({ code: m[1], expr: segment });
      } else {
        others.push(upper);
        otherTexts.push(segment);
      }
    });
    return { types, others, otherTexts };
  }

  // 環境依存文字（機種依存文字）の判定。Shift_JIS（CP932）の文字の表を一度だけ作り、次のものを
  // 環境依存文字とする（する蔵からYahoo!へのデータはShift_JISで出力され、モールの出品前チェックでも
  // 引っかかるため）。
  //  ・NEC特殊文字（13区：①、Ⅰ、㈱、㎜等）・NEC選定IBM拡張文字（89〜92区）・外字（95〜114区）・
  //    IBM拡張文字（115〜119区）。ただしJIS第1・第2水準と同じ文字（≒、∵等）は除く
  //  ・Shift_JISで表せない文字（絵文字、™、Mac等で入力される〜（波ダッシュ）・−（マイナス）等）
  //  ・WindowsとMacで別の文字になる記号のうち、―（ダッシュ）・∥・￠・￡・￢（「フォレスタ―」の「―」が
  //    出品前のチェックで環境依存文字として指摘された）
  // ～（全角チルダ）・－（全角マイナス）も同じ種類の記号だが、普段から入力され、出品中の商品名でも
  // 使われている（2026-10-07のYahoo!データで商品名に～が14件）ため対象外。半角カナも対象外
  // （商品名略称で使う運用のため）。
  const WINDOWS_ONLY_SYMBOLS = new Set(["―", "∥", "￠", "￡", "￢"]);
  const ENV_CHAR_DESCRIPTIONS = {
    "―": "ダッシュ記号", // ―
    "—": "ダッシュ記号", // —
    "−": "マイナス記号", // −
    "〜": "波ダッシュ", // 〜
    "∥": "平行記号", // ∥
    "‖": "二重縦線", // ‖
    "​": "ゼロ幅スペース。見えない文字", // ZERO WIDTH SPACE
    "﻿": "見えない文字", // BOM
  };
  const LONG_VOWEL_LOOKALIKES = new Set(["―", "—", "−"]);
  let jisStandardChars = null;

  // JIS第1・第2水準（1〜8区・16〜84区）の文字の集合。TextDecoderでShift_JISの全コードを読んで作る。
  // TextDecoderがShift_JISを扱えない環境では作れないためnullを返す（その場合は下の範囲指定だけで判定する）。
  function getJisStandardChars() {
    if (jisStandardChars !== null) return jisStandardChars || null;
    try {
      const decoder = new TextDecoder("shift_jis");
      const chars = new Set();
      const leads = [];
      for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
      for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
      leads.forEach((lead) => {
        for (let trail = 0x40; trail <= 0xfc; trail++) {
          if (trail === 0x7f) continue;
          const row = (lead <= 0x9f ? lead - 0x81 : lead - 0xc1) * 2 + 1 + (trail >= 0x9f ? 1 : 0);
          if (!((row >= 1 && row <= 8) || (row >= 16 && row <= 84))) continue;
          const ch = decoder.decode(new Uint8Array([lead, trail]));
          if (ch.length === 1 && ch !== "�") chars.add(ch);
        }
      });
      jisStandardChars = chars;
    } catch (err) {
      console.warn("[ページレフェリー] Shift_JISの文字表を作れなかったため、環境依存文字は主なものだけ判定します", err);
      jisStandardChars = false;
    }
    return jisStandardChars || null;
  }

  // 文字表が作れない場合の代わり: 代表的な環境依存文字（丸数字・ローマ数字・囲み文字・単位記号・
  // №・℡・ℓ・™・©・®・Mac等で入力される—‖−〜・見えない文字・IBM拡張漢字・絵文字）
  const ENV_CHAR_FALLBACK_RE =
    /[①-⓿Ⅰ-ⅿ㈀-㏿№℡ℓ™©®—‖−〜​﻿﨎-鶴]|[\u{1f000}-\u{1faff}]/u;

  function isEnvironmentDependentChar(ch) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) return false;
    if (cp >= 0xff61 && cp <= 0xff9f) return false; // 半角カナ
    if (WINDOWS_ONLY_SYMBOLS.has(ch)) return true;
    const standard = getJisStandardChars();
    if (!standard) return ENV_CHAR_FALLBACK_RE.test(ch);
    return !standard.has(ch);
  }

  // text中の環境依存文字を、文字ごとに最初の出現箇所の前後と一緒に返す。
  // 戻り値: [{ ch, context: "…スバル フォレスタ―…", afterKatakana: true }]
  function findEnvironmentDependentChars(text) {
    const found = new Map();
    const chars = Array.from(text);
    chars.forEach((ch, i) => {
      if (found.has(ch) || !isEnvironmentDependentChar(ch)) return;
      const before = chars.slice(Math.max(0, i - 8), i).join("");
      const after = chars.slice(i + 1, i + 5).join("");
      found.set(ch, {
        ch,
        context: `${i > 8 ? "…" : ""}${before}${ch}${after}${i + 5 < chars.length ? "…" : ""}`,
        afterKatakana: i > 0 && /[ァ-ヺー]/.test(chars[i - 1]),
      });
    });
    return Array.from(found.values());
  }

  // ===== 商品名の「色・左右・前後」の食い違い =====
  // 同じ商品のモール別の商品名（楽天・Yahoo!）や基本情報の商品名では、色（ブルー等）・左右（右・左）・
  // 前後（フロント・リア）は同じ値でなければならない。1d.（楽天とYahoo!の商品名の差異チェック）は、
  // 文字数の都合で検索ワード欄や説明文へ移した語を許容するため、説明文に「レッド」「ブルー」が並んでいると、
  // 「ブルーの商品なのに楽天の商品名がレッドのまま」でも見逃してしまう（ページ作成担当者からの
  // フィードバックより）。そのため、互いに相手に無い値を持っている場合（楽天がレッド・Yahoo!がブルー等）は、
  // 説明文を見ずに食い違いとして指摘する。片方がもう片方の一部だけの場合（楽天が「ブラック/ブルー」・
  // Yahoo!が「ブラック」等）は、文字数の都合の省略の可能性があるため対象外にする。
  const NAME_ATTRIBUTE_SEVERITY_KEY = "商品名の色・左右・前後の不一致";
  const NAME_ATTRIBUTE_GROUPS = [
    { key: "color", label: "色" },
    { key: "side", label: "左右" },
    { key: "position", label: "前後（フロント／リア）" },
  ];
  // 色の語は、カタカナの連なりの全体が色の名前のときだけ色とみなす（「ベースグレード」の「グレー」、
  // 「ブルートゥース」の「ブルー」、「ワインディング」の「ワイン」を色と間違えないため）
  const COLOR_BASE_WORDS = new Set([
    "ブラック", "ホワイト", "レッド", "ブルー", "グリーン", "イエロー", "オレンジ", "ピンク", "パープル",
    "ブラウン", "グレー", "シルバー", "ゴールド", "ベージュ", "ネイビー", "カーキ", "ガンメタ", "ブロンズ",
    "アイボリー", "バイオレット", "ターコイズ", "マゼンタ", "ワインレッド", "クリア", "スモーク",
  ]);
  const COLOR_SYNONYMS = { グレイ: "グレー", ガンメタル: "ガンメタ", ガンメタリック: "ガンメタ" };
  const COLOR_MODIFIERS = [
    "ライト", "ダーク", "スカイ", "ネイビー", "メタリック", "ピュア", "マット", "ディープ", "パステル",
    "ロイヤル", "チタン", "パール", "ブライト", "アッシュ", "オリーブ", "ミント", "ローズ",
  ];
  const ENGLISH_COLORS = {
    black: "ブラック", white: "ホワイト", red: "レッド", blue: "ブルー", green: "グリーン", yellow: "イエロー",
    orange: "オレンジ", pink: "ピンク", purple: "パープル", brown: "ブラウン", gray: "グレー", grey: "グレー",
    silver: "シルバー", gold: "ゴールド", beige: "ベージュ", navy: "ネイビー", khaki: "カーキ",
  };
  const KANJI_COLORS = {
    黒: "ブラック", 白: "ホワイト", 赤: "レッド", 青: "ブルー", 緑: "グリーン", 黄: "イエロー",
    紫: "パープル", 茶: "ブラウン", 銀: "シルバー", 金: "ゴールド", 灰: "グレー",
  };
  // 「リアル」「リアクション」等の別の語を前後の「リア」と間違えないための除外
  const POSITION_RE = /フロント|(?<![ァ-ヶ])(?:リア|リヤ)(?!ル|リ|クション|クター|クト|ライズ)/g;
  const SIDE_RE = /右|左|(?<![A-Za-z0-9])(?:RH|LH)(?![A-Za-z0-9])/gi;

  // カタカナの連なり1つが色の名前なら、その色（「ライトブルー」等の修飾付きも含む）を返す。違えばnull
  function colorTokenOfKatakanaRun(run) {
    let rest = run;
    let prefix = "";
    for (let i = 0; i < 3; i++) {
      const base = COLOR_SYNONYMS[rest] || rest;
      if (COLOR_BASE_WORDS.has(base)) return prefix + base;
      const modifier = COLOR_MODIFIERS.find((m) => rest.startsWith(m) && rest.length > m.length);
      if (!modifier) return null;
      prefix += modifier;
      rest = rest.slice(modifier.length);
    }
    return null;
  }

  // 商品名から色・左右・前後の値を取り出す。戻り値: { color, side, position }（それぞれ 正規化した値→元の表記 のMap）。
  // 表記ゆれ（ブラック/Black/黒、グレー/グレイ、フロント、リア/リヤ、右/RH）は同じ値にそろえる。
  function extractNameAttributes(text) {
    const normalized = normalizeText(stripHtmlTags(text));
    const attrs = { color: new Map(), side: new Map(), position: new Map() };
    const put = (group, value, raw) => {
      if (!attrs[group].has(value)) attrs[group].set(value, raw);
    };
    (normalized.match(/[ァ-ヶー]+/g) || []).forEach((run) => {
      const color = colorTokenOfKatakanaRun(run);
      if (color) put("color", color, run);
    });
    for (const m of normalized.matchAll(/(?<![A-Za-z])[A-Za-z]+(?![A-Za-z])/g)) {
      const color = ENGLISH_COLORS[m[0].toLowerCase()];
      if (color) put("color", color, m[0]);
    }
    // 漢字1文字の色は、前後が漢字・かなでない場合だけ（「黄ばみ」「金具」等を除くため）
    for (const m of normalized.matchAll(/(?<![一-龥ぁ-んァ-ヶー])[黒白赤青緑黄紫茶銀金灰](?![一-龥ぁ-んァ-ヶー])/g)) {
      put("color", KANJI_COLORS[m[0]], m[0]);
    }
    for (const m of normalized.matchAll(SIDE_RE)) {
      const raw = m[0];
      put("side", raw === "右" || raw.toUpperCase() === "RH" ? "右" : "左", raw);
    }
    for (const m of normalized.matchAll(POSITION_RE)) {
      put("position", m[0] === "フロント" ? "フロント" : "リア", m[0]);
    }
    return attrs;
  }

  // 2つの値の集まりが「互いに相手に無い値を持っている」（食い違っている）なら、それぞれにしかない値を返す
  function attributeConflict(a, b) {
    const onlyA = Array.from(a.keys()).filter((v) => !b.has(v));
    const onlyB = Array.from(b.keys()).filter((v) => !a.has(v));
    return onlyA.length && onlyB.length ? { onlyA, onlyB } : null;
  }

  // 楽天・Yahoo!の商品名と基本情報の商品名の、色・左右・前後の食い違いをイエロー等で指摘する。
  // 戻り値: 1d.で同じ語を二重に指摘しないための、指摘済みの値 { rakuten: Map(項目→Set), yahoo: Map(項目→Set) }
  function checkNameAttributeConflicts(domValues, severityMap, addFinding) {
    const reported = { rakuten: new Map(), yahoo: new Map() };
    if (severityMap && severityMap[NAME_ATTRIBUTE_SEVERITY_KEY] === "none") return reported;
    const attrsOf = (key) => (stripHtmlTags(domValues[key] || "") ? extractNameAttributes(domValues[key]) : null);
    const rakuten = attrsOf("楽天商品名");
    const yahoo = attrsOf("Yahoo商品名");
    const base = attrsOf("商品名");
    const quote = (values) => `「${values.join("、")}」`;

    NAME_ATTRIBUTE_GROUPS.forEach(({ key, label }) => {
      const r = rakuten && rakuten[key];
      const y = yahoo && yahoo[key];
      const b = base ? base[key] : new Map();

      // 楽天とYahoo!の商品名同士が食い違っている場合。どちらが違うか分かるよう、基本情報の商品名の値も添える
      const mallConflict = r && y ? attributeConflict(r, y) : null;
      if (mallConflict) {
        const rakutenOffBase = b.size ? attributeConflict(r, b) : null;
        const yahooOffBase = b.size ? attributeConflict(y, b) : null;
        addFinding(
          `name_attribute_conflict_${key}`,
          `楽天の商品名とYahoo!の商品名で、${label}が食い違っています（楽天:${quote(mallConflict.onlyA)}／Yahoo!:${quote(mallConflict.onlyB)}${b.size ? `／基本情報の商品名:${quote(Array.from(b.keys()))}` : ""}）。コピー元のまま更新し忘れていないか確認してください`,
          "yellow",
          { targetKey: yahooOffBase && !rakutenOffBase ? "Yahoo商品名" : "楽天商品名" },
          NAME_ATTRIBUTE_SEVERITY_KEY
        );
        reported.rakuten.set(key, new Set(mallConflict.onlyA));
        reported.yahoo.set(key, new Set(mallConflict.onlyB));
        return;
      }

      // 楽天とYahoo!は同じだが、基本情報の商品名と食い違っている場合（両方ともコピー元のまま等）
      if (!b.size) return;
      const off = [
        { label: "楽天", key: "楽天商品名", conflict: r ? attributeConflict(r, b) : null },
        { label: "Yahoo!", key: "Yahoo商品名", conflict: y ? attributeConflict(y, b) : null },
      ].filter((m) => m.conflict);
      if (!off.length) return;
      const sameValues = off.length === 2 && off[0].conflict.onlyA.join() === off[1].conflict.onlyA.join();
      (sameValues ? [{ label: "楽天・Yahoo!", key: "楽天商品名", conflict: off[0].conflict }] : off).forEach((m) => {
        addFinding(
          `name_attribute_conflict_${key}_${m.key}`,
          `${m.label}の商品名の${label}は${quote(m.conflict.onlyA)}ですが、基本情報の商品名は${quote(m.conflict.onlyB)}です。コピー元のまま更新し忘れていないか確認してください`,
          "yellow",
          { targetKey: m.key },
          NAME_ATTRIBUTE_SEVERITY_KEY
        );
      });
    });
    return reported;
  }

  // 1d.の「〜にしかない語」から、すでに色・左右・前後の食い違いとして指摘した語を除く
  function withoutReportedAttributeWords(phrases, reportedMap) {
    if (!reportedMap.size) return phrases;
    return phrases
      .map((phrase) =>
        phrase
          .split(/[\s　]+/)
          .filter((word) => {
            const attrs = extractNameAttributes(word);
            return !NAME_ATTRIBUTE_GROUPS.some(
              ({ key }) => reportedMap.has(key) && Array.from(attrs[key].keys()).some((v) => reportedMap.get(key).has(v))
            );
          })
          .join(" ")
      )
      .filter(Boolean);
  }

  // 商品タイプの表記（の直前の語）が、サイトカテゴリのいずれかの階層と関係しているか
  // （「シートレール BTタイプ」と「…≫シートレール≫フルバケットシート用≫BGタイプ」等）
  function isTypeRelatedToCategory(entry, otherSegments) {
    return entry.words.some(
      (w) => w.length >= 2 && otherSegments.some((s) => s.length >= 2 && (s.includes(w) || w.includes(s)))
    );
  }

  // 全角英数記号→半角変換。管理表の値が全角英字（「１５０ｍｍ」等）で入力されていても、
  // 半角表記の商品名等と正しく一致判定できるようにするため、数字だけでなくU+FF01～U+FF5E
  // （全角英字・記号）全体を対象にする（全角スペースU+3000はこの範囲に含まれず対象外だが、
  // 語の区切り判定では半角/全角スペースどちらも扱っているため問題ない）。
  function toHalfWidth(str) {
    return String(str).replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  // 半角カタカナ→全角カタカナ変換。管理表の値が半角カタカナ（「NURMAN Gﾛｺﾞ ｶｰﾎﾞﾝ」等、
  // コピー&ペースト元の都合等で混入することがある）で入力されていても、全角表記の商品名と
  // 正しく一致判定できるようにする。濁点・半濁点（ﾞ/ﾟ）は単独の半角文字として続くため、
  // 直前の仮名と組み合わせて濁音・半濁音の全角文字（例:"ｺ"+"ﾞ"→"ゴ"）に変換する。
  const HW_KATAKANA_BASE = {
    "｡": "。", "｢": "「", "｣": "」", "､": "、", "･": "・",
    "ｦ": "ヲ", "ｧ": "ァ", "ｨ": "ィ", "ｩ": "ゥ", "ｪ": "ェ", "ｫ": "ォ",
    "ｬ": "ャ", "ｭ": "ュ", "ｮ": "ョ", "ｯ": "ッ", "ｰ": "ー",
    "ｱ": "ア", "ｲ": "イ", "ｳ": "ウ", "ｴ": "エ", "ｵ": "オ",
    "ｶ": "カ", "ｷ": "キ", "ｸ": "ク", "ｹ": "ケ", "ｺ": "コ",
    "ｻ": "サ", "ｼ": "シ", "ｽ": "ス", "ｾ": "セ", "ｿ": "ソ",
    "ﾀ": "タ", "ﾁ": "チ", "ﾂ": "ツ", "ﾃ": "テ", "ﾄ": "ト",
    "ﾅ": "ナ", "ﾆ": "ニ", "ﾇ": "ヌ", "ﾈ": "ネ", "ﾉ": "ノ",
    "ﾊ": "ハ", "ﾋ": "ヒ", "ﾌ": "フ", "ﾍ": "ヘ", "ﾎ": "ホ",
    "ﾏ": "マ", "ﾐ": "ミ", "ﾑ": "ム", "ﾒ": "メ", "ﾓ": "モ",
    "ﾔ": "ヤ", "ﾕ": "ユ", "ﾖ": "ヨ",
    "ﾗ": "ラ", "ﾘ": "リ", "ﾙ": "ル", "ﾚ": "レ", "ﾛ": "ロ",
    "ﾜ": "ワ", "ﾝ": "ン",
  };
  const HW_VOICED_MAP = {
    ウ: "ヴ",
    カ: "ガ", キ: "ギ", ク: "グ", ケ: "ゲ", コ: "ゴ",
    サ: "ザ", シ: "ジ", ス: "ズ", セ: "ゼ", ソ: "ゾ",
    タ: "ダ", チ: "ヂ", ツ: "ヅ", テ: "デ", ト: "ド",
    ハ: "バ", ヒ: "ビ", フ: "ブ", ヘ: "ベ", ホ: "ボ",
  };
  const HW_SEMIVOICED_MAP = { ハ: "パ", ヒ: "ピ", フ: "プ", ヘ: "ペ", ホ: "ポ" };

  function halfWidthKatakanaToFullWidth(str) {
    const s = String(str);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const base = HW_KATAKANA_BASE[ch];
      if (base) {
        const next = s[i + 1];
        if (next === "ﾞ" && HW_VOICED_MAP[base]) {
          out += HW_VOICED_MAP[base];
          i++;
        } else if (next === "ﾟ" && HW_SEMIVOICED_MAP[base]) {
          out += HW_SEMIVOICED_MAP[base];
          i++;
        } else {
          out += base;
        }
      } else if (ch === "ﾞ") {
        out += "゛";
      } else if (ch === "ﾟ") {
        out += "゜";
      } else {
        out += ch;
      }
    }
    return out;
  }

  // ローマ数字（環境依存文字。Ⅰ〜Ⅻ・ⅰ〜ⅻ等）→半角英字の組み合わせ（I〜XII等）に変換。
  // する蔵側は環境依存文字が登録できないため、管理表の「STRADIAⅢ」等は「STRADIAIII」のように
  // 手打ちで置き換えて運用されている。見た目は同じ車種名でも文字コードが異なり一致しないため。
  const ROMAN_NUMERAL_MAP = {
    "Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V", "Ⅵ": "VI",
    "Ⅶ": "VII", "Ⅷ": "VIII", "Ⅸ": "IX", "Ⅹ": "X", "Ⅺ": "XI", "Ⅻ": "XII",
    "Ⅼ": "L", "Ⅽ": "C", "Ⅾ": "D", "Ⅿ": "M",
    "ⅰ": "I", "ⅱ": "II", "ⅲ": "III", "ⅳ": "IV", "ⅴ": "V", "ⅵ": "VI",
    "ⅶ": "VII", "ⅷ": "VIII", "ⅸ": "IX", "ⅹ": "X", "ⅺ": "XI", "ⅻ": "XII",
    "ⅼ": "L", "ⅽ": "C", "ⅾ": "D", "ⅿ": "M",
  };
  function normalizeRomanNumerals(str) {
    return String(str).replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿ]/g, (ch) => ROMAN_NUMERAL_MAP[ch] || ch);
  }

  // 価格・品番などの正規化比較用: 全角数字→半角、カンマ・空白除去、大文字小文字統一
  function normalizeForCompare(value) {
    if (value === null || value === undefined) return "";
    let s = String(value);
    s = toHalfWidth(s);
    s = halfWidthKatakanaToFullWidth(s);
    s = normalizeRomanNumerals(s);
    s = s.replace(/[，,]/g, "");
    s = s.replace(/\s+/g, "");
    s = s.trim().toLowerCase();
    return s;
  }

  // 説明文などの自由テキスト走査用: 改行・全角スペースは残しつつ軽く正規化
  function normalizeText(value) {
    if (value === null || value === undefined) return "";
    return normalizeRomanNumerals(halfWidthKatakanaToFullWidth(toHalfWidth(String(value))));
  }

  function valuesEqual(a, b) {
    const na = normalizeForCompare(a);
    const nb = normalizeForCompare(b);
    if (na === "" && nb === "") return true;
    // 管理表の金額は税抜×1.1等の計算式で端数（例: 898×1.1=987.8）が生じることがあるが、
    // 円は整数でしか入力されないため、両方とも数値として読める場合は四捨五入して比較する
    // （ページ作成担当者からのフィードバックより：管理表の表示上の数字に合っていればよい）
    const numA = Number(na);
    const numB = Number(nb);
    if (na !== "" && nb !== "" && Number.isFinite(numA) && Number.isFinite(numB)) {
      return Math.round(numA) === Math.round(numB);
    }
    return na === nb;
  }

  // 金額をメッセージ・コピーボタンに表示する際、管理表の端数付きの生値（例: 987.8）ではなく
  // 表示上の整数（例: 988）を見せる／コピーさせるための整形
  function formatAmountForDisplay(value) {
    const normalized = normalizeForCompare(value);
    const num = Number(normalized);
    if (normalized !== "" && Number.isFinite(num)) return String(Math.round(num));
    return value;
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

  // 検出結果の入れ物と、それに追加するaddFindingを作る（runChecks・runSubpageChecksで共用）。
  // severityKeyは重大度設定（severityMap）を引くためのキー。copy_residue_商品名のような
  // 合成キー（key）は一覧表示や該当箇所へのスクロールのために別々にしているだけなので、
  // 重大度は元の項目名（severityKey、省略時はkeyそのもの）で引く。
  // severityMap[severityKey]が"none"の場合はユーザーがこのチェックを無効化しているので
  // 検出結果自体を出さない。
  // targetKey（=severityKey||key）はcontent.js側で該当箇所へスクロールする際、
  // fieldMapを直接引くためのキーとしても使う（合成キーからの逆算に頼らないようにする）。
  // addOkは、別画面（SKU別 商品情報・商品属性設定・セット構成）が正しく設定されていたことを
  // 示すグリーン表示（severity: "ok"）。重大度設定の対象外で、レッド/イエローの件数・登録ボタンの
  // ロック・実績ログには含めない。
  function createFindingCollector(severityMap) {
    const findings = [];
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
    function addOk(key, message, extra) {
      findings.push(Object.assign({ key, targetKey: key, severity: "ok", message }, extra || {}));
    }
    return { findings, addFinding, addOk };
  }

  // domValues: { logicalKey: string値 }（フィールドマッピングに従いcontent.js側で取得済み）
  // copySourceMatch: managementMatchの「コピー元」列の値（コピー元商品の自社品番）で
  //   findManagementRowを引いた結果（コピー元商品自体の管理表行）。無ければnull。
  // equalityPairs: [{ domKey, mgmtKey, isAmount }] DOM項目と管理表の列論理名の対応
  // fixedRuleChecks: [{ domKey, expectedValue, expectedChecked, message }] 新規登録時の固定ルール
  // freeTextKeys: { rakuten: [logicalKey...], yahoo: [logicalKey...] } 自由テキスト系の論理キー
  // urlTemplates: { rakuten, yahoo } 正しいモールURLのひな形（{code}が自社品番に置き換わる）
  // rakutenSubpages / setComposition: 別画面の保存済みの内容（content.jsで読み込んだもの。7.を参照）
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
      rakutenSubpages,
      attributeRules,
      setComposition,
    } = params;

    const { findings, addFinding, addOk } = createFindingCollector(severityMap);

    // 0. 楽天・Yahoo!の商品名の色・左右・前後の食い違い（管理表が見つからなくても確認できる。
    // 下の1d.で同じ語を二重に指摘しないよう、指摘した語を覚えておく）
    const reportedNameAttributes = checkNameAttributeConflicts(domValues, severityMap, addFinding);

    // 1. 完全一致（正規化比較・管理表の列マッピングに基づく明示的な組み合わせ）
    const isSet = isSetProduct(domValues);
    if (managementMatch) {
      for (const pair of equalityPairs || []) {
        if (isSet && SET_EXEMPT_EQUALITY_KEYS.has(pair.domKey)) continue;
        const header = managementMatch.columnMap[pair.mgmtKey];
        if (!header) continue; // 列マッピング未設定の項目はスキップ
        let expected = managementMatch.row[header];
        // 「-」等、1以上の数字として読めない値は0（加算・追加なし）とみなしてよい項目
        // （例: 特別加算金が無い場合に「-」と表記される等）
        if (pair.treatNonPositiveAsZero) {
          const n = Number(normalizeForCompare(expected));
          if (!(Number.isFinite(n) && n >= 1)) expected = "0";
        }
        const actual = domValues[pair.domKey];

        if (pair.treatNonPositiveAsZero && isZeroOrEmpty(expected)) {
          // treatNonPositiveAsZeroは「管理表が '-' 等の非数値表記＝加算なし」を0として扱うための
          // ものであり、expectedが0であること自体は確定した正しい期待値。そのため下のオープン
          // 価格向けスキップ処理（期待値が不明なため比較を諦める）の対象にはせず、ここで
          // 「ページ側も空欄/0になっているか」を直接検証する（管理表が0なのにページに金額が
          // 残っていても指摘されなかった問題の修正）。
          if (!isZeroOrEmpty(actual)) {
            addFinding(
              pair.domKey,
              `「${pair.domKey}」が管理表の「${pair.mgmtKey}」(加算なし)と一致しません（ページ: ${actual} / 管理表: 加算なし）`,
              "red",
              { copyValue: "0" }
            );
          }
          continue;
        }

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

        if (!valuesEqual(actual, expected)) {
          const expectedDisplay = pair.isAmount ? formatAmountForDisplay(expected) : expected;
          addFinding(
            pair.domKey,
            `「${pair.domKey}」が管理表の「${pair.mgmtKey}」と一致しません（ページ: ${actual === undefined || actual === null || actual === "" ? "(空欄)" : actual} / 管理表: ${expectedDisplay}）`,
            "red",
            { copyValue: expectedDisplay }
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
      // 管理表では英語表記（例:"LOW"）、する蔵側では対応するカタカナ表記（例:"ロー"）で
      // 運用されている語の辞書。表記ゆれで一致しなくなるのを防ぐため、該当語については
      // どちらの表記で書かれていても一致とみなす（新しいケースが見つかり次第追加する）。
      const WORD_ALIAS_MAP = {
        low: ["ロー"],
        high: ["ハイ"],
        standard: ["スタンダード"],
        mid: ["ミドル"],
        middle: ["ミドル"],
        full: ["フル"],
        semi: ["セミ"],
        long: ["ロング"],
        short: ["ショート"],
        wide: ["ワイド"],
        narrow: ["ナロー"],
        custom: ["カスタム"],
        sport: ["スポーツ"],
        sports: ["スポーツ"],
        racing: ["レーシング"],
        front: ["フロント"],
        rear: ["リア"],
      };

      // alwaysAllowFreeText: true にすると、英数字を含まない語（車種名・メーカー名等）も
      // freeText側を見て許容する。1b/1c（車種名は商品名本体に残っていてほしい）では既定の
      // false のまま呼び出し、1d（モール間の商品名差異チェックはどちらの語も文字数都合で
      // 移動しうる）でのみ true を渡す。
      function findMissingWords(needle, mainText, freeText, alwaysAllowFreeText) {
        // 表示用に元の大文字小文字を保ったまま単語分割し、判定だけ小文字化して行う
        const originalWords = normalizeText(needle).split(/[\s　]+/).filter(Boolean);
        const mainSpace = normalizeText(mainText).toLowerCase();
        const searchSpace = mainSpace + " " + normalizeText(freeText).toLowerCase();
        const missingFlags = originalWords.map((originalWord) => {
          const w = originalWord.toLowerCase();
          const isRelocatable = alwaysAllowFreeText || /[0-9a-zA-Z]/.test(w);
          const space = isRelocatable ? searchSpace : mainSpace;
          if (space.includes(w)) return false;
          const aliases = WORD_ALIAS_MAP[w];
          if (aliases && aliases.some((alias) => space.includes(normalizeText(alias).toLowerCase()))) {
            return false;
          }
          return true;
        });
        // 「Strut Tower Bar」のように連続する複数語がまとめて欠落している場合、
        // 単語ごとに個別表示すると「strut、tower、bar」のように句読点で区切られた
        // 単語の羅列に見えて分かりにくいため、連続する欠落語は元の並びのまま
        // 1つのフレーズとして結合して返す。
        const result = [];
        let buffer = [];
        originalWords.forEach((w, i) => {
          if (missingFlags[i]) {
            buffer.push(w);
          } else if (buffer.length) {
            result.push(buffer.join(" "));
            buffer = [];
          }
        });
        if (buffer.length) result.push(buffer.join(" "));
        return result;
      }

      // 楽天・Yahoo!どちらの説明文（＝検索ワード欄の置き場所）に移されていても許容できるよう、
      // 商品名／商品名略称（モールに紐づかない共通項目）のチェックでは両モール分をまとめて見る。
      const allFreeText = [
        ...((freeTextKeys && freeTextKeys.rakuten) || []),
        ...((freeTextKeys && freeTextKeys.yahoo) || []),
      ]
        .map((k) => domValues[k] || "")
        .join(" ");

      // 1b. シリーズ整合性（ソフトチェック）: 管理表のシリーズ名が商品名（＋各モールの説明文）に
      // 含まれているか
      const seriesHeader = managementMatch.columnMap["シリーズ"];
      const seriesValue = seriesHeader ? managementMatch.row[seriesHeader] : null;
      if (seriesValue && String(seriesValue).trim()) {
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
        // 商品名・商品名略称自体は「取付位置」等の詳細を省いたざっくりした表記で運用されており、
        // 車種名の一部が無くても正しい状態であることが多いため独立チェックの対象にはしない
        // （フォールバック用途にのみ使う。ページ作成担当者からのフィードバックより）。
        const modelTargets = [
          { key: "楽天商品名", nameKeys: ["楽天商品名", "商品名"], label: "楽天の商品名", freeText: allFreeText },
          { key: "Yahoo商品名", nameKeys: ["Yahoo商品名", "商品名"], label: "Yahoo!の商品名", freeText: allFreeText },
        ];
        for (const target of modelTargets) {
          const text = target.nameKeys.map((k) => domValues[k] || "").find((v) => v) || "";
          if (!text) continue;
          const missingWords = findMissingWords(modelValue, text, target.freeText);
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

      // 1d. 楽天商品名とYahoo商品名の差異チェック（ソフトチェック）: 同じ商品でもモール別に
      // 個別編集されるため、コピペミス・入力ミスによる意図しない差異が無いか確認する
      // （例:「4200lm 6000K」の一方が誤って「4200K」になっている等）。Yahoo!は入力できる
      // 文字数が少なく、その分の語を検索ワード欄等に移すことがあるため、findMissingWordsと
      // 同じ理屈（型式等・半角英数字を含む語は相手側の説明文にもあれば許容）で比較する。
      // <BR>等が単語にくっつくと分割がずれるため、比較前にHTMLタグを取り除く。
      {
        const rakutenTitle = stripHtmlTags(domValues["楽天商品名"] || "");
        const yahooTitle = stripHtmlTags(domValues["Yahoo商品名"] || "");
        if (rakutenTitle && yahooTitle) {
          const rakutenFreeText = ((freeTextKeys && freeTextKeys.rakuten) || [])
            .map((k) => domValues[k] || "")
            .join(" ");
          const yahooFreeText = ((freeTextKeys && freeTextKeys.yahoo) || [])
            .map((k) => domValues[k] || "")
            .join(" ");
          // 色・左右・前後の食い違いは0.で指摘済みのため、ここでは同じ語を重ねて指摘しない
          const onlyInRakuten = withoutReportedAttributeWords(
            findMissingWords(rakutenTitle, yahooTitle, yahooFreeText, true),
            reportedNameAttributes.rakuten
          );
          const onlyInYahoo = withoutReportedAttributeWords(
            findMissingWords(yahooTitle, rakutenTitle, rakutenFreeText, true),
            reportedNameAttributes.yahoo
          );
          if (onlyInRakuten.length || onlyInYahoo.length) {
            addFinding(
              "rakuten_yahoo_name_diff",
              `楽天の商品名とYahoo!の商品名に違いがあるようです。楽天にしかない語:「${onlyInRakuten.join("、") || "(なし)"}」／Yahoo!にしかない語:「${onlyInYahoo.join("、") || "(なし)"}」。入力ミス・コピペミスがないか確認してください（文字数の都合で検索ワード欄等に移した場合は問題ありません）`,
              "yellow",
              {},
              "楽天商品名"
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
      // 自社の品番・自社品番（このページ自身のもの）。「製品ラインナップ」のような、
      // 同シリーズの兄弟品番を並べて案内するセクションでは、コピー元の品番と一緒に
      // 自社（今回作成中）の品番も同じ説明文中に載っているのが正しい状態のため、
      // 両方揃って見つかった場合は本当の更新し忘れではなく意図的な案内とみなしてスルーする
      // （ページ作成担当者からのフィードバックより）。
      const ownPartNoHeader = managementMatch.columnMap["品番"];
      const ownPartNo = ownPartNoHeader ? managementMatch.row[ownPartNoHeader] : null;
      const ownCompanyCode = domValues["自社品番"];

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
          if (!text) continue;
          const ownCodeFound =
            (ownCompanyCode && text.includes(normalizeText(ownCompanyCode).toLowerCase())) ||
            (ownPartNo && text.includes(normalizeText(ownPartNo).toLowerCase()));
          if (ownCodeFound) continue; // 自社の品番も一緒に載っている＝製品ラインナップ等の意図的な案内
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

      // 2b-2. 商品説明文の自社品番整合性チェック（PC版⇔スマホ版）
      // テンプレートによっては商品説明文の冒頭に「・〇〇工業 △△、{品番}です。」のように
      // 自社の品番を書き込む運用があり、コピー元のままこの挿入箇所だけ片方のモール（PC版/
      // スマホ版）で空欄のまま残ってしまうミスがある。2d.のPC/スマホ比較は適合車両情報・
      // 注意書きに範囲を絞っているため本文（宣伝文等）までは見ておらず、このミスは拾えない。
      // 宣伝文の言い回し自体の違いまで指摘するとノイズになる（ルールブックNo.48の方針）ため、
      // 品番の文字列が本文中に「あるかないか」だけをPC版⇔スマホ版で突き合わせる。
      if (ownPartNo && String(ownPartNo).trim()) {
        const ownPartNoNorm = normalizeText(ownPartNo).toLowerCase();
        const descriptionPairs = [
          {
            pcText: [domValues["楽天PC用商品説明文"], domValues["楽天PC用販売説明文"]].filter(Boolean).join("\n"),
            mobileText: [domValues["楽天モバイル用商品説明文"], domValues["楽天スマホ用商品説明文"]].filter(Boolean).join("\n"),
            label: "楽天",
          },
          {
            pcText: domValues["ヤフー商品説明"] || "",
            mobileText: domValues["Yahooスマートフォン用フリースペース"] || "",
            label: "Yahoo!",
          },
        ];
        for (const pair of descriptionPairs) {
          if (!pair.pcText && !pair.mobileText) continue;
          const pcHas = normalizeText(stripHtmlTags(pair.pcText)).toLowerCase().includes(ownPartNoNorm);
          const mobileHas = normalizeText(stripHtmlTags(pair.mobileText)).toLowerCase().includes(ownPartNoNorm);
          if (pcHas !== mobileHas) {
            addFinding(
              `own_partno_description_mismatch_${pair.label}`,
              `${pair.label}の商品説明文に、自社の品番「${ownPartNo}」が${pcHas ? "PC版にはあるのにスマホ版に無い" : "スマホ版にはあるのにPC版に無い"}ようです。コピー元の品番挿入欄が空欄のまま残っていないか確認してください`,
              "yellow",
              {},
              "商品説明文自社品番不一致"
            );
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
      // 下の2c-2.でシート形状の食い違いを同じモールについて二重に指摘しないよう、ここで指摘したモールを覚えておく
      const keywordConflictLabels = new Set();
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
          keywordConflictLabels.add(target.label);
        }
      }

      // 2c-2. 商品のタイプとサイトカテゴリのタイプの食い違いチェック: サイトカテゴリの階層に
      // 「BGタイプ」「タイプRS」のようなタイプの表記があるとき、商品のタイプと食い違っていないか調べる
      // （BTタイプの商品なのに、コピー元のBGタイプのカテゴリのままになっている等。ページ作成担当者からの
      // フィードバックより）。正しいカテゴリまでは判断せず、食い違っているときだけ知らせる。
      // 商品のタイプは根拠の強い順に、BRIDEのシートレールならメーカー品番の末尾（N112BT→BT）、
      // 管理表のシリーズ（「シートレール BTタイプ」）、商品名等にある「〇〇タイプ」の表記から読み取る
      // （管理表は登録時点で分かっている情報のため、メーカー品番を優先する）。
      // タイプ表記の直前の語（「シートレール」等）がカテゴリの階層にも含まれる場合だけ比べ、車種名の
      // 「タイプR」のような無関係な表記とは比べない。商品のタイプが分からない、またはカテゴリに
      // タイプの表記が無い場合は、判断材料が無いので何もしない。
      // BRIDEのシートレールはタイプからシート形状（フルバケット/リクライニング）も分かるため、
      // 「…≫シートレール≫リクライニング」のようなタイプ表記の無いカテゴリとも比べる。
      {
        const NAME_FIELD_LABELS = {
          楽天商品名: "楽天の商品名",
          Yahoo商品名: "Yahoo!の商品名",
          商品名: "商品名",
          商品名略称: "商品名略称",
          メーカー品名: "メーカー品名",
        };
        const seriesHeader = managementMatch && managementMatch.columnMap["シリーズ"];
        const seriesValue = seriesHeader ? String(managementMatch.row[seriesHeader] || "").trim() : "";
        const identityText = normalizeText(
          [...Object.keys(NAME_FIELD_LABELS).map((k) => domValues[k] || ""), seriesValue].join(" ")
        ).toUpperCase();
        const isBrideRail =
          (/^bride-/i.test(String(domValues["自社品番"] || "").trim()) || /BRIDE|ブリッド/.test(identityText)) &&
          identityText.includes("シートレール");

        const makerCode = String(domValues["メーカー品番"] || "").trim();
        const makerCodes = isBrideRail
          ? [
              ...new Set(
                normalizeText(makerCode)
                  .toUpperCase()
                  .split("+")
                  .map((part) => {
                    const m = part.trim().match(/^[A-Z]{1,2}\d{2,4}([A-Z]{2})$/);
                    return m && brideRailSeatKind(m[1]) ? m[1] : null;
                  })
                  .filter(Boolean)
              ),
            ]
          : [];
        // Yahoo!等でカテゴリの階層名が「シートレール」でない場合（「フルバケット用レール」等）も比べられるよう、
        // 「レール」やブランド名の階層とも関係ありとみなす
        const makerSource = {
          entries: makerCodes.map((code) => ({ code, expr: `${code}タイプ`, words: ["シートレール", "レール", "BRIDE", "ブリッド"] })),
          describe: () => `メーカー品番「${makerCode}」は${makerCodes.map((c) => `${c}タイプ`).join("・")}です`,
        };
        const seriesSource = {
          entries: extractTypeExpressions(seriesValue),
          describe: () => `管理表のシリーズは「${seriesValue}」です`,
        };
        const nameSourceFor = (nameKeys) => {
          const entries = [];
          nameKeys.forEach((key) => {
            extractTypeExpressions(domValues[key] || "").forEach((e) => entries.push(Object.assign({ field: NAME_FIELD_LABELS[key] }, e)));
          });
          return {
            entries,
            describe: (related) =>
              `${related[0].field}に${[...new Set(related.map((e) => `「${e.expr}」`))].join("")}とあります`,
          };
        };

        // BRIDEのシートレールのシート形状（根拠の強い順に、最初に分かったもの）
        let seat = null;
        if (isBrideRail) {
          for (const source of [makerSource, seriesSource, nameSourceFor(Object.keys(NAME_FIELD_LABELS))]) {
            const railEntries = source.entries.filter((e) => brideRailSeatKind(e.code));
            const kinds = [...new Set(railEntries.map((e) => brideRailSeatKind(e.code)))];
            if (kinds.length === 1) {
              const codes = [...new Set(railEntries.map((e) => `${e.code}タイプ`))].join("・");
              seat = {
                kind: kinds[0],
                describe: () => `${source.describe(railEntries)}。${codes}は${BRIDE_SEAT_LABELS[kinds[0]]}です`,
              };
              break;
            }
            if (kinds.length > 1) break; // 形状の違うタイプが混ざっていて1つに決められない場合は比べない
          }
        }

        for (const target of categoryCheckTargets) {
          const sources = [makerSource, seriesSource, nameSourceFor(target.nameKeys.concat(["商品名略称", "メーカー品名"]))];
          target.categoryKeys.forEach((categoryKey, idx) => {
            const path = String(domValues[categoryKey] || "").trim();
            if (!path) return;
            const { types, others, otherTexts } = splitCategoryPath(path);
            const slotLabel = `${target.label}${idx + 1}`;
            const pathForDisplay = truncateForDisplay(path.replace(/\s+/g, " "), 100);

            let typeMismatch = false;
            if (types.length) {
              for (const source of sources) {
                const related = source.entries.filter((e) => isTypeRelatedToCategory(e, others));
                if (!related.length) continue;
                const productCodes = new Set(related.map((e) => e.code));
                if (!types.some((t) => productCodes.has(t.code))) {
                  typeMismatch = true;
                  addFinding(
                    `category_type_code_mismatch_${categoryKey}`,
                    `${slotLabel}が「${types.map((t) => t.expr).join("・")}」になっていますが、${source.describe(related)}（カテゴリ: ${pathForDisplay}）。コピー元のカテゴリのまま変更し忘れていないか確認してください`,
                    "yellow",
                    { targetKey: categoryKey },
                    target.severityKey
                  );
                }
                break; // 一番根拠の強い情報だけで判断する
              }
            }

            if (typeMismatch || !seat || keywordConflictLabels.has(target.label)) return;
            if (!others.some((s) => s.includes("シートレール"))) return;
            const ownKeywords = BRIDE_SEAT_KEYWORDS[seat.kind];
            const otherKeywords = Object.keys(BRIDE_SEAT_KEYWORDS)
              .filter((kind) => kind !== seat.kind)
              .flatMap((kind) => BRIDE_SEAT_KEYWORDS[kind]);
            if (otherTexts.some((s) => ownKeywords.some((k) => s.includes(k)))) return;
            const conflictSegment = otherTexts.find((s) => otherKeywords.some((k) => s.includes(k)));
            if (!conflictSegment) return;
            addFinding(
              `category_seat_kind_mismatch_${categoryKey}`,
              `${slotLabel}が「${conflictSegment}」になっていますが、${seat.describe()}（カテゴリ: ${pathForDisplay}）。コピー元のカテゴリのまま変更し忘れていないか確認してください`,
              "yellow",
              { targetKey: categoryKey },
              target.severityKey
            );
          });
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
      // 「適合車両情報」等の見出し語も同様。比較範囲は最初の見出しの後ろからなので、片方にだけ
      // 見出しが2回ある（「■適合情報」の下に「■適合車両情報」がある、ページ内リンクの後に本来の
      // 見出しがある等）と、2回目の見出し語だけが片方にしかない語として検出されてしまっていた
      // （「スマホ版にしかない語:「適合車両情報」」の誤検知。ページ作成担当者からのフィードバックより）。
      // 見出し語は車種名・型式・年式のようなデータではないため、比較対象から除外して問題ない。
      const PC_MOBILE_DIFF_IGNORE_WORDS = new Set(["注記"].concat(FITMENT_HEADING_WORDS).map(normalizeForCompare));
      const pcMobileTargets = [
        {
          // 楽天は「PC用商品説明文」とは別枠の「PC用販売説明文」に「※画像はイメージです。」
          // 等の注意書きが書かれていることがあり、そちらにしか無い内容を見落として
          // スマホ側にしかない差分として誤検知していたため、両方合わせてPC側とみなす
          // （PC用販売説明文にはスマホ側の対応項目が無い）。
          pcKeys: ["楽天PC用商品説明文", "楽天PC用販売説明文"],
          mobileKey: "楽天スマホ用商品説明文",
          label: "楽天のPC用商品説明文とスマホ用商品説明文",
        },
        {
          pcKeys: ["ヤフー商品説明"],
          mobileKey: "Yahooスマートフォン用フリースペース",
          label: "Yahoo!の商品説明とスマートフォン用フリースペース",
        },
      ];
      for (const target of pcMobileTargets) {
        // pcKeys[0]＝本来のPC用商品説明文のみの内容（「PCにあってスマホに無い」の判定に使う）。
        // 「PC用販売説明文」のような補助欄は、スマホ側の内容がPC側のどちらかにあれば良い
        // （＝「スマホにあってPCに無い」の見落とし防止）という片方向の救済にのみ使い、
        // 補助欄だけにある内容をもって「PCにあってスマホに無い」とは指摘しない
        // （補助欄はスマホ側に対応欄が無く、元々スマホには載らない運用のため。
        // 作業者からのフィードバックより）。
        const pcMainRelevant = extractRelevantMismatchText(domValues[target.pcKeys[0]]);
        const pcCombinedRelevant = target.pcKeys.map((k) => extractRelevantMismatchText(domValues[k])).filter(Boolean).join("\n");
        const mobileRelevant = extractRelevantMismatchText(domValues[target.mobileKey]);
        if (!pcCombinedRelevant && !mobileRelevant) continue;
        const pcMainMap = buildTextTokenMap(stripHtmlTags(pcMainRelevant));
        const pcCombinedMap = buildTextTokenMap(stripHtmlTags(pcCombinedRelevant));
        const mobileMap = buildTextTokenMap(stripHtmlTags(mobileRelevant));
        const onlyPc = Array.from(pcMainMap.keys())
          .filter((k) => !mobileMap.has(k) && !PC_MOBILE_DIFF_IGNORE_WORDS.has(k))
          .map((k) => pcMainMap.get(k));
        const onlyMobile = Array.from(mobileMap.keys())
          .filter((k) => !pcCombinedMap.has(k) && !PC_MOBILE_DIFF_IGNORE_WORDS.has(k))
          .map((k) => mobileMap.get(k));
        if (onlyPc.length || onlyMobile.length) {
          addFinding(
            `pc_mobile_mismatch_${target.pcKeys[0]}`,
            `${target.label}の適合車両情報・注意書きに違いがあるようです。PC版にしかない語:「${truncateForDisplay(onlyPc.join("、") || "(なし)", 80)}」／スマホ版にしかない語:「${truncateForDisplay(onlyMobile.join("、") || "(なし)", 80)}」`,
            "yellow",
            {},
            target.pcKeys[0]
          );
        }
      }
    }

    // 2e. 商品名のスペース表記チェック（ページ作成担当者からのフィードバックより）:
    // 半角スペースが2つ以上連続しているもの、末尾に半角/全角スペースが余分に残っているものは
    // 見た目上不自然なためイエロー扱いとする（managementMatchが無くても実行できる）。
    // 重大度は楽天商品名・Yahoo商品名の設定（コピー元残存・車種名整合性等と共通）ではなく、
    // このスペースチェック専用の設定（初期値イエロー）で判定する（楽天商品名等の色を
    // 変えても、スペースの指摘はイエローのままにするため）。
    {
      const DOUBLE_HALFWIDTH_SPACE_RE = / {2,}/;
      const TRAILING_SPACE_RE = /[ 　]$/;
      const PRODUCT_NAME_SPACE_SEVERITY_KEY = "商品名のスペース";
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
            { targetKey: target.key },
            PRODUCT_NAME_SPACE_SEVERITY_KEY
          );
        }
        if (TRAILING_SPACE_RE.test(raw)) {
          addFinding(
            `product_name_trailing_space_${target.key}`,
            `${target.label}の末尾に不要なスペースが入っています`,
            "yellow",
            { targetKey: target.key },
            PRODUCT_NAME_SPACE_SEVERITY_KEY
          );
        }
      }

      // 2e-2. コード系入力欄の空白混入チェック（ページ作成担当者からのフィードバックより）:
      // 自社品番・各モールの商品番号・カタログID・JANコード・SKUコード等は本来スペースを
      // 含まない識別子のため、先頭/末尾/途中を問わずスペース（半角・全角）が1文字でも
      // 入っていれば入力ミス（コピペ時の混入等）とみなす。商品名と違い語の区切りとして
      // スペースを使う場面が無いため、2個以上連続・末尾限定ではなく「1文字でもあれば」で判定する。
      // 重大度は各項目の設定（自社品番・メーカー品番はレッド等）ではなく、この空白チェック専用の
      // 設定（初期値イエロー）で判定する（依頼どおりイエローで注意する。以前は項目の設定を使って
      // いたため、自社品番・メーカー品番・SKU情報ではレッドになっていた）。
      const ANY_SPACE_RE = /[ 　]/;
      const CODE_SPACE_SEVERITY_KEY = "コード欄のスペース";
      const codeFieldTargets = [
        { key: "自社品番", label: "自社品番" },
        { key: "メーカー品番", label: "メーカー品番", spacesMayBeIntended: true },
        { key: "楽天商品管理番号", label: "楽天の商品管理番号" },
        { key: "楽天商品番号", label: "楽天の商品番号" },
        { key: "楽天カタログID", label: "楽天のカタログID" },
        { key: "ヤフー商品コード", label: "Yahoo!の商品コード" },
        { key: "ヤフーJANコード", label: "Yahoo!のJANコード" },
        { key: "Yahoo製品コード", label: "Yahoo!の製品コード", spacesMayBeIntended: true },
        { key: "Yahooショッピング製品コード", label: "Yahoo!ショッピング製品コード" },
      ];
      // メーカー品番（とそれをもとに入れる製品コード）には、入力ミスではないスペースもある。
      // ・セット商品の「SR-7820 2set」のような、品番と数量の間のスペース（セット構成のチェックで使う書き方）
      // ・管理表の品番にもともとスペースがあり、そのとおりに入力されているもの（「Citrus Foam」等）
      const withoutSetQuantitySpaces = (raw) =>
        String(raw)
          .normalize("NFKC")
          .split("+")
          .map((token) => token.replace(/\s+\d+\s*(?:個|本|枚|組)?\s*(?:set|セット)\s*$/i, (suffix) => suffix.replace(/\s+/g, "")))
          .join("+");
      const sameAsManagementValue = (domKey, raw) =>
        !!managementMatch &&
        (equalityPairs || []).some((pair) => {
          if (pair.domKey !== domKey) return false;
          const header = managementMatch.columnMap[pair.mgmtKey];
          const expected = header ? managementMatch.row[header] : undefined;
          return expected !== undefined && expected !== null && String(expected) === raw;
        });
      for (const target of codeFieldTargets) {
        const raw = domValues[target.key];
        if (!raw || !ANY_SPACE_RE.test(raw)) continue;
        if (target.spacesMayBeIntended && (!ANY_SPACE_RE.test(withoutSetQuantitySpaces(raw)) || sameAsManagementValue(target.key, raw))) {
          continue;
        }
        addFinding(
          `code_field_space_${target.key}`,
          `${target.label}「${raw}」にスペースが含まれています。入力ミスの可能性があるため確認してください`,
          "yellow",
          { targetKey: target.key },
          CODE_SPACE_SEVERITY_KEY
        );
      }

      const skuRowsForSpaceCheck = domValues.__skuRows || [];
      skuRowsForSpaceCheck.forEach((sku, idx) => {
        const skuFieldTargets = [
          { value: sku.skuCode, label: "SKUコード" },
          { value: sku.janCode, label: "正規JAN" },
          { value: sku.shelfNumber, label: "棚番号" },
          { value: sku.asin, label: "ASIN" },
        ];
        for (const f of skuFieldTargets) {
          if (f.value && ANY_SPACE_RE.test(f.value)) {
            addFinding(
              `sku_code_space_${f.label}_${idx}`,
              `SKU情報 ${idx + 1}行目の${f.label}「${f.value}」にスペースが含まれています。入力ミスの可能性があるため確認してください`,
              "yellow",
              { targetKey: "SKU情報" },
              CODE_SPACE_SEVERITY_KEY
            );
          }
        }
      });
    }

    // 2e-3. 環境依存文字チェック（出品前のチェックで「フォレスタ―」の「―」が環境依存文字として
    // 指摘されたため）: 商品名・キャッチコピー・説明文に環境依存文字があれば、項目ごとに、どの文字が
    // どこにあるかを示してイエローで知らせる（判定の範囲はisEnvironmentDependentCharを参照）。
    // 重大度は各項目の設定ではなく、このチェック専用の設定（初期値イエロー）で判定する。説明文は
    // テンプレートの「容量：300ℓ」のように同じ文字が何か所にも出ることがあるため、商品名とは別の設定にする。
    {
      const NAME_SEVERITY_KEY = "環境依存文字（商品名）";
      const TEXT_SEVERITY_KEY = "環境依存文字（説明文）";
      const ENV_CHAR_TARGETS = [
        { key: "商品名", label: "商品名", severityKey: NAME_SEVERITY_KEY },
        { key: "商品名略称", label: "商品名略称", severityKey: NAME_SEVERITY_KEY },
        { key: "メーカー品名", label: "メーカー品名", severityKey: NAME_SEVERITY_KEY },
        { key: "楽天商品名", label: "楽天の商品名", severityKey: NAME_SEVERITY_KEY },
        { key: "Yahoo商品名", label: "Yahoo!の商品名", severityKey: NAME_SEVERITY_KEY },
        { key: "ヤフーキャッチコピー", label: "Yahoo!のキャッチコピー", severityKey: TEXT_SEVERITY_KEY },
        { key: "楽天PC用商品説明文", label: "楽天のPC用商品説明文", severityKey: TEXT_SEVERITY_KEY },
        { key: "楽天PC用販売説明文", label: "楽天のPC用販売説明文", severityKey: TEXT_SEVERITY_KEY },
        { key: "楽天モバイル用商品説明文", label: "楽天のモバイル用商品説明文", severityKey: TEXT_SEVERITY_KEY },
        { key: "楽天スマホ用商品説明文", label: "楽天のスマホ用商品説明文", severityKey: TEXT_SEVERITY_KEY },
        { key: "ヤフー商品説明", label: "Yahoo!の商品説明", severityKey: TEXT_SEVERITY_KEY },
        { key: "ヤフー商品情報", label: "Yahoo!の商品情報", severityKey: TEXT_SEVERITY_KEY },
        { key: "Yahooフリースペース1", label: "Yahoo!のフリースペース1", severityKey: TEXT_SEVERITY_KEY },
        { key: "Yahooフリースペース2", label: "Yahoo!のフリースペース2", severityKey: TEXT_SEVERITY_KEY },
        { key: "Yahooフリースペース3", label: "Yahoo!のフリースペース3", severityKey: TEXT_SEVERITY_KEY },
        { key: "Yahooスマートフォン用フリースペース", label: "Yahoo!のスマートフォン用フリースペース", severityKey: TEXT_SEVERITY_KEY },
      ];
      const MAX_LISTED = 5;
      for (const target of ENV_CHAR_TARGETS) {
        const text = stripHtmlTags(domValues[target.key] || "");
        if (!text) continue;
        const found = findEnvironmentDependentChars(text);
        if (!found.length) continue;
        const listed = found.slice(0, MAX_LISTED).map((f) => {
          const desc = ENV_CHAR_DESCRIPTIONS[f.ch];
          return `「${f.ch}」（${desc ? `${desc}。` : ""}「${f.context}」の部分）`;
        });
        const more = found.length > MAX_LISTED ? `ほか${found.length - MAX_LISTED}種類` : "";
        const longVowelHint = found.some((f) => f.afterKatakana && LONG_VOWEL_LOOKALIKES.has(f.ch))
          ? "カタカナの後の横線は、伸ばす音なら長音記号「ー」に直してください。"
          : "";
        addFinding(
          `env_dependent_char_${target.key}`,
          `${target.label}に環境依存文字があります：${listed.join("、")}${more}。${longVowelHint}モールで文字化けやエラーになることがあるため、別の文字に置き換えてください`,
          "yellow",
          { targetKey: target.key },
          target.severityKey
        );
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

    // 2g. DIXCEL「同一適合ラインナップ」リンクの品番チェック
    // DIXCELの一部商品ページには、同一適合ラインナップ（型式違い等）の他商品ページへ案内する
    // 画像リンク（dixcel-rotor-lineup.jpg等）があり、リンク先の検索URLに
    // 「dixcel+{品番の数字部分}」という形でこのページ自身の品番を埋め込む運用になっている。
    // コピー元のまま数字部分を更新し忘れる、または文字まで含めてしまう（例:「PD2018851S」。
    // 本来は数字部分のみでよい）ミスがあったため、自社品番から求めた本来の数字部分と
    // 一致しているかを確認する（楽天・Yahoo!双方の全説明文・フリースペースが対象。
    // ページ作成担当者からのフィードバックより）。
    {
      const dixcelMatch = String(domValues["自社品番"] || "").match(/^dixcel-[a-z]*?(\d+)[a-z]*$/i);
      if (dixcelMatch) {
        const ownBareNumber = dixcelMatch[1];
        const lineupTargetKeys = [...((freeTextKeys && freeTextKeys.rakuten) || []), ...((freeTextKeys && freeTextKeys.yahoo) || [])];
        for (const key of lineupTargetKeys) {
          const text = domValues[key];
          if (!text) continue;
          const re = /dixcel\+([a-z0-9]+)/gi;
          let m;
          while ((m = re.exec(text))) {
            const found = m[1];
            if (found.toLowerCase() !== ownBareNumber.toLowerCase()) {
              addFinding(
                `dixcel_lineup_mismatch_${key}`,
                `「${key}」内の同一適合ラインナップのリンクに、自社品番の数字部分「${ownBareNumber}」とは異なる値「${found}」が入っています。コピー元のまま、または入力形式の誤りの可能性があります`,
                "yellow",
                { copyValue: ownBareNumber },
                key
              );
              break; // 同じ項目内で複数見つかっても1件にまとめる
            }
          }
        }
      }
    }

    // 2h. 【純正品番】見出しの直後が空欄のチェック
    // 商品説明文の「【純正品番】」という見出しの後に具体的な品番が続かず、見出しだけが
    // 残っているケースがある（コピー元からの編集時に品番の入力自体を忘れたもの。
    // ページ作成担当者からのフィードバックより）。見出し直後の行（<br>区切り）が
    // 空、または次の見出しに続く場合にイエローで指摘する。
    {
      const purePartNoTargetKeys = [...((freeTextKeys && freeTextKeys.rakuten) || []), ...((freeTextKeys && freeTextKeys.yahoo) || [])];
      const PURE_PARTNO_EMPTY_RE = /【純正品番】\s*(?:<br\s*\/?>\s*)*(?:【|$)/i;
      for (const key of purePartNoTargetKeys) {
        const text = domValues[key];
        if (!text) continue;
        if (PURE_PARTNO_EMPTY_RE.test(text)) {
          addFinding(
            `pure_partno_empty_${key}`,
            `「${key}」内の「【純正品番】」の直後に品番が入っていないようです。コピー元から編集する際に品番の入力を忘れていないか確認してください`,
            "yellow",
            {},
            key
          );
        }

        // 2h-2. 【純正品番】以降の品番の重複行チェック: コピー元の内容をそのまま
        // 複製してしまい、同じ品番の行がそのまま連続して重複しているケースがある。
        // 複数の車種で同じ純正品番を記載する（車種ごとに同じ品番が離れて登場する）のは
        // 正しい運用のため、隣接する行同士が完全に同じ場合だけを重複とみなす。
        const afterHeading = text.split(/【純正品番】/i)[1];
        if (afterHeading) {
          const lines = afterHeading
            .split(/<br\s*\/?>/gi)
            .map((line) => stripHtmlTags(line).trim())
            .filter((line) => line && line !== "・")
            .slice(0, 20); // 純正品番一覧より後の無関係な文章まで見てしまわないよう上限を設ける
          for (let i = 1; i < lines.length; i++) {
            if (normalizeForCompare(lines[i]) === normalizeForCompare(lines[i - 1])) {
              addFinding(
                `pure_partno_dup_${key}`,
                `「${key}」内の純正品番一覧に、同じ内容の行「${lines[i]}」が連続して重複しているようです`,
                "yellow",
                {},
                key
              );
              break; // 同じ項目内で複数重複があっても1件にまとめる
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

    // 4b-2. 楽天「カタログIDなしの理由」チェック（3-1.楽天市場ページ作成マニュアル[19]カタログID）
    //  - セット商品 → カタログIDの有無に関わらず「選択してください」（空欄）にする
    //    （運用変更により、カタログIDが入っていてもセット商品なら理由欄は空欄が正解になった）
    //  - セット商品以外でカタログIDが空欄 → 「5：該当商品コードなし」にする
    {
      const catalogId = domValues["楽天カタログID"];
      const catalogReason = domValues["楽天カタログIDなしの理由"];
      if (isSetProduct(domValues)) {
        if (!isZeroOrEmpty(catalogReason)) {
          addFinding(
            "catalog_id_reason_set",
            `セット商品のため楽天の「カタログIDなしの理由」は空欄（選択してください）にする必要があります（現在: ${catalogReason}）`,
            "yellow",
            { targetKey: "楽天カタログIDなしの理由" },
            "楽天カタログIDなしの理由セット商品"
          );
        }
      } else if (isZeroOrEmpty(catalogId) && normalizeForCompare(catalogReason) !== "5") {
        addFinding(
          "catalog_id_reason_missing",
          `楽天の「カタログID」が空欄です。正規のJANコードが無い場合は「カタログIDなしの理由」を「5：該当商品コードなし」にする必要があります（現在: ${catalogReason ? catalogReason : "(選択してください)"}）`,
          "red",
          {},
          "楽天カタログIDなしの理由"
        );
      }
    }

    // 4b-2a. セット商品のYahoo!「製品コード」「JANコード」空欄チェック
    //  - 4-1.Yahoo!ショッピングページ作成マニュアル[11][13]より、セット商品は正規JANコード・
    //    製品コードのどちらも存在しないため空欄で登録する（単品商品との等価性チェックは
    //    SET_EXEMPT_EQUALITY_KEYSで既にスキップしているが、スキップ＝空欄を強制する
    //    わけではないため、空欄チェック自体は別途必要。実際に製品コードへコピー元の値が
    //    残ったまま登録されていた事例より）。
    if (isSetProduct(domValues)) {
      const setBlankTargets = [
        { key: "Yahoo製品コード", label: "製品コード" },
        { key: "ヤフーJANコード", label: "JANコード" },
      ];
      for (const target of setBlankTargets) {
        const value = domValues[target.key];
        if (!isZeroOrEmpty(value)) {
          addFinding(
            `set_product_yahoo_blank_${target.key}`,
            `セット商品のためYahoo!の「${target.label}」は空欄にする必要があります（現在: ${value}）`,
            "yellow",
            {},
            target.key
          );
        }
      }
    }

    // 4b-2b. 楽天「在庫切れ時納期」とYahoo!「在庫切れ時納期」の不一致チェック
    //  - 楽天側は文言を直接選ぶプルダウン（#template_9）で、選択肢の並び順＝管理番号（value）。
    //  - Yahoo!側（#lead_time_outstock）は同じ管理番号を手入力するだけの欄で、文言は出ない
    //    （値の意味はストアクリエイターProの「お届け情報設定」でしか確認できない）。
    //  - Yahoo!の番号は楽天の選択肢と同じ並び順で付けられているだけなので、本来両者の値は
    //    常に一致するはず。どの番号にすべきかをページレフェリー側で判断するのは難しいため、
    //    「食い違っていたら楽天の値をそのままYahoo!にコピーする」運用にする
    //    （実際に楽天「3」・Yahoo!「1」のまま登録されてしまった事例より）。
    {
      const rakutenLeadTime = domValues["楽天在庫切れ時納期"];
      const yahooLeadTime = domValues["Yahoo在庫切れ時納期"];
      if (!isZeroOrEmpty(rakutenLeadTime) && normalizeForCompare(rakutenLeadTime) !== normalizeForCompare(yahooLeadTime)) {
        const rakutenLabel = domValues["楽天在庫切れ時納期文言"];
        addFinding(
          "lead_time_outstock_mismatch",
          `楽天の「在庫切れ時納期」（${rakutenLeadTime}${rakutenLabel ? `：${rakutenLabel}` : ""}）とYahoo!の「在庫切れ時納期」管理番号（${yahooLeadTime ? yahooLeadTime : "(空欄)"}）が一致していません。Yahoo!には楽天と同じ番号「${rakutenLeadTime}」を入力してください`,
          "yellow",
          { copyValue: rakutenLeadTime, targetKey: "Yahoo在庫切れ時納期" },
          "楽天Yahoo在庫切れ時納期差異"
        );
      }
    }

    // 4b-3. 楽天「商品画像名称19・20」チェック: キャンペーン用に一時的に使う欄のため、
    // コピー元にキャンペーン用の画像URL/ALTが残ったまま新規登録されることがある。
    // 新規作成時は空欄である必要がある（ページ作成担当者からのフィードバックより）。
    {
      const campaignImageSlots = [
        { urlKey: "楽天商品画像19URL", altKey: "楽天商品画像19ALT", label: "商品画像名称19" },
        { urlKey: "楽天商品画像20URL", altKey: "楽天商品画像20ALT", label: "商品画像名称20" },
      ];
      for (const slot of campaignImageSlots) {
        if (!isZeroOrEmpty(domValues[slot.urlKey]) || !isZeroOrEmpty(domValues[slot.altKey])) {
          addFinding(
            `campaign_image_not_empty_${slot.urlKey}`,
            `楽天の「${slot.label}」（キャンペーン用画像欄）に何か入力されています。新規作成時は空欄にする必要があるため、コピー元の内容が残っていないか確認して削除してください`,
            "yellow",
            {},
            slot.urlKey
          );
        }
      }
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

    // 4d. Amazon用編集項目（発送日数・配送パターン・販売価格等）
    // 新規作成時点ではAmazon側の入力は不要になったため、ASINの有無にかかわらず常に
    // 発送日数「0」・配送パターン「---（未選択）」・その他項目は空欄/未チェックである
    // 必要がある（ページ作成担当者からのフィードバックより。以前はASIN登録済みの場合に
    // 別の入力ルールがあったが、その運用は廃止された）。
    {
      const amazonUnusedSeverityKey = "Amazon不要入力";

      if (normalizeForCompare(domValues["Amazon発送日数"]) !== "0") {
        addFinding(
          "amazon_leadtime_not_zero",
          `Amazonの「発送日数」は0である必要があります（現在の値: ${domValues["Amazon発送日数"] || "(空欄)"}）`,
          "red",
          { targetKey: "Amazon発送日数" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazon配送パターン"])) {
        addFinding(
          "amazon_shipping_pattern_not_empty",
          `Amazonの「配送パターン」は「---（未選択）」である必要があります（現在の値: ${domValues["Amazon配送パターン"]}）`,
          "red",
          { targetKey: "Amazon配送パターン" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazon販売価格"])) {
        addFinding(
          "amazon_price_not_empty",
          `Amazonの「販売価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazon販売価格"]}）`,
          "red",
          { targetKey: "Amazon販売価格" },
          amazonUnusedSeverityKey
        );
      }
      // Amazonの「ポイント」「法人価格」は、常に空欄が必要なFIXED_RULE_CHECKS側の
      // ルールで一括してチェックする（ここで重複してチェックすると同じ内容が2件出てしまう）。
      if (!isZeroOrEmpty(domValues["Amazonメーカー希望小売価格"])) {
        addFinding(
          "amazon_msrp_not_empty",
          `Amazonの「メーカー希望小売価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazonメーカー希望小売価格"]}）`,
          "red",
          { targetKey: "Amazonメーカー希望小売価格" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazonセール価格"])) {
        addFinding(
          "amazon_saleprice_not_empty",
          `Amazonの「セール価格（税込）」は空欄である必要があります（現在の値: ${domValues["Amazonセール価格"]}）`,
          "red",
          { targetKey: "Amazonセール価格" },
          amazonUnusedSeverityKey
        );
      }
      if (!isZeroOrEmpty(domValues["Amazonセール期間開始"]) || !isZeroOrEmpty(domValues["Amazonセール期間終了"])) {
        addFinding(
          "amazon_sale_period_not_empty",
          "Amazonの「セール期間」は空欄である必要があります",
          "red",
          { targetKey: "Amazonセール期間開始" },
          amazonUnusedSeverityKey
        );
      }
      if (domValues["Amazonギフト包装"] === "true") {
        addFinding(
          "amazon_giftwrap_checked",
          "Amazonの「ギフト（ギフト包装を行う）」のチェックは外す必要があります",
          "red",
          { targetKey: "Amazonギフト包装" },
          amazonUnusedSeverityKey
        );
      }
      if (domValues["Amazonギフトメッセージ"] === "true") {
        addFinding(
          "amazon_giftmessage_checked",
          "Amazonの「ギフト（ギフトメッセージを行う）」のチェックは外す必要があります",
          "red",
          { targetKey: "Amazonギフトメッセージ" },
          amazonUnusedSeverityKey
        );
      }
      if (domValues["Amazon並行輸入品"] === "true") {
        addFinding(
          "amazon_parallel_import_checked",
          "Amazonの「販売形態（並行輸入品）」のチェックは外す必要があります",
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
        let mgmtSkuMismatchFlagged = false;
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
          mgmtSkuMismatchFlagged = true;
        }

        // セット商品は楽天SKU商品情報の「SKU」欄に自社品番をそのまま入れる運用のため、
        // 管理表側のSKU列が空欄等でチェックできない場合でも、自社品番との不一致だけは
        // 検出できるようにする（一致していないと楽天への商品登録自体が失敗することがある。
        // ページ作成担当者からのフィードバックより）。管理表との不一致で既に指摘済みの
        // 場合は同じ原因を二重に報告しないようスキップする。
        if (isSetProduct(domValues) && sku.skuCode && !mgmtSkuMismatchFlagged) {
          const ownCompanyCode = domValues["自社品番"];
          if (ownCompanyCode && !valuesEqual(sku.skuCode, ownCompanyCode)) {
            addFinding(
              `sku_code_set_mismatch_${idx}`,
              `セット商品のため、SKU情報 ${idx + 1}行目のSKU「${sku.skuCode}」は自社品番「${ownCompanyCode}」と一致している必要があります（一致していないと楽天への商品登録に失敗することがあります）`,
              "red",
              { copyValue: ownCompanyCode },
              "SKU情報"
            );
          }
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

        // 新規作成時点ではAmazonへの入力は不要になったため、ASINは空欄である必要がある
        // （ページ作成担当者からのフィードバックより）。
        if (sku.asin) {
          addFinding(
            `sku_asin_not_empty_${idx}`,
            `SKU情報 ${idx + 1}行目のASIN「${sku.asin}」が入力されています。新規作成時は空欄にする必要があります`,
            "red",
            {},
            "SKU情報"
          );
        }

        // 1.通販する蔵の商品マスター作成マニュアル sku_data [9]メーカーサイズ:
        // 新規作成時は「登録日」だけが入っているはず。コピー元の日付がそのまま
        // 残っている（今日の日付になっていない）場合、空欄のまま未入力の場合、
        // および今日の日付の後に別の日付の断片等が余分にくっついて残っている場合
        // （例:「2026/09/14登録04登録」。コピー元の値が完全に上書きされず末尾に
        // 残ったケース）、いずれも更新し忘れの可能性がある。startsWithだと末尾の
        // 余分な残存に気づけないため、完全一致で判定する。
        // 前日以前に作成したページを翌日以降に確認すると、正しく入力されていても今日の日付では
        // ないため必ず指摘される。そのため重大度はSKU情報（レッド）ではなく、この項目専用の設定
        // （初期値イエロー）で判定する（ページ作成担当者からのフィードバックより）。
        if (normalizeText(sku.makerSize).trim() !== `${todayForMakerSize}登録`) {
          const message = sku.makerSize
            ? `SKU情報 ${idx + 1}行目の「メーカーサイズ」が今日の日付になっていません（コピー元の日付「${sku.makerSize}」が残っている可能性があります。新規作成時は「${todayForMakerSize}登録」のように今日の日付を入力してください。前日以前に作成した商品で、作成した日の日付が入っている場合は問題ありません）`
            : `SKU情報 ${idx + 1}行目の「メーカーサイズ」が空欄です。新規作成時は「${todayForMakerSize}登録」のように今日の日付を入力してください`;
          addFinding(
            `sku_makersize_stale_${idx}`,
            message,
            "yellow",
            { copyValue: `${todayForMakerSize}登録`, targetKey: "SKU情報" },
            "SKU情報のメーカーサイズ"
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
      } else if (rule.expectedZeroOrEmpty) {
        // 空欄で保存すると、する蔵側の仕様で自動的に「0」が入る数値項目向け。
        // 空欄・「0」のどちらも正しい状態として扱う。
        if (!isZeroOrEmpty(actual)) {
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

    // 7. 別画面（楽天「SKU別 商品情報」「商品属性設定」、セット商品の「セット構成」）チェック
    // どれもメイン画面のボタンから開く別画面で、メイン画面で一度登録した後でないと入力できない。
    // content.js側で保存済みの内容を読み込んで渡してもらい、ここで判定する（rakutenSubpages・
    // setCompositionが無い＝読み込み処理を通っていない場合は何もしない）。
    // 問題が無かった別画面は、正しく設定されていることが分かるようグリーンで表示する。
    if (rakutenSubpages) {
      checkRakutenSubpages(rakutenSubpages, attributeRules, domValues["自社品番"], addFinding, addOk, isSet);
    }
    if (setComposition) {
      checkSetComposition(setComposition, domValues["メーカー品番"], addFinding, addOk);
    }

    return findings;
  }

  // addFindingを包んで、検出した問題の数を数える（重大度設定で「なし」にして表示しないものも
  // 数える）。問題が1つも無かった別画面だけをグリーンにするために使う。
  function countIssues(addFinding) {
    let count = 0;
    return {
      report(...args) {
        count += 1;
        addFinding(...args);
      },
      get count() {
        return count;
      },
    };
  }

  const SUBPAGE_UNAVAILABLE_SEVERITY_KEY = "楽天SKU別・商品属性の確認不可";
  const SAVED_STATE_NOTE = "※各画面で「更新」ボタンを押して保存済みの内容で判定しています";

  function lastGenreSegment(genreName) {
    const parts = String(genreName || "").split(/[＞>]/);
    return parts[parts.length - 1].trim();
  }

  function emptySkuCodes(row) {
    return Object.keys(row.bySku).filter((sku) => !row.bySku[sku].filled);
  }

  function skuSuffix(row, emptySkus) {
    return Object.keys(row.bySku).length > 1 ? `、SKU: ${emptySkus.join("・")}` : "";
  }

  // 指摘をクリックしたときの移動先。メイン画面（保存済みの内容を読み込んで判定）では
  // その画面を開くボタンへ、サブ画面そのもの（live: 入力中の内容で判定）では該当する入力欄へ。
  // サブ画面で入力欄を特定できない指摘（決め事が未設定など）は移動先なしにする。
  function subpageTarget(live, buttonKey, targetName) {
    if (!live) return { targetKey: buttonKey };
    return targetName ? { targetName } : {};
  }

  // isSet: セット商品か（登録前のお知らせに「セット構成の登録」も含めるため）
  function checkRakutenSubpages(subpages, attributeRules, companyCode, addFinding, addOk, isSet) {
    if (!subpages.registered) {
      const screens = isSet
        ? "「SKU別 商品情報」「商品属性設定」の入力と、「セット構成の登録」"
        : "「SKU別 商品情報」「商品属性設定」の入力";
      addFinding(
        "rakuten_subpages_before_register",
        `メイン画面の登録後に表示される${screens}も必要です。登録後にもう一度「確認する」を押して、入力漏れが無いか確認してください`,
        "yellow",
        {},
        "楽天SKU別・商品属性の登録後リマインド"
      );
      return;
    }

    const ownCode = String(companyCode || "").trim();

    const skuIssues = countIssues(addFinding);
    checkSkuSubpage(subpages.sku, ownCode, skuIssues.report, false);
    const sku = subpages.sku;
    if (skuIssues.count === 0 && sku && sku.ok && sku.skus.length) {
      addOk(
        "rakuten_sku_ok",
        sku.skus.length === 1
          ? `「SKU別 商品情報」のSKU管理番号は自社品番「${ownCode}」と一致しています`
          : `「SKU別 商品情報」のSKU管理番号はすべて入力されています（SKU ${sku.skus.length}件）`,
        { targetKey: "楽天SKU別商品情報ボタン" }
      );
    }

    const genreIssues = countIssues(addFinding);
    checkGenreSubpage(subpages.genre, attributeRules, genreIssues.report, false);
    const genre = subpages.genre;
    if (genreIssues.count === 0 && genre && genre.ok && genre.genres.length) {
      const genreLabels = genre.genres
        .map((g) => `ジャンル${g.genreId}${g.genreName ? `：${lastGenreSegment(g.genreName)}` : ""}`)
        .join("、");
      addOk(
        "rakuten_genre_ok",
        `「商品属性設定」は正しく設定されています（必須項目・決め事のオレンジ項目すべて入力済み／${genreLabels}）`,
        { targetKey: "楽天商品属性設定ボタン" }
      );
    }
  }

  // sku: subpages.parseSkuPageの戻り値。live（その画面自体で入力中の内容を判定）かどうかで
  // 移動先と、保存済みの内容で判定している旨の注記の有無だけが変わる。
  function checkSkuSubpage(sku, ownCode, addFinding, live) {
    const note = live ? "" : SAVED_STATE_NOTE;
    const target = (targetName) => subpageTarget(live, "楽天SKU別商品情報ボタン", targetName);
    if (!sku || !sku.ok) {
      addFinding(
        "rakuten_sku_page_unavailable",
        `「SKU別 商品情報」の画面を読み込めなかったため、SKU管理番号を確認できませんでした${sku && sku.error ? `（${sku.error}）` : ""}。画面を開いて直接確認してください`,
        "yellow",
        target(),
        SUBPAGE_UNAVAILABLE_SEVERITY_KEY
      );
      return;
    }
    // SKUが1件も無い場合はメイン画面のSKU情報側（sku_empty）で既に指摘しているため何もしない
    sku.skus.forEach((s, idx) => {
      if (!s.skuManageNo) {
        addFinding(
          `rakuten_sku_manage_no_empty_${idx}`,
          `「SKU別 商品情報」のSKU管理番号が空欄です（SKU: ${s.skuCode}）。自社品番${ownCode ? `「${ownCode}」` : ""}を入力してください。${note}`,
          "red",
          Object.assign({ copyValue: ownCode }, target(s.targetName)),
          "楽天SKU管理番号"
        );
      } else if (sku.skus.length === 1 && ownCode && s.skuManageNo !== ownCode) {
        // 複数SKU（カラー・サイズ違い等）の商品はSKUごとに別の管理番号になるため、
        // 自社品番との一致まで求めるのは1SKUの商品だけにする。
        addFinding(
          `rakuten_sku_manage_no_mismatch_${idx}`,
          `「SKU別 商品情報」のSKU管理番号「${s.skuManageNo}」が自社品番「${ownCode}」と一致しません。コピー元の値が残っていないか確認してください`,
          "red",
          Object.assign({ copyValue: ownCode }, target(s.targetName)),
          "楽天SKU管理番号"
        );
      }
    });
  }

  // genre: subpages.parseGenrePageの戻り値。liveについてはcheckSkuSubpageと同じ。
  // 複数SKUで空欄のSKUが複数ある場合、移動先はそのうち最初のSKUの入力欄にする。
  function checkGenreSubpage(genre, attributeRules, addFinding, live) {
    const note = live ? "" : SAVED_STATE_NOTE;
    const target = (targetName) => subpageTarget(live, "楽天商品属性設定ボタン", targetName);
    if (!genre || !genre.ok) {
      addFinding(
        "rakuten_genre_page_unavailable",
        `「商品属性設定」の画面を読み込めなかったため、商品属性を確認できませんでした${genre && genre.error ? `（${genre.error}）` : ""}。画面を開いて直接確認してください`,
        "yellow",
        target(),
        SUBPAGE_UNAVAILABLE_SEVERITY_KEY
      );
      return;
    }
    if (!genre.genres.length) {
      addFinding(
        "rakuten_genre_none",
        "「商品属性設定」に現在のジャンルが表示されていません。楽天のジャンルIDが設定されているか確認してください",
        "red",
        target(),
        "楽天商品属性の必須項目"
      );
      return;
    }

    let rulesMissingReported = false;
    genre.genres.forEach((g) => {
      const genreLabel = `ジャンル${g.genreId}${g.genreName ? `：${lastGenreSegment(g.genreName)}` : ""}`;

      g.rows
        .filter((row) => row.required)
        .forEach((row) => {
          const emptySkus = emptySkuCodes(row);
          if (!emptySkus.length) return;
          addFinding(
            `rakuten_attr_required_${g.genreId}_${row.label}`,
            `「商品属性設定」の必須項目「${row.label}」が空欄です（${genreLabel}${skuSuffix(row, emptySkus)}）。${note}`,
            "red",
            target(row.bySku[emptySkus[0]].targetName),
            "楽天商品属性の必須項目"
          );
        });

      if (!attributeRules || !attributeRules.genres || !attributeRules.groups) {
        if (!rulesMissingReported) {
          rulesMissingReported = true;
          addFinding(
            "rakuten_attr_rules_missing",
            "商品属性の決め事ファイルが未設定のため、オレンジ背景の推奨項目が入力されているかは確認できていません（設定画面「②-2 商品属性の決め事ファイル」で読み込んでください）",
            "yellow",
            target(),
            SUBPAGE_UNAVAILABLE_SEVERITY_KEY
          );
        }
        return;
      }
      const genreRule = attributeRules.genres[g.genreId];
      if (!genreRule) {
        addFinding(
          `rakuten_attr_genre_unknown_${g.genreId}`,
          `${genreLabel} が決め事の「★ジャンル一覧」に載っていないため、入力すべき推奨項目（オレンジ）を確認できませんでした。決め事への追加が必要か管理者に確認してください`,
          "yellow",
          target(),
          SUBPAGE_UNAVAILABLE_SEVERITY_KEY
        );
        return;
      }
      const groupRule = attributeRules.groups[genreRule.group];
      if (!groupRule) {
        addFinding(
          `rakuten_attr_group_unknown_${g.genreId}`,
          `グループ「${genreRule.group}」が決め事の「★属性早見表」に見当たらないため、入力すべき推奨項目（オレンジ）を確認できませんでした`,
          "yellow",
          target(),
          SUBPAGE_UNAVAILABLE_SEVERITY_KEY
        );
        return;
      }

      groupRule.orange.forEach((attrName) => {
        const row = g.rows.find((r) => normalizeForCompare(r.label) === normalizeForCompare(attrName));
        if (!row) {
          addFinding(
            `rakuten_attr_orange_not_found_${g.genreId}_${attrName}`,
            `決め事でオレンジ（入力が必要）の「${attrName}」が、「商品属性設定」の画面に見当たりませんでした（グループ: ${genreRule.group}、${genreLabel}）。楽天側で項目名が変わっていないか確認してください`,
            "yellow",
            target(),
            SUBPAGE_UNAVAILABLE_SEVERITY_KEY
          );
          return;
        }
        if (row.required) return; // 必須項目として上で判定済み
        const emptySkus = emptySkuCodes(row);
        if (!emptySkus.length) return;
        addFinding(
          `rakuten_attr_orange_${g.genreId}_${attrName}`,
          `「商品属性設定」の「${attrName}」が空欄です。決め事（★属性早見表）でオレンジ＝入力が必要な項目です（グループ: ${genreRule.group}、${genreLabel}${skuSuffix(row, emptySkus)}）。${note}`,
          "red",
          target(row.bySku[emptySkus[0]].targetName),
          "楽天商品属性のオレンジ項目"
        );
      });
    });
  }

  // 「SKU別 商品情報」「商品属性設定」の画面そのもので「確認する」を押したときの判定。
  // 管理表との照合などメイン画面用の確認はできないため、その画面の入力欄だけを、まだ「更新」
  // していない入力中の内容（parsedはsubpagesのparse○○Page(…, { live: true })の戻り値）で
  // 確認する。判定内容と重大度設定は、メイン画面での確認（checkRakutenSubpages）と同じ。
  function runSubpageChecks(params) {
    const { subpageType, parsed, companyCode, attributeRules, severityMap } = params;
    const { findings, addFinding } = createFindingCollector(severityMap);
    if (subpageType === "sku") {
      checkSkuSubpage(parsed, String(companyCode || "").trim(), addFinding, true);
    } else if (subpageType === "genre") {
      checkGenreSubpage(parsed, attributeRules, addFinding, true);
    } else {
      throw new Error(`runSubpageChecks: 未対応の画面です（${subpageType}）`);
    }
    return findings;
  }

  // ---------- セット構成 ----------
  // セット商品の構成品は、メーカー品番を「+」で区切った品番（同じ品番が2つあれば数量2）。
  // 「SR-7820 2set」「ER266BS3 2セット」のように、品番の後ろに空白を挟んで「数字＋set/セット」が
  // 付いている場合はその数量。「M4×8Ti」「VSTK6-X1EA2」のように×やXを含む普通の品番を数量と
  // 取り違えないよう、数量として読むのはこの書き方だけにする。
  const SET_QUANTITY_SUFFIX_RE = /^(.+?)\s+(\d+)\s*(?:個|本|枚|組)?\s*(?:set|セット)$/i;
  const SET_TARGET = { targetKey: "セット構成の登録ボタン" };
  const SET_SAVED_NOTE = "※セット構成の画面で「登録」した内容で判定しています";

  // 品番の比較用キー（大文字小文字・全角半角・空白・ハイフン類の違いは無視する）
  function partNumberKey(code) {
    return String(code || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[\s\-‐‑‒–—―−]/g, "");
  }

  // 戻り値: [{ code, key, qty }]（同じ品番はまとめて数量を合計）
  function parseSetComposition(makerCode) {
    const items = [];
    String(makerCode || "")
      .normalize("NFKC")
      .split("+")
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach((token) => {
        const m = token.match(SET_QUANTITY_SUFFIX_RE);
        const code = m ? m[1].trim() : token;
        const key = partNumberKey(code);
        if (!key) return;
        const qty = m ? parseInt(m[2], 10) : 1;
        const existing = items.find((item) => item.key === key);
        if (existing) existing.qty += qty;
        else items.push({ code, key, qty });
      });
    return items;
  }

  // 片方の品番の前にだけ英字2文字以上が付いている（THULEの「TH7105」と「7105」、「THKIT5475」と
  // 「5475」のように、同じ商品でもメーカー品番の書き方が商品によって違うもの）。末尾の色記号等が
  // 違うもの（XB130とXB130BK）は別の商品として扱う。
  function differsOnlyByAlphaPrefix(a, b) {
    const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
    if (longer === shorter || !longer.endsWith(shorter)) return false;
    if (shorter.length < 3 || !/\d/.test(shorter)) return false;
    return /^[A-Z]{2,}$/.test(longer.slice(0, longer.length - shorter.length));
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // 子商品名の中に品番がそのまま含まれているか（前後が英数字でないこと。XB130がXB130BKに
  // 一致しないようにする）
  function nameContainsPartNumber(name, code) {
    const hay = String(name || "").normalize("NFKC").toUpperCase();
    const needle = String(code || "").normalize("NFKC").toUpperCase().trim();
    if (!needle) return false;
    return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(needle)}($|[^A-Z0-9])`).test(hay);
  }

  // 子商品がメーカー品番から読み取った品番と同じ商品かどうか。数字が小さいほど確かな一致。
  // 1: 一致 2: 英字の接頭辞だけ違う 3: 子商品にメーカー品番が無く、子商品名に品番が含まれる 0: 別の商品
  function setPartMatchLevel(item, child) {
    if (child.makerKey) {
      if (child.makerKey === item.key) return 1;
      return differsOnlyByAlphaPrefix(child.makerKey, item.key) ? 2 : 0;
    }
    return nameContainsPartNumber(child.name, item.code) ? 3 : 0;
  }

  // 子商品の行を品番ごとにまとめる（同じ商品が複数行に分けて登録されている場合は数量を合計）
  function groupSetChildren(children) {
    const groups = [];
    children.forEach((c) => {
      const makerKey = partNumberKey(c.makerCode);
      const groupKey = makerKey || `#${String(c.code).toLowerCase()}`;
      let group = groups.find((g) => g.groupKey === groupKey);
      if (!group) {
        group = { groupKey, makerKey, makerCode: c.makerCode, name: c.name, code: c.code, qty: 0, qtyInvalid: false, rows: 0 };
        groups.push(group);
      }
      group.rows += 1;
      if (c.qty === null) group.qtyInvalid = true;
      else group.qty += c.qty;
    });
    return groups;
  }

  // メーカー品番から読み取った構成品（expectedItems）と、セット構成に登録されている子商品の突き合わせ。
  // 確かな一致から順に組み合わせる。戻り値: { pairs: [{ item, child }], missing: [item], extra: [child] }
  // （pairsはメーカー品番の並び順）
  function compareSetComposition(expectedItems, children) {
    const pending = expectedItems.slice();
    const unmatched = groupSetChildren(children);
    const pairs = [];
    [1, 2, 3].forEach((level) => {
      pending.slice().forEach((item) => {
        const idx = unmatched.findIndex((child) => setPartMatchLevel(item, child) === level);
        if (idx < 0) return;
        pairs.push({ item, child: unmatched[idx] });
        unmatched.splice(idx, 1);
        pending.splice(pending.indexOf(item), 1);
      });
    });
    pairs.sort((a, b) => expectedItems.indexOf(a.item) - expectedItems.indexOf(b.item));
    return { pairs, missing: pending, extra: unmatched };
  }

  function formatSetItems(items) {
    return items.map((item) => `${item.code}×${item.qty}`).join("・");
  }

  function describeSetChild(child) {
    if (child.makerCode) return child.name ? `${child.makerCode}（${child.name}）` : child.makerCode;
    return child.name || child.code;
  }

  // setData: { search: subpages.parseSetSearchPageの戻り値, entries: [親SKUごとのparseSetEntryPageの戻り値] }
  // （メイン画面で一度登録した後のセット商品だけ、content.js側で読み込んで渡してもらう）
  function checkSetComposition(setData, makerCode, addFinding, addOk) {
    const makerCodeText = String(makerCode || "").trim();
    const expectedItems = parseSetComposition(makerCodeText);
    if (!expectedItems.length) {
      addFinding(
        "set_maker_code_empty",
        "セット商品ですが、メーカー品番が空のため、セット構成の構成品が正しいか確認できません（構成品はメーカー品番を「+」で区切った品番で判断します）",
        "yellow",
        { targetKey: "メーカー品番" },
        "セット構成の確認不可"
      );
      return;
    }

    const search = setData.search;
    if (!search || !search.ok) {
      addFinding(
        "set_page_unavailable",
        `セット構成の画面を読み込めなかったため、構成品を確認できませんでした${search && search.error ? `（${search.error}）` : ""}。「セット構成の登録」から直接確認してください`,
        "yellow",
        SET_TARGET,
        "セット構成の確認不可"
      );
      return;
    }
    if (!search.groups.length) {
      addFinding(
        "set_not_registered",
        `セット構成が登録されていません。「セット構成の登録」から、メーカー品番「${makerCodeText}」の構成品（${formatSetItems(expectedItems)}）を登録してください`,
        "red",
        SET_TARGET,
        "セット構成"
      );
      return;
    }

    // 1つのセット商品にSKUが複数ある場合、セット構成はSKU（親SKU）ごとに登録されている
    const multi = search.groups.length > 1;
    search.groups.forEach((group, gi) => {
      const where = multi ? `（親SKU: ${group.parentSku}）` : "";
      const entry = setData.entries && setData.entries[gi];
      if (!entry || !entry.ok) {
        addFinding(
          `set_entry_unavailable_${gi}`,
          `セット構成の編集画面を読み込めなかったため、構成品を確認できませんでした${where}${entry && entry.error ? `（${entry.error}）` : ""}。「セット構成の登録」から直接確認してください`,
          "yellow",
          SET_TARGET,
          "セット構成の確認不可"
        );
        return;
      }

      const issues = countIssues(addFinding);
      if (!entry.children.length) {
        issues.report(
          `set_no_children_${gi}`,
          `セット構成に構成品が1つも登録されていません${where}。メーカー品番「${makerCodeText}」の構成品（${formatSetItems(expectedItems)}）を登録してください。${SET_SAVED_NOTE}`,
          "red",
          SET_TARGET,
          "セット構成"
        );
        return;
      }

      const { pairs, missing, extra } = compareSetComposition(expectedItems, entry.children);
      missing.forEach((item) => {
        issues.report(
          `set_missing_${gi}_${item.key}`,
          `メーカー品番「${makerCodeText}」に含まれる「${item.code}」（数量${item.qty}）が、セット構成に登録されていません${where}。${SET_SAVED_NOTE}`,
          "red",
          SET_TARGET,
          "セット構成"
        );
      });
      extra.forEach((child) => {
        issues.report(
          `set_extra_${gi}_${child.groupKey}`,
          `セット構成に登録されている「${describeSetChild(child)}」は、メーカー品番「${makerCodeText}」に含まれていない構成品です${where}。登録した商品が間違っていないか確認してください。${SET_SAVED_NOTE}`,
          "red",
          SET_TARGET,
          "セット構成"
        );
      });
      pairs.forEach(({ item, child }) => {
        const label = child.makerCode || item.code;
        if (child.qtyInvalid || child.qty !== item.qty) {
          const actualQty = child.qtyInvalid ? "未入力（または数字以外）" : String(child.qty);
          issues.report(
            `set_qty_${gi}_${item.key}`,
            `セット構成の「${label}」の数量が${actualQty}になっています${where}。メーカー品番「${makerCodeText}」では数量${item.qty}です。${SET_SAVED_NOTE}`,
            "red",
            SET_TARGET,
            "セット構成"
          );
        }
        if (child.rows > 1) {
          issues.report(
            `set_duplicate_${gi}_${child.groupKey}`,
            `セット構成に「${label}」が${child.rows}行に分けて登録されています${where}。1行にまとめて、数量を${item.qty}にしてください`,
            "yellow",
            SET_TARGET,
            "セット構成の重複"
          );
        }
      });

      if (issues.count === 0) {
        const summary = pairs.map(({ item, child }) => `${child.makerCode || item.code}×${item.qty}`).join("・");
        addOk(`set_ok_${gi}`, `セット構成は正しく登録されています${where}（${summary}）`, SET_TARGET);
      }
    });
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
    runSubpageChecks,
    isSetProduct,
    parseSetComposition,
    compareSetComposition,
    extractNameAttributes,
  };
})(typeof window !== "undefined" ? window : globalThis);
