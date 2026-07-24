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
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return { ar: String(value), en: String(value) }; }
}

function parseInventoryLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    return {
      email: String(parsed.email || ''),
      password: String(parsed.password || ''),
      twoFactor: String(parsed.twoFactor || parsed.two_factor || parsed['2fa'] || ''),
      code: String(parsed.code || ''),
      extra: String(parsed.extra || parsed.note || ''),
      raw
    };
  }
  let parts;
  if (raw.includes('|')) parts = raw.split('|');
  else if (raw.includes(';')) parts = raw.split(';');
  else if (raw.includes(',')) parts = raw.split(',');
  else parts = [raw];
  const [email, password, twoFactor, ...rest] = parts.map(v => String(v).trim());
  return {
    email: email || '',
    password: password || '',
    twoFactor: twoFactor || '',
    code: '',
    extra: rest.join('|'),
    raw
  };
}

function parseInventoryText(text) {
  return String(text || '').split(/\r?\n/).map(parseInventoryLine).filter(Boolean);
}

function serializeInventory(item) {
  return JSON.stringify(item);
}

function deserializeInventory(value, extra = '') {
  const raw = String(value || '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  const parsed = parseInventoryLine(raw) || { raw };
  if (extra && !parsed.extra) parsed.extra = extra;
  return parsed;
}

function renderDelivery(item, lang = 'ar', sharedPosition = null) {
  const labels = lang === 'en'
    ? { email: 'Email', password: 'Password', twoFactor: '2FA', code: 'Code', extra: 'Extra', slot: 'Shared use' }
    : { email: 'الإيميل', password: 'الباسورد', twoFactor: 'المصادقة الثنائية', code: 'الكود', extra: 'إضافي', slot: 'رقم المشترك' };
  const lines = [];
  if (item.email) lines.push(`<b>${labels.email}:</b> <code>${escapeHtml(item.email)}</code>`);
  if (item.password) lines.push(`<b>${labels.password}:</b> <code>${escapeHtml(item.password)}</code>`);
  if (item.twoFactor) lines.push(`<b>${labels.twoFactor}:</b> <code>${escapeHtml(item.twoFactor)}</code>`);
  if (item.code) lines.push(`<b>${labels.code}:</b> <code>${escapeHtml(item.code)}</code>`);
  if (item.extra) lines.push(`<b>${labels.extra}:</b> ${escapeHtml(item.extra)}`);
  if (sharedPosition) lines.push(`<b>${labels.slot}:</b> ${sharedPosition.current}/${sharedPosition.max}`);
  return lines.join('\n') || escapeHtml(item.raw || 'راجع الدعم للتسليم');
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
  escapeHtml, moneyUsd, moneyIqd, parseDescription, parseInventoryText,
  serializeInventory, deserializeInventory, renderDelivery, randomCaptcha
};
