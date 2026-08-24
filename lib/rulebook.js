// Googleスプレッドシートで管理している「ページ作成ルールブック」を、都度最新の内容で
// 参照するための処理。スプレッドシートの共有設定を「リンクを知っている全員が閲覧可」に
// しておけば、ログイン不要でCSVとして取得できる（xlsxを都度ダウンロード・選び直す手間を
// なくすため）。content.js・options.js の両方から読み込んで使う。
(function (global) {
  "use strict";

  function extractSpreadsheetId(url) {
    const match = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  function extractGid(url) {
    const match = String(url || "").match(/[?#&]gid=([0-9]+)/);
    return match ? match[1] : null;
  }

  // RFC4180相当の簡易CSVパーサ（ダブルクオートで囲まれたセル内のカンマ・改行・
  // エスケープされた""に対応）。
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // 続く\nで改行するので無視
      } else {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function csvToHeadersAndRows(text) {
    const table = parseCsv(text).filter((r) => r.some((cell) => cell !== ""));
    if (!table.length) return { headers: [], rows: [] };
    const headers = table[0].map((h, i) => h || `(列${i + 1})`);
    const rows = table.slice(1).map((line) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = line[i] === undefined ? "" : line[i];
      });
      return obj;
    });
    return { headers, rows };
  }

  // shareUrl: Googleスプレッドシートの共有URL（gid付きでも可）。
  // 戻り値: { headers: string[], rows: object[] }（該当タブ1枚分）
  async function fetchRulebookSheet(shareUrl) {
    const sheetId = extractSpreadsheetId(shareUrl);
    if (!sheetId) {
      throw new Error("GoogleスプレッドシートのURLの形式が正しくありません");
    }
    const gid = extractGid(shareUrl);
    const exportUrl =
      `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv` + (gid ? `&gid=${gid}` : "");
    const res = await fetch(exportUrl);
    if (!res.ok) {
      throw new Error(
        `ルールブックの取得に失敗しました(HTTP ${res.status})。共有設定が「リンクを知っている全員が閲覧可」になっているか確認してください。`
      );
    }
    const text = await res.text();
    return csvToHeadersAndRows(text);
  }

  global.HinbanReferee = global.HinbanReferee || {};
  global.HinbanReferee.rulebook = {
    extractSpreadsheetId,
    extractGid,
    parseCsv,
    csvToHeadersAndRows,
    fetchRulebookSheet,
  };
})(typeof window !== "undefined" ? window : globalThis);
