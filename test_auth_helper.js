const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || '48441b493ae87ff9390434467ca504e90ab614f36c4754134cbe2bd9ef681215';

function createTestToken(payload = {}) {
  const uid = payload.uid || 'test_user_' + Math.random().toString(36).slice(2, 8);
  let role = payload.role;
  if (!role) {
    const uidLower = uid.toLowerCase();
    if (uidLower.startsWith('admin')) role = 'admin';
    else if (uidLower.startsWith('dispatcher')) role = 'dispatcher';
    else if (uidLower.startsWith('supervisor')) role = 'supervisor';
    else if (uidLower.startsWith('driver')) role = 'driver';
    else role = 'driver';
  } else {
    role = String(role).toLowerCase();
  }

  const header = 'test_token';
  const body = Buffer.from(JSON.stringify({
    uid,
    email: payload.email || 'user@example.com',
    name: payload.name || 'Test User',
    role,
    exp: payload.exp || (Date.now() + 3600 * 1000),
    ...payload,
    // Asegurar que payload.role no sobrescriba si era explícito
    role
  })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body)
    .digest('hex');
  return `${header}.${body}.${sig}`;
}

module.exports = { createTestToken };
