// xlsxファイルのパース処理（options.html でのみ使用。SheetJS(xlsx.full.min.js)に依存）
(function (global) {
  "use strict";

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  function uniqueHeaders(rawHeaders) {
    const seen = new Map();
    return rawHeaders.map((h, i) => {
      let name = h === undefined || h === null || h === "" ? `(列${i + 1})` : String(h);
      const count = seen.get(name) || 0;
      seen.set(name, count + 1);
      if (count > 0) name = `${name}(${count + 1})`;
      return name;
    });
  }

  function sheetToHeadersAndRows(worksheet) {
    const raw = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: true, blankrows: false });
    if (!raw.length) return { headers: [], rows: [] };
    const headers = uniqueHeaders(raw[0]);
    const rows = raw.slice(1).map((line) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = line[i] === undefined ? "" : line[i];
      });
      return obj;
    });
    return { headers, rows };
  }

  // 戻り値: { fileName, importedAt, sheetNames: string[], sheets: { [name]: { headers, rows } } }
  async function parseWorkbookFile(file) {
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: "array" });
    const sheets = {};
    wb.SheetNames.forEach((name) => {
      sheets[name] = sheetToHeadersAndRows(wb.Sheets[name]);
    });
    return {
      fileName: file.name,
      importedAt: new Date().toISOString(),
      sheetNames: wb.SheetNames,
      sheets,
    };
  }

  // 【決め事】商品属性の推奨値・任意項目.xlsx の読み込み。
  // ★ジャンル一覧: ジャンルID → 商品属性定義詳細グループ
  // ★属性早見表: グループごとの属性名。背景がオレンジのセルが「入力すべき推奨項目」
  //   （文字ではなくセルの色で運用されているため、色そのものを読み取る）。
  const ORANGE_FILL_RGB = "FFC000";
  const GENRE_SHEET_KEYWORD = "ジャンル一覧";
  const QUICKREF_SHEET_KEYWORD = "属性早見表";

  function findSheetName(sheetNames, keyword) {
    return sheetNames.find((name) => name.includes(keyword)) || null;
  }

  function cellFillRgb(cell) {
    const rgb = cell && cell.s && cell.s.fgColor && cell.s.fgColor.rgb;
    return rgb ? String(rgb).slice(-6).toUpperCase() : null;
  }

  function findHeaderIndex(headerRow, keyword) {
    return headerRow.findIndex((h) => String(h || "").includes(keyword));
  }

  // 戻り値: { genres: { [genreId]: { group, path } }, groups: { [group]: { orange: string[] } }, stats }
  function parseAttributeRulesWorkbook(wb) {
    const genreSheetName = findSheetName(wb.SheetNames, GENRE_SHEET_KEYWORD);
    const quickrefSheetName = findSheetName(wb.SheetNames, QUICKREF_SHEET_KEYWORD);
    if (!genreSheetName || !quickrefSheetName) {
      throw new Error(`「★${GENRE_SHEET_KEYWORD}」「★${QUICKREF_SHEET_KEYWORD}」のシートが見つかりません`);
    }

    const genreRows = XLSX.utils.sheet_to_json(wb.Sheets[genreSheetName], { header: 1, defval: "", raw: true });
    const genreHeader = genreRows[0] || [];
    const idCol = findHeaderIndex(genreHeader, "ジャンルID");
    const groupCol = findHeaderIndex(genreHeader, "グループ");
    const pathCol = findHeaderIndex(genreHeader, "階層");
    if (idCol < 0 || groupCol < 0) {
      throw new Error(`「${genreSheetName}」の見出しに「ジャンルID」「商品属性定義詳細グループ」が見つかりません`);
    }
    const genres = {};
    genreRows.slice(1).forEach((row) => {
      const id = String(row[idCol] === undefined ? "" : row[idCol]).trim();
      const group = String(row[groupCol] || "").trim();
      if (!id || !group) return;
      genres[id] = { group, path: pathCol >= 0 ? String(row[pathCol] || "").trim() : "" };
    });

    const ws = wb.Sheets[quickrefSheetName];
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const groups = {};
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const groupCell = ws[XLSX.utils.encode_cell({ r, c: range.s.c })];
      const group = groupCell ? String(groupCell.v || "").trim() : "";
      if (!group) continue;
      const orange = [];
      for (let c = range.s.c + 1; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        const name = cell ? String(cell.v === undefined ? "" : cell.v).trim() : "";
        if (name && cellFillRgb(cell) === ORANGE_FILL_RGB) orange.push(name);
      }
      groups[group] = { orange };
    }

    return {
      genres,
      groups,
      stats: {
        genreCount: Object.keys(genres).length,
        groupCount: Object.keys(groups).length,
        orangeGroupCount: Object.values(groups).filter((g) => g.orange.length).length,
      },
    };
  }

  // 戻り値: { fileName, importedAt, genres, groups, stats }
  // 9MB超のファイルで、使うのは2シートだけのため、シート名だけ先に読んでから必要な
  // シートのみ（セルの色情報つきで）読み込む。
  async function parseAttributeRulesFile(file) {
    const buf = await readFileAsArrayBuffer(file);
    const bookOnly = XLSX.read(buf, { type: "array", bookSheets: true });
    const targets = [GENRE_SHEET_KEYWORD, QUICKREF_SHEET_KEYWORD]
      .map((keyword) => findSheetName(bookOnly.SheetNames, keyword))
      .filter(Boolean);
    const wb = XLSX.read(buf, { type: "array", cellStyles: true, sheets: targets });
    return Object.assign(
      { fileName: file.name, importedAt: new Date().toISOString() },
      parseAttributeRulesWorkbook(wb)
    );
  }

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.workbook = { parseWorkbookFile, parseAttributeRulesFile, parseAttributeRulesWorkbook };
})(typeof window !== "undefined" ? window : globalThis);
