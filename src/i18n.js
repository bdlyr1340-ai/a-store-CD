const text = {
  ar: {
    welcome: 'أهلاً بك في المتجر 🛍️\nاختَر من القائمة أدناه.',
    products: '🛍️ المنتجات', wallet: '👛 المحفظة', orders: '📦 طلباتي', support: '💬 الدعم', language: '🌐 اللغة',
    verify: 'للتأكد أنك مو حساب وهمي، جاوب:', verified: '✅ تم التحقق بنجاح.', wrong: '❌ الجواب غير صحيح.',
    noProducts: 'ماكو منتجات متوفرة حالياً.', chooseProduct: 'اختَر المنتج:',
    price: 'السعر', stock: 'المخزون', sold: 'المبيعات', warranty: 'الضمان', description: 'الوصف',
    buy: '🛒 شراء', quantity: 'اختَر الكمية:', payment: 'اختَر طريقة الدفع:',
    payWallet: '👛 من المحفظة', payBinance: '🟡 Binance Pay', paySuperQi: '🔵 SuperQi',
    insufficient: '❌ رصيد المحفظة غير كافي.', outOfStock: '❌ المخزون غير كافي.',
    delivered: '✅ تم التسليم', waitingCode: '⏳ بيانات الحساب وصلت، والطلب ينتظر كود من الإدارة.',
    paymentPending: '⏳ الطلب بانتظار الدفع.', paymentPaid: '✅ تم تأكيد الدفع.',
    proofPrompt: 'أرسل صورة إيصال الدفع هنا.', proofSent: '✅ وصل الإيصال للإدارة. انتظر الموافقة.',
    walletBalance: 'رصيد محفظتك', noOrders: 'ما عندك طلبات بعد.',
    supportText: 'للتواصل مع الدعم:', adminOnly: 'هذا الأمر للإدارة فقط.', cancelled: 'تم الإلغاء.'
  },
  en: {
    welcome: 'Welcome to the store 🛍️\nChoose from the menu below.',
    products: '🛍️ Products', wallet: '👛 Wallet', orders: '📦 My orders', support: '💬 Support', language: '🌐 Language',
    verify: 'To verify you are human, answer:', verified: '✅ Verification completed.', wrong: '❌ Wrong answer.',
    noProducts: 'No products are currently available.', chooseProduct: 'Choose a product:',
    price: 'Price', stock: 'Stock', sold: 'Sold', warranty: 'Warranty', description: 'Description',
    buy: '🛒 Buy', quantity: 'Choose quantity:', payment: 'Choose a payment method:',
    payWallet: '👛 Wallet', payBinance: '🟡 Binance Pay', paySuperQi: '🔵 SuperQi',
    insufficient: '❌ Insufficient wallet balance.', outOfStock: '❌ Insufficient stock.',
    delivered: '✅ Delivered', waitingCode: '⏳ Account details delivered; waiting for a code from admin.',
    paymentPending: '⏳ Waiting for payment.', paymentPaid: '✅ Payment confirmed.',
    proofPrompt: 'Send the payment receipt screenshot here.', proofSent: '✅ Receipt sent to admin. Wait for approval.',
    walletBalance: 'Wallet balance', noOrders: 'You have no orders yet.',
    supportText: 'Contact support:', adminOnly: 'Admins only.', cancelled: 'Cancelled.'
  }
};
function t(lang, key) { return text[lang]?.[key] || text.ar[key] || key; }
module.exports = { t };
