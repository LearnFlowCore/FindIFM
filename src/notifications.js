const nodemailer = require('nodemailer');

class NotificationService {
  constructor(repo, desktop, logger) { this.repo = repo; this.desktop = desktop; this.log = logger; }
  async send(event, message) {
    const settings = this.repo.settings();
    const enabled = event === 'captcha' ? settings.notifyOnCaptcha !== false
      : event === 'failed' ? settings.notifyOnError : event === 'new-data' ? settings.notifyOnNewData : settings.notifyOnFinish;
    if (!enabled) return;
    const attempts = [];
    if (settings.notifications !== false && this.desktop) attempts.push(Promise.resolve().then(() => this.desktop(message, event)));
    if (settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId) attempts.push(this.telegram(settings, message));
    if (settings.emailEnabled && settings.emailHost && settings.emailTo) attempts.push(this.email(settings, message));
    const results = await Promise.allSettled(attempts);
    for (const result of results) if (result.status === 'rejected') this.log.warn({ error: result.reason?.message }, 'Не удалось отправить уведомление');
  }
  async telegram(settings, message) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.telegramChatId, text: message }),
      });
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    } finally { clearTimeout(timer); }
  }
  async email(settings, message) {
    const transport = nodemailer.createTransport({
      host: settings.emailHost, port: Number(settings.emailPort) || 587, secure: Boolean(settings.emailSecure),
      auth: settings.emailUser ? { user: settings.emailUser, pass: settings.emailPassword } : undefined,
    });
    await transport.sendMail({ from: settings.emailFrom || settings.emailUser, to: settings.emailTo, subject: 'Сигнал', text: message });
  }
}

module.exports = { NotificationService };
