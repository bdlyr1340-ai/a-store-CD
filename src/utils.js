const crypto = require('crypto');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function moneyUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function moneyIqd(value) {
  return `${new Intl.NumberFormat('ar-IQ', { maximumFractionDigits: 0 }).format(Number(value || 0))} د.ع`;
}

function parseDescription(value) {
  if (!value) return { ar: '', en: '', warrantyAr: '', warrantyEn: '', sold: 0 };

  let parsed = value;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    const trimmed = parsed.trim();
    if (!trimmed) break;
    try { parsed = JSON.parse(trimmed); }
    catch {
      parsed = { ar: trimmed, en: trimmed };
      break;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = { ar: String(parsed || ''), en: String(parsed || '') };
  }

  return {
    ar: String(
      parsed.ar ??
      parsed.descriptionAr ??
      parsed.description_ar ??
      parsed.arabic ??
      parsed.descriptionArabic ??
      ''
    ),
    en: String(
      parsed.en ??
      parsed.descriptionEn ??
      parsed.description_en ??
      parsed.english ??
      parsed.descriptionEnglish ??
      ''
    ),
    warrantyAr: String(
      parsed.warrantyAr ??
      parsed.warranty_ar ??
      parsed.arWarranty ??
      ''
    ),
    warrantyEn: String(
      parsed.warrantyEn ??
      parsed.warranty_en ??
      parsed.enWarranty ??
      ''
    ),
    sold: Number(parsed.sold ?? parsed.soldCount ?? 0) || 0
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function looksLikeEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@|;,]+@[^\s@|;,]+\.[^\s@|;,]+$/.test(email);
}

function splitInventoryLine(raw) {
  if (raw.includes('|')) return raw.split('|');
  if (raw.includes(';')) return raw.split(';');
  if (raw.includes('\t')) return raw.split('\t');
  if (raw.includes(',')) return raw.split(',');
  return [raw];
}

function parseJsonInventory(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON must be an object');
  }
  return {
    email: String(parsed.email || '').trim(),
    password: String(parsed.password || parsed.pass || '').trim(),
    twoFactor: String(parsed.twoFactor || parsed.two_factor || parsed['2fa'] || '').trim(),
    code: String(parsed.code || parsed.key || '').trim(),
    extra: String(parsed.extra || parsed.note || '').trim(),
    raw
  };
}

function parseInventoryLineForType(line, productType = 'private') {
  const raw = String(line || '').trim();
  if (!raw) return { item: null, error: null };

  let item;
  try {
    if (raw.startsWith('{')) {
      item = parseJsonInventory(raw);
    } else {
      const parts = splitInventoryLine(raw).map(value => String(value).trim());
      if (productType === 'code') {
        item = { email: '', password: '', twoFactor: '', code: raw, extra: '', raw };
      } else {
        const [email = '', password = '', twoFactor = '', ...rest] = parts;
        item = {
          email,
          password,
          twoFactor,
          code: '',
          extra: rest.join('|').trim(),
          raw
        };
      }
    }
  } catch (error) {
    return { item: null, error: `JSON غير صالح: ${error.message}` };
  }

  if (productType === 'code') {
    const code = String(item.code || item.email || item.raw || '').trim();
    if (!code) return { item: null, error: 'الكود فارغ' };
    return {
      item: { email: '', password: '', twoFactor: '', code, extra: item.extra || '', raw },
      error: null
    };
  }

  const email = String(item.email || '').trim();
  const password = String(item.password || '').trim();
  const twoFactor = String(item.twoFactor || '').trim();
  const extra = String(item.extra || '').trim();

  if (!looksLikeEmail(email)) {
    return { item: null, error: 'الإيميل غير صحيح' };
  }

  if (productType === 'shared') {
    if (!password) return { item: null, error: 'الحساب المشترك لازم يحتوي إيميل وباسورد' };
    if (twoFactor) return { item: null, error: 'الحساب المشترك يقبل إيميل وباسورد فقط بدون 2FA' };
    return {
      item: { email, password, twoFactor: '', code: '', extra: '', raw },
      error: null
    };
  }

  if (productType === 'wait_code') {
    // Waiting-code accounts may be email-only or email + password. 2FA is not accepted.
    if (twoFactor) return { item: null, error: 'منتج انتظار الكود لا يقبل 2FA' };
    return {
      item: { email, password, twoFactor: '', code: '', extra, raw },
      error: null
    };
  }

  // Personal/private accounts: email + password, with optional 2FA.
  if (!password) return { item: null, error: 'الحساب الشخصي لازم يحتوي إيميل وباسورد' };
  return {
    item: { email, password, twoFactor, code: '', extra, raw },
    error: null
  };
}

