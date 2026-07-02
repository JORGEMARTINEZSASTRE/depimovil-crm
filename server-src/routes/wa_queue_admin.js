const express = require('express');
const pool = require('../utils/db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function auditWaQueue(req, action, detail) {
  await pool.query(
    'INSERT INTO audit_log (accion, entidad, detalle, usuario_id, ip) VALUES ($1,$2,$3,$4,$5)',
    [action, 'whatsapp', detail, req.user.id, req.ip]
  ).catch(() => {});
}

router.delete('/queue', auth, requireRole('superadmin', 'operaciones'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM wa_queue WHERE enviado = false');
    await auditWaQueue(req, 'WA_QUEUE_CLEAR', `Pendientes borrados: ${result.rowCount}`);
    res.json({ ok: true, count: result.rowCount });
  } catch (err) {
    console.error('WA queue clear error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/queue/:id', auth, requireRole('superadmin', 'operaciones'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await pool.query(
      'DELETE FROM wa_queue WHERE id = $1 AND enviado = false RETURNING id, telefono, tipo',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mensaje no encontrado o ya enviado' });

    const msg = rows[0];
    await auditWaQueue(req, 'WA_QUEUE_DELETE', `queue#${id} descartado -> ${msg.telefono || ''} (${msg.tipo || 'pendiente'})`);
    res.json({ ok: true, deleted: msg });
  } catch (err) {
    console.error('WA queue delete error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
