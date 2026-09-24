// Канонизация URL нужна для устойчивой дедупликации результатов.
function normalizeUrl(value) { try { const u = new URL(value); u.hash = ''; u.protocol = 'https:'; u.hostname = u.hostname.replace(/^www\./i, ''); [...u.searchParams.keys()].filter(k => /^(utm_|yclid|gclid|fbclid|ref$)/i.test(k)).forEach(k => u.searchParams.delete(k)); return u.toString().replace(/\/$/, ''); } catch { return null; } }
module.exports = { normalizeUrl };
