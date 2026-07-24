const { Sequelize, DataTypes, Op } = require('sequelize');
const config = require('./config');
const { encryptPayload, decryptPayload, isEncrypted, legacyPayload } = require('./cryptoStore');
const { inventoryFingerprint, inventoryPayloadIsValid, parseDescription } = require('./utils');

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
  firstName: { type: DataTypes.STRING, allowNull: true },
  referredBy: { type: DataTypes.BIGINT, allowNull: true },
  referralProcessed: { type: DataTypes.BOOLEAN, defaultValue: false },
  referralOfferShown: { type: DataTypes.BOOLEAN, defaultValue: false }
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
  sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  // Secret admin-only field. Never rendered to customers.
  ownerNote: { type: DataTypes.TEXT, allowNull: true }
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
  buyers: { type: DataTypes.JSONB, defaultValue: [] },
  fingerprint: { type: DataTypes.STRING(64), allowNull: true }
}, {
  indexes: [
    { fields: ['merchantId', 'fingerprint'] },
    { fields: ['merchantId', 'isUsed'] }
  ]
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

const BinanceTransfer = sequelize.define('BinanceTransfer', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  orderId: { type: DataTypes.INTEGER, allowNull: true },
  balanceTransactionId: { type: DataTypes.INTEGER, allowNull: true },
  verificationCode: { type: DataTypes.STRING(32), allowNull: false },
  expectedAmount: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  currency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'USDT' },
  status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'WAITING' },
  submittedOrderId: { type: DataTypes.STRING(128), allowNull: true },
  transactionId: { type: DataTypes.STRING(128), allowNull: true, unique: true },
  verifiedAt: { type: DataTypes.DATE, allowNull: true },
  rawPayload: { type: DataTypes.JSONB, allowNull: true }
}, {
  indexes: [
    { fields: ['userId'] },
    { fields: ['orderId'] },
    { fields: ['status'] },
    { unique: true, fields: ['transactionId'] }
  ]
});

const SupportTicket = sequelize.define('SupportTicket', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'open' },
  assignedAdminId: { type: DataTypes.BIGINT, allowNull: true },
  lastMessageAt: { type: DataTypes.DATE, allowNull: true },
  closedAt: { type: DataTypes.DATE, allowNull: true }
}, {
  indexes: [
    { fields: ['userId', 'status'] },
    { fields: ['lastMessageAt'] }
  ]
});

const Referral = sequelize.define('Referral', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  referrerId: { type: DataTypes.BIGINT, allowNull: false },
  referredId: { type: DataTypes.BIGINT, allowNull: false, unique: true },
  rewardAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'rewarded' }
}, {
  indexes: [
    { fields: ['referrerId'] },
    { unique: true, fields: ['referredId'] }
  ]
});

const GiftClaim = sequelize.define('GiftClaim', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  campaignKey: { type: DataTypes.STRING(128), allowNull: false },
  merchantId: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  orderId: { type: DataTypes.INTEGER, allowNull: true },
  error: { type: DataTypes.TEXT, allowNull: true }
}, {
  indexes: [
    { unique: true, fields: ['userId', 'campaignKey'] },
    { fields: ['status'] }
  ]
});

Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant, { foreignKey: 'merchantId' });
User.hasMany(PurchaseOrder, { foreignKey: 'userId' });
PurchaseOrder.belongsTo(User, { foreignKey: 'userId' });
Merchant.hasMany(PurchaseOrder, { foreignKey: 'merchantId' });
PurchaseOrder.belongsTo(Merchant, { foreignKey: 'merchantId' });
PurchaseOrder.hasOne(BinanceTransfer, { foreignKey: 'orderId' });
BinanceTransfer.belongsTo(PurchaseOrder, { foreignKey: 'orderId' });
User.hasMany(SupportTicket, { foreignKey: 'userId' });
SupportTicket.belongsTo(User, { foreignKey: 'userId' });

async function addColumnIfMissing(tableName, columnName, definition) {
  const qi = sequelize.getQueryInterface();
  let table;
  try { table = await qi.describeTable(tableName); } catch { return; }
  if (!table[columnName]) await qi.addColumn(tableName, columnName, definition);
}

