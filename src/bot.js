const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('./config');
const {
  sequelize, Op, User, Merchant, Code, PurchaseOrder, BalanceTransaction, BinancePayPayment,
  getIqdRate, getSuperQiNumber, setSetting
} = require('./db');
const { t } = require('./i18n');
const {
  escapeHtml, moneyUsd, moneyIqd, parseDescription, parseInventoryText,
  renderDelivery, randomCaptcha
} = require('./utils');
const {
  getProductStock, listActiveProducts, createOrder, fulfillOrder, payFromWallet, addWaitingCode
} = require('./services/orders');
const binancePay = require('./payments/binancePay');
const { encryptPayload } = require('./cryptoStore');

const bot = new TelegramBot(config.token, { polling: true });
const captchaAnswers = new Map();
const memoryRate = new Map();

function isAdmin(id) { return config.admins.has(Number(id)); }
function parseState(user) { try { return user?.state ? JSON.parse(user.state) : null; } catch { return null; } }
async function setState(userId, state) { await User.update({ state: state ? JSON.stringify(state) : null }, { where: { id: userId } }); }
async function clearState(userId) { await setState(userId, null); }

async function getOrCreateUser(from) {
  const [user] = await User.findOrCreate({
    where: { id: from.id },
    defaults: {
      lang: config.defaultLanguage,
      balance: 0,
      verified: !config.captchaEnabled,
      username: from.username || null,
      firstName: from.first_name || ''
    }
  });
  const changes = {};
  if (user.username !== (from.username || null)) changes.username = from.username || null;
  if (user.firstName !== (from.first_name || '')) changes.firstName = from.first_name || '';
  if (Object.keys(changes).length) await user.update(changes);
  return user;
}

