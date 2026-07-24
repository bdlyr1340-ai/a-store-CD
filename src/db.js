const { Sequelize, DataTypes, Op } = require('sequelize');
const config = require('./config');
const { encryptPayload, isEncrypted, legacyPayload } = require('./cryptoStore');

const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: config.databaseUrl.includes('railway.internal')
    ? {}
    : { ssl: { require: true, rejectUnauthorized: false } },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
});

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  lang: { type: DataTypes.STRING(2), defaultValue: 'ar' },
  balance: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  state: { type: DataTypes.TEXT, allowNull: true },
  verified: { type: DataTypes.BOOLEAN, defaultValue: false },
  blocked: { type: DataTypes.BOOLEAN, defaultValue: false },
  username: { type: DataTypes.STRING, allowNull: true },
  firstName: { type: DataTypes.STRING, allowNull: true }
});

const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, allowNull: false },
  lang: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'global' },
  value: { type: DataTypes.TEXT, allowNull: false }
}, { indexes: [{ unique: true, fields: ['key', 'lang'] }] });

const Merchant = sequelize.define('Merchant', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  category: { type: DataTypes.STRING, defaultValue: 'general' },
  type: { type: DataTypes.STRING, defaultValue: 'private' },
  description: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
  image: { type: DataTypes.TEXT, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  sharedLimit: { type: DataTypes.INTEGER, defaultValue: 1 },
  deliveryMode: { type: DataTypes.STRING, defaultValue: 'instant' },
  sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 }
});

const Code = sequelize.define('Code', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false },
  extra: { type: DataTypes.TEXT, allowNull: true },
  merchantId: { type: DataTypes.INTEGER, references: { model: Merchant, key: 'id' } },
  isUsed: { type: DataTypes.BOOLEAN, defaultValue: false },
  usedBy: { type: DataTypes.BIGINT, allowNull: true },
  soldAt: { type: DataTypes.DATE, allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
  maxUses: { type: DataTypes.INTEGER, defaultValue: 1 },
  usedCount: { type: DataTypes.INTEGER, defaultValue: 0 },
  buyers: { type: DataTypes.JSONB, defaultValue: [] }
});

const PurchaseOrder = sequelize.define('PurchaseOrder', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  merchantId: { type: DataTypes.INTEGER, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  unitPrice: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  totalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  currency: { type: DataTypes.STRING(10), defaultValue: 'USDT' },
  paymentMethod: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'pending_payment' },
  proofFileId: { type: DataTypes.TEXT, allowNull: true },
  paymentRef: { type: DataTypes.TEXT, allowNull: true },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  delivery: { type: DataTypes.JSONB, defaultValue: [] },
  paidAt: { type: DataTypes.DATE, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true }
});

const BalanceTransaction = sequelize.define('BalanceTransaction', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  paymentMethodId: { type: DataTypes.INTEGER, allowNull: true },
  txid: { type: DataTypes.STRING, allowNull: true },
  imageFileId: { type: DataTypes.STRING, allowNull: true },
  caption: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  lastReminderAt: { type: DataTypes.DATE, allowNull: true }
});

const BinancePayPayment = sequelize.define('BinancePayPayment', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  orderId: { type: DataTypes.INTEGER, allowNull: true },
  balanceTransactionId: { type: DataTypes.INTEGER, allowNull: true },
  merchantTradeNo: { type: DataTypes.STRING(32), allowNull: false, unique: true },
  prepayId: { type: DataTypes.STRING, allowNull: true },
  amount: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  currency: { type: DataTypes.STRING(16), allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'CREATED' },
  bizStatus: { type: DataTypes.STRING, allowNull: true },
  binanceTransactionId: { type: DataTypes.STRING, allowNull: true },
  passThroughInfo: { type: DataTypes.TEXT, allowNull: true },
  checkoutUrl: { type: DataTypes.TEXT, allowNull: true },
  deeplink: { type: DataTypes.TEXT, allowNull: true },
  universalUrl: { type: DataTypes.TEXT, allowNull: true },
  qrcodeLink: { type: DataTypes.TEXT, allowNull: true },
  qrContent: { type: DataTypes.TEXT, allowNull: true },
  orderPayload: { type: DataTypes.JSONB, allowNull: true },
  webhookPayload: { type: DataTypes.JSONB, allowNull: true },
  queryPayload: { type: DataTypes.JSONB, allowNull: true },
  creditedAt: { type: DataTypes.DATE, allowNull: true },
  lastQueriedAt: { type: DataTypes.DATE, allowNull: true },
  expireTime: { type: DataTypes.DATE, allowNull: true },
  meta: { type: DataTypes.JSONB, defaultValue: {} }
}, {
  indexes: [
    { unique: true, fields: ['merchantTradeNo'] },
    { fields: ['prepayId'] },
    { fields: ['status'] },
    { fields: ['userId'] },
    { fields: ['orderId'] }
  ]
});

Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant, { foreignKey: 'merchantId' });
User.hasMany(PurchaseOrder, { foreignKey: 'userId' });
PurchaseOrder.belongsTo(User, { foreignKey: 'userId' });
Merchant.hasMany(PurchaseOrder, { foreignKey: 'merchantId' });
PurchaseOrder.belongsTo(Merchant, { foreignKey: 'merchantId' });
PurchaseOrder.hasOne(BinancePayPayment, { foreignKey: 'orderId' });
BinancePayPayment.belongsTo(PurchaseOrder, { foreignKey: 'orderId' });

