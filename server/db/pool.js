const { Pool } = require('pg');

const pgPoolMax = Math.min(100, Math.max(2, parseInt(process.env.PGPOOL_MAX || '25', 10)));

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL
    || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: pgPoolMax,
  idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONN_TIMEOUT_MS || '10000', 10),
});

module.exports = { pool, pgPoolMax };
