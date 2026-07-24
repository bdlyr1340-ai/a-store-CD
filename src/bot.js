const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('./config');
const {
  sequelize,
  Op,
  User,
  Merchant,
  Code,
  PurchaseOrder,
  BalanceTransaction,
  BinanceTransfer,
  getIqdRate,
  getSuperQiNumber,
  setSetting
} = require('./db');
const { t } = require('./i18n');
const {
  escapeHtml,
  moneyUsd,
  moneyIqd,
  parseDescription,
  parseInventoryText,
  renderDelivery,
  randomCaptcha
} = require('./utils');
const {
  getProductStock,
  listActiveProducts,
  createOrder,
  fulfillOrder,
  payFromWallet,
  addWaitingCode
} = require('./services/orders');
const binancePay = require('./payments/binancePay');
const { encryptPayload } = require('./cryptoStore');

const bot = new TelegramBot(config.token, { polling: false });
const captchaAnswers = new Map();
const memoryRate = new Map();

function isAdmin(id) {
  return config.admins.has(Number(id));
}

function parseState(user) {
  try { return user?.state ? JSON.parse(user.state) : null; }
  catch { return null; }
}

async function setState(userId, state) {
  await User.update({ state: state ? JSON.stringify(state) : null }, { where: { id: userId } });
}

async function clearState(userId) {
  await setState(userId, null);
}

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
      [{ text: '👤 إدارة مستخدم', callback_data: 'adm:user_lookup' }, { text: '💰 شحن مستخدم', callback_data: 'adm:user_credit' }],
      [{ text: '💳 دفعات SuperQi', callback_data: 'adm:proofs' }, { text: '🧾 الطلبات', callback_data: 'adm:orders' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'adm:settings' }, { text: '📊 الإحصائيات', callback_data: 'adm:stats' }]
    ]
  };
}

function rateAllowed(userId) {
  const now = Date.now();
  const recent = (memoryRate.get(userId) || []).filter(timestamp => now - timestamp < 10000);
  if (recent.length >= 12) return false;
  recent.push(now);
  memoryRate.set(userId, recent);
  return true;
}

async function answerCallback(id, text = '', alert = false) {
  try { await bot.answerCallbackQuery(id, { text, show_alert: alert }); }
  catch {}
}

async function sendCaptcha(chatId, userId, lang) {
  const captcha = randomCaptcha();
  captchaAnswers.set(userId, captcha.answer);
  const buttons = [];
  for (let index = 0; index < captcha.options.length; index += 2) {
    buttons.push(captcha.options.slice(index, index + 2).map(value => ({
      text: String(value),
      callback_data: `cap:${value}`
    })));
  }
  await bot.sendMessage(chatId, `${t(lang, 'verify')}\n\n<b>${captcha.question} = ?</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showMain(chatId, user) {
  await bot.sendMessage(chatId, t(user.lang, 'welcome'), { reply_markup: mainKeyboard(user.lang) });
}

function productCaption(product, stock, lang) {
  const descriptionData = parseDescription(product.description);
  const name = lang === 'en' ? (product.nameEn || product.nameAr) : (product.nameAr || product.nameEn);
  const description = lang === 'en'
    ? (descriptionData.en || descriptionData.ar || '')
    : (descriptionData.ar || descriptionData.en || '');
  const warranty = lang === 'en'
    ? (descriptionData.warrantyEn || descriptionData.warrantyAr || '—')
    : (descriptionData.warrantyAr || descriptionData.warrantyEn || '—');

  // Shared-account limits and owner notes are intentionally secret and admin-only.
  return [
    `<b>${escapeHtml(name)}</b>`,
    `💵 <b>${t(lang, 'price')}:</b> ${moneyUsd(product.price)}`,
    `📦 <b>${t(lang, 'stock')}:</b> ${stock}`,
    `📈 <b>${t(lang, 'sold')}:</b> ${Number(descriptionData.sold || 0)}`,
    `🛡 <b>${t(lang, 'warranty')}:</b> ${escapeHtml(warranty)}`,
    '',
    `❝ <b>${t(lang, 'description')}:</b>`,
    escapeHtml(description || '—')
  ].join('\n');
}

async function showProducts(chatId, user, page = 0) {
  const rows = await listActiveProducts();
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const slice = rows.slice(safePage * perPage, safePage * perPage + perPage);
  if (!slice.length) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));

  const keyboard = slice.map(({ product, stock }) => {
    const name = user.lang === 'en' ? (product.nameEn || product.nameAr) : product.nameAr;
    return [{
      text: `${name} | ${moneyUsd(product.price)} | 📦 ${stock}`,
      callback_data: `prod:${product.id}`
    }];
  });
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️', callback_data: `products:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop' });
  if (safePage < pages - 1) navigation.push({ text: '➡️', callback_data: `products:${safePage + 1}` });
  keyboard.push(navigation);
  return bot.sendMessage(chatId, t(user.lang, 'chooseProduct'), { reply_markup: { inline_keyboard: keyboard } });
}

async function showProduct(chatId, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !product.isActive) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));
  const stock = await getProductStock(product.id);
  const caption = productCaption(product, stock, user.lang);
  const markup = { inline_keyboard: [[{ text: t(user.lang, 'buy'), callback_data: `buy:${product.id}` }]] };
  if (product.image) {
    try {
      await bot.sendPhoto(chatId, product.image, { caption, parse_mode: 'HTML', reply_markup: markup });
      return;
    } catch (error) {
      console.error('Product image failed:', error.message);
    }
  }
  await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: markup });
}

async function notifyAdmins(text, options = {}) {
  for (const adminId of config.admins) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'HTML', ...options });
    } catch (error) {
      console.error('Admin notify:', error.message);
    }
  }
}

