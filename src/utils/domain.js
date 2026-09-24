// Правило без '=' включает поддомены, правило с '=' требует точного домена.
function splitRules(value) { return Array.isArray(value) ? value : String(value || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean); }
function ruleMatches(host, rule) { const exact = rule.startsWith('='); rule = (exact ? rule.slice(1) : rule).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; host = host.toLowerCase().replace(/^www\./, ''); return exact ? host === rule : (host === rule || host.endsWith(`.${rule}`)); }
function domainAllowed(url, whitelist, blacklist) { let host; try { host = new URL(url).hostname; } catch { return false; } const deny = splitRules(blacklist).some(r => ruleMatches(host, r)); const allow = splitRules(whitelist); return !deny && (!allow.length || allow.some(r => ruleMatches(host, r))); }
module.exports = { splitRules, ruleMatches, domainAllowed };
