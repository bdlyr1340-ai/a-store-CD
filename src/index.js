const express = require('express');
const config = require('./config');
const { initializeDatabase, sequelize } = require('./db');
const binancePay = require('./payments/binancePay');

let startupState = 'starting';
let startupError = '';
let bot = null;

// Start the HTTP server immediately so Railway health checks do not time out
// while database migrations / inventory cleanup are still running.
const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/', (_req, res) => {
  res.type('text').send(`CD Store bot is ${startupState}.`);
});
app.get('/health', (_req, res) => {
  if (startupState === 'failed') {
    return res.status(503).json({ ok: false, state: startupState, error: startupError });
  }
  // Railway only needs to know the container is alive. During startup the bot
  // may still be migrating old inventory; readiness is available at /ready.
  return res.json({ ok: true, state: startupState, bot: 'CD Store' });
});
app.get('/ready', async (_req, res) => {
  if (startupState !== 'ready') {
    return res.status(503).json({ ok: false, state: startupState, error: startupError || undefined });
  }
  try {
    await sequelize.query('SELECT 1');
    return res.json({
      ok: true,
      state: startupState,
      bot: 'CD Store',
      binanceTransferVerification: binancePay.configured()
    });
  } catch (error) {
    return res.status(503).json({ ok: false, state: startupState, error: error.message });
  }
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Health server listening on 0.0.0.0:${config.port}`);
});

async function setupTelegramCommands(activeBot) {
  try {
    await activeBot.setMyCommands([
      { command: 'start', description: 'فتح المتجر' },
      { command: 'cancel', description: 'إلغاء العملية الحالية' }
    ]);
    for (const adminId of config.admins) {
      await activeBot.setMyCommands([
        { command: 'start', description: 'فتح المتجر' },
        { command: 'admin', description: 'لوحة الإدارة' },
        { command: 'cancel', description: 'إلغاء العملية الحالية' }
      ], { scope: { type: 'chat', chat_id: adminId } }).catch(() => {});
    }
  } catch (error) {
    console.error('Telegram command setup:', error.message);
  }
}

async function main() {
  startupState = 'database';
  console.log('Starting database initialization...');
  await initializeDatabase();
  console.log('Database ready');

  startupState = 'telegram';
  ({ bot } = require('./bot'));

  // Polling and webhooks cannot be active together. Clear any old webhook.
  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
    console.log('Telegram webhook cleared');
  } catch (error) {
    console.error('Could not clear Telegram webhook:', error.message);
  }

  await bot.startPolling({ restart: true });
  console.log('Telegram bot polling started');
  await setupTelegramCommands(bot);

  startupState = 'ready';
  console.log('CD Store v4.1 is ready');
}

main().catch(error => {
  startupState = 'failed';
  startupError = error?.stack || error?.message || String(error);
  console.error('Fatal startup error:', error);
  // Give Railway enough time to capture the real error in Deploy Logs, then
  // terminate so the restart policy can retry instead of serving a dead bot.
  setTimeout(() => {
    try { server.close(); } catch {}
    process.exit(1);
  }, 8000).unref();
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  try {
    if (bot) await bot.stopPolling({ cancel: true });
  } catch (error) {
    console.error('Could not stop Telegram polling:', error.message);
  }
  try { await sequelize.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
