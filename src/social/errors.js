// Единая классификация ошибок диагностики соцсетей.
const CODES = [
  'INVALID_URL', 'INVALID_IDENTIFIER', 'NOT_FOUND', 'PUBLIC_PREVIEW_UNAVAILABLE',
  'AUTH_MISSING', 'AUTH_INVALID', 'ACCESS_DENIED', 'RATE_LIMITED', 'NETWORK_TIMEOUT',
  'NETWORK_ERROR', 'HTTP_BLOCKED', 'CHALLENGE_OR_CAPTCHA', 'PARSE_ERROR', 'EMPTY_RESPONSE',
  'METRIC_MISSING', 'PERSISTENCE_ERROR', 'NO_TARGETS_CONFIGURED', 'UNKNOWN',
];

class DiagnosticError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DiagnosticError';
    this.code = CODES.includes(code) ? code : 'UNKNOWN';
    this.details = details;
  }
}

function classifyHttpStatus(status) {
  if (status === 401) return 'AUTH_INVALID';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'HTTP_BLOCKED';
  return 'HTTP_BLOCKED';
}

function toDiagnosticError(error, fallback = 'UNKNOWN') {
  if (error instanceof DiagnosticError) return error;
  const cause = error?.cause || {};
  const marker = `${cause.code || ''} ${cause.message || ''} ${error?.message || ''}`;
  if (error?.name === 'AbortError' || /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(marker)) {
    return new DiagnosticError('NETWORK_TIMEOUT', 'Запрос превысил время ожидания.', { cause: cause.code || error?.name || null });
  }
  if (error instanceof TypeError || /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED/i.test(marker)) {
    return new DiagnosticError('NETWORK_ERROR', 'Ошибка сетевого соединения.', { cause: cause.code || null });
  }
  return new DiagnosticError(fallback, error?.message || 'Неизвестная ошибка.');
}

module.exports = { CODES, DiagnosticError, classifyHttpStatus, toDiagnosticError };
