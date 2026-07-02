const pool = require('./db');

async function ensureAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sesiones_whatsapp (
      id SERIAL PRIMARY KEY,
      whatsapp VARCHAR(30) NOT NULL,
      codigo_hash TEXT NOT NULL,
      rol_solicitado VARCHAR(50) NOT NULL DEFAULT 'operadora',
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0,
      ip VARCHAR(80),
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_sesiones_whatsapp_lookup ON sesiones_whatsapp (whatsapp, rol_solicitado, used_at, expires_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sesiones_whatsapp_recent ON sesiones_whatsapp (whatsapp, created_at DESC) WHERE used_at IS NULL');
}

module.exports = ensureAuthTables;
