const express = require('express');
const config = require('./config');
const { initializeDatabase, sequelize, BinancePayPayment } = require('./db');
const binancePay = require('./payments/binancePay');

async function clearTelegramWebhook() {
  const url = `https://api.telegram.org/bot${config.token}/deleteWebhook?drop_pending_updates=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram deleteWebhook failed: ${data.description || response.status}`);
  }
  console.log('Telegram webhook cleared; switching to polling');
}

async function main() {
  await initializeDatabase();
  console.log('Database ready');

  // Polling cannot work while a webhook is still attached to the bot.
  // Clear any old webhook before requiring bot.js, because bot.js starts polling on load.
  await clearTelegramWebhook();

  // Load bot only after database migrations and webhook cleanup are complete.
  const { bot, notifyBinanceResult } = require('./bot');

  const app = express();
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buffer) => { req.rawBody = buffer?.toString('utf8') || ''; }
  }));

  app.get('/', (_req, res) => res.type('text').send('My Bot Store Clean v2 is running.'));
  app.get('/health', async (_req, res) => {
    try {
      await sequelize.query('SELECT 1');
      res.json({ ok: true, bot: 'My Bot Store Clean v2', binancePay: binancePay.configured() });
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message });
    }
  });

  const webhookPath = config.binance.webhookPath.startsWith('/') ? config.binance.webhookPath : `/${config.binance.webhookPath}`;
  app.post(webhookPath, async (req, res) => {
    try {
      const result = await binancePay.handleWebhook(req);
      if (!result.ok) return res.status(result.http || 400).json({ returnCode: 'FAIL', returnMessage: result.message || 'ERROR' });
      res.json({ returnCode: 'SUCCESS', returnMessage: null });
      if (result.paid && result.result) notifyBinanceResult(result.result).catch(error => console.error('Binance notify:', error.message));
    } catch (error) {
      console.error('Binance webhook:', error);
      res.status(500).json({ returnCode: 'FAIL', returnMessage: 'INTERNAL_ERROR' });
    }
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Health server listening on 0.0.0.0:${config.port}`);
    if (config.publicUrl && binancePay.configured()) {
      console.log(`Binance webhook URL: ${config.publicUrl}${webhookPath}`);
    }
  });

  // Backup reconciliation: even if the webhook is misconfigured, paid orders are checked periodically.
  setInterval(async () => {
    if (!binancePay.configured()) return;
    const pending = await BinancePayPayment.findAll({
      where: { status: ['CREATED', 'PENDING', 'INITIAL'], creditedAt: null },
      order: [['id', 'ASC']],
      limit: 20
    }).catch(() => []);
    for (const payment of pending) {
      try {
        const result = await binancePay.query(payment.id);
        if (result.paid) await notifyBinanceResult(result);
      } catch (error) {
        console.error('Binance reconcile:', error.message);
      }
    }
  }, 90 * 1000).unref();

  console.log('Telegram bot polling started');
}

main().catch(error => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
