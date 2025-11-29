const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'dbsimpat',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 10,
  idleTimeoutMillis: 30000,
});

// sanity check
pool.query('SELECT 1')
  .then(() => console.log('[DB] Connected to PostgreSQL'))
  .catch(err => console.error('[DB] Connection error:', err.message));

module.exports = pool;
