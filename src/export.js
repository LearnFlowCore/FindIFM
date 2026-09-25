// Формирование совместимой с Excel книги с базовым оформлением.
const ExcelJS = require('exceljs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function exportXlsx(rows, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Результаты', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'URL', key: 'url', width: 52 }, { header: 'Домен', key: 'domain', width: 24 },
    { header: 'Заголовок', key: 'title', width: 42 }, { header: 'Дата', key: 'date', width: 15 },
    { header: 'Описание', key: 'description', width: 55 }, { header: 'Статус', key: 'status', width: 25 },
    { header: 'Запрос', key: 'query', width: 30 }, { header: 'Дата поиска', key: 'search_date', width: 22 },
    { header: 'Дата запуска поиска', key: 'search_run_date', width: 22 },
  ];
  sheet.addRows(rows);
  sheet.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17324D' } }; });
  sheet.eachRow((row, index) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (index > 1 && index % 2 === 0) row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6F8' } }; });
    if (index > 1) row.getCell('url').value = { text: row.getCell('url').value, hyperlink: row.getCell('url').value };
  });
  sheet.autoFilter = { from: 'A1', to: 'I1' };
  await workbook.xlsx.writeFile(filename);
  return filename;
}
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function exportCsv(rows, filename) {
  const headers = ['URL', 'Заголовок страницы', 'Дата публикации', 'Краткое описание'];
  const lines = [headers, ...rows.map(row => [row.url, row.title, row.date, row.description])]
    .map(row => row.map(csvCell).join(';'));
  require('node:fs').writeFileSync(filename, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  return filename;
}
function downloadsFolder() {
  if (process.env.DOWNLOADS_PATH) {
    fs.mkdirSync(process.env.DOWNLOADS_PATH, { recursive: true });
    return process.env.DOWNLOADS_PATH;
  }
  const home = os.homedir();
  const localized = path.join(home, 'Загрузки');
  const standard = path.join(home, 'Downloads');
  if (fs.existsSync(localized)) return localized;
  fs.mkdirSync(standard, { recursive: true });
  return standard;
}
function exportTxt(rows, filename) {
  const links = rows.map(row => String(row.url || '').trim()).filter(Boolean);
  fs.writeFileSync(filename, links.length ? `${links.join('\r\n')}\r\n` : '', 'utf8');
  return filename;
}
function exportTxtToDownloads(rows) {
  const file = path.join(downloadsFolder(), 'FindIFM.txt');
  return exportTxt(rows, file);
}
module.exports = { exportXlsx, exportCsv, exportTxt, exportTxtToDownloads, downloadsFolder };
