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

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.workbook = { parseWorkbookFile };
})(typeof window !== "undefined" ? window : globalThis);
