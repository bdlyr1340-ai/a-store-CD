const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { sequelize, User, BalanceTransaction, BinancePayPayment, PurchaseOrder } = require('../db');
const { fulfillOrder } = require('../services/orders');

const certCache = { fetchedAt: 0, bySerial: new Map() };

function configured() {
  return Boolean(config.binance.apiKey && config.binance.secretKey);
}

function nonce() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function signaturePayload(timestamp, requestNonce, bodyText) {
  return `${timestamp}\n${requestNonce}\n${bodyText}\n`;
}

function sign(timestamp, requestNonce, bodyText) {
  return crypto
    .createHmac('sha512', config.binance.secretKey)
    .update(signaturePayload(timestamp, requestNonce, bodyText), 'utf8')
    .digest('hex')
    .toUpperCase();
}

async function callApi(path, payload = {}) {
  if (!configured()) return { success: false, reason: 'NOT_CONFIGURED' };
  const bodyText = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const timestamp = String(Date.now());
  const requestNonce = nonce();
  try {
    const response = await axios.post(`${config.binance.baseUrl}${path}`, bodyText, {
      timeout: 25000,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': timestamp,
        'BinancePay-Nonce': requestNonce,
        'BinancePay-Certificate-SN': config.binance.apiKey,
        'BinancePay-Signature': sign(timestamp, requestNonce, bodyText)
      }
    });
    const raw = response.data || {};
    const ok = response.status >= 200 && response.status < 300 && raw.status === 'SUCCESS' && String(raw.code) === '000000';
    return {
      success: ok,
      statusCode: response.status,
      code: raw.code,
      errorMessage: raw.errorMessage || raw.message || null,
      data: raw.data || null,
      raw
    };
  } catch (error) {
    return { success: false, reason: 'NETWORK_ERROR', errorMessage: error.message, raw: error.response?.data || null };
  }
}