function mainKeyboard(lang) {
  return {
    keyboard: [
      [{ text: t(lang, 'products') }, { text: t(lang, 'support') }],
      [{ text: t(lang, 'wallet') }, { text: t(lang, 'orders') }],
      [{ text: t(lang, 'language') }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function adminMenu() {
  return {
    inline_keyboard: [
      [{ text: '📦 المنتجات', callback_data: 'adm:products:0' }, { text: '📥 المخزون', callback_data: 'adm:stock' }],
      [{ text: '💳 دفعات SuperQi', callback_data: 'adm:proofs' }, { text: '🧾 الطلبات', callback_data: 'adm:orders' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'adm:settings' }, { text: '📊 الإحصائيات', callback_data: 'adm:stats' }]
    ]
  };
}

function rateAllowed(userId) {
  const now = Date.now();
  const recent = (memoryRate.get(userId) || []).filter(ts => now - ts < 10000);
  if (recent.length >= 10) return false;
  recent.push(now); memoryRate.set(userId, recent); return true;
}

async function answerCallback(id, text = '', alert = false) {
  try { await bot.answerCallbackQuery(id, { text, show_alert: alert }); } catch {}
}

async function sendCaptcha(chatId, userId, lang) {
  const cap = randomCaptcha();
  captchaAnswers.set(userId, cap.answer);
  const buttons = [];
  for (let i = 0; i < cap.options.length; i += 2) {
    buttons.push(cap.options.slice(i, i + 2).map(n => ({ text: String(n), callback_data: `cap:${n}` })));
  }
  await bot.sendMessage(chatId, `${t(lang, 'verify')}\n\n<b>${cap.question} = ?</b>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons }
  });
}

async function showMain(chatId, user) {
  await bot.sendMessage(chatId, t(user.lang, 'welcome'), { reply_markup: mainKeyboard(user.lang) });
}

async function productCaption(product, stock, lang) {
  const desc = parseDescription(product.description);
  const name = lang === 'en' ? product.nameEn : product.nameAr;
  const description = lang === 'en' ? (desc.en || desc.ar || '') : (desc.ar || desc.en || '');
  const warranty = lang === 'en' ? (desc.warrantyEn || desc.warrantyAr || '—') : (desc.warrantyAr || desc.warrantyEn || '—');
  return [
    `<b>${escapeHtml(name)}</b>`,
    `💵 <b>${t(lang, 'price')}:</b> ${moneyUsd(product.price)}`,
    `📦 <b>${t(lang, 'stock')}:</b> ${stock}`,
    `📈 <b>${t(lang, 'sold')}:</b> ${Number(desc.sold || 0)}`,
    `🛡 <b>${t(lang, 'warranty')}:</b> ${escapeHtml(warranty)}`,
    '',
    `❝ <b>${t(lang, 'description')}:</b>`,
    escapeHtml(description || '—'),
    '',
    product.type === 'shared' ? `👥 الحساب الواحد ينباع تلقائياً ${Number(product.sharedLimit || 5)} مرات.` : ''
  ].filter(Boolean).join('\n');
}

async function showProducts(chatId, user, page = 0) {
  const rows = await listActiveProducts();
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const slice = rows.slice(safePage * perPage, safePage * perPage + perPage);
  if (!slice.length) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));
  const keyboard = slice.map(({ product, stock }) => [{
    text: `${product.nameAr} | ${moneyUsd(product.price)} | 📦 ${stock}`,
    callback_data: `prod:${product.id}`
  }]);
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️', callback_data: `products:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop' });
  if (safePage < pages - 1) nav.push({ text: '➡️', callback_data: `products:${safePage + 1}` });
  keyboard.push(nav);
  await bot.sendMessage(chatId, t(user.lang, 'chooseProduct'), { reply_markup: { inline_keyboard: keyboard } });
}

async function showProduct(chatId, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !product.isActive) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));
  const stock = await getProductStock(product.id);
  const caption = await productCaption(product, stock, user.lang);
  const markup = { inline_keyboard: [[{ text: t(user.lang, 'buy'), callback_data: `buy:${product.id}` }]] };
  if (product.image) {
    try {
      await bot.sendPhoto(chatId, product.image, { caption, parse_mode: 'HTML', reply_markup: markup });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: markup });
}

async function sendDeliveryToUser(userId, fulfillment) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'ar';
  const order = fulfillment.order;
  await bot.sendMessage(userId, `${t(lang, 'delivered')} — <b>#${order.id}</b>`, { parse_mode: 'HTML' });
  for (const delivery of fulfillment.deliveries || []) {
    await bot.sendMessage(userId, renderDelivery(delivery.payload, lang, delivery.sharedPosition), { parse_mode: 'HTML' });
  }
  if ((fulfillment.deliveries || []).some(d => d.waitingCode)) {
    await bot.sendMessage(userId, t(lang, 'waitingCode'));
    await notifyAdmins(`🔐 الطلب #${order.id} ينتظر كود.\nأرسل: <code>/code_${order.id}_123456</code>`);
  }
}

async function notifyAdmins(text, options = {}) {
  for (const adminId of config.admins) {
    try { await bot.sendMessage(adminId, text, { parse_mode: 'HTML', ...options }); } catch (e) { console.error('Admin notify:', e.message); }
  }
}

async function notifyBinanceResult(result) {
  if (!result || result.alreadyProcessed) return;
  if (result.topup) {
    const user = await User.findByPk(result.userId);
    const lang = user?.lang || 'ar';
    await bot.sendMessage(result.userId, `✅ تم شحن المحفظة تلقائياً عبر Binance Pay.\nالمبلغ: <b>${moneyUsd(result.amount)}</b>\nالرصيد الجديد: <b>${moneyUsd(result.newBalance)}</b>`, { parse_mode: 'HTML' });
    await notifyAdmins(`✅ شحن Binance تلقائي\nالمستخدم: <code>${result.userId}</code>\nالمبلغ: <b>${moneyUsd(result.amount)}</b>`);
    return;
  }
  if (!result.fulfillment) return;
  await sendDeliveryToUser(result.fulfillment.order.userId, result.fulfillment);
  await notifyAdmins(`✅ Binance Pay أكد الطلب #${result.fulfillment.order.id} وتم التسليم تلقائياً.`);
}

bot.on('message', async (msg) => {
  if (!msg.from || !rateAllowed(msg.from.id)) return;
  const user = await getOrCreateUser(msg.from);
  if (user.blocked) return;

  if (msg.text === '/start') {
    if (!user.verified) return sendCaptcha(msg.chat.id, user.id, user.lang);
    return showMain(msg.chat.id, user);
  }
  if (msg.text === '/admin') {
    if (!isAdmin(user.id)) return bot.sendMessage(msg.chat.id, t(user.lang, 'adminOnly'));
    return bot.sendMessage(msg.chat.id, '👑 <b>لوحة الإدارة النظيفة</b>\nكل الحقول واضحة وماكو خانات أو بوتات إضافية.', { parse_mode: 'HTML', reply_markup: adminMenu() });
  }
  if (msg.text === '/cancel') {
    await clearState(user.id);
    return bot.sendMessage(msg.chat.id, t(user.lang, 'cancelled'), { reply_markup: mainKeyboard(user.lang) });
  }

  if (!user.verified) return sendCaptcha(msg.chat.id, user.id, user.lang);

  const state = parseState(user);
  if (state) {
    const consumed = await handleStateMessage(msg, user, state);
    if (consumed) return;
  }

  if (msg.text === t('ar', 'products') || msg.text === t('en', 'products')) return showProducts(msg.chat.id, user, 0);
  if (msg.text === t('ar', 'wallet') || msg.text === t('en', 'wallet')) {
    const inline = [];
    if (binancePay.configured()) inline.push([{ text: '🟡 شحن Binance Pay', callback_data: 'topup:binance' }]);
    inline.push([{ text: '🔵 شحن SuperQi', callback_data: 'topup:superqi' }]);
    return bot.sendMessage(msg.chat.id, `${t(user.lang, 'walletBalance')}: <b>${moneyUsd(user.balance)}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inline } });
  }
  if (msg.text === t('ar', 'orders') || msg.text === t('en', 'orders')) return showOrders(msg.chat.id, user);
  if (msg.text === t('ar', 'support') || msg.text === t('en', 'support')) {
    const support = config.supportUsername ? `@${config.supportUsername}` : 'غير محدد';
    return bot.sendMessage(msg.chat.id, `${t(user.lang, 'supportText')} ${support}`);
  }
  if (msg.text === t('ar', 'language') || msg.text === t('en', 'language')) {
    user.lang = user.lang === 'ar' ? 'en' : 'ar'; await user.save(); return showMain(msg.chat.id, user);
  }
});

bot.on('callback_query', async query => {
  if (!query.from || !rateAllowed(query.from.id)) return;
  const user = await getOrCreateUser(query.from);
  const data = String(query.data || '');
  if (data === 'noop') return answerCallback(query.id);

  if (data.startsWith('cap:')) {
    const chosen = Number(data.split(':')[1]);
    if (chosen !== captchaAnswers.get(user.id)) {
      await answerCallback(query.id, t(user.lang, 'wrong'), true);
      return sendCaptcha(query.message.chat.id, user.id, user.lang);
    }
    captchaAnswers.delete(user.id); user.verified = true; await user.save();
    await answerCallback(query.id, t(user.lang, 'verified'));
    try { await bot.editMessageText(t(user.lang, 'verified'), { chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch {}
    return showMain(query.message.chat.id, user);
  }
  if (!user.verified) return answerCallback(query.id, 'Verify first', true);

  try {
    if (data.startsWith('products:')) { await answerCallback(query.id); return showProducts(query.message.chat.id, user, Number(data.split(':')[1])); }
    if (data.startsWith('prod:')) { await answerCallback(query.id); return showProduct(query.message.chat.id, user, Number(data.split(':')[1])); }
    if (data.startsWith('buy:')) return handleBuy(query, user, Number(data.split(':')[1]));
    if (data.startsWith('qty:')) return handleQuantity(query, user, data);
    if (data.startsWith('pay:')) return handlePayment(query, user, data);
    if (data.startsWith('bincheck:')) return handleBinanceCheck(query, user, Number(data.split(':')[1]));
    if (data.startsWith('bintopupcheck:')) return handleBinanceTopupCheck(query, user, Number(data.split(':')[1]));
    if (data.startsWith('topup:')) return handleTopupStart(query, user, data.split(':')[1]);
    if (data.startsWith('order:')) return showOrder(query.message.chat.id, user, Number(data.split(':')[1]), query.id);

    if (data.startsWith('sq:approve:') || data.startsWith('sq:reject:')) return handleSuperQiAdmin(query, data);
    if (data.startsWith('sqtop:approve:') || data.startsWith('sqtop:reject:')) return handleSuperQiTopupAdmin(query, data);

    if (data.startsWith('adm:')) {
      if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
      return handleAdminCallback(query, user, data);
    }
  } catch (error) {
    console.error('Callback error:', error);
    await answerCallback(query.id, `خطأ: ${error.message}`, true);
  }
});

async function handleBuy(query, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || !product.isActive || stock < 1) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  const max = Math.min(stock, 10);
  const row1 = [], row2 = [];
  for (let i = 1; i <= max; i++) (i <= 5 ? row1 : row2).push({ text: String(i), callback_data: `qty:${merchantId}:${i}` });
  const rows = [row1]; if (row2.length) rows.push(row2);
  await answerCallback(query.id);
  await bot.sendMessage(query.message.chat.id, `${t(user.lang, 'quantity')} 1-${max}`, { reply_markup: { inline_keyboard: rows } });
}

async function handleQuantity(query, user, data) {
  const [, merchantIdRaw, qtyRaw] = data.split(':');
  const merchantId = Number(merchantIdRaw), quantity = Number(qtyRaw);
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || stock < quantity) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  await setState(user.id, { action: 'checkout', merchantId, quantity });
  const total = Number(product.price) * quantity;
  const buttons = [[{ text: t(user.lang, 'payWallet'), callback_data: 'pay:wallet' }]];
  if (binancePay.configured()) buttons.push([{ text: t(user.lang, 'payBinance'), callback_data: 'pay:binance' }]);
  buttons.push([{ text: t(user.lang, 'paySuperQi'), callback_data: 'pay:superqi' }]);
  await answerCallback(query.id);
  await bot.sendMessage(query.message.chat.id, `${t(user.lang, 'payment')}\n💰 <b>${moneyUsd(total)}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

async function handlePayment(query, user, data) {
  const method = data.split(':')[1];
  const state = parseState(await User.findByPk(user.id));
  if (!state || state.action !== 'checkout') return answerCallback(query.id, t(user.lang, 'cancelled'), true);
  const order = await createOrder({ userId: user.id, merchantId: state.merchantId, quantity: state.quantity, paymentMethod: method });
  await clearState(user.id);
  await answerCallback(query.id);

  if (method === 'wallet') {
    try {
      const fulfillment = await payFromWallet(order.id);
      return sendDeliveryToUser(user.id, fulfillment);
    } catch (error) {
      if (error.message === 'INSUFFICIENT_BALANCE') return bot.sendMessage(user.id, t(user.lang, 'insufficient'));
      if (error.message === 'OUT_OF_STOCK') return bot.sendMessage(user.id, t(user.lang, 'outOfStock'));
      throw error;
    }
  }

  if (method === 'binance') {
    const created = await binancePay.createForOrder(order.id);
    if (!created.success) {
      await order.update({ status: 'payment_error' });
      return bot.sendMessage(user.id, `❌ Binance Pay: ${escapeHtml(created.errorMessage || created.reason || 'error')}`, { parse_mode: 'HTML' });
    }
    const payment = created.payment;
    const url = binancePay.checkoutUrl(payment);
    const inline = [];
    if (url) inline.push([{ text: '💳 ادفع الآن', url }]);
    inline.push([{ text: '🔄 تحقق من الدفع', callback_data: `bincheck:${payment.id}` }]);
    const message = `🟡 <b>Binance Pay</b>\n\nالطلب: <code>#${order.id}</code>\nالمبلغ: <b>${moneyUsd(order.totalAmount)} USDT</b>\nرقم العملية: <code>${escapeHtml(payment.merchantTradeNo)}</code>\n\nبعد الدفع اضغط تحقق من الدفع. وإذا الـWebhook مضبوط راح يتأكد ويسلّم تلقائياً.`;
    if (payment.qrcodeLink) {
      try { return bot.sendPhoto(user.id, payment.qrcodeLink, { caption: message, parse_mode: 'HTML', reply_markup: { inline_keyboard: inline } }); } catch {}
    }
    return bot.sendMessage(user.id, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inline } });
  }

  if (method === 'superqi') {
    const rate = await getIqdRate();
    const number = await getSuperQiNumber();
    const iqd = Number(order.totalAmount) * rate;
    await setState(user.id, { action: 'superqi_proof', orderId: order.id });
    return bot.sendMessage(user.id,
      `🔵 <b>دفع SuperQi يدوي</b>\n\nالطلب: <code>#${order.id}</code>\nالمبلغ بالدولار: <b>${moneyUsd(order.totalAmount)}</b>\nسعر الصرف: <b>${moneyIqd(rate)} لكل 1$</b>\nالمبلغ المطلوب: <b>${moneyIqd(iqd)}</b>\n\nحوّل إلى الرقم:\n<code>${escapeHtml(number)}</code>\n\n${t(user.lang, 'proofPrompt')}`,
      { parse_mode: 'HTML' }
    );
  }
}

async function handleBinanceCheck(query, user, paymentId) {
  await answerCallback(query.id, 'جاري التحقق...');
  const payment = await BinancePayPayment.findByPk(paymentId);
  if (!payment || String(payment.userId) !== String(user.id)) return bot.sendMessage(user.id, '❌ الطلب غير موجود.');
  const result = await binancePay.query(paymentId);
  if (!result.success) return bot.sendMessage(user.id, `❌ تعذر التحقق: ${escapeHtml(result.errorMessage || result.reason || 'error')}`, { parse_mode: 'HTML' });
  if (!result.paid) return bot.sendMessage(user.id, '⏳ الدفع ما زال غير مؤكد. انتظر قليلاً ثم جرّب مرة ثانية.');
  if (!result.alreadyProcessed) await sendDeliveryToUser(user.id, result.fulfillment);
  return bot.sendMessage(user.id, t(user.lang, 'paymentPaid'));
}

async function handleTopupStart(query, user, method) {
  if (method === 'binance' && !binancePay.configured()) return answerCallback(query.id, 'Binance Pay غير مهيأ.', true);
  await setState(user.id, { action: 'wallet_topup_amount', method });
  await answerCallback(query.id);
  await bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار (الحد الأدنى 1$):`);
}

async function handleBinanceTopupCheck(query, user, paymentId) {
  await answerCallback(query.id, 'جاري التحقق...');
  const payment = await BinancePayPayment.findByPk(paymentId);
  if (!payment || String(payment.userId) !== String(user.id) || payment.orderId) return bot.sendMessage(user.id, '❌ طلب الشحن غير موجود.');
  const result = await binancePay.query(paymentId);
  if (!result.success) return bot.sendMessage(user.id, `❌ تعذر التحقق: ${escapeHtml(result.errorMessage || result.reason || 'error')}`, { parse_mode: 'HTML' });
  if (!result.paid) return bot.sendMessage(user.id, '⏳ الدفع غير مؤكد بعد. انتظر قليلاً ثم أعد التحقق.');
  if (!result.alreadyProcessed) await notifyBinanceResult(result);
  return bot.sendMessage(user.id, '✅ تم التحقق من الشحن.');
}

async function handleSuperQiTopupAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, txIdRaw] = data.split(':');
  const tx = await BalanceTransaction.findByPk(Number(txIdRaw));
  if (!tx || tx.status !== 'proof_pending') return answerCallback(query.id, 'تمت معالجة العملية سابقاً.', true);
  if (action === 'reject') {
    await tx.update({ status: 'rejected' });
    await answerCallback(query.id, 'تم الرفض.');
    await bot.sendMessage(tx.userId, `❌ تم رفض إيصال شحن المحفظة #${tx.id}. راجع الدعم.`);
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch {}
    return;
  }
  const transaction = await sequelize.transaction();
  try {
    const lockedTx = await BalanceTransaction.findByPk(tx.id, { transaction, lock: transaction.LOCK.UPDATE });
    const targetUser = await User.findByPk(lockedTx.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (lockedTx.status !== 'proof_pending') throw new Error('ALREADY_PROCESSED');
    targetUser.balance = Number(targetUser.balance || 0) + Number(lockedTx.amount);
    await targetUser.save({ transaction });
    lockedTx.status = 'completed';
    await lockedTx.save({ transaction });
    await transaction.commit();
    await answerCallback(query.id, 'تمت الموافقة وشحن المحفظة.');
    await bot.sendMessage(targetUser.id, `✅ تم شحن محفظتك عبر SuperQi.\nالمبلغ: <b>${moneyUsd(lockedTx.amount)}</b>\nالرصيد الجديد: <b>${moneyUsd(targetUser.balance)}</b>`, { parse_mode: 'HTML' });
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch {}
  } catch (error) {
    await transaction.rollback();
    await answerCallback(query.id, error.message, true);
  }
}

async function handleStateMessage(msg, user, state) {
  if (state.action === 'wallet_topup_amount') {
    const amount = Number(String(msg.text || '').trim());
    if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
      await bot.sendMessage(user.id, '❌ أرسل مبلغ صحيح، الحد الأدنى 1$.');
      return true;
    }
    if (state.method === 'binance') {
      const created = await binancePay.createForTopup(user.id, amount);
      if (!created.success) {
        await clearState(user.id);
        await bot.sendMessage(user.id, `❌ Binance Pay: ${escapeHtml(created.errorMessage || created.reason || 'error')}`, { parse_mode: 'HTML' });
        return true;
      }
      await clearState(user.id);
      const payment = created.payment;
      const url = binancePay.checkoutUrl(payment);
      const buttons = [];
      if (url) buttons.push([{ text: '💳 ادفع الآن', url }]);
      buttons.push([{ text: '🔄 تحقق من الشحن', callback_data: `bintopupcheck:${payment.id}` }]);
      const message = `🟡 <b>شحن Binance Pay</b>

المبلغ: <b>${moneyUsd(amount)} USDT</b>
رقم العملية: <code>${escapeHtml(payment.merchantTradeNo)}</code>

بعد الدفع راح ينشحن الرصيد تلقائياً. وإذا تأخر، اضغط تحقق من الشحن.`;
      if (payment.qrcodeLink) {
        try { await bot.sendPhoto(user.id, payment.qrcodeLink, { caption: message, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }); return true; } catch {}
      }
      await bot.sendMessage(user.id, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      return true;
    }

    const rate = await getIqdRate();
    const number = await getSuperQiNumber();
    const tx = await BalanceTransaction.create({
      userId: user.id,
      amount,
      type: 'deposit',
      txid: `SUPERQI-${Date.now()}-${user.id}`,
      caption: 'SuperQi manual wallet topup',
      status: 'awaiting_proof',
      lastReminderAt: new Date()
    });
    await setState(user.id, { action: 'superqi_topup_proof', transactionId: tx.id });
    await bot.sendMessage(user.id,
      `🔵 <b>شحن المحفظة عبر SuperQi</b>

المبلغ بالدولار: <b>${moneyUsd(amount)}</b>
سعر الصرف: <b>${moneyIqd(rate)} لكل 1$</b>
المبلغ المطلوب: <b>${moneyIqd(amount * rate)}</b>

حوّل إلى الرقم:
<code>${escapeHtml(number)}</code>

${t(user.lang, 'proofPrompt')}`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  if (state.action === 'superqi_topup_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const tx = await BalanceTransaction.findByPk(state.transactionId);
    if (!tx || String(tx.userId) !== String(user.id) || tx.status !== 'awaiting_proof') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await tx.update({ imageFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const rate = await getIqdRate();
    for (const adminId of config.admins) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: `🔵 <b>إيصال شحن SuperQi</b>
العملية: <code>#${tx.id}</code>
المستخدم: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>
المبلغ: ${moneyUsd(tx.amount)} = ${moneyIqd(Number(tx.amount) * rate)}`,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وشحن', callback_data: `sqtop:approve:${tx.id}` },
            { text: '❌ رفض', callback_data: `sqtop:reject:${tx.id}` }
          ]] }
        });
      } catch (error) { console.error('SuperQi topup admin:', error.message); }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (state.action === 'superqi_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(msg.chat.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id) || order.status !== 'pending_payment') {
      await clearState(user.id); return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await order.update({ proofFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const product = await Merchant.findByPk(order.merchantId);
    const rate = await getIqdRate();
    for (const adminId of config.admins) {
      try {
        const sent = await bot.sendPhoto(adminId, fileId, {
          caption: `🔵 <b>إيصال SuperQi</b>\nالطلب: <code>#${order.id}</code>\nالزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>\nالمنتج: ${escapeHtml(product?.nameAr || '')}\nالكمية: ${order.quantity}\nالمبلغ: ${moneyUsd(order.totalAmount)} = ${moneyIqd(Number(order.totalAmount) * rate)}`,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وتسليم', callback_data: `sq:approve:${order.id}` },
            { text: '❌ رفض', callback_data: `sq:reject:${order.id}` }
          ]] }
        });
        if (!order.adminMessageId) await order.update({ adminMessageId: sent.message_id });
      } catch (e) { console.error('SuperQi admin photo:', e.message); }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (!isAdmin(user.id)) return false;

  if (state.action === 'admin_edit_product') {
    const product = await Merchant.findByPk(state.productId);
    if (!product) { await clearState(user.id); return true; }
    const field = state.field;
    let value = msg.text?.trim();
    if (field === 'image' && msg.photo?.length) value = msg.photo[msg.photo.length - 1].file_id;
    if (!value) return true;
    const desc = parseDescription(product.description);
    if (field === 'nameAr') product.nameAr = value;
    else if (field === 'nameEn') product.nameEn = value;
    else if (field === 'price') {
      const n = Number(value); if (!Number.isFinite(n) || n < 0) { await bot.sendMessage(user.id, '❌ سعر غير صحيح.'); return true; } product.price = n;
    } else if (field === 'category') product.category = value;
    else if (field === 'descriptionAr') desc.ar = value;
    else if (field === 'descriptionEn') desc.en = value;
    else if (field === 'warrantyAr') desc.warrantyAr = value;
    else if (field === 'warrantyEn') desc.warrantyEn = value;
    else if (field === 'image') product.image = value === '-' ? null : value;
    else if (field === 'sharedLimit') {
      const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 100) { await bot.sendMessage(user.id, '❌ العدد لازم من 1 إلى 100.'); return true; }
      product.sharedLimit = n;
      if (product.type === 'shared') {
        await Code.update({ maxUses: n }, { where: { merchantId: product.id, usedCount: 0, isUsed: false } });
      }
    }
    product.description = desc;
    await product.save(); await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم الحفظ.'); await showAdminProductEditor(user.id, product.id);
    return true;
  }

  if (state.action === 'admin_add_stock') {
    let text = msg.text || '';
    if (msg.document) {
      const link = await bot.getFileLink(msg.document.file_id);
      const response = await axios.get(link, { responseType: 'text', timeout: 20000 });
      text = String(response.data || '');
    }
    const items = parseInventoryText(text);
    if (!items.length) { await bot.sendMessage(user.id, '❌ ما حصلت بيانات صحيحة.'); return true; }
    const product = await Merchant.findByPk(state.productId);
    if (product.type === 'code') {
      for (const item of items) {
        if (!item.code && item.email && !item.password && !item.twoFactor) {
          item.code = item.email;
          item.email = '';
        }
      }
    }
    const maxUses = product.type === 'shared' ? Number(product.sharedLimit || 5) : 1;
    const transaction = await sequelize.transaction();
    try {
      for (const item of items) {
        await Code.create({ value: encryptPayload(item), extra: null, merchantId: product.id, maxUses, usedCount: 0, isUsed: false, buyers: [] }, { transaction });
      }
      await transaction.commit(); await clearState(user.id);
      await bot.sendMessage(user.id, `✅ انضاف ${items.length} حساب/كود.\nكل واحد ينباع ${maxUses} مرة.`);
    } catch (e) { await transaction.rollback(); throw e; }
    return true;
  }

  if (state.action === 'admin_setting') {
    const value = msg.text?.trim(); if (!value) return true;
    if (state.key === 'iqd_rate') {
      const n = Number(value); if (!Number.isFinite(n) || n < 1) { await bot.sendMessage(user.id, '❌ رقم غير صحيح.'); return true; }
    }
    await setSetting(state.key, value); await clearState(user.id); await bot.sendMessage(user.id, '✅ تم تحديث الإعداد.');
    return true;
  }

  return false;
}

async function handleSuperQiAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, orderIdRaw] = data.split(':');
  const order = await PurchaseOrder.findByPk(Number(orderIdRaw));
  if (!order || order.status !== 'proof_pending') return answerCallback(query.id, 'تمت معالجة الطلب سابقاً.', true);
  if (action === 'reject') {
    await order.update({ status: 'rejected' });
    await answerCallback(query.id, 'تم الرفض.');
    await bot.sendMessage(order.userId, `❌ تم رفض إيصال الطلب #${order.id}. راجع الدعم.`);
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch {}
    return;
  }
  try {
    const fulfillment = await fulfillOrder(order.id, { paymentRef: `superqi:${order.id}` });
    await answerCallback(query.id, 'تمت الموافقة والتسليم.');
    await sendDeliveryToUser(order.userId, fulfillment);
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch {}
  } catch (error) {
    await answerCallback(query.id, error.message === 'OUT_OF_STOCK' ? 'المخزون غير كافي.' : error.message, true);
  }
}