function adminSharedDetails(fulfillment) {
  const details = [];
  for (const delivery of fulfillment.deliveries || []) {
    if (delivery.sharedPosition) {
      details.push(`المخزون #${delivery.codeId}: الاستخدام ${delivery.sharedPosition.current}/${delivery.sharedPosition.max}`);
    }
  }
  return details.join('\n');
}

async function sendDeliveryToUser(userId, fulfillment) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'ar';
  const order = fulfillment.order;
  await bot.sendMessage(userId, `${t(lang, 'delivered')} — <b>#${order.id}</b>`, { parse_mode: 'HTML' });
  for (const delivery of fulfillment.deliveries || []) {
    // Do not reveal shared-use position or limits to customers.
    await bot.sendMessage(userId, renderDelivery(delivery.payload, lang), { parse_mode: 'HTML' });
  }
  if ((fulfillment.deliveries || []).some(delivery => delivery.waitingCode)) {
    await bot.sendMessage(userId, t(lang, 'waitingCode'));
    await notifyAdmins(`🔐 الطلب #${order.id} ينتظر كود.\nأرسل: <code>/code_${order.id}_123456</code>`);
  }
  const shared = adminSharedDetails(fulfillment);
  await notifyAdmins([
    `✅ تم تسليم الطلب <b>#${order.id}</b>`,
    `المستخدم: <code>${order.userId}</code>`,
    shared ? `\n🔒 تفاصيل المشاركة السرية:\n${shared}` : ''
  ].filter(Boolean).join('\n'));
}

function binanceFailureText(result, lang = 'ar') {
  const ar = lang !== 'en';
  const messages = {
    NOT_CONFIGURED: ar ? 'إعدادات Binance ناقصة. راجع الإدارة.' : 'Binance settings are incomplete.',
    INVALID_AMOUNT: ar ? 'المبلغ غير صحيح.' : 'Invalid amount.',
    INVALID_ORDER_ID: ar ? 'رقم الطلب غير صحيح.' : 'Invalid order ID.',
    DUPLICATE_TRANSACTION: ar ? 'هذه العملية مستخدمة مسبقاً.' : 'This transaction was already used.',
    NO_MATCH: ar ? 'ما حصلت عملية مطابقة بعد. تأكد من رقم الطلب وانتظر دقيقة ثم جرّب.' : 'No matching transaction was found yet.',
    AMOUNT_OR_RECEIVER_MISMATCH: ar ? 'العملية موجودة لكن المبلغ أو المستلم غير مطابق.' : 'The transaction exists, but amount or receiver does not match.',
    OUT_OF_STOCK: ar ? 'الدفع صحيح لكن المخزون غير كافي. راجع الدعم.' : 'Payment is valid, but stock is insufficient. Contact support.',
    BINANCE_API_PERMISSION: ar ? 'مفتاح Binance مرفوض. لازم يكون API عادي بصلاحية القراءة، وIP مسموح إذا مقيّد.' : 'Binance API key was rejected. It needs read permission and an allowed IP if restricted.'
  };
  if (result?.detail && messages[result.detail]) return messages[result.detail];
  return messages[result?.reason] || (ar ? `تعذر التحقق: ${result?.detail || result?.reason || 'خطأ'}` : `Verification failed: ${result?.detail || result?.reason || 'error'}`);
}

async function notifyBinanceResult(result) {
  if (!result || result.alreadyProcessed) return;
  if (result.topup) {
    const user = await User.findByPk(result.userId);
    const lang = user?.lang || 'ar';
    const text = lang === 'en'
      ? `✅ Wallet credited through Binance.\nAmount: <b>${moneyUsd(result.amount)}</b>\nNew balance: <b>${moneyUsd(result.newBalance)}</b>`
      : `✅ تم شحن محفظتك تلقائياً عبر Binance.\nالمبلغ: <b>${moneyUsd(result.amount)}</b>\nالرصيد الجديد: <b>${moneyUsd(result.newBalance)}</b>`;
    await bot.sendMessage(result.userId, text, { parse_mode: 'HTML' });
    await notifyAdmins(`✅ شحن Binance تلقائي\nالمستخدم: <code>${result.userId}</code>\nالمبلغ: <b>${moneyUsd(result.amount)}</b>\nرقم العملية: <code>${escapeHtml(result.transactionId || '')}</code>`);
    return;
  }
  if (result.fulfillment) await sendDeliveryToUser(result.fulfillment.order.userId, result.fulfillment);
}

