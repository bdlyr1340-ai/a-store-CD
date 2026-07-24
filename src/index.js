const express = require('express');
const config = require('./config');
const { initializeDatabase, sequelize } = require('./db');
const binancePay = require('./payments/binancePay');

async function main() {
  await initializeDatabase();
  console.log('Database ready');

  const { bot } = require('./bot');

  // Polling and webhooks cannot be active together. Clear any old Telegram webhook.
  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
    console.log('Telegram webhook cleared');
  } catch (error) {
    console.error('Could not clear Telegram webhook:', error.message);
  }

  await bot.startPolling({ restart: true });
  console.log('Telegram bot polling started');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/', (_req, res) => res.type('text').send('CD Store bot is running.'));
  app.get('/health', async (_req, res) => {
    try {
      await sequelize.query('SELECT 1');
      res.json({ ok: true, bot: 'CD Store', binanceTransferVerification: binancePay.configured() });
    } catch (error) {
      res.status(503).json({ ok: false, error: error.message });
    }
  });

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Health server listening on 0.0.0.0:${config.port}`);
  });

  try {
    await bot.setMyCommands([
      { command: 'start', description: 'فتح المتجر' },
      { command: 'cancel', description: 'إلغاء العملية الحالية' }
    ]);
    for (const adminId of config.admins) {
      await bot.setMyCommands([
        { command: 'start', description: 'فتح المتجر' },
        { command: 'admin', description: 'لوحة الإدارة' },
        { command: 'cancel', description: 'إلغاء العملية الحالية' }
      ], { scope: { type: 'chat', chat_id: adminId } }).catch(() => {});
    }
  } catch (error) {
    console.error('Telegram command setup:', error.message);
  }

}

main().catch(error => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