async function populateFingerprintsAndRemoveUnusedDuplicates() {
  const products = await Merchant.findAll({ attributes: ['id', 'type'], raw: true });
  for (const product of products) {
    const rows = await Code.findAll({
      where: { merchantId: product.id },
      order: [['id', 'ASC']]
    });
    const availableSeen = new Set();

    for (const row of rows) {
      let payload;
      try { payload = decryptPayload(row.value, row.extra); }
      catch { continue; }

      const usedCount = Number(row.usedCount || 0);
      const maxUses = Number(row.maxUses || 1);
      const isAvailable = !row.isUsed && usedCount < maxUses;
      const isAvailableUnused = isAvailable && usedCount === 0;

      if (product.type === 'shared') {
        const cleaned = {
          email: String(payload.email || '').trim(),
          password: String(payload.password || '').trim(),
          twoFactor: '',
          code: '',
          extra: ''
        };
        if (JSON.stringify(cleaned) !== JSON.stringify({
          email: String(payload.email || '').trim(),
          password: String(payload.password || '').trim(),
          twoFactor: String(payload.twoFactor || ''),
          code: String(payload.code || ''),
          extra: String(payload.extra || '')
        })) {
          payload = cleaned;
          row.value = encryptPayload(payload);
          row.extra = null;
        }
      }

      if (!inventoryPayloadIsValid(product.type, payload)) {
        if (isAvailableUnused) {
          await row.destroy();
        } else {
          // Preserve purchase history but stop any invalid row from being sold again.
          row.isUsed = true;
          row.maxUses = Math.max(1, Number(row.usedCount || 1));
          await row.save({ fields: ['isUsed', 'maxUses'] });
        }
        continue;
      }

      const fingerprint = inventoryFingerprint(product.type, payload);

      if (isAvailable && availableSeen.has(fingerprint)) {
        if (usedCount === 0) {
          await row.destroy();
        } else {
          // Keep historical buyers but exhaust the duplicate so it cannot be sold again.
          row.isUsed = true;
          row.maxUses = Math.max(1, usedCount);
          await row.save({ fields: ['isUsed', 'maxUses'] });
        }
        continue;
      }

      if (isAvailable) availableSeen.add(fingerprint);
      if (row.fingerprint !== fingerprint || row.changed('value') || row.changed('extra')) {
        row.fingerprint = fingerprint;
        await row.save({ fields: ['fingerprint', 'value', 'extra'] });
      }
    }
  }
}

async function normalizeProductDescriptions() {
  const products = await Merchant.findAll();
  for (const product of products) {
    const normalized = parseDescription(product.description);
    const canonical = {
      ar: normalized.ar,
      en: normalized.en,
      warrantyAr: normalized.warrantyAr,
      warrantyEn: normalized.warrantyEn,
      sold: normalized.sold
    };
    if (JSON.stringify(product.description || {}) !== JSON.stringify(canonical)) {
      product.set('description', canonical);
      product.changed('description', true);
      await product.save({ fields: ['description'] });
    }
  }
}

async function initializeDatabase() {
  await sequelize.authenticate();
  await sequelize.sync({ alter: false });

  await addColumnIfMissing('Users', 'blocked', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Users', 'username', { type: DataTypes.STRING, allowNull: true });
  await addColumnIfMissing('Users', 'firstName', { type: DataTypes.STRING, allowNull: true });
  await addColumnIfMissing('Users', 'referredBy', { type: DataTypes.BIGINT, allowNull: true });
  await addColumnIfMissing('Users', 'referralProcessed', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Users', 'referralOfferShown', { type: DataTypes.BOOLEAN, defaultValue: false });

  await addColumnIfMissing('Merchants', 'image', { type: DataTypes.TEXT, allowNull: true });
  await addColumnIfMissing('Merchants', 'isActive', { type: DataTypes.BOOLEAN, defaultValue: true });
  await addColumnIfMissing('Merchants', 'sharedLimit', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Merchants', 'deliveryMode', { type: DataTypes.STRING, defaultValue: 'instant' });
  await addColumnIfMissing('Merchants', 'sortOrder', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Merchants', 'ownerNote', { type: DataTypes.TEXT, allowNull: true });

  await addColumnIfMissing('Codes', 'maxUses', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Codes', 'usedCount', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Codes', 'buyers', { type: DataTypes.JSONB, defaultValue: [] });
  await addColumnIfMissing('Codes', 'fingerprint', { type: DataTypes.STRING(64), allowNull: true });

  await sequelize.query(`
    UPDATE "Codes"
    SET "maxUses" = COALESCE("maxUses", 1),
        "usedCount" = CASE WHEN "isUsed" = TRUE AND COALESCE("usedCount",0)=0 THEN 1 ELSE COALESCE("usedCount",0) END,
        "buyers" = COALESCE("buyers", '[]'::jsonb)
  `).catch(() => {});

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

  await populateFingerprintsAndRemoveUnusedDuplicates();
  await normalizeProductDescriptions();
}

async function getSetting(key, fallback = '') {
  const row = await Setting.findOne({ where: { key, lang: 'global' } });
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  const [row] = await Setting.findOrCreate({
    where: { key, lang: 'global' },
    defaults: { value: String(value) }
  });
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
  sequelize,
  Op,
  User,
  Setting,
  Merchant,
  Code,
  PurchaseOrder,
  BalanceTransaction,
  BinanceTransfer,
  SupportTicket,
  Referral,
  GiftClaim,
  initializeDatabase,
  getSetting,
  setSetting,
  getIqdRate,
  getSuperQiNumber
};
