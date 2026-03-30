const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');

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
      (async () => {
        // Nunca confiar em `pode_controlo_stock` vindo do JWT:
        // usar sempre o valor atual da BD (ou false em fallback).
        let mergedUser = {
          ...user,
          pode_controlo_stock: false
        };
        try {
          const uid = Number(user && user.id);
          if (Number.isFinite(uid)) {
            try {
              const r = await pool.query(
                `SELECT id, role, COALESCE(pode_controlo_stock, false) AS pode_controlo_stock
                 FROM usuarios
                 WHERE id = $1
                 LIMIT 1`,
                [uid]
              );
              if (r.rows.length > 0) {
                const dbu = r.rows[0];
                mergedUser = {
                  ...user,
                  id: dbu.id,
                  role: dbu.role || user.role,
                  pode_controlo_stock:
                    dbu.pode_controlo_stock === true ||
                    dbu.pode_controlo_stock === 't' ||
                    dbu.pode_controlo_stock === 1
                };
              }
            } catch (e) {
              // fallback para BD sem coluna pode_controlo_stock
              if (e && e.code === '42703') {
                const r2 = await pool.query(
                  `SELECT id, role
                   FROM usuarios
                   WHERE id = $1
                   LIMIT 1`,
                  [uid]
                );
                if (r2.rows.length > 0) {
                  const dbu = r2.rows[0];
                  mergedUser = {
                    ...user,
                    id: dbu.id,
                    role: dbu.role || user.role,
                    pode_controlo_stock: false
                  };
                }
              }
            }
          }
        } catch (_) {}
        req.user = mergedUser;
        next();
      })();
    });
  };
}

module.exports = { createAuthenticateToken };
