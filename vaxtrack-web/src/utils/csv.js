// Small, dependency-free CSV helpers for client-side export.
//
//  * toCsv builds an RFC-4180-style CSV string: fields containing a comma,
//    double-quote, or newline are wrapped in double-quotes, and embedded
//    double-quotes are escaped by doubling them. Rows use CRLF endings for
//    maximum spreadsheet compatibility.
//  * downloadCsv triggers a browser download via a Blob object URL, with a
//    leading UTF-8 BOM so Excel reads the peso sign and accents correctly.

function escapeCsvValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// headers: string[] (optional); rows: Array<Array<string|number|null|undefined>>
export function toCsv(headers, rows) {
  const lines = [];
  if (Array.isArray(headers) && headers.length > 0) {
    lines.push(headers.map(escapeCsvValue).join(","));
  }
  for (const row of rows || []) {
    lines.push((row || []).map(escapeCsvValue).join(","));
  }
  return lines.join("\r\n");
}

export function downloadCsv(filename, csvText) {
  const bom = String.fromCharCode(0xfeff); // UTF-8 BOM for Excel
  const blob = new Blob([bom + csvText], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
