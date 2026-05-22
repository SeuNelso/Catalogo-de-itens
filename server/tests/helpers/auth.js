const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config/secrets');

function signTestToken(overrides = {}) {
  const payload = {
    id: overrides.id ?? 999001,
    username: overrides.username ?? 'test_admin',
    role: overrides.role ?? 'admin',
    ...overrides,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

module.exports = { signTestToken, authHeader };
