require('dotenv').config();

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAdminIds() {
  const raw = process.env.ADMIN_IDS || process.env.ADMIN_ID || '';
  const ids = raw.split(',').map(v => Number(String(v).trim())).filter(Number.isFinite);
  if (!ids.length) throw new Error('ADMIN_IDS or ADMIN_ID is required');
  return new Set(ids);
}

const publicUrl = String(process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();

const inventoryKey = requireEnv('INVENTORY_ENCRYPTION_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(inventoryKey)) {
  throw new Error('INVENTORY_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
}

module.exports = {
  token: requireEnv('BOT_TOKEN'),
  databaseUrl: requireEnv('DATABASE_URL'),
  admins: parseAdminIds(),
  port: Number(process.env.PORT || 3000),
  publicUrl: publicUrl && !publicUrl.startsWith('http') ? `https://${publicUrl}` : publicUrl.replace(/\/$/, ''),
  supportUsername: String(process.env.SUPPORT_USERNAME || '').replace(/^@/, ''),
  defaultLanguage: process.env.DEFAULT_LANGUAGE === 'en' ? 'en' : 'ar',
  captchaEnabled: process.env.CAPTCHA_ENABLED !== 'false',
  inventoryKey,
  superQiNumber: String(process.env.SUPERQI_NUMBER || '917392710336').trim(),
  iqdRate: Number(process.env.IQD_RATE || 1500),
  binance: {
    apiKey: String(process.env.BINANCE_PAY_API_KEY || '').trim(),
    secretKey: String(process.env.BINANCE_PAY_SECRET_KEY || '').trim(),
    baseUrl: String(process.env.BINANCE_PAY_BASE_URL || 'https://bpay.binanceapi.com').replace(/\/$/, ''),
    webhookPath: String(process.env.BINANCE_PAY_WEBHOOK_PATH || '/webhooks/binance-pay').trim() || '/webhooks/binance-pay',
    returnUrl: String(process.env.BINANCE_PAY_RETURN_URL || '').trim(),
    cancelUrl: String(process.env.BINANCE_PAY_CANCEL_URL || '').trim(),
    orderExpireMs: Math.max(5 * 60 * 1000, Number(process.env.BINANCE_PAY_ORDER_EXPIRE_MS || 30 * 60 * 1000))
  }
};