async function addColumnIfMissing(tableName, columnName, definition) {
  const qi = sequelize.getQueryInterface();
  let table;
  try { table = await qi.describeTable(tableName); } catch { return; }
  if (!table[columnName]) await qi.addColumn(tableName, columnName, definition);
}

async function initializeDatabase() {
  await sequelize.authenticate();
  await sequelize.sync({ alter: false });

  // Safe additions for databases created by the old bot.
  await addColumnIfMissing('Users', 'blocked', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Users', 'username', { type: DataTypes.STRING, allowNull: true });
  await addColumnIfMissing('Users', 'firstName', { type: DataTypes.STRING, allowNull: true });

  await addColumnIfMissing('Merchants', 'image', { type: DataTypes.TEXT, allowNull: true });
  await addColumnIfMissing('Merchants', 'isActive', { type: DataTypes.BOOLEAN, defaultValue: true });
  await addColumnIfMissing('Merchants', 'sharedLimit', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Merchants', 'deliveryMode', { type: DataTypes.STRING, defaultValue: 'instant' });
  await addColumnIfMissing('Merchants', 'sortOrder', { type: DataTypes.INTEGER, defaultValue: 0 });

  await addColumnIfMissing('Codes', 'maxUses', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Codes', 'usedCount', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Codes', 'buyers', { type: DataTypes.JSONB, defaultValue: [] });

  await addColumnIfMissing('BinancePayPayments', 'orderId', { type: DataTypes.INTEGER, allowNull: true });

  // Convert legacy unused codes to the new counters.
  await sequelize.query(`
    UPDATE "Codes"
    SET "maxUses" = COALESCE("maxUses", 1),
        "usedCount" = CASE WHEN "isUsed" = TRUE AND COALESCE("usedCount",0)=0 THEN 1 ELSE COALESCE("usedCount",0) END,
        "buyers" = COALESCE("buyers", '[]'::jsonb)
  `).catch(() => {});

  // Encrypt old plaintext inventory in small batches. New rows are always encrypted before saving.
  while (true) {
    const rows = await Code.findAll({
      where: { value: { [Op.notLike]: 'enc:v1:%' } },
      attributes: ['id', 'value', 'extra'],
      raw: true,
      limit: 500,
      order: [['id', 'ASC']]
    });
    if (!rows.length) break;
    const updates = rows.map(row => ({
      id: row.id,
      value: isEncrypted(row.value) ? row.value : encryptPayload(legacyPayload(row.value, row.extra)),
      extra: null
    }));
    await Code.bulkCreate(updates, { updateOnDuplicate: ['value', 'extra'] });
  }
}

async function getSetting(key, fallback = '') {
  const row = await Setting.findOne({ where: { key, lang: 'global' } });
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  const [row] = await Setting.findOrCreate({ where: { key, lang: 'global' }, defaults: { value: String(value) } });
  if (row.value !== String(value)) await row.update({ value: String(value) });
  return row;
}

async function getIqdRate() {
  const raw = await getSetting('iqd_rate', String(config.iqdRate));
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : config.iqdRate;
}

async function getSuperQiNumber() {
  return getSetting('superqi_number', config.superQiNumber);
}

module.exports = {
  sequelize, Op,
  User, Setting, Merchant, Code, PurchaseOrder, BalanceTransaction, BinancePayPayment,
  initializeDatabase, getSetting, setSetting, getIqdRate, getSuperQiNumber
};