bot.on('message', async msg => {
  try {
    if (!msg.from || !rateAllowed(msg.from.id)) return;
    const user = await getOrCreateUser(msg.from);
    if (user.blocked && !isAdmin(user.id)) {
      if (msg.text === '/start') await bot.sendMessage(msg.chat.id, '⛔ حسابك محظور من استخدام المتجر. راجع الدعم.');
      return;
    }

    if (msg.text === '/start') {
      if (!user.verified) return sendCaptcha(msg.chat.id, user.id, user.lang);
      return showMain(msg.chat.id, user);
    }
    if (msg.text === '/admin') {
      if (!isAdmin(user.id)) return bot.sendMessage(msg.chat.id, t(user.lang, 'adminOnly'));
      return bot.sendMessage(msg.chat.id, '👑 <b>لوحة إدارة المالك</b>\nهذه اللوحة لا تظهر للمستخدمين.', {
        parse_mode: 'HTML',
        reply_markup: adminMenu()
      });
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
      if (binancePay.configured()) inline.push([{ text: '🟡 شحن Binance ID', callback_data: 'topup:binance' }]);
      inline.push([{ text: '🔵 شحن SuperQi', callback_data: 'topup:superqi' }]);
      return bot.sendMessage(msg.chat.id, `${t(user.lang, 'walletBalance')}: <b>${moneyUsd(user.balance)}</b>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inline }
      });
    }
    if (msg.text === t('ar', 'orders') || msg.text === t('en', 'orders')) return showOrders(msg.chat.id, user);
    if (msg.text === t('ar', 'support') || msg.text === t('en', 'support')) {
      const support = config.supportUsername ? `@${config.supportUsername}` : 'غير محدد';
      return bot.sendMessage(msg.chat.id, `${t(user.lang, 'supportText')} ${support}`);
    }
    if (msg.text === t('ar', 'language') || msg.text === t('en', 'language')) {
      user.lang = user.lang === 'ar' ? 'en' : 'ar';
      await user.save();
      return showMain(msg.chat.id, user);
    }
  } catch (error) {
    console.error('Message handler error:', error);
    if (msg.chat?.id) await bot.sendMessage(msg.chat.id, '❌ صار خطأ داخلي. جرّب مرة ثانية.').catch(() => {});
  }
});

bot.on('callback_query', async query => {
  if (!query.from || !rateAllowed(query.from.id)) return;
  const user = await getOrCreateUser(query.from);
  const data = String(query.data || '');

  if (user.blocked && !isAdmin(user.id)) return answerCallback(query.id, 'حسابك محظور.', true);
  if (data === 'noop') return answerCallback(query.id);

  if (data.startsWith('cap:')) {
    const chosen = Number(data.split(':')[1]);
    if (chosen !== captchaAnswers.get(user.id)) {
      await answerCallback(query.id, t(user.lang, 'wrong'), true);
      return sendCaptcha(query.message.chat.id, user.id, user.lang);
    }
    captchaAnswers.delete(user.id);
    user.verified = true;
    await user.save();
    await answerCallback(query.id, t(user.lang, 'verified'));
    try {
      await bot.editMessageText(t(user.lang, 'verified'), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    } catch {}
    return showMain(query.message.chat.id, user);
  }

  if (!user.verified) return answerCallback(query.id, 'Verify first', true);

  try {
    if (data.startsWith('products:')) {
      await answerCallback(query.id);
      return showProducts(query.message.chat.id, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('prod:')) {
      await answerCallback(query.id);
      return showProduct(query.message.chat.id, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('buy:')) return handleBuy(query, user, Number(data.split(':')[1]));
    if (data.startsWith('qty:')) return handleQuantity(query, user, data);
    if (data.startsWith('pay:')) return handlePayment(query, user, data);
    if (data.startsWith('binverify:')) return beginBinanceVerification(query, user, Number(data.split(':')[1]));
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
  const first = [];
  const second = [];
  for (let quantity = 1; quantity <= max; quantity += 1) {
    (quantity <= 5 ? first : second).push({ text: String(quantity), callback_data: `qty:${merchantId}:${quantity}` });
  }
  const rows = [first];
  if (second.length) rows.push(second);
  await answerCallback(query.id);
  return bot.sendMessage(query.message.chat.id, `${t(user.lang, 'quantity')} 1-${max}`, {
    reply_markup: { inline_keyboard: rows }
  });
}

async function handleQuantity(query, user, data) {
  const [, merchantIdRaw, quantityRaw] = data.split(':');
  const merchantId = Number(merchantIdRaw);
  const quantity = Number(quantityRaw);
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || stock < quantity) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  await setState(user.id, { action: 'checkout', merchantId, quantity });
  const total = Number(product.price) * quantity;
  const buttons = [[{ text: t(user.lang, 'payWallet'), callback_data: 'pay:wallet' }]];
  if (binancePay.configured()) buttons.push([{ text: '🟡 Binance ID', callback_data: 'pay:binance' }]);
  buttons.push([{ text: t(user.lang, 'paySuperQi'), callback_data: 'pay:superqi' }]);
  await answerCallback(query.id);
  return bot.sendMessage(query.message.chat.id, `${t(user.lang, 'payment')}\n💰 <b>${moneyUsd(total)}</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handlePayment(query, user, data) {
  const method = data.split(':')[1];
  const freshUser = await User.findByPk(user.id);
  const state = parseState(freshUser);
  if (!state || state.action !== 'checkout') return answerCallback(query.id, t(user.lang, 'cancelled'), true);

  const order = await createOrder({
    userId: user.id,
    merchantId: state.merchantId,
    quantity: state.quantity,
    paymentMethod: method
  });
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
      return bot.sendMessage(user.id, binanceFailureText(created, user.lang));
    }
    return sendBinanceInstructions(user, created.transfer);
  }

  const rate = await getIqdRate();
  const number = await getSuperQiNumber();
  const iqd = Number(order.totalAmount) * rate;
  await setState(user.id, { action: 'superqi_proof', orderId: order.id });
  return bot.sendMessage(user.id, [
    '🔵 <b>دفع SuperQi</b>',
    '',
    `المبلغ: <b>${moneyUsd(order.totalAmount)}</b>`,
    `بالدينار: <b>${moneyIqd(iqd)}</b>`,
    `حوّل إلى: <code>${escapeHtml(number)}</code>`,
    '',
    t(user.lang, 'proofPrompt')
  ].join('\n'), { parse_mode: 'HTML' });
}

async function sendBinanceInstructions(user, transfer) {
  const keyboard = [[{ text: '🧾 تحقق برقم الطلب', callback_data: `binverify:${transfer.id}` }]];
  return bot.sendMessage(user.id, binancePay.instructions(transfer, user.lang), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function beginBinanceVerification(query, user, transferId) {
  const transfer = await BinanceTransfer.findByPk(transferId);
  if (!transfer || String(transfer.userId) !== String(user.id)) {
    return answerCallback(query.id, 'العملية غير موجودة.', true);
  }
  if (transfer.status === 'VERIFIED') return answerCallback(query.id, 'تم التحقق سابقاً.', true);
  await setState(user.id, { action: 'binance_verify', transferId });
  await answerCallback(query.id);
  const prompt = user.lang === 'en'
    ? 'Send the Binance Order ID now. You can copy it from the payment details.'
    : 'أرسل الآن رقم طلب Binance (Order ID) الموجود داخل تفاصيل التحويل.';
  return bot.sendMessage(user.id, prompt);
}

async function handleTopupStart(query, user, method) {
  if (method === 'binance' && !binancePay.configured()) {
    return answerCallback(query.id, 'Binance غير مهيأ.', true);
  }
  await setState(user.id, { action: 'wallet_topup_amount', method });
  await answerCallback(query.id);
  const minimum = method === 'binance' ? config.binance.minAmount : 1;
  return bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار (الحد الأدنى $${minimum}):`);
}

async function handleStateMessage(msg, user, state) {
  if (state.action === 'wallet_topup_amount') {
    const amount = Number(String(msg.text || '').trim());
    const minimumAmount = state.method === 'binance' ? config.binance.minAmount : 1;
    if (!Number.isFinite(amount) || amount < minimumAmount || amount > 100000) {
      await bot.sendMessage(user.id, '❌ المبلغ غير صحيح.');
      return true;
    }

    if (state.method === 'binance') {
      const created = await binancePay.createForTopup(user.id, amount);
      if (!created.success) {
        await clearState(user.id);
        await bot.sendMessage(user.id, binanceFailureText(created, user.lang));
        return true;
      }
      await clearState(user.id);
      await sendBinanceInstructions(user, created.transfer);
      return true;
    }

    const rate = await getIqdRate();
    const number = await getSuperQiNumber();
    const transaction = await BalanceTransaction.create({
      userId: user.id,
      amount,
      type: 'deposit',
      txid: `SUPERQI-${Date.now()}-${user.id}`,
      caption: 'SuperQi manual wallet topup',
      status: 'awaiting_proof',
      lastReminderAt: new Date()
    });
    await setState(user.id, { action: 'superqi_topup_proof', transactionId: transaction.id });
    await bot.sendMessage(user.id, [
      '🔵 <b>شحن المحفظة عبر SuperQi</b>',
      '',
      `المبلغ بالدولار: <b>${moneyUsd(amount)}</b>`,
      `سعر الصرف: <b>${moneyIqd(rate)} لكل 1$</b>`,
      `المبلغ المطلوب: <b>${moneyIqd(amount * rate)}</b>`,
      '',
      'حوّل إلى الرقم:',
      `<code>${escapeHtml(number)}</code>`,
      '',
      t(user.lang, 'proofPrompt')
    ].join('\n'), { parse_mode: 'HTML' });
    return true;
  }

  if (state.action === 'binance_verify') {
    const submittedOrderId = String(msg.text || '').trim();
    await bot.sendMessage(user.id, '🔄 جاري التحقق من Binance...');
    const result = await binancePay.verify(state.transferId, submittedOrderId);
    if (!result.success) {
      if (result.paymentConfirmed) {
        await clearState(user.id);
        const text = user.lang === 'en'
          ? '✅ Binance payment was confirmed, but automatic delivery is waiting for stock. Support has been notified; do not pay again.'
          : '✅ تم تأكيد دفع Binance، لكن التسليم التلقائي ينتظر توفر المخزون. تم إشعار الإدارة، لا تدفع مرة ثانية.';
        await bot.sendMessage(user.id, text);
        await notifyAdmins(`⚠️ دفع Binance مؤكد والتسليم متوقف\nالمستخدم: <code>${user.id}</code>\nالتحويل: <code>${state.transferId}</code>\nالسبب: ${escapeHtml(result.reason || 'خطأ بالتسليم')}`);
        return true;
      }
      await bot.sendMessage(user.id, `❌ ${binanceFailureText(result, user.lang)}\n\nأرسل رقم الطلب الصحيح للمحاولة مرة ثانية، أو /cancel للإلغاء.`);
      return true;
    }
    await clearState(user.id);
    if (result.alreadyProcessed) {
      await bot.sendMessage(user.id, '✅ هذه العملية متحققة ومضافة سابقاً.');
      return true;
    }
    await notifyBinanceResult(result);
    return true;
  }

  if (state.action === 'superqi_topup_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const transaction = await BalanceTransaction.findByPk(state.transactionId);
    if (!transaction || String(transaction.userId) !== String(user.id) || transaction.status !== 'awaiting_proof') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await transaction.update({ imageFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const rate = await getIqdRate();
    for (const adminId of config.admins) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: [
            '🔵 <b>إيصال شحن SuperQi</b>',
            `العملية: <code>#${transaction.id}</code>`,
            `المستخدم: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المبلغ: ${moneyUsd(transaction.amount)} = ${moneyIqd(Number(transaction.amount) * rate)}`
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وشحن', callback_data: `sqtop:approve:${transaction.id}` },
            { text: '❌ رفض', callback_data: `sqtop:reject:${transaction.id}` }
          ]] }
        });
      } catch (error) {
        console.error('SuperQi topup admin:', error.message);
      }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (state.action === 'superqi_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id) || order.status !== 'pending_payment') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await order.update({ proofFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const product = await Merchant.findByPk(order.merchantId);
    const rate = await getIqdRate();
    for (const adminId of config.admins) {
      try {
        const sent = await bot.sendPhoto(adminId, fileId, {
          caption: [
            '🔵 <b>إيصال SuperQi</b>',
            `الطلب: <code>#${order.id}</code>`,
            `الزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المنتج: ${escapeHtml(product?.nameAr || '')}`,
            `الكمية: ${order.quantity}`,
            `المبلغ: ${moneyUsd(order.totalAmount)} = ${moneyIqd(Number(order.totalAmount) * rate)}`
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وتسليم', callback_data: `sq:approve:${order.id}` },
            { text: '❌ رفض', callback_data: `sq:reject:${order.id}` }
          ]] }
        });
        if (!order.adminMessageId) await order.update({ adminMessageId: sent.message_id });
      } catch (error) {
        console.error('SuperQi admin photo:', error.message);
      }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (!isAdmin(user.id)) return false;

  if (state.action === 'admin_edit_product') {
    const product = await Merchant.findByPk(state.productId);
    if (!product) {
      await clearState(user.id);
      return true;
    }
    const field = state.field;
    let value = msg.text?.trim();
    if (field === 'image' && msg.photo?.length) value = msg.photo[msg.photo.length - 1].file_id;
    if (!value) return true;

    const description = parseDescription(product.description);
    if (field === 'nameAr') product.nameAr = value;
    else if (field === 'nameEn') product.nameEn = value;
    else if (field === 'price') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        await bot.sendMessage(user.id, '❌ سعر غير صحيح.');
        return true;
      }
      product.price = number;
    } else if (field === 'category') product.category = value;
    else if (field === 'descriptionAr') description.ar = value === '-' ? '' : value;
    else if (field === 'descriptionEn') description.en = value === '-' ? '' : value;
    else if (field === 'warrantyAr') description.warrantyAr = value === '-' ? '' : value;
    else if (field === 'warrantyEn') description.warrantyEn = value === '-' ? '' : value;
    else if (field === 'image') product.image = value === '-' ? null : value;
    else if (field === 'ownerNote') product.ownerNote = value === '-' ? null : value;
    else if (field === 'sharedLimit') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 100) {
        await bot.sendMessage(user.id, '❌ العدد لازم من 1 إلى 100.');
        return true;
      }
      product.sharedLimit = number;
      if (product.type === 'shared') {
        await Code.update({ maxUses: number }, {
          where: { merchantId: product.id, usedCount: 0, isUsed: false }
        });
      }
    }

    // Force JSONB dirty tracking so Arabic/English descriptions always persist.
    product.set('description', { ...description });
    product.changed('description', true);
    await product.save();
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم الحفظ.');
    await showAdminProductEditor(user.id, product.id);
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
    if (!items.length) {
      await bot.sendMessage(user.id, '❌ ما حصلت بيانات صحيحة.');
      return true;
    }
    const product = await Merchant.findByPk(state.productId);
    if (!product) {
      await clearState(user.id);
      return true;
    }
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
        await Code.create({
          value: encryptPayload(item),
          extra: null,
          merchantId: product.id,
          maxUses,
          usedCount: 0,
          isUsed: false,
          buyers: []
        }, { transaction });
      }
      await transaction.commit();
      await clearState(user.id);
      // This secret usage information is sent only to the owner/admin.
      await bot.sendMessage(user.id, `✅ انضاف ${items.length} حساب/كود.\nالاستخدام لكل حساب: ${maxUses} (معلومة سرية لا تظهر للزبائن).`);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return true;
  }

  if (state.action === 'admin_setting') {
    const value = msg.text?.trim();
    if (!value) return true;
    if (state.key === 'iqd_rate') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 1) {
        await bot.sendMessage(user.id, '❌ رقم غير صحيح.');
        return true;
      }
    }
    await setSetting(state.key, value);
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم تحديث الإعداد.');
    return true;
  }

  if (state.action === 'admin_user_lookup') {
    const targetId = Number(String(msg.text || '').trim());
    if (!Number.isFinite(targetId)) {
      await bot.sendMessage(user.id, '❌ أرسل آيدي رقمي صحيح.');
      return true;
    }
    await clearState(user.id);
    await showAdminUserCard(user.id, targetId);
    return true;
  }

  if (state.action === 'admin_user_credit_id') {
    const targetId = Number(String(msg.text || '').trim());
    if (!Number.isFinite(targetId)) {
      await bot.sendMessage(user.id, '❌ أرسل آيدي رقمي صحيح.');
      return true;
    }
    const target = await User.findByPk(targetId);
    if (!target) {
      await bot.sendMessage(user.id, '❌ المستخدم ما مستخدم البوت بعد.');
      return true;
    }
    await setState(user.id, { action: 'admin_user_credit_amount', targetId });
    await bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
    return true;
  }

  if (state.action === 'admin_user_credit_amount') {
    const amount = Number(String(msg.text || '').trim());
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      await bot.sendMessage(user.id, '❌ مبلغ غير صحيح.');
      return true;
    }
    const result = await adminCreditUser(state.targetId, amount, user.id);
    await clearState(user.id);
    await bot.sendMessage(user.id, `✅ تم شحن ${moneyUsd(amount)} للمستخدم <code>${state.targetId}</code>.\nالرصيد الجديد: <b>${moneyUsd(result.balance)}</b>`, { parse_mode: 'HTML' });
    await bot.sendMessage(state.targetId, `✅ تم شحن محفظتك من الإدارة بمبلغ <b>${moneyUsd(amount)}</b>.\nرصيدك الجديد: <b>${moneyUsd(result.balance)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
    return true;
  }

  return false;
}

async function adminCreditUser(targetId, amount, adminId) {
  const transaction = await sequelize.transaction();
  try {
    const target = await User.findByPk(targetId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!target) throw new Error('USER_NOT_FOUND');
    target.balance = Number(target.balance || 0) + Number(amount);
    await target.save({ transaction });
    await BalanceTransaction.create({
      userId: target.id,
      amount,
      type: 'admin_credit',
      txid: `ADMIN-${adminId}-${Date.now()}`,
      caption: `Manual credit by admin ${adminId}`,
      status: 'completed',
      lastReminderAt: new Date()
    }, { transaction });
    await transaction.commit();
    return { balance: Number(target.balance) };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function handleSuperQiTopupAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, transactionIdRaw] = data.split(':');
  const transactionId = Number(transactionIdRaw);
  const dbTransaction = await sequelize.transaction();
  try {
    const ledger = await BalanceTransaction.findByPk(transactionId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    if (!ledger || ledger.status !== 'proof_pending') {
      await dbTransaction.rollback();
      return answerCallback(query.id, 'تمت معالجة العملية سابقاً.', true);
    }
    if (action === 'reject') {
      ledger.status = 'rejected';
      await ledger.save({ transaction: dbTransaction });
      await dbTransaction.commit();
      await answerCallback(query.id, 'تم الرفض.');
      await bot.sendMessage(ledger.userId, `❌ تم رفض إيصال شحن SuperQi #${ledger.id}.`);
      return;
    }
    const targetUser = await User.findByPk(ledger.userId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    targetUser.balance = Number(targetUser.balance || 0) + Number(ledger.amount);
    await targetUser.save({ transaction: dbTransaction });
    ledger.status = 'completed';
    await ledger.save({ transaction: dbTransaction });
    await dbTransaction.commit();
    await answerCallback(query.id, 'تم الشحن.');
    await bot.sendMessage(targetUser.id, `✅ تم شحن محفظتك عبر SuperQi.\nالمبلغ: <b>${moneyUsd(ledger.amount)}</b>\nالرصيد الجديد: <b>${moneyUsd(targetUser.balance)}</b>`, { parse_mode: 'HTML' });
  } catch (error) {
    await dbTransaction.rollback();
    throw error;
  }
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
    return;
  }
  try {
    const fulfillment = await fulfillOrder(order.id, { paymentRef: `superqi:${order.id}` });
    await answerCallback(query.id, 'تمت الموافقة والتسليم.');
    await sendDeliveryToUser(order.userId, fulfillment);
  } catch (error) {
    await answerCallback(query.id, error.message === 'OUT_OF_STOCK' ? 'المخزون غير كافي.' : error.message, true);
  }
}