async function showOrders(chatId, user) {
  const orders = await PurchaseOrder.findAll({ where: { userId: user.id }, order: [['id','DESC']], limit: 15, include: [Merchant] });
  if (!orders.length) return bot.sendMessage(chatId, t(user.lang, 'noOrders'));
  const keyboard = orders.map(o => [{ text: `#${o.id} | ${o.Merchant?.nameAr || ''} | ${o.status}`, callback_data: `order:${o.id}` }]);
  await bot.sendMessage(chatId, t(user.lang, 'orders'), { reply_markup: { inline_keyboard: keyboard } });
}

async function showOrder(chatId, user, orderId, callbackId = null) {
  if (callbackId) await answerCallback(callbackId);
  const order = await PurchaseOrder.findByPk(orderId, { include: [Merchant] });
  if (!order || (String(order.userId) !== String(user.id) && !isAdmin(user.id))) return;
  const text = `🧾 <b>الطلب #${order.id}</b>\nالمنتج: ${escapeHtml(order.Merchant?.nameAr || '')}\nالكمية: ${order.quantity}\nالمبلغ: ${moneyUsd(order.totalAmount)}\nالدفع: ${escapeHtml(order.paymentMethod)}\nالحالة: ${escapeHtml(order.status)}`;
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function handleAdminCallback(query, user, data) {
  if (data === 'adm:stock') {
    await answerCallback(query.id); return showStockProductList(query.message.chat.id);
  }
  if (data === 'adm:proofs') {
    await answerCallback(query.id);
    const rows = await PurchaseOrder.findAll({ where: { status: 'proof_pending' }, order: [['id','DESC']], limit: 30, include: [Merchant] });
    return bot.sendMessage(query.message.chat.id, rows.length ? rows.map(o => `#${o.id} | ${o.Merchant?.nameAr || ''} | ${moneyUsd(o.totalAmount)}`).join('\n') : 'ماكو دفعات معلقة.');
  }
  if (data === 'adm:orders') {
    await answerCallback(query.id);
    const rows = await PurchaseOrder.findAll({ order: [['id','DESC']], limit: 30, include: [Merchant] });
    return bot.sendMessage(query.message.chat.id, rows.length ? rows.map(o => `#${o.id} | ${o.Merchant?.nameAr || ''} | ${o.status} | ${moneyUsd(o.totalAmount)}`).join('\n') : 'ماكو طلبات.');
  }
  if (data === 'adm:stats') {
    await answerCallback(query.id);
    const [users, products, orders] = await Promise.all([User.count(), Merchant.count(), PurchaseOrder.count()]);
    const stockRows = await listActiveProducts(); const stock = stockRows.reduce((s,r) => s + r.stock, 0);
    return bot.sendMessage(query.message.chat.id, `📊 المستخدمون: ${users}\n📦 المنتجات: ${products}\n🧾 الطلبات: ${orders}\n🔐 المخزون المتاح: ${stock}`);
  }
  if (data === 'adm:settings') {
    await answerCallback(query.id);
    const rate = await getIqdRate(), number = await getSuperQiNumber();
    return bot.sendMessage(query.message.chat.id, `⚙️ <b>الإعدادات</b>\n\nسعر الدولار: ${moneyIqd(rate)}\nرقم SuperQi: <code>${escapeHtml(number)}</code>`, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
        { text: '💱 تغيير سعر الدولار', callback_data: 'adm:set:iqd_rate' },
        { text: '🔵 تغيير رقم SuperQi', callback_data: 'adm:set:superqi_number' }
      ]] }
    });
  }
  if (data.startsWith('adm:set:')) {
    const key = data.split(':')[2]; await setState(user.id, { action: 'admin_setting', key }); await answerCallback(query.id);
    return bot.sendMessage(user.id, key === 'iqd_rate' ? 'أرسل سعر 1 دولار بالدينار:' : 'أرسل رقم SuperQi الجديد:');
  }
  if (data.startsWith('adm:products:')) {
    await answerCallback(query.id); return showAdminProducts(query.message.chat.id, Number(data.split(':')[2]));
  }
  if (data === 'adm:add_product') {
    const product = await Merchant.create({ nameAr: 'منتج جديد', nameEn: 'New product', price: 1, category: 'عام', type: 'private', description: { ar: '', en: '', warrantyAr: '', warrantyEn: '', sold: 0 }, isActive: true, sharedLimit: 1, deliveryMode: 'instant' });
    await answerCallback(query.id); return showAdminProductEditor(query.message.chat.id, product.id);
  }
  if (data.startsWith('adm:edit:')) { await answerCallback(query.id); return showAdminProductEditor(query.message.chat.id, Number(data.split(':')[2])); }
  if (data.startsWith('adm:field:')) {
    const [, , idRaw, field] = data.split(':'); await setState(user.id, { action: 'admin_edit_product', productId: Number(idRaw), field }); await answerCallback(query.id);
    return bot.sendMessage(user.id, `أرسل القيمة الجديدة للحقل: ${field}\nللصورة أرسل صورة مباشرة، Telegram file_id، رابط، أو - للحذف.`);
  }
  if (data.startsWith('adm:type:')) {
    const [, , idRaw, type] = data.split(':'); const product = await Merchant.findByPk(Number(idRaw)); if (!product) return;
    product.type = type;
    product.sharedLimit = type === 'shared' ? Math.max(2, Number(product.sharedLimit || 5)) : 1;
    product.deliveryMode = type === 'wait_code' ? 'wait_code' : 'instant';
    await product.save();
    await Code.update({ maxUses: product.sharedLimit }, { where: { merchantId: product.id, usedCount: 0, isUsed: false } });
    await answerCallback(query.id, 'تم التحديث.'); return showAdminProductEditor(query.message.chat.id, product.id);
  }
  if (data.startsWith('adm:toggle:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2])); if (!product) return;
    product.isActive = !product.isActive; await product.save(); await answerCallback(query.id, product.isActive ? 'تم النشر.' : 'تم الإخفاء.'); return showAdminProductEditor(query.message.chat.id, product.id);
  }
  if (data.startsWith('adm:delete:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2])); if (!product) return;
    await Code.destroy({ where: { merchantId: product.id } }); await product.destroy(); await answerCallback(query.id, 'تم الحذف.'); return showAdminProducts(query.message.chat.id, 0);
  }
  if (data.startsWith('adm:stockprod:')) {
    const productId = Number(data.split(':')[2]); await setState(user.id, { action: 'admin_add_stock', productId }); await answerCallback(query.id);
    return bot.sendMessage(user.id, 'أرسل المخزون كنص أو ملف TXT/CSV، كل حساب بسطر:\n\n<code>email|password|2FA\nemail|password\ncode</code>', { parse_mode: 'HTML' });
  }
}

async function showAdminProducts(chatId, page = 0) {
  const products = await Merchant.findAll({ order: [['id','ASC']] });
  const perPage = 8, pages = Math.max(1, Math.ceil(products.length/perPage)), safe = Math.max(0, Math.min(page,pages-1));
  const keyboard = products.slice(safe*perPage,safe*perPage+perPage).map(p => [{ text: `${p.isActive?'✅':'⛔'} ${p.nameAr} | ${moneyUsd(p.price)}`, callback_data: `adm:edit:${p.id}` }]);
  keyboard.push([{ text: '➕ إضافة منتج', callback_data: 'adm:add_product' }]);
  const nav=[]; if(safe>0)nav.push({text:'⬅️',callback_data:`adm:products:${safe-1}`}); nav.push({text:`${safe+1}/${pages}`,callback_data:'noop'}); if(safe<pages-1)nav.push({text:'➡️',callback_data:`adm:products:${safe+1}`}); keyboard.push(nav);
  await bot.sendMessage(chatId, '📦 <b>المنتجات</b>\nكل منتج ظاهر هنا، وماكو خانات رقمية إضافية.', { parse_mode:'HTML', reply_markup:{inline_keyboard:keyboard} });
}

async function showAdminProductEditor(chatId, productId) {
  const p = await Merchant.findByPk(productId); if (!p) return;
  const d = parseDescription(p.description); const stock = await getProductStock(p.id);
  const text = [
    `📝 <b>تعديل المنتج #${p.id}</b>`, '',
    `الاسم عربي: <b>${escapeHtml(p.nameAr)}</b>`, `الاسم إنجليزي: <b>${escapeHtml(p.nameEn)}</b>`,
    `السعر: <b>${moneyUsd(p.price)}</b>`, `القسم: <b>${escapeHtml(p.category)}</b>`,
    `النوع: <b>${escapeHtml(p.type)}</b>`, `مرات الحساب المشترك: <b>${p.sharedLimit}</b>`,
    `المخزون: <b>${stock}</b>`, `الحالة: <b>${p.isActive?'منشور للجميع':'مخفي'}</b>`,
    `الوصف عربي: ${escapeHtml(d.ar||'—')}`, `الوصف إنجليزي: ${escapeHtml(d.en||'—')}`,
    `الضمان عربي: ${escapeHtml(d.warrantyAr||'—')}`, `الصورة: ${p.image?'موجودة':'بدون'}`
  ].join('\n');
  const kb = [
    [{text:'اسم عربي',callback_data:`adm:field:${p.id}:nameAr`},{text:'اسم English',callback_data:`adm:field:${p.id}:nameEn`}],
    [{text:'السعر',callback_data:`adm:field:${p.id}:price`},{text:'القسم',callback_data:`adm:field:${p.id}:category`}],
    [{text:'الوصف عربي',callback_data:`adm:field:${p.id}:descriptionAr`},{text:'الوصف English',callback_data:`adm:field:${p.id}:descriptionEn`}],
    [{text:'الضمان عربي',callback_data:`adm:field:${p.id}:warrantyAr`},{text:'الضمان English',callback_data:`adm:field:${p.id}:warrantyEn`}],
    [{text:'الصورة',callback_data:`adm:field:${p.id}:image`},{text:'عدد المشتركين',callback_data:`adm:field:${p.id}:sharedLimit`}],
    [{text:'شخصي',callback_data:`adm:type:${p.id}:private`},{text:'مشترك',callback_data:`adm:type:${p.id}:shared`}],
    [{text:'كود',callback_data:`adm:type:${p.id}:code`},{text:'ينتظر كود',callback_data:`adm:type:${p.id}:wait_code`}],
    [{text:p.isActive?'⛔ إخفاء':'✅ نشر للجميع',callback_data:`adm:toggle:${p.id}`},{text:'📥 إضافة مخزون',callback_data:`adm:stockprod:${p.id}`}],
    [{text:'🗑 حذف نهائي',callback_data:`adm:delete:${p.id}`}]
  ];
  await bot.sendMessage(chatId, text, {parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
}

async function showStockProductList(chatId) {
  const products = await Merchant.findAll({ order:[['id','ASC']] });
  const kb=[]; for(const p of products){const stock=await getProductStock(p.id);kb.push([{text:`${p.nameAr} | 📦 ${stock}`,callback_data:`adm:stockprod:${p.id}`}]);}
  await bot.sendMessage(chatId,'اختَر المنتج لإضافة المخزون:',{reply_markup:{inline_keyboard:kb}});
}

bot.onText(/^\/code_(\d+)_(.+)$/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const result = await addWaitingCode(Number(match[1]), String(match[2]).trim());
    const user = await User.findByPk(result.order.userId); const lang=user?.lang||'ar';
    await bot.sendMessage(result.order.userId, `${t(lang,'delivered')} — <b>#${result.order.id}</b>\n${renderDelivery(result.delivery.payload,lang,result.delivery.sharedPosition)}`,{parse_mode:'HTML'});
    await bot.sendMessage(msg.chat.id,'✅ تم إرسال الكود.');
  } catch(e){await bot.sendMessage(msg.chat.id,`❌ ${e.message}`);}
});

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));

module.exports = { bot, notifyBinanceResult, sendDeliveryToUser };
