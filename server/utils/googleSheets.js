/** Converte URL do Google Sheets para formato de exportação XLSX */
function convertGoogleSheetsUrlToExport(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    const sheetId = match[1];
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx&gid=0`;
  }
  return null;
}

module.exports = { convertGoogleSheetsUrlToExport };
