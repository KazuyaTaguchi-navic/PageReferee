// chrome.storage.local ラッパー + 既定値定義（プレーンスクリプト。options.js / content.js 両方から読み込む）
(function (global) {
  "use strict";

  const STORAGE_KEY = "hinbanReferee";

  // 通販する蔵の実ページ（PCT/する蔵ページソース...txt）から確認済みの既定DOMマッピング。
  // 型は "single"（1要素） / "repeating"（SKU情報のような繰り返し行）。
  const DEFAULT_FIELD_MAP = {
    自社品番: { type: "single", selector: "#company_product_code", attr: "value" },
    メーカー品番: { type: "single", selector: "[name=\"maker_product_code\"]", attr: "value" },
    // #product_nameは共通の下書き項目。実際に各モールのページタイトルになるのは
    // 楽天用の#product_name_r／Yahoo用の#product_name_yで、それぞれ「※商品名をコピー」
    // ボタンで#product_nameの内容を初期値としてコピーしたあと個別に編集する仕組み。
    商品名: { type: "single", selector: "#product_name", attr: "value" },
    商品名略称: { type: "single", selector: "[name=\"informality_name\"]", attr: "value" },
    メーカー品名: { type: "single", selector: "[name=\"maker_product_name\"]", attr: "value" },
    // する蔵画面上の実際のラベルは「メーカー希望小売価格」（1.通販する蔵の商品マスター作成マニュアル [16]）
    メーカー希望小売価格: { type: "single", selector: "#price", attr: "value" },
    販売価格: { type: "single", selector: "#sale_price", attr: "value" },
    原価: { type: "single", selector: "#genka_price", attr: "value" },
    個別送料: { type: "single", selector: "#postage", attr: "value" },
    送料特別加算金額: { type: "single", selector: "#postage_add_charge", attr: "value" },
    商品タグ: { type: "single", selector: "#item_tag", attr: "value" },
    楽天商品管理番号: { type: "single", selector: "#product_url_code", attr: "value" },
    楽天商品番号: { type: "single", selector: "#rakuten_product_code", attr: "value" },
    楽天商品名: { type: "single", selector: "#product_name_r", attr: "value" },
    楽天表示価格: { type: "single", selector: "#price_r", attr: "value" },
    楽天販売価格: { type: "single", selector: "#sale_price_r", attr: "value" },
    楽天配送方法セット管理番号: { type: "single", selector: "#delivery_set_id", attr: "value" },
    楽天カタログID: { type: "single", selector: "#catalog_id", attr: "value" },
    楽天注文ボタン: { type: "single", selector: "[name=\"order_button_flg\"]:checked", attr: "value" },
    楽天PC用商品説明文: { type: "single", selector: "#pc_product_explanation", attr: "value" },
    楽天モバイル用商品説明文: { type: "single", selector: "#mobile_product_explanation", attr: "value" },
    楽天スマホ用商品説明文: { type: "single", selector: "#smartphone_product_explanation", attr: "value" },
    ヤフー商品コード: { type: "single", selector: "#code", attr: "value" },
    ヤフーJANコード: { type: "single", selector: "#jan", attr: "value" },
    ヤフーページ公開: { type: "single", selector: "[name=\"display\"]:checked", attr: "value" },
    Yahoo商品名: { type: "single", selector: "#product_name_y", attr: "value" },
    ヤフー定価: { type: "single", selector: "#original_price_y", attr: "value" },
    ヤフー通常販売価格: { type: "single", selector: "#price_y", attr: "value" },
    Yahoo特価: { type: "single", selector: "#sale_price_y", attr: "value" },
    Yahoo会員向け価格: { type: "single", selector: "#member_price", attr: "value" },
    Yahooショッピング製品コード: { type: "single", selector: "#yahoo_product_code", attr: "value" },
    Yahoo製品コード: { type: "single", selector: "#product_code", attr: "value" },
    // する蔵画面上のラベルは「重量」だが、実際は送料コード（0/1/5000/6000）を入れる項目
    // （4-1.Yahoo!ショッピングページ作成マニュアル [16]）。画面表記に合わせて項目名は「重量」にする。
    Yahoo重量: { type: "single", selector: "#ship_weight", attr: "value" },
    Yahoo送料無料: { type: "single", selector: "[name=\"delivery\"]:checked", attr: "value" },
    ヤフーキャッチコピー: { type: "single", selector: "#headline", attr: "value" },
    ヤフー商品説明: { type: "single", selector: "#caption", attr: "value" },
    Yahooフリースペース1: { type: "single", selector: "#additional1", attr: "value" },
    Yahooフリースペース2: { type: "single", selector: "#additional2", attr: "value" },
    Yahooフリースペース3: { type: "single", selector: "#additional3", attr: "value" },
    Yahooスマートフォン用フリースペース: { type: "single", selector: "#sp_additional", attr: "value" },
    Amazon発送日数: { type: "single", selector: "#pma_leadtime_to_ship", attr: "value" },
    Amazon配送パターン: { type: "single", selector: "[name=\"pma_merchant_shipping_group_name\"]", attr: "value" },
    Amazon販売価格: { type: "single", selector: "#pma_itemprice", attr: "value" },
    Amazonポイント: { type: "single", selector: "#pma_standard_price_points", attr: "value" },
    Amazonメーカー希望小売価格: { type: "single", selector: "#pma_msrp", attr: "value" },
    Amazon法人価格: { type: "single", selector: "#pma_businessprice", attr: "value" },
    楽天掲載: { type: "single", selector: "#rakuten_rec_flg", attr: "checked" },
    Yahoo掲載: { type: "single", selector: "#yahoo_rec_flg", attr: "checked" },
    Amazon掲載: { type: "single", selector: "#amazon_rec_flg", attr: "checked" },
    ヤフオク掲載: { type: "single", selector: "#yo1_yahoo_auction_rec_flg", attr: "checked" },
    新ヤフオク掲載: { type: "single", selector: "#z__rec_flg", attr: "checked" },
    楽天サイトカテゴリ1: { type: "single", selector: "#category_1_all", attr: "value" },
    Yahooプロダクトカテゴリ: { type: "single", selector: "#product_category", attr: "value" },
    楽天ジャンルID: { type: "single", selector: "#rakuten_id", attr: "value" },
    楽天ポイント変倍率: { type: "single", selector: "#point_magnification", attr: "value" },
    Yahoo一律ポイント区分: { type: "single", selector: "[name=\"point_code_flg\"]:checked", attr: "value" },
    Yahoo商品別倍率指定: { type: "single", selector: "#point_code_all", attr: "value" },
    楽天動画: { type: "single", selector: "#movie_html", attr: "value" },
  };

  // 重大度の既定値は「レッド・イエロー基準.xlsx」に明確に対応する項目のみそれに従い、
  // 対応する項目が無いものは既定を「none」（チェック自体は行うが表には出さない）にする。
  // ユーザーが必要と判断すれば、設定画面④でいつでもレッド/イエローに変更できる。
  const DEFAULT_SEVERITY = {
    // I-自社品番・I-メーカー品番・I-メーカー品名・I-商品名・I-商品名略称・I-定価・I-原価: レッド
    自社品番: "red",
    メーカー品番: "red",
    メーカー品名: "red",
    商品名: "red",
    商品名略称: "red",
    メーカー希望小売価格: "red",
    原価: "red",
    // I-販売価格: イエロー（item_data側の「販売価格」は常に"0"であるべきダミー項目。
    // 実売価との一致チェックは「楽天販売価格」の方で行う）
    販売価格: "yellow",
    // R-商品管理/商品番号: イエロー
    楽天商品管理番号: "yellow",
    楽天商品番号: "yellow",
    // R-ジャンルID: イエロー
    楽天ジャンルID: "yellow",
    // R-カタログID: イエロー
    楽天カタログID: "yellow",
    // R-売価: レッド
    楽天販売価格: "red",
    // R-商品名(品番)・R-商品名(適合)等: イエロー（コピー元残存・車種名整合性ともにここで管理）
    楽天商品名: "yellow",
    // R-送料: レッド（対応する具体的な入力欄は特定できていないため、現状は判定不能。
    // 個別送料/送料特別加算金額とは別概念）
    // R-配送方法セット管理番号: レッド
    楽天配送方法セット管理番号: "red",
    // R-注文ボタン: レッド
    楽天注文ボタン: "red",
    // R-キャッチコピー・R-商品説明文(品番等)・R-スマホコピー元のまま: イエロー
    楽天PC用商品説明文: "yellow",
    楽天モバイル用商品説明文: "yellow",
    楽天スマホ用商品説明文: "yellow",
    // R-動画: イエロー
    楽天動画: "yellow",
    // Y-商品コード: イエロー
    ヤフー商品コード: "yellow",
    // Y-プロダクトカテゴリ: イエロー
    Yahooプロダクトカテゴリ: "yellow",
    // Y-ページ公開: レッド
    ヤフーページ公開: "red",
    // Y-商品名: イエロー（コピー元残存・車種名整合性ともにここで管理）
    Yahoo商品名: "yellow",
    // Y-定価: レッド
    ヤフー定価: "red",
    // Y-売価: レッド
    ヤフー通常販売価格: "red",
    // Y-JANコード: イエロー
    ヤフーJANコード: "yellow",
    // Y-製品コード: イエロー
    Yahoo製品コード: "yellow",
    // Y-重量: レッド（画面表記は「重量」だが実際は送料コード）
    Yahoo重量: "red",
    // Y-送料無料: レッド
    Yahoo送料無料: "red",
    // Y-商品別ポイント倍率: レッド
    Yahoo一律ポイント区分: "red",
    Yahoo商品別倍率指定: "red",
    // Y-キャッチコピー・Y-商品説明: イエロー
    ヤフーキャッチコピー: "yellow",
    ヤフー商品説明: "yellow",
    // Y-コピー元のまま: イエロー
    Yahooフリースペース1: "yellow",
    Yahooフリースペース2: "yellow",
    Yahooフリースペース3: "yellow",
    // Y-スマホコピー元のまま: イエロー
    Yahooスマートフォン用フリースペース: "yellow",
    // I-掲載フラグ: レッド（楽天・Yahoo・Amazon・ヤフオク・新ヤフオクの5チェックボックス共通）
    楽天掲載: "red",
    Yahoo掲載: "red",
    Amazon掲載: "red",
    ヤフオク掲載: "red",
    新ヤフオク掲載: "red",
    // A-配送パターン・A-販売価格・A-ポイント: レッド／A-発送日数: イエロー
    Amazon配送パターン: "red",
    Amazon販売価格: "red",
    Amazonポイント: "red",
    Amazon発送日数: "yellow",
    // 車種別タグ: イエロー
    商品タグ: "yellow",
    // S-SKU・S-正規JAN・A-ASIN: レッド（複数のSKU系チェックを1つの重大度で管理）
    SKU情報: "red",

    // ---- 以下、レッド・イエロー基準.xlsxに対応項目が見つからないため既定は「none」 ----
    シリーズ整合性: "none",
    個別送料: "none",
    送料特別加算金額: "none",
    楽天表示価格: "none",
    楽天サイトカテゴリ1: "none",
    楽天ポイント変倍率: "none",
    Yahoo特価: "none",
    Yahoo会員向け価格: "none",
    Yahooショッピング製品コード: "none",
    Amazon法人価格: "none",
    Amazonメーカー希望小売価格: "none",
  };

  // 完全一致比較の対象ペア（DOM側の項目名と管理表側の列論理名が異なる場合があるため、
  // 単純な同名キー同士ではなく明示的な組み合わせで持つ）。重要項目.txtの指定に基づく。
  // isAmount: true の項目は「管理表が空欄/0の場合は要確認」超重要項目（金額系）。
  const EQUALITY_PAIRS = [
    { domKey: "自社品番", mgmtKey: "自社品番" },
    { domKey: "楽天商品管理番号", mgmtKey: "自社品番" },
    { domKey: "楽天商品番号", mgmtKey: "自社品番" },
    { domKey: "ヤフー商品コード", mgmtKey: "自社品番" },
    { domKey: "メーカー品番", mgmtKey: "品番" },
    { domKey: "メーカー品名", mgmtKey: "品番" },
    { domKey: "ヤフーJANコード", mgmtKey: "SKU" },
    { domKey: "楽天カタログID", mgmtKey: "SKU" },
    { domKey: "メーカー希望小売価格", mgmtKey: "定価税抜", isAmount: true },
    { domKey: "ヤフー定価", mgmtKey: "定価税込", isAmount: true },
    // 「販売価格」(#sale_price)はitem_data側のダミー項目で常に"0"が正解（別途FIXED_RULE_CHECKSで
    // チェック）。管理表の売価税抜と実際に突き合わせるべきは楽天側の実売価「楽天販売価格」
    // (#sale_price_r)。3-1.楽天市場ページ作成マニュアルの[7]販売価格に基づく。
    { domKey: "楽天販売価格", mgmtKey: "売価税抜", isAmount: true },
    { domKey: "ヤフー通常販売価格", mgmtKey: "売価税込", isAmount: true },
    { domKey: "原価", mgmtKey: "原価", isAmount: true },
    // 「個別送料」(#postage)は3-1.楽天市場ページ作成マニュアル[22]の通り楽天側の未使用項目
    // （空欄が正しい）で、管理表の送料列と比較すべき項目ではなかったため削除。
    // （管理表の送料列に対応する直接の入力欄は、配送方法の選択から決まるため現状見つかっていない）
    { domKey: "送料特別加算金額", mgmtKey: "特別加算金" },
    // 4-1.Yahoo!ショッピングページ作成マニュアルの[13]製品コード＝品番
    { domKey: "Yahoo製品コード", mgmtKey: "品番" },
  ];

  // 新規登録時に固定で満たすべき業務ルール（管理表とは無関係の固定値チェック）
  const FIXED_RULE_CHECKS = [
    {
      // 1.通販する蔵の商品マスター作成マニュアル [17]販売価格
      domKey: "販売価格",
      expectedValue: "0",
      message:
        "商品情報(item_data)の「販売価格」は基本情報側では使用しないため「0」を入力する必要があります（実際の売価は楽天の「販売価格」項目で設定します）",
    },
    {
      // 3-1.楽天市場ページ作成マニュアル [6]表示価格
      domKey: "楽天表示価格",
      expectedValue: "",
      message: "楽天の「表示価格」は現在使用していない項目のため空欄にする必要があります",
    },
    {
      // 3-1.楽天市場ページ作成マニュアル [22]個別送料
      domKey: "個別送料",
      expectedValue: "",
      message: "楽天の「個別送料」は現在使用していない項目のため空欄にする必要があります",
    },
    {
      // 3-1.楽天市場ページ作成マニュアル [46]モバイル用商品説明文
      domKey: "楽天モバイル用商品説明文",
      expectedValue: "",
      message: "楽天の「モバイル用商品説明文」は現在使用していない項目のため空欄にする必要があります",
    },
    {
      // 4-1.Yahoo!ショッピングページ作成マニュアル [7]特価
      domKey: "Yahoo特価",
      expectedValue: "",
      message: "Yahoo!の「特価」は現在使用していない項目のため空欄にする必要があります",
    },
    {
      // 4-1.Yahoo!ショッピングページ作成マニュアル [8]会員向け価格
      domKey: "Yahoo会員向け価格",
      expectedValue: "",
      message: "Yahoo!の「会員向け価格」は現在使用していない項目のため空欄にする必要があります",
    },
    {
      // 4-1.Yahoo!ショッピングページ作成マニュアル [10]Yahoo!ショッピング製品コード
      domKey: "Yahooショッピング製品コード",
      expectedValue: "",
      message: "Yahoo!の「Yahoo!ショッピング製品コード」は現在使用していない項目のため空欄にする必要があります",
    },
    {
      // 5-1.Amazonページ作成マニュアル 6.法人価格（税込）
      domKey: "Amazon法人価格",
      expectedValue: "",
      message: "Amazonの「法人価格（税込）」は新規作成時点では設定しないため空欄にする必要があります（金額が入っていれば削除してください）",
    },
    {
      domKey: "楽天注文ボタン",
      expectedValue: "0",
      message: "楽天の「注文ボタン」は新規登録時「ボタンをつけない」にする必要があります",
    },
    {
      domKey: "ヤフーページ公開",
      expectedValue: "0",
      message: "ヤフーの「ページ公開」は新規登録時「非公開」にする必要があります",
    },
    {
      domKey: "楽天掲載",
      expectedChecked: true,
      message: "サイト掲載フラグ「楽天」にチェックが必要です",
    },
    {
      domKey: "Yahoo掲載",
      expectedChecked: true,
      message: "サイト掲載フラグ「Yahoo!」にチェックが必要です",
    },
    {
      domKey: "Amazon掲載",
      expectedChecked: false,
      message: "サイト掲載フラグ「Amazon」は新規登録時チェックを外す必要があります",
    },
    {
      domKey: "ヤフオク掲載",
      expectedChecked: false,
      message: "サイト掲載フラグ「ヤフオク」は新規登録時チェックを外す必要があります",
    },
    {
      domKey: "新ヤフオク掲載",
      expectedChecked: false,
      message: "サイト掲載フラグ「新ヤフオク」は新規登録時チェックを外す必要があります",
    },
    {
      domKey: "楽天サイトカテゴリ1",
      expectedNotEmpty: true,
      message: "楽天のサイトカテゴリ1が設定されていません",
    },
    {
      domKey: "Yahooプロダクトカテゴリ",
      expectedNotEmpty: true,
      message: "Yahoo!のプロダクトカテゴリが設定されていません",
    },
    {
      domKey: "楽天ジャンルID",
      expectedNotEmpty: true,
      message: "楽天のジャンルIDが設定されていません",
    },
    {
      // 3-1.楽天市場ページ作成マニュアル [39]配送方法セット管理番号
      // （楽天は掲載する前提でページ作成をするため、掲載フラグに関わらずチェックする）
      domKey: "楽天配送方法セット管理番号",
      expectedNotEmpty: true,
      message: "楽天の「配送方法セット管理番号」が未設定です",
    },
    {
      domKey: "楽天ポイント変倍率",
      expectedValue: "0",
      message: "楽天の「ポイント変倍率」は「個別設定しない」にする必要があります",
    },
    {
      domKey: "Yahoo一律ポイント区分",
      expectedValue: "1",
      message: "Yahoo!の商品別ポイント倍率は「一律に設定」にする必要があります",
    },
    {
      domKey: "Yahoo商品別倍率指定",
      expectedValue: "",
      message: "Yahoo!の商品別ポイント倍率は「商品別倍率指定なし」にする必要があります",
    },
    {
      domKey: "Amazonポイント",
      expectedValue: "",
      message: "Amazonの「ポイント」は空欄にする必要があります（0や値を入れてはいけません）",
    },
    {
      domKey: "楽天動画",
      reminderIfNotEmpty: true,
      message: "楽天に動画(HTML)が設定されています。Yahoo!のストアクリエイターエディタでも動画のアップロードを忘れずに行ってください",
    },
  ];

  // コピー元の品番残存チェックの対象にする自由テキスト系の論理キー
  const COPY_SOURCE_CHECK_KEYS = [
    "商品名",
    "商品名略称",
    "楽天商品名",
    "Yahoo商品名",
    "楽天PC用商品説明文",
    "楽天モバイル用商品説明文",
    "楽天スマホ用商品説明文",
    "ヤフー商品説明",
    "ヤフーキャッチコピー",
    "Yahooフリースペース1",
    "Yahooフリースペース2",
    "Yahooフリースペース3",
    "Yahooスマートフォン用フリースペース",
  ];

  const FREE_TEXT_KEYS = {
    rakuten: ["楽天PC用商品説明文", "楽天モバイル用商品説明文", "楽天スマホ用商品説明文"],
    yahoo: [
      "ヤフー商品説明",
      "ヤフーキャッチコピー",
      "Yahooフリースペース1",
      "Yahooフリースペース2",
      "Yahooフリースペース3",
      "Yahooスマートフォン用フリースペース",
    ],
  };

  // 管理表（「管理表」シート）の列マッピングで想定する論理キー一覧。
  // 重要項目.txtの列指定（K=自社品番, L=SKU, M=品番, U=定価税抜, V=定価税込,
  // W=売価税抜, X=売価税込, Y=原価, N=シリーズ）と、送料・特別加算金列に対応させている。
  const MANAGEMENT_LOGICAL_KEYS = [
    "自社品番",
    "品番",
    "SKU",
    "定価税抜",
    "定価税込",
    "売価税抜",
    "売価税込",
    "原価",
    "送料",
    "特別加算金",
    "シリーズ",
    "車種名",
    "コピー元",
  ];

  const DEFAULT_TAG_SHEET_CONFIG = {
    sheetName: "★リスト",
    columnMap: {
      メーカー: "メーカー",
      車種名: "車種名",
      カテゴリ: "カテゴリ",
      タグ: "タグ",
      自社品番: "自社品番",
    },
  };

  // 車種名→タグの辞書（★タグ一覧シート想定）。自社品番でひける★リストとは別に、
  // 商品名・説明文に出てくる車種名からタグ候補を推測するために使う（APIなしのキーワード一致）。
  const DEFAULT_TAG_DICTIONARY_CONFIG = {
    sheetName: "★タグ一覧",
    columnMap: {},
  };

  // 各モールの正しい商品URLのひな形。{code} が自社品番に置き換わる。
  // モール取り違えチェックで「正しいURL」をコピーできるようにするために使う。
  const DEFAULT_URL_TEMPLATES = {
    rakuten: "https://item.rakuten.co.jp/creer/{code}",
    yahoo: "https://store.shopping.yahoo.co.jp/creer-net/{code}",
  };

  // 車種名からタグ候補を探す際に、商品のどの項目のテキストを走査するか
  const TAG_CANDIDATE_TEXT_KEYS = [
    "商品名",
    "商品名略称",
    "メーカー品名",
    "楽天商品名",
    "Yahoo商品名",
    "楽天PC用商品説明文",
    "楽天モバイル用商品説明文",
    "楽天スマホ用商品説明文",
    "ヤフー商品説明",
    "ヤフーキャッチコピー",
  ];

  function defaultState() {
    return {
      managementWorkbook: null, // { fileName, importedAt, sheets: { [sheetName]: { headers, rows } } }
      productSheetConfigs: [], // [{ sheetName, columnMap: { logicalKey: header } }]
      tagWorkbook: null,
      tagSheetConfig: DEFAULT_TAG_SHEET_CONFIG,
      tagDictionaryConfig: DEFAULT_TAG_DICTIONARY_CONFIG,
      domFieldMap: DEFAULT_FIELD_MAP,
      severity: DEFAULT_SEVERITY,
      urlTemplates: DEFAULT_URL_TEMPLATES,
    };
  }

  // 拡張機能が chrome://extensions で再読み込みされた後、古いタブに残っている
  // スクリプトから chrome.storage を呼ぶと「Extension context invalidated」で
  // 例外になることがある。その場合は既定値で解決し、呼び出し側にはエラーを投げない。
  function getAll() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(defaultState());
            return;
          }
          const stored = result[STORAGE_KEY] || {};
          const merged = Object.assign(defaultState(), stored);
          // severity/domFieldMapはキー単位のオブジェクトなので、丸ごと上書きすると
          // 過去にストレージへ保存した時点より後に増えた既定項目（新しいチェック項目等）が
          // 反映されなくなってしまう。既定値をベースに保存済みの値で上書きする形にして、
          // ユーザーの変更は残しつつ新しい既定項目も自動で追加されるようにする。
          merged.severity = Object.assign({}, DEFAULT_SEVERITY, stored.severity || {});
          merged.domFieldMap = Object.assign({}, DEFAULT_FIELD_MAP, stored.domFieldMap || {});
          resolve(merged);
        });
      } catch (e) {
        resolve(defaultState());
      }
    });
  }

  function setPatch(patch) {
    return getAll().then((current) => {
      const next = Object.assign({}, current, patch);
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [STORAGE_KEY]: next }, () => resolve(next));
        } catch (e) {
          resolve(next);
        }
      });
    });
  }

  const EXPORTABLE_KEYS = [
    "productSheetConfigs",
    "tagSheetConfig",
    "tagDictionaryConfig",
    "domFieldMap",
    "severity",
    "urlTemplates",
  ];

  function exportConfig() {
    return getAll().then((state) => {
      const exported = {};
      EXPORTABLE_KEYS.forEach((k) => {
        exported[k] = state[k];
      });
      return JSON.stringify(exported, null, 2);
    });
  }

  function importConfig(jsonText) {
    const parsed = JSON.parse(jsonText);
    const patch = {};
    EXPORTABLE_KEYS.forEach((k) => {
      if (parsed[k] !== undefined) patch[k] = parsed[k];
    });
    return setPatch(patch);
  }

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.storage = {
    getAll,
    setPatch,
    exportConfig,
    importConfig,
    DEFAULT_FIELD_MAP,
    DEFAULT_SEVERITY,
    DEFAULT_TAG_SHEET_CONFIG,
    DEFAULT_TAG_DICTIONARY_CONFIG,
    DEFAULT_URL_TEMPLATES,
    TAG_CANDIDATE_TEXT_KEYS,
    EQUALITY_PAIRS,
    FIXED_RULE_CHECKS,
    COPY_SOURCE_CHECK_KEYS,
    FREE_TEXT_KEYS,
    MANAGEMENT_LOGICAL_KEYS,
  };
})(typeof window !== "undefined" ? window : globalThis);