function merchantTradeNo(userId, orderId) {
  const time = Date.now().toString().slice(-10);
  const user = String(Math.abs(Number(userId) || 0)).slice(-6).padStart(6, '0');
  const order = String(orderId).slice(-6).padStart(6, '0');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CD${time}${user}${order}${random}`.replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function normalizeStatus(status, bizStatus = '') {
  const s = String(status || '').toUpperCase();
  const b = String(bizStatus || '').toUpperCase();
  if (['PAY_SUCCESS', 'PAY_CLOSED'].includes(b)) return b === 'PAY_SUCCESS' ? 'PAID' : 'CLOSED';
  if (['PAID', 'PAY_SUCCESS', 'SUCCESS'].includes(s)) return 'PAID';
  if (['CANCELED', 'CANCELLED', 'PAY_CLOSED', 'CLOSED'].includes(s)) return 'CLOSED';
  if (['EXPIRED'].includes(s)) return 'EXPIRED';
  if (['ERROR', 'PAY_FAIL', 'FAILED'].includes(s)) return 'ERROR';
  return s || 'PENDING';
}

async function createForOrder(orderId) {
  if (!configured()) return { success: false, reason: 'NOT_CONFIGURED' };
  const order = await PurchaseOrder.findByPk(orderId);
  if (!order) return { success: false, reason: 'ORDER_NOT_FOUND' };
  if (order.status !== 'pending_payment') return { success: false, reason: 'ORDER_ALREADY_PROCESSED' };

  const tradeNo = merchantTradeNo(order.userId, order.id);
  const amount = Number(order.totalAmount).toFixed(2);
  const passThroughInfo = JSON.stringify({ orderId: order.id, userId: String(order.userId) });
  const body = {
    env: { terminalType: 'WAP' },
    merchantTradeNo: tradeNo,
    orderAmount: Number(amount),
    currency: 'USDT',
    goods: {
      goodsType: '02',
      goodsCategory: 'Z000',
      referenceGoodsId: `ORDER${order.id}`,
      goodsName: 'DigitalProduct',
      goodsDetail: `Telegram store order ${order.id}`
    },
    passThroughInfo,
    orderExpireTime: Date.now() + config.binance.orderExpireMs
  };
  if (config.binance.returnUrl) body.returnUrl = config.binance.returnUrl;
  if (config.binance.cancelUrl) body.cancelUrl = config.binance.cancelUrl;
  if (config.publicUrl) {
    const webhookPath = config.binance.webhookPath.startsWith('/') ? config.binance.webhookPath : `/${config.binance.webhookPath}`;
    body.webhookUrl = `${config.publicUrl}${webhookPath}`;
  }

  const response = await callApi('/binancepay/openapi/v2/order', body);
  if (!response.success || !response.data) return response;
  const data = response.data;
  const payment = await BinancePayPayment.create({
    userId: order.userId,
    orderId: order.id,
    merchantTradeNo: tradeNo,
    prepayId: data.prepayId || null,
    amount,
    currency: 'USDT',
    status: 'CREATED',
    passThroughInfo,
    checkoutUrl: data.checkoutUrl || null,
    deeplink: data.deeplink || null,
    universalUrl: data.universalUrl || null,
    qrcodeLink: data.qrcodeLink || null,
    qrContent: data.qrContent || null,
    orderPayload: body,
    expireTime: data.expireTime ? new Date(Number(data.expireTime)) : new Date(Date.now() + config.binance.orderExpireMs),
    meta: { createResponse: response.raw }
  });
  order.paymentRef = tradeNo;
  await order.save();
  return { success: true, payment, response: response.raw };
}

async function createForTopup(userId, amount) {
  if (!configured()) return { success: false, reason: 'NOT_CONFIGURED' };
  const normalizedAmount = Number(amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount < 1 || normalizedAmount > 100000) {
    return { success: false, reason: 'INVALID_AMOUNT' };
  }
  const tx = await BalanceTransaction.create({
    userId,
    amount: normalizedAmount,
    type: 'deposit',
    txid: null,
    caption: 'Binance Pay wallet topup',
    status: 'created',
    lastReminderAt: new Date()
  });
  const tradeNo = merchantTradeNo(userId, tx.id);
  const passThroughInfo = JSON.stringify({ balanceTransactionId: tx.id, userId: String(userId), purpose: 'topup' });
  const body = {
    env: { terminalType: 'WAP' },
    merchantTradeNo: tradeNo,
    orderAmount: Number(normalizedAmount.toFixed(2)),
    currency: 'USDT',
    goods: {
      goodsType: '02',
      goodsCategory: 'Z000',
      referenceGoodsId: `TOPUP${tx.id}`,
      goodsName: 'WalletTopup',
      goodsDetail: `Telegram wallet topup ${tx.id}`
    },
    passThroughInfo,
    orderExpireTime: Date.now() + config.binance.orderExpireMs
  };
  if (config.binance.returnUrl) body.returnUrl = config.binance.returnUrl;
  if (config.binance.cancelUrl) body.cancelUrl = config.binance.cancelUrl;
  if (config.publicUrl) {
    const webhookPath = config.binance.webhookPath.startsWith('/') ? config.binance.webhookPath : `/${config.binance.webhookPath}`;
    body.webhookUrl = `${config.publicUrl}${webhookPath}`;
  }
  const response = await callApi('/binancepay/openapi/v2/order', body);
  if (!response.success || !response.data) {
    await tx.update({ status: 'error', caption: `Binance create error: ${response.errorMessage || response.reason || ''}` });
    return response;
  }
  const data = response.data;
  tx.txid = tradeNo;
  await tx.save();
  const payment = await BinancePayPayment.create({
    userId,
    orderId: null,
    balanceTransactionId: tx.id,
    merchantTradeNo: tradeNo,
    prepayId: data.prepayId || null,
    amount: normalizedAmount,
    currency: 'USDT',
    status: 'CREATED',
    passThroughInfo,
    checkoutUrl: data.checkoutUrl || null,
    deeplink: data.deeplink || null,
    universalUrl: data.universalUrl || null,
    qrcodeLink: data.qrcodeLink || null,
    qrContent: data.qrContent || null,
    orderPayload: body,
    expireTime: data.expireTime ? new Date(Number(data.expireTime)) : new Date(Date.now() + config.binance.orderExpireMs),
    meta: { purpose: 'topup', createResponse: response.raw }
  });
  return { success: true, payment, transaction: tx, response: response.raw };
}

async function creditWalletTopup(payment, remote, source) {
  const transaction = await sequelize.transaction();
  try {
    const lockedPayment = await BinancePayPayment.findByPk(payment.id, { transaction, lock: transaction.LOCK.UPDATE });
    const ledger = await BalanceTransaction.findByPk(lockedPayment.balanceTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
    const user = await User.findByPk(lockedPayment.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ledger || !user) throw new Error('TOPUP_RECORD_NOT_FOUND');
    if (ledger.status === 'completed' || lockedPayment.creditedAt) {
      await transaction.commit();
      return { success: true, paid: true, topup: true, alreadyProcessed: true, payment: lockedPayment, userId: user.id, amount: Number(lockedPayment.amount), newBalance: Number(user.balance) };
    }
    user.balance = Number(user.balance || 0) + Number(lockedPayment.amount);
    await user.save({ transaction });
    ledger.status = 'completed';
    ledger.caption = `Binance Pay confirmed | ${lockedPayment.merchantTradeNo}`;
    await ledger.save({ transaction });
    lockedPayment.status = 'PAID';
    lockedPayment.bizStatus = remote.bizStatus || 'PAY_SUCCESS';
    lockedPayment.binanceTransactionId = remote.transactionId || lockedPayment.binanceTransactionId;
    lockedPayment.prepayId = remote.prepayId || lockedPayment.prepayId;
    lockedPayment.creditedAt = new Date();
    lockedPayment.lastQueriedAt = new Date();
    lockedPayment.meta = { ...(lockedPayment.meta || {}), paidSource: source };
    await lockedPayment.save({ transaction });
    await transaction.commit();
    return { success: true, paid: true, topup: true, alreadyProcessed: false, payment: lockedPayment, userId: user.id, amount: Number(lockedPayment.amount), newBalance: Number(user.balance) };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function markAndFulfill(payment, remote, source) {
  const expected = Number(payment.amount);
  const settled = Number(remote.orderAmount ?? remote.totalFee ?? payment.amount);
  const currency = String(remote.currency || payment.currency || '').toUpperCase();
  if (!Number.isFinite(settled) || Math.abs(expected - settled) > 0.00000001 || currency !== String(payment.currency).toUpperCase()) {
    await payment.update({ status: 'ERROR', bizStatus: 'MISMATCH', queryPayload: remote });
    return { success: false, reason: 'AMOUNT_OR_CURRENCY_MISMATCH', payment };
  }

  if (!payment.orderId && payment.balanceTransactionId) {
    return creditWalletTopup(payment, remote, source);
  }

  // fulfillOrder is idempotent and locks the order, so webhook + manual check cannot double-deliver.
  const fulfillment = await fulfillOrder(payment.orderId, { paymentRef: payment.merchantTradeNo });
  await payment.update({
    status: 'PAID',
    bizStatus: remote.bizStatus || 'PAY_SUCCESS',
    binanceTransactionId: remote.transactionId || payment.binanceTransactionId,
    prepayId: remote.prepayId || payment.prepayId,
    creditedAt: payment.creditedAt || new Date(),
    lastQueriedAt: new Date(),
    meta: { ...(payment.meta || {}), paidSource: source }
  });
  return { success: true, paid: true, payment, fulfillment, alreadyProcessed: fulfillment.alreadyProcessed };
}

async function query(identifier) {
  let payment = null;
  if (typeof identifier === 'number') payment = await BinancePayPayment.findByPk(identifier);
  else payment = await BinancePayPayment.findOne({ where: { merchantTradeNo: String(identifier) } });
  if (!payment) return { success: false, reason: 'PAYMENT_NOT_FOUND' };

  const body = payment.prepayId ? { prepayId: payment.prepayId } : { merchantTradeNo: payment.merchantTradeNo };
  const response = await callApi('/binancepay/openapi/v2/order/query', body);
  if (!response.success || !response.data) return { ...response, payment };
  const remote = response.data;
  const status = normalizeStatus(remote.status);
  if (status === 'PAID') return markAndFulfill(payment, remote, 'query');
  await payment.update({
    status,
    bizStatus: remote.status || null,
    queryPayload: response.raw,
    lastQueriedAt: new Date(),
    prepayId: remote.prepayId || payment.prepayId,
    binanceTransactionId: remote.transactionId || payment.binanceTransactionId
  });
  return { success: true, paid: false, status, payment, remote };
}

async function fetchCertificates(force = false) {
  if (!force && certCache.bySerial.size && Date.now() - certCache.fetchedAt < 30 * 60 * 1000) return certCache.bySerial;
  const response = await callApi('/binancepay/openapi/certificates', {});
  if (!response.success) return new Map();
  const list = Array.isArray(response.data) ? response.data : response.data?.certificates || [];
  const map = new Map();
  for (const row of list) {
    const serial = String(row.certSerial || row.certSN || row.serial || '').trim();
    const key = String(row.certPublic || row.publicKey || '').trim();
    if (serial && key) map.set(serial, key);
  }
  certCache.bySerial = map;
  certCache.fetchedAt = Date.now();
  return map;
}

async function verifyWebhook(req) {
  const headers = req.headers || {};
  const certSerial = String(headers['binancepay-certificate-sn'] || '').trim();
  const requestNonce = String(headers['binancepay-nonce'] || '').trim();
  const timestamp = String(headers['binancepay-timestamp'] || '').trim();
  const signature = String(headers['binancepay-signature'] || '').trim();
  const rawBody = String(req.rawBody || '');
  if (!certSerial || !requestNonce || !timestamp || !signature || !rawBody) return false;
  let certificates = await fetchCertificates(false);
  let publicKey = certificates.get(certSerial);
  if (!publicKey) {
    certificates = await fetchCertificates(true);
    publicKey = certificates.get(certSerial);
  }
  if (!publicKey) return false;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signaturePayload(timestamp, requestNonce, rawBody), 'utf8');
  verifier.end();
  return verifier.verify(publicKey, Buffer.from(signature, 'base64'));
}

async function handleWebhook(req) {
  if (!(await verifyWebhook(req))) return { ok: false, http: 400, message: 'INVALID_SIGNATURE' };
  const payload = req.body || {};
  if (String(payload.bizType || '').toUpperCase() !== 'PAY') return { ok: true, ignored: true };
  const data = typeof payload.data === 'string' ? JSON.parse(payload.data) : (payload.data || {});
  const tradeNo = String(data.merchantTradeNo || '').trim();
  const prepayId = String(payload.bizIdStr || payload.bizId || data.prepayId || '').trim();
  let payment = tradeNo ? await BinancePayPayment.findOne({ where: { merchantTradeNo: tradeNo } }) : null;
  if (!payment && prepayId) payment = await BinancePayPayment.findOne({ where: { prepayId } });
  if (!payment) return { ok: false, http: 404, message: 'ORDER_NOT_FOUND' };
  const status = normalizeStatus(data.status, payload.bizStatus);
  if (status === 'PAID') {
    const result = await markAndFulfill(payment, { ...data, bizStatus: payload.bizStatus, prepayId }, 'webhook');
    await payment.update({ webhookPayload: payload });
    return { ok: result.success, paid: result.success, result, payment };
  }
  await payment.update({ status, bizStatus: payload.bizStatus || data.status, webhookPayload: payload });
  return { ok: true, paid: false, status, payment };
}

function checkoutUrl(payment) {
  return payment.checkoutUrl || payment.universalUrl || payment.deeplink || payment.qrContent || null;
}

module.exports = { configured, createForOrder, createForTopup, query, handleWebhook, checkoutUrl };
