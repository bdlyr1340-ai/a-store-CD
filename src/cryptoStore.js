const crypto = require('crypto');
const config = require('./config');

const key = Buffer.from(config.inventoryKey, 'hex');
const PREFIX = 'enc:v1:';

function legacyPayload(value, extra = '') {
  const raw = String(value || '').trim();
  const rawExtra = String(extra || '').trim();
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  if (raw.includes('|') || raw.includes(';') || raw.includes(',')) {
    const delimiter = raw.includes('|') ? '|' : raw.includes(';') ? ';' : ',';
    const [email, password, twoFactor, ...rest] = raw.split(delimiter).map(v => v.trim());
    return { email, password: password || '', twoFactor: twoFactor || '', extra: rest.join('|') || rawExtra };
  }
  if (rawExtra) {
    try {
      const parsed = JSON.parse(rawExtra);
      if (parsed && typeof parsed === 'object') {
        return {
          email: raw,
          password: String(parsed.password || parsed.pass || ''),
          twoFactor: String(parsed.verify || parsed.verification || parsed.check || ''),
          extra: String(parsed.note || parsed.extra || parsed.additional || '')
        };
      }
    } catch {}
    return { email: raw.includes('@') ? raw : '', password: raw.includes('@') ? rawExtra : '', code: raw.includes('@') ? '' : raw, extra: raw.includes('@') ? '' : rawExtra };
  }
  return raw.includes('@') ? { email: raw } : { code: raw };
}

function encryptPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decryptPayload(value, extra = '') {
  const raw = String(value || '');
  if (!raw.startsWith(PREFIX)) return legacyPayload(raw, extra);
  const data = Buffer.from(raw.slice(PREFIX.length), 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

function isEncrypted(value) {
  return String(value || '').startsWith(PREFIX);
}

module.exports = { encryptPayload, decryptPayload, isEncrypted, legacyPayload };
