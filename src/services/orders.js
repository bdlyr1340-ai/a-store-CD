const { QueryTypes } = require('sequelize');
const { sequelize, User, Merchant, Code, PurchaseOrder } = require('../db');
const { parseDescription } = require('../utils');
const { decryptPayload } = require('../cryptoStore');

async function getProductStock(merchantId) {
  const [rows] = await sequelize.query(`
    SELECT COALESCE(SUM(GREATEST(COALESCE("maxUses",1)-COALESCE("usedCount",0),0)),0)::int AS stock
    FROM "Codes"
    WHERE "merchantId" = :merchantId
      AND COALESCE("isUsed", FALSE) = FALSE
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  `, { replacements: { merchantId } });
  return Number(rows[0]?.stock || 0);
}

async function listActiveProducts() {
  const products = await Merchant.findAll({ where: { isActive: true }, order: [['sortOrder','ASC'], ['id','ASC']] });
  const rows = [];
  for (const product of products) rows.push({ product, stock: await getProductStock(product.id) });
  return rows;
}

async function createOrder({ userId, merchantId, quantity, paymentMethod }) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !product.isActive) throw new Error('PRODUCT_NOT_FOUND');
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new Error('INVALID_QUANTITY');
  const stock = await getProductStock(product.id);
  if (stock < qty) throw new Error('OUT_OF_STOCK');
  return PurchaseOrder.create({
    userId,
    merchantId,
    quantity: qty,
    unitPrice: Number(product.price),
    totalAmount: Number(product.price) * qty,
    currency: 'USDT',
    paymentMethod,
    status: 'pending_payment'
  });
}

async function fulfillOrder(orderId, options = {}) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status === 'completed' || order.status === 'waiting_code') {
      await transaction.commit();
      return { order, deliveries: order.delivery || [], alreadyProcessed: true };
    }
    if (!['pending_payment','paid','proof_pending'].includes(order.status)) throw new Error('ORDER_ALREADY_PROCESSED');

    const product = await Merchant.findByPk(order.merchantId, { transaction, lock: transaction.LOCK.UPDATE });
    const deliveries = [];
    for (let i = 0; i < order.quantity; i++) {
      const inventoryRows = await sequelize.query(`
        SELECT * FROM "Codes"
        WHERE "merchantId" = :merchantId
          AND COALESCE("isUsed", FALSE) = FALSE
          AND COALESCE("usedCount",0) < COALESCE("maxUses",1)
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        ORDER BY "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `, {
        replacements: { merchantId: product.id },
        type: QueryTypes.SELECT,
        transaction
      });
      const inventoryRow = inventoryRows[0];
      if (!inventoryRow) throw new Error('OUT_OF_STOCK');
      const inventory = inventoryRow;

      const nextCount = Number(inventory.usedCount || 0) + 1;
      const maxUses = Number(inventory.maxUses || 1);
      const exhausted = nextCount >= maxUses;
      const buyers = Array.isArray(inventory.buyers) ? inventory.buyers : [];
      buyers.push({ userId: String(order.userId), orderId: order.id, usedAt: new Date().toISOString(), position: nextCount });

      await Code.update({
        usedCount: nextCount,
        maxUses,
        buyers,
        isUsed: exhausted,
        usedBy: exhausted ? order.userId : inventory.usedBy,
        soldAt: exhausted ? new Date() : inventory.soldAt
      }, { where: { id: inventory.id }, transaction });

      const payload = decryptPayload(inventory.value, inventory.extra);
      const waitingCode = product.deliveryMode === 'wait_code';
      deliveries.push({
        codeId: inventory.id,
        payload,
        sharedPosition: maxUses > 1 ? { current: nextCount, max: maxUses } : null,
        waitingCode
      });
    }

    const waitingCode = deliveries.some(d => d.waitingCode);
    order.status = waitingCode ? 'waiting_code' : 'completed';
    order.delivery = deliveries;
    order.paidAt = order.paidAt || new Date();
    if (!waitingCode) order.completedAt = new Date();
    if (options.paymentRef) order.paymentRef = options.paymentRef;
    await order.save({ transaction });

    const description = parseDescription(product.description);
    description.sold = Number(description.sold || 0) + Number(order.quantity || 0);
    product.description = description;
    await product.save({ transaction });

    await transaction.commit();
    return { order, deliveries, product };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function payFromWallet(orderId) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status !== 'pending_payment') throw new Error('ORDER_ALREADY_PROCESSED');
    const user = await User.findByPk(order.userId, { transaction, lock: transaction.LOCK.UPDATE });
    const balance = Number(user.balance || 0);
    const total = Number(order.totalAmount);
    if (balance + 1e-9 < total) throw new Error('INSUFFICIENT_BALANCE');
    user.balance = balance - total;
    await user.save({ transaction });
    order.status = 'paid';
    order.paidAt = new Date();
    await order.save({ transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  try {
    return await fulfillOrder(orderId, { paymentRef: 'wallet' });
  } catch (error) {
    // Compensating refund if inventory disappeared between checkout and fulfilment.
    const refundTx = await sequelize.transaction();
    try {
      const order = await PurchaseOrder.findByPk(orderId, { transaction: refundTx, lock: refundTx.LOCK.UPDATE });
      const user = await User.findByPk(order.userId, { transaction: refundTx, lock: refundTx.LOCK.UPDATE });
      if (order.status === 'paid' && order.paymentRef !== 'wallet_refunded') {
        user.balance = Number(user.balance || 0) + Number(order.totalAmount || 0);
        await user.save({ transaction: refundTx });
        order.status = 'payment_error';
        order.paymentRef = 'wallet_refunded';
        await order.save({ transaction: refundTx });
      }
      await refundTx.commit();
    } catch (refundError) {
      await refundTx.rollback();
      console.error('Wallet refund failed:', refundError.message);
    }
    throw error;
  }
}

async function addWaitingCode(orderId, code) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status !== 'waiting_code') throw new Error('ORDER_NOT_WAITING_CODE');
    const deliveries = Array.isArray(order.delivery) ? [...order.delivery] : [];
    const target = deliveries.find(d => d.waitingCode && !d.payload?.code);
    if (!target) throw new Error('NO_WAITING_ITEM');
    target.payload = { ...(target.payload || {}), code: String(code) };
    target.waitingCode = false;
    const stillWaiting = deliveries.some(d => d.waitingCode && !d.payload?.code);
    order.delivery = deliveries;
    order.status = stillWaiting ? 'waiting_code' : 'completed';
    if (!stillWaiting) order.completedAt = new Date();
    await order.save({ transaction });
    await transaction.commit();
    return { order, delivery: target, stillWaiting };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = {
  getProductStock, listActiveProducts, createOrder, fulfillOrder, payFromWallet, addWaitingCode
};
