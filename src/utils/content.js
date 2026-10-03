const { normalizeText } = require('./query');

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalizePrices(value) {
  return cleanText(value).replace(/(\d[\d\s]{2,})(?:[.,](\d{1,2}))?\s*(₽|руб(?:\.|ля|лей)?)/gi, (_match, whole, fraction) => {
    const amount = String(whole).replace(/\s/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${amount}${fraction ? `,${fraction.padEnd(2, '0')}` : ''} ₽`;
  });
}
function titleKey(value) { return normalizeText(cleanText(value)); }
function sourceId(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get('id') || url.searchParams.get('article') || url.pathname.match(/(?:^|\/)(\d{5,})(?:\/|$)/)?.[1] || '';
  } catch { return ''; }
}
function validHttpUrl(value) { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }

module.exports = { cleanText, normalizePrices, titleKey, sourceId, validHttpUrl };
