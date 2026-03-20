const jwt = require('jsonwebtoken');

function createAuthenticateToken(jwtSecret) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token de acesso necessário' });
    }

    jwt.verify(token, jwtSecret, (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Token inválido' });
      }
      req.user = user;
      next();
    });
  };
}

module.exports = { createAuthenticateToken };
