// Интервалы измеряются отдельно: первый заканчивается уведомлением, второй начинается им.
const fields = ['spikeAt', 'notifiedAt', 'responseAt'];

function parseEventTimes(input) {
  const times = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null || value === '') { times[field] = null; continue; }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw Object.assign(new Error(`Некорректная дата ${field}: укажите время с часовым поясом.`), { statusCode: 400 });
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw Object.assign(new Error(`Некорректная дата ${field}.`), { statusCode: 400 });
    times[field] = date.toISOString();
  }
  return times;
}

function interval(start, end) {
  if (!start || !end) return null;
  const milliseconds = Date.parse(end) - Date.parse(start);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds / 1000) : null;
}

function metrics({ spikeAt, notifiedAt, responseAt }) {
  return {
    spikeToNotificationSeconds: interval(spikeAt, notifiedAt),
    notificationToResponseSeconds: interval(notifiedAt, responseAt),
  };
}

module.exports = { parseEventTimes, metrics };