async function showOrders(chatId, user) {
  const orders = await PurchaseOrder.findAll({
    where: { userId: user.id },
    order: [['id', 'DESC']],
    limit: 15,
    include: [Merchant]
  });
  if (!orders.length) return bot.sendMessage(chatId, t(user.lang, 'noOrders'));
  const keyboard = orders.map(order => [{
    text: `#${order.id} | ${user.lang === 'en' ? (order.Merchant?.nameEn || order.Merchant?.nameAr) : (order.Merchant?.nameAr || '')} | ${order.status}`,
    callback_data: `order:${order.id}`
  }]);
  return bot.sendMessage(chatId, t(user.lang, 'orders'), { reply_markup: { inline_keyboard: keyboard } });
}

async function showOrder(chatId, user, orderId, callbackId = null) {
  if (callbackId) await answerCallback(callbackId);
  const order = await PurchaseOrder.findByPk(orderId, { include: [Merchant] });
  if (!order || (String(order.userId) !== String(user.id) && !isAdmin(user.id))) return;
  const name = user.lang === 'en' ? (order.Merchant?.nameEn || order.Merchant?.nameAr) : order.Merchant?.nameAr;
  const text = [
    `🧾 <b>الطلب #${order.id}</b>`,
    `المنتج: ${escapeHtml(name || '')}`,
    `الكمية: ${order.quantity}`,
    `المبلغ: ${moneyUsd(order.totalAmount)}`,
    `الدفع: ${escapeHtml(order.paymentMethod)}`,
    `الحالة: ${escapeHtml(order.status)}`
  ].join('\n');
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function handleAdminCallback(query, user, data) {
  if (data === 'adm:stock') {
    await answerCallback(query.id);
    return showStockProductList(query.message.chat.id);
  }
  if (data === 'adm:user_lookup') {
    await setState(user.id, { action: 'admin_user_lookup' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, 'أرسل آيدي المستخدم الرقمي لعرض حسابه:');
  }
  if (data === 'adm:user_credit') {
    await setState(user.id, { action: 'admin_user_credit_id' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, 'أرسل آيدي المستخدم الرقمي الذي تريد شحنه:');
  }
  if (data.startsWith('adm:usercard:')) {
    await answerCallback(query.id);
    return showAdminUserCard(query.message.chat.id, Number(data.split(':')[2]));
  }
  if (data.startsWith('adm:userblock:')) {
    const targetId = Number(data.split(':')[2]);
    const target = await User.findByPk(targetId);
    if (!target) return answerCallback(query.id, 'المستخدم غير موجود.', true);
    if (isAdmin(target.id)) return answerCallback(query.id, 'لا يمكن حظر المالك/الإدارة.', true);
    target.blocked = !target.blocked;
    await target.save();
    await answerCallback(query.id, target.blocked ? 'تم الحظر.' : 'تم فك الحظر.');
    await bot.sendMessage(target.id, target.blocked ? '⛔ تم حظر حسابك من المتجر.' : '✅ تم فك الحظر عن حسابك.').catch(() => {});
    return showAdminUserCard(query.message.chat.id, targetId);
  }
  if (data.startsWith('adm:usercredit:')) {
    const targetId = Number(data.split(':')[2]);
    await setState(user.id, { action: 'admin_user_credit_amount', targetId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
  }
  if (data === 'adm:proofs') {
    await answerCallback(query.id);
    const rows = await PurchaseOrder.findAll({
      where: { status: 'proof_pending' },
      order: [['id', 'DESC']],
      limit: 30,
      include: [Merchant]
    });
    return bot.sendMessage(query.message.chat.id, rows.length
      ? rows.map(order => `#${order.id} | ${order.Merchant?.nameAr || ''} | ${moneyUsd(order.totalAmount)}`).join('\n')
      : 'ماكو دفعات معلقة.');
  }
  if (data === 'adm:orders') {
    await answerCallback(query.id);
    const rows = await PurchaseOrder.findAll({ order: [['id', 'DESC']], limit: 30, include: [Merchant] });
    return bot.sendMessage(query.message.chat.id, rows.length
      ? rows.map(order => `#${order.id} | ${order.Merchant?.nameAr || ''} | ${order.status} | ${moneyUsd(order.totalAmount)}`).join('\n')
      : 'ماكو طلبات.');
  }
  if (data === 'adm:stats') {
    await answerCallback(query.id);
    const [users, blocked, products, orders, verifiedBinance] = await Promise.all([
      User.count(),
      User.count({ where: { blocked: true } }),
      Merchant.count(),
      PurchaseOrder.count(),
      BinanceTransfer.count({ where: { status: 'VERIFIED' } })
    ]);
    const stockRows = await listActiveProducts();
    const stock = stockRows.reduce((sum, row) => sum + row.stock, 0);
    return bot.sendMessage(query.message.chat.id, [
      `📊 المستخدمون: ${users}`,
      `⛔ المحظورون: ${blocked}`,
      `📦 المنتجات: ${products}`,
      `🧾 الطلبات: ${orders}`,
      `🟡 دفعات Binance المؤكدة: ${verifiedBinance}`,
      `🔐 المخزون المتاح: ${stock}`
    ].join('\n'));
  }
  if (data === 'adm:settings') {
    await answerCallback(query.id);
    const rate = await getIqdRate();
    const number = await getSuperQiNumber();
    return bot.sendMessage(query.message.chat.id, [
      '⚙️ <b>الإعدادات</b>',
      '',
      `سعر الدولار: ${moneyIqd(rate)}`,
      `رقم SuperQi: <code>${escapeHtml(number)}</code>`,
      `Binance ID: <code>${escapeHtml(config.binance.payId || 'غير مضاف')}</code>`,
      `Binance API: <b>${binancePay.configured() ? 'جاهز' : 'ناقص'}</b>`
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '💱 تغيير سعر الدولار', callback_data: 'adm:set:iqd_rate' },
        { text: '🔵 تغيير رقم SuperQi', callback_data: 'adm:set:superqi_number' }
      ]] }
    });
  }
  if (data.startsWith('adm:set:')) {
    const key = data.split(':')[2];
    await setState(user.id, { action: 'admin_setting', key });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, key === 'iqd_rate' ? 'أرسل سعر 1 دولار بالدينار:' : 'أرسل رقم SuperQi الجديد:');
  }
  if (data.startsWith('adm:products:')) {
    await answerCallback(query.id);
    return showAdminProducts(query.message.chat.id, Number(data.split(':')[2]));
  }
  if (data === 'adm:add_product') {
    const product = await Merchant.create({
      nameAr: 'منتج جديد',
      nameEn: 'New product',
      price: 1,
      category: 'عام',
      type: 'private',
      description: { ar: '', en: '', warrantyAr: '', warrantyEn: '', sold: 0 },
      isActive: true,
      sharedLimit: 1,
      deliveryMode: 'instant',
      ownerNote: ''
    });
    await answerCallback(query.id);
    return showAdminProductEditor(query.message.chat.id, product.id);
  }
  if (data.startsWith('adm:edit:')) {
    await answerCallback(query.id);
    return showAdminProductEditor(query.message.chat.id, Number(data.split(':')[2]));
  }
  if (data.startsWith('adm:field:')) {
    const [, , idRaw, field] = data.split(':');
    await setState(user.id, { action: 'admin_edit_product', productId: Number(idRaw), field });
    await answerCallback(query.id);
    const secret = field === 'ownerNote' ? '\n🔒 هذا الحقل يظهر إلك فقط.' : '';
    return bot.sendMessage(user.id, `أرسل القيمة الجديدة للحقل: ${field}${secret}\nللصورة أرسل صورة مباشرة، Telegram file_id، رابط، أو - للحذف.`);
  }
  if (data.startsWith('adm:type:')) {
    const [, , idRaw, type] = data.split(':');
    const product = await Merchant.findByPk(Number(idRaw));
    if (!product) return;
    product.type = type;
    product.sharedLimit = type === 'shared' ? Math.max(2, Number(product.sharedLimit || 5)) : 1;
    product.deliveryMode = type === 'wait_code' ? 'wait_code' : 'instant';
    await product.save();
    await Code.update({ maxUses: product.sharedLimit }, {
      where: { merchantId: product.id, usedCount: 0, isUsed: false }
    });
    await answerCallback(query.id, 'تم التحديث.');
    return showAdminProductEditor(query.message.chat.id, product.id);
  }
  if (data.startsWith('adm:toggle:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product) return;
    product.isActive = !product.isActive;
    await product.save();
    await answerCallback(query.id, product.isActive ? 'تم النشر.' : 'تم الإخفاء.');
    return showAdminProductEditor(query.message.chat.id, product.id);
  }
  if (data.startsWith('adm:delete:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product) return;
    await Code.destroy({ where: { merchantId: product.id } });
    await product.destroy();
    await answerCallback(query.id, 'تم الحذف.');
    return showAdminProducts(query.message.chat.id, 0);
  }
  if (data.startsWith('adm:stockprod:')) {
    const productId = Number(data.split(':')[2]);
    await setState(user.id, { action: 'admin_add_stock', productId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, 'أرسل المخزون كنص أو ملف TXT/CSV، كل حساب بسطر:\n\n<code>email|password|2FA\nemail|password\ncode</code>', { parse_mode: 'HTML' });
  }
}

async function showAdminUserCard(chatId, targetId) {
  const target = await User.findByPk(targetId);
  if (!target) return bot.sendMessage(chatId, '❌ المستخدم ما فتح البوت بعد.');
  const orders = await PurchaseOrder.count({ where: { userId: target.id } });
  const text = [
    '👤 <b>إدارة المستخدم</b>',
    '',
    `الآيدي: <code>${target.id}</code>`,
    `الاسم: ${escapeHtml(target.firstName || '—')}`,
    `المعرف: ${target.username ? `@${escapeHtml(target.username)}` : '—'}`,
    `الرصيد: <b>${moneyUsd(target.balance)}</b>`,
    `الطلبات: <b>${orders}</b>`,
    `التحقق: <b>${target.verified ? 'نعم' : 'لا'}</b>`,
    `الحظر: <b>${target.blocked ? 'محظور' : 'غير محظور'}</b>`
  ].join('\n');
  const keyboard = [
    [{ text: '💰 شحن الرصيد', callback_data: `adm:usercredit:${target.id}` }],
    [{ text: target.blocked ? '✅ فك الحظر' : '⛔ حظر المستخدم', callback_data: `adm:userblock:${target.id}` }],
    [{ text: '🔄 تحديث', callback_data: `adm:usercard:${target.id}` }]
  ];
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showAdminProducts(chatId, page = 0) {
  const products = await Merchant.findAll({ order: [['id', 'ASC']] });
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(products.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const keyboard = products
    .slice(safePage * perPage, safePage * perPage + perPage)
    .map(product => [{
      text: `${product.isActive ? '✅' : '⛔'} ${product.nameAr} | ${moneyUsd(product.price)}`,
      callback_data: `adm:edit:${product.id}`
    }]);
  keyboard.push([{ text: '➕ إضافة منتج', callback_data: 'adm:add_product' }]);
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️', callback_data: `adm:products:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop' });
  if (safePage < pages - 1) navigation.push({ text: '➡️', callback_data: `adm:products:${safePage + 1}` });
  keyboard.push(navigation);
  await bot.sendMessage(chatId, '📦 <b>المنتجات</b>\nكل الحقول الإدارية سرية ولا تظهر للزبائن.', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showAdminProductEditor(chatId, productId) {
  const product = await Merchant.findByPk(productId);
  if (!product) return;
  const description = parseDescription(product.description);
  const stock = await getProductStock(product.id);
  const text = [
    `📝 <b>تعديل المنتج #${product.id}</b>`,
    '',
    `الاسم عربي: <b>${escapeHtml(product.nameAr)}</b>`,
    `الاسم إنجليزي: <b>${escapeHtml(product.nameEn)}</b>`,
    `السعر: <b>${moneyUsd(product.price)}</b>`,
    `القسم: <b>${escapeHtml(product.category)}</b>`,
    `النوع: <b>${escapeHtml(product.type)}</b>`,
    `المخزون: <b>${stock}</b>`,
    `الحالة: <b>${product.isActive ? 'منشور للجميع' : 'مخفي'}</b>`,
    '',
    `الوصف عربي: ${escapeHtml(description.ar || '—')}`,
    `الوصف إنجليزي: ${escapeHtml(description.en || '—')}`,
    `الضمان عربي: ${escapeHtml(description.warrantyAr || '—')}`,
    `الضمان إنجليزي: ${escapeHtml(description.warrantyEn || '—')}`,
    `الصورة: ${product.image ? 'موجودة' : 'بدون'}`,
    '',
    '🔒 <b>حقول سرية للمالك فقط:</b>',
    `المالك/المصدر: ${escapeHtml(product.ownerNote || '—')}`,
    `مرات بيع الحساب المشترك: <b>${product.sharedLimit}</b>`
  ].join('\n');
  const keyboard = [
    [{ text: 'اسم عربي', callback_data: `adm:field:${product.id}:nameAr` }, { text: 'اسم English', callback_data: `adm:field:${product.id}:nameEn` }],
    [{ text: 'السعر', callback_data: `adm:field:${product.id}:price` }, { text: 'القسم', callback_data: `adm:field:${product.id}:category` }],
    [{ text: 'الوصف عربي', callback_data: `adm:field:${product.id}:descriptionAr` }, { text: 'الوصف English', callback_data: `adm:field:${product.id}:descriptionEn` }],
    [{ text: 'الضمان عربي', callback_data: `adm:field:${product.id}:warrantyAr` }, { text: 'الضمان English', callback_data: `adm:field:${product.id}:warrantyEn` }],
    [{ text: 'الصورة', callback_data: `adm:field:${product.id}:image` }, { text: '🔒 المالك/المصدر', callback_data: `adm:field:${product.id}:ownerNote` }],
    [{ text: '🔒 عدد المشتركين', callback_data: `adm:field:${product.id}:sharedLimit` }],
    [{ text: 'شخصي', callback_data: `adm:type:${product.id}:private` }, { text: 'مشترك', callback_data: `adm:type:${product.id}:shared` }],
    [{ text: 'كود', callback_data: `adm:type:${product.id}:code` }, { text: 'ينتظر كود', callback_data: `adm:type:${product.id}:wait_code` }],
    [{ text: product.isActive ? '⛔ إخفاء' : '✅ نشر للجميع', callback_data: `adm:toggle:${product.id}` }, { text: '📥 إضافة مخزون', callback_data: `adm:stockprod:${product.id}` }],
    [{ text: '🗑 حذف نهائي', callback_data: `adm:delete:${product.id}` }]
  ];
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showStockProductList(chatId) {
  const products = await Merchant.findAll({ order: [['id', 'ASC']] });
  const keyboard = [];
  for (const product of products) {
    const stock = await getProductStock(product.id);
    keyboard.push([{ text: `${product.nameAr} | 📦 ${stock}`, callback_data: `adm:stockprod:${product.id}` }]);
  }
  await bot.sendMessage(chatId, 'اختَر المنتج لإضافة المخزون:', { reply_markup: { inline_keyboard: keyboard } });
}

bot.onText(/^\/code_(\d+)_(.+)$/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const result = await addWaitingCode(Number(match[1]), String(match[2]).trim());
    const user = await User.findByPk(result.order.userId);
    const lang = user?.lang || 'ar';
    await bot.sendMessage(result.order.userId, `${t(lang, 'delivered')} — <b>#${result.order.id}</b>\n${renderDelivery(result.delivery.payload, lang)}`, { parse_mode: 'HTML' });
    await bot.sendMessage(msg.chat.id, '✅ تم إرسال الكود.');
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `❌ ${error.message}`);
  }
});

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));

module.exports = { bot, notifyBinanceResult, sendDeliveryToUser };