function parseInventoryTextForProduct(text, productType = 'private') {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  const errors = [];

  lines.forEach((line, index) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    const result = parseInventoryLineForType(trimmed, productType);
    if (result.error) errors.push({ line: index + 1, value: trimmed, error: result.error });
    else if (result.item) items.push(result.item);
  });

  return { items, errors };
}

function parseInventoryText(text) {
  return parseInventoryTextForProduct(text, 'private').items;
}

function deserializeInventory(value, extra = '') {
  const raw = String(value || '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  const result = parseInventoryLineForType(raw, 'private');
  const parsed = result.item || { raw };
  if (extra && !parsed.extra) parsed.extra = extra;
  return parsed;
}

function inventoryPayloadIsValid(productType, item) {
  const type = String(productType || 'private');
  if (type === 'code') return Boolean(String(item?.code || item?.raw || '').trim());
  if (!looksLikeEmail(item?.email)) return false;
  if (type === 'wait_code') return !String(item?.twoFactor || '').trim();
  if (type === 'shared') {
    return Boolean(String(item?.password || '').trim()) && !String(item?.twoFactor || '').trim();
  }
  return Boolean(String(item?.password || '').trim());
}

function inventoryFingerprint(productType, item) {
  const type = String(productType || 'private');
  const normalized = type === 'code'
    ? { code: String(item?.code || item?.raw || '').trim() }
    : { email: normalizeEmail(item?.email) };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function renderDelivery(item, lang = 'ar') {
  const labels = lang === 'en'
    ? { email: 'Email', password: 'Password', twoFactor: '2FA', code: 'Code', extra: 'Extra' }
    : { email: 'الإيميل', password: 'الباسورد', twoFactor: 'المصادقة الثنائية', code: 'الكود', extra: 'إضافي' };
  const lines = [];
  if (item.email) lines.push(`<b>${labels.email}:</b> <code>${escapeHtml(item.email)}</code>`);
  if (item.password) lines.push(`<b>${labels.password}:</b> <code>${escapeHtml(item.password)}</code>`);
  if (item.twoFactor) lines.push(`<b>${labels.twoFactor}:</b> <code>${escapeHtml(item.twoFactor)}</code>`);
  if (item.code) lines.push(`<b>${labels.code}:</b> <code>${escapeHtml(item.code)}</code>`);
  if (item.extra) lines.push(`<b>${labels.extra}:</b> ${escapeHtml(item.extra)}`);
  return lines.join('\n') || escapeHtml(item.raw || (lang === 'en' ? 'Contact support for delivery.' : 'راجع الدعم للتسليم.'));
}

function randomCaptcha() {
  const a = Math.floor(Math.random() * 8) + 2;
  const b = Math.floor(Math.random() * 7) + 1;
  const answer = a + b;
  const options = new Set([answer]);
  while (options.size < 4) options.add(Math.max(1, answer + Math.floor(Math.random() * 9) - 4));
  return { question: `${a} + ${b}`, answer, options: [...options].sort(() => Math.random() - 0.5) };
}

module.exports = {
  escapeHtml,
  moneyUsd,
  moneyIqd,
  parseDescription,
  parseInventoryText,
  parseInventoryTextForProduct,
  parseInventoryLineForType,
  inventoryFingerprint,
  inventoryPayloadIsValid,
  deserializeInventory,
  renderDelivery,
  randomCaptcha,
  looksLikeEmail
};
