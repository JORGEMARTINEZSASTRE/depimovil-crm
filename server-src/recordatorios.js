/**
 * DepiMóvil — Sistema de Recordatorios Automáticos por WhatsApp
 *
 * Corre un cron job cada 5 minutos.
 * En cada ejecución busca reservas que entren en la ventana de tiempo
 * y envía mensajes de recordatorio a las operadoras.
 *
 * Tipos de recordatorio:
 *   - 24h antes: ventana entre 23:50hs y 24:10hs desde ahora
 *   - 2h antes:  ventana entre 1:50hs y 2:10hs desde ahora
 *
 * Condiciones para enviar:
 *   - La reserva debe estar en estado activo (aprobada o confirmada)
 *   - El campo de control (recordatorio_Xh_enviado) debe ser false o null
 *   - La operadora debe tener número de WhatsApp registrado
 *
 * Variables disponibles en plantillas:
 *   {nombre}, {apellido}, {reserva}, {maquina}, {fecha}, {estado}, {departamento}
 */

const cron = require('node-cron');
const pool = require('./utils/db');
const { enviarMensaje } = require('./utils/wa_sender');
const { marcarEnviado } = require('./utils/wa_queue');

// ══════════════════════════════════════════════
// PLANTILLAS DE MENSAJES
// ══════════════════════════════════════════════

const PLANTILLA_24H = `¡Hola {nombre}! 👋

Te recordamos tu reserva de mañana:
📌 Equipo: *{maquina}*
📅 Fecha: *{fecha}*
📍 Departamento: *{departamento}*
🔖 Código: {reserva}

¿Necesitás hacer algún cambio? Contactanos a la brevedad.
_Equipo DepiMóvil_ ✦`;

const PLANTILLA_2H = `¡Hola {nombre}! ⏰

Tu reserva es *en 2 horas*:
📌 Equipo: *{maquina}*
📅 Fecha: *{fecha}*
🔖 Código: {reserva}

¡Te esperamos! Si tenés alguna consulta, escribinos.
_Equipo DepiMóvil_ ✦`;

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════

/**
 * Formatea una fecha ISO a formato legible en español.
 * @param {string|Date} dateVal
 * @returns {string} Ej: "lun. 15 de abr."
 */
function formatearFecha(dateVal) {
  try {
    const d = new Date(
      typeof dateVal === 'string' && dateVal.length === 10
        ? dateVal + 'T12:00:00'
        : dateVal
    );
    return d.toLocaleDateString('es-UY', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return String(dateVal);
  }
}

/**
 * Reemplaza las variables de una plantilla con los datos de la reserva.
 * @param {string} plantilla
 * @param {Object} datos
 * @returns {string}
 */
function aplicarPlantilla(plantilla, datos) {
  return plantilla
    .replace(/{nombre}/g,       datos.nombre       || '')
    .replace(/{apellido}/g,     datos.apellido      || '')
    .replace(/{reserva}/g,      datos.reserva       || '')
    .replace(/{maquina}/g,      datos.maquina       || '')
    .replace(/{fecha}/g,        datos.fecha         || '')
    .replace(/{estado}/g,       datos.estado        || '')
    .replace(/{departamento}/g, datos.departamento  || '');
}

/**
 * Guarda un mensaje en la cola wa_queue (para envio manual si falla el auto).
 */
async function encolarMensaje(pool, { reservaId, operadoraId, tipo, mensaje, telefono }) {
  try {
    await pool.query(
      `INSERT INTO wa_queue (reserva_id, operadora_id, tipo, mensaje, telefono)
       VALUES ($1, $2, $3, $4, $5)`,
      [reservaId, operadoraId, tipo, mensaje, telefono]
    );
  } catch (err) {
    console.error('❌ Error encolando mensaje WA:', err.message);
  }
}

async function obtenerNumerosAdminWhatsapp() {
  const { rows: configRows } = await pool.query(
    "SELECT valor FROM configuracion WHERE clave = 'admin_whatsapp_notificaciones' AND COALESCE(valor, '') <> ''"
  );
  const { rows: userRows } = await pool.query(`
    SELECT whatsapp
    FROM usuarios
    WHERE COALESCE(status, 'activo') = 'activo'
      AND rol IN ('superadmin','administrador','operaciones')
      AND COALESCE(whatsapp, '') <> ''
  `);

  return Array.from(new Set(
    [
      ...configRows.map(r => r.valor),
      ...userRows.map(r => r.whatsapp),
    ]
      .flatMap(v => String(v || '').split(/[,\n;]/))
      .map(v => v.trim())
      .filter(Boolean)
  ));
}

async function notificarAdminsLogistica({ tipo, envio, mensaje }) {
  const numeros = await obtenerNumerosAdminWhatsapp();
  if (!numeros.length) {
    console.warn(`⚠️ [${tipo}] Sin WhatsApp admin configurado para alerta ${envio.codigo}`);
    return;
  }

  for (const telefono of numeros) {
    const result = await enviarMensaje(telefono, mensaje);
    if (!result.ok) {
      await encolarMensaje(pool, {
        reservaId: envio.reserva_id,
        operadoraId: envio.operadora_id,
        tipo,
        mensaje,
        telefono,
      });
      console.warn(`⚠️ [${tipo}] Fallo aviso admin ${telefono} — encolado. Error: ${result.error}`);
    }
  }
}

async function notificarAdminsSistema({ tipo, mensaje }) {
  const numeros = await obtenerNumerosAdminWhatsapp();
  if (!numeros.length) {
    console.warn(`⚠️ [${tipo}] Sin WhatsApp admin configurado`);
    return false;
  }

  let enviado = false;
  for (const telefono of numeros) {
    const result = await enviarMensaje(telefono, mensaje);
    if (result.ok) {
      enviado = true;
    } else {
      await encolarMensaje(pool, {
        reservaId: null,
        operadoraId: null,
        tipo,
        mensaje,
        telefono,
      });
      console.warn(`⚠️ [${tipo}] Fallo aviso admin ${telefono} — encolado. Error: ${result.error}`);
    }
  }
  return enviado;
}

// ══════════════════════════════════════════════
// LÓGICA PRINCIPAL
// ══════════════════════════════════════════════

/**
 * Procesa los recordatorios para una ventana de tiempo dada.
 *
 * @param {Object} opts
 * @param {number} opts.minutosMin  - Minutos mínimos hasta la reserva (ej: 1430 para 23:50)
 * @param {number} opts.minutosMax  - Minutos máximos hasta la reserva (ej: 1450 para 24:10)
 * @param {string} opts.campo       - Columna de control: 'recordatorio_24h_enviado' | 'recordatorio_2h_enviado'
 * @param {string} opts.tipo        - Etiqueta: 'recordatorio_24h' | 'recordatorio_2h'
 * @param {string} opts.plantilla   - Texto de la plantilla con variables
 */
async function procesarVentana({ minutosMin, minutosMax, campo, tipo, plantilla }) {
  const ahora = new Date();
  const desde = new Date(ahora.getTime() + minutosMin * 60 * 1000);
  const hasta = new Date(ahora.getTime() + minutosMax * 60 * 1000);

  // Formatear a YYYY-MM-DD para comparar con la columna fecha_jornada/fecha_inicio
  const desdeFecha = desde.toISOString().split('T')[0];
  const hastaFecha = hasta.toISOString().split('T')[0];

  // Para reservas de tipo 'jornada' (sin hora) usamos la fecha del dia.
  // La condicion es: la fecha_inicio cae dentro del rango de dias relevante
  // para la ventana de recordatorio.
  // Nota: como las reservas actuales no tienen campo 'hora', el recordatorio 24h
  // se dispara el dia anterior. El de 2h se omite para jornadas sin hora
  // (solo aplica si en el futuro se agrega hora al modelo).

  const { rows: reservas } = await pool.query(
    `SELECT
       r.id,
       r.codigo,
       r.estado,
       r.fecha_jornada,
       r.fecha_inicio,
       r.dept_logistica,
       m.nombre AS maquina,
       o.nombre AS op_nombre,
       o.apellido AS op_apellido,
       o.whatsapp AS op_whatsapp,
       o.id AS operadora_id
     FROM reservas r
     JOIN maquinas   m ON m.id = r.maquina_id
     JOIN operadoras o ON o.id = r.operadora_id
     WHERE r.estado IN ('aprobada', 'confirmada')
       AND r.${campo} IS NOT TRUE
       AND COALESCE(r.fecha_jornada, r.fecha_inicio) BETWEEN $1 AND $2
       AND o.whatsapp IS NOT NULL
       AND o.whatsapp <> ''`,
    [desdeFecha, hastaFecha]
  );

  if (!reservas.length) return;

  console.log(`📋 [${tipo}] ${reservas.length} reserva(s) en ventana`);

  for (const r of reservas) {
    const fechaDisplay = formatearFecha(r.fecha_jornada || r.fecha_inicio);
    const datos = {
      nombre:      r.op_nombre,
      apellido:    r.op_apellido,
      reserva:     r.codigo,
      maquina:     r.maquina,
      fecha:       fechaDisplay,
      estado:      r.estado.replace(/_/g, ' '),
      departamento: r.dept_logistica || '',
    };

    const mensaje = aplicarPlantilla(plantilla, datos);

    // Intentar enviar
    const result = await enviarMensaje(r.op_whatsapp, mensaje);

    if (result.ok) {
      // Marcar como enviado en la DB
      await pool.query(
        `UPDATE reservas SET ${campo} = true, updated_at = NOW() WHERE id = $1`,
        [r.id]
      );

      // Auditoría
      await pool.query(
        `INSERT INTO audit_log (accion, entidad, entidad_id, detalle)
         VALUES ('WA_RECORDATORIO', 'reserva', $1, $2)`,
        [r.id, `${tipo} → ${r.op_whatsapp} — ${r.codigo}`]
      );

      console.log(`✅ [${tipo}] Enviado a ${r.op_nombre} ${r.op_apellido} (${r.op_whatsapp}) — ${r.codigo}`);
    } else {
      // Fallo: encolar para envio manual
      await encolarMensaje(pool, {
        reservaId:    r.id,
        operadoraId:  r.operadora_id,
        tipo,
        mensaje,
        telefono:     r.op_whatsapp,
      });

      console.warn(`⚠️ [${tipo}] Fallo envio a ${r.op_whatsapp} — encolado. Error: ${result.error}`);
    }
  }
}

async function procesarColaAutomatica() {
  const { rows } = await pool.query(
    `SELECT *
     FROM wa_queue
     WHERE enviado = false
       AND (
         (tipo = 'codigo_login_operadora' AND creado_en > NOW() - INTERVAL '10 minutes')
         OR
         (tipo = 'admin_nueva_operadora' AND creado_en > NOW() - INTERVAL '24 hours')
       )
     ORDER BY creado_en ASC
     LIMIT 20`
  );

  if (!rows.length) return;

  console.log(`📤 Cola WA automática: ${rows.length} mensaje(s) pendiente(s)`);
  for (const msg of rows) {
    const result = await enviarMensaje(msg.telefono, msg.mensaje);
    if (result.ok) {
      await marcarEnviado(msg.id);
      await pool.query(
        `INSERT INTO audit_log (accion, entidad, entidad_id, detalle)
         VALUES ('WA_QUEUE_RETRY', 'whatsapp', $1, $2)`,
        [msg.id, `${msg.tipo} → ${msg.telefono}`]
      );
      console.log(`✅ Cola WA automática enviada: #${msg.id} ${msg.tipo} → ${msg.telefono}`);
    } else {
      console.warn(`⚠️ Cola WA automática sigue pendiente: #${msg.id} ${msg.tipo} → ${msg.telefono}. Error: ${result.error}`);
    }
  }
}

async function procesarAlertasEnvios() {
  const { rows: alertas } = await pool.query(`
    SELECT e.*,
           r.codigo AS reserva_codigo,
           o.nombre AS op_nombre,
           o.apellido AS op_apellido,
           m.nombre AS maquina_nombre
    FROM envios e
    LEFT JOIN reservas r ON r.id = e.reserva_id
    LEFT JOIN operadoras o ON o.id = e.operadora_id
    LEFT JOIN maquinas m ON m.id = e.maquina_id
    WHERE e.estado NOT IN ('retirado','cancelado')
      AND (
        (
          e.fecha_envio_est IS NOT NULL
          AND e.fecha_envio_est < CURRENT_DATE
          AND e.fecha_envio_real IS NULL
          AND e.estado IN ('pendiente_envio','preparando','en_transito')
        )
        OR
        (
          e.fecha_retiro_est IS NOT NULL
          AND e.fecha_retiro_est < CURRENT_DATE
          AND e.fecha_retiro_real IS NULL
          AND e.estado IN ('entregado','retiro_pendiente')
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.accion = 'ALERTA_ENVIO'
          AND a.entidad = 'envio'
          AND a.entidad_id = e.id
          AND a.created_at::date = CURRENT_DATE
      )
    ORDER BY COALESCE(e.fecha_envio_est, e.fecha_retiro_est), e.id
    LIMIT 20
  `);

  if (!alertas.length) return;

  console.log(`🚚 Alertas logística: ${alertas.length} envío(s) requieren revisión`);
  for (const e of alertas) {
    const esRetiro = ['entregado', 'retiro_pendiente'].includes(e.estado);
    const tipo = esRetiro ? 'alerta_retiro_atrasado' : 'alerta_envio_atrasado';
    const fecha = formatearFecha(esRetiro ? e.fecha_retiro_est : e.fecha_envio_est);
    const operadora = [e.op_nombre, e.op_apellido].filter(Boolean).join(' ') || 'Sin operadora';
    const mensaje = esRetiro
      ? `⚠️ *Retiro pendiente vencido*\n\nEnvío: *${e.codigo}*\nReserva: ${e.reserva_codigo || '—'}\nOperadora: ${operadora}\nMáquina: ${e.maquina_nombre || '—'}\nDepartamento: ${e.departamento || '—'}\nRetiro estimado: *${fecha}*\n\nRevisar logística y coordinar retiro.`
      : `⚠️ *Envío atrasado*\n\nEnvío: *${e.codigo}*\nReserva: ${e.reserva_codigo || '—'}\nOperadora: ${operadora}\nMáquina: ${e.maquina_nombre || '—'}\nDepartamento: ${e.departamento || '—'}\nEnvío estimado: *${fecha}*\nEstado actual: ${e.estado}\n\nRevisar logística y actualizar estado.`;

    await notificarAdminsLogistica({ tipo, envio: e, mensaje });
    await pool.query(
      `INSERT INTO audit_log (accion, entidad, entidad_id, detalle)
       VALUES ('ALERTA_ENVIO', 'envio', $1, $2)`,
      [e.id, `${tipo} — ${e.codigo}`]
    );
  }
}

async function procesarResumenDiarioOperativo() {
  const yaEnviado = await pool.query(`
    SELECT id
    FROM audit_log
    WHERE accion = 'RESUMEN_DIARIO'
      AND entidad = 'operativa'
      AND created_at::date = CURRENT_DATE
    LIMIT 1
  `);
  if (yaEnviado.rows.length) return;

  const [
    reservasHoy,
    reservasManana,
    reservasSinAprobar,
    enviosPendientes,
    enviosAtrasados,
    retirosPendientes,
    pagosPendientes,
    deudasVencidas,
    operadorasRevision,
  ] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM reservas
      WHERE estado IN ('aprobada','confirmada')
        AND COALESCE(fecha_jornada, fecha_inicio) = CURRENT_DATE
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM reservas
      WHERE estado IN ('aprobada','confirmada')
        AND COALESCE(fecha_jornada, fecha_inicio) = CURRENT_DATE + INTERVAL '1 day'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM reservas
      WHERE estado IN ('solicitud_recibida','pendiente_aprobacion')
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM envios
      WHERE estado IN ('pendiente_envio','preparando','en_transito')
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM envios
      WHERE estado NOT IN ('retirado','cancelado')
        AND fecha_envio_est IS NOT NULL
        AND fecha_envio_est < CURRENT_DATE
        AND fecha_envio_real IS NULL
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM envios
      WHERE estado IN ('entregado','retiro_pendiente')
        AND fecha_retiro_real IS NULL
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM pagos
      WHERE estado IN ('pendiente','sena_pendiente','sena_abonada')
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM pagos
      WHERE estado = 'deuda_vencida'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM usuarios
      WHERE (registro_origen = 'registro_web_operadora' OR requiere_revision_admin = true)
        AND COALESCE(revision_admin_estado, 'pendiente') IN ('pendiente','documentos_solicitados','observada')
    `),
  ]);

  const hoy = new Date().toLocaleDateString('es-UY', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const v = r => r.rows[0]?.total || 0;
  const mensaje =
    `📋 *Resumen operativo DepiMóvil*\n` +
    `${hoy}\n\n` +
    `Reservas hoy: *${v(reservasHoy)}*\n` +
    `Reservas mañana: *${v(reservasManana)}*\n` +
    `Reservas sin aprobar: *${v(reservasSinAprobar)}*\n\n` +
    `Envíos en proceso: *${v(enviosPendientes)}*\n` +
    `Envíos atrasados: *${v(enviosAtrasados)}*\n` +
    `Retiros pendientes: *${v(retirosPendientes)}*\n\n` +
    `Pagos pendientes: *${v(pagosPendientes)}*\n` +
    `Deudas vencidas: *${v(deudasVencidas)}*\n` +
    `Operadoras a revisar: *${v(operadorasRevision)}*\n\n` +
    `Entrá al CRM para resolver los puntos marcados.`;

  await notificarAdminsSistema({ tipo: 'resumen_diario_operativo', mensaje });
  await pool.query(
    `INSERT INTO audit_log (accion, entidad, entidad_id, detalle)
     VALUES ('RESUMEN_DIARIO', 'operativa', NULL, $1)`,
    [`Resumen operativo enviado: reservas hoy ${v(reservasHoy)}, envíos atrasados ${v(enviosAtrasados)}, deudas ${v(deudasVencidas)}`]
  );
}

async function procesarResumenSemanalLeads() {
  const yaEnviado = await pool.query(`
    SELECT id
    FROM audit_log
    WHERE accion = 'RESUMEN_SEMANAL_LEADS'
      AND entidad = 'leads'
      AND created_at::date = CURRENT_DATE
    LIMIT 1
  `);
  if (yaEnviado.rows.length) return;

  const [
    nuevos,
    ganados,
    perdidos,
    porCanal,
    seguimientoVencido,
  ] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM leads
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM leads_estado_historial
      WHERE estado_nuevo = 'ganado'
        AND created_at >= NOW() - INTERVAL '7 days'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM leads_estado_historial
      WHERE estado_nuevo = 'perdido'
        AND created_at >= NOW() - INTERVAL '7 days'
    `),
    pool.query(`
      SELECT COALESCE(canal, 'otro') AS canal, COUNT(*)::int AS total
      FROM leads
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY COALESCE(canal, 'otro')
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM leads
      WHERE estado NOT IN ('ganado','perdido')
        AND prox_fecha IS NOT NULL
        AND prox_fecha < CURRENT_DATE
    `),
  ]);

  const v = r => r.rows[0]?.total || 0;
  const canalLines = porCanal.rows.length
    ? porCanal.rows.map(r => `  • ${r.canal}: *${r.total}*`).join('\n')
    : '  • Sin datos esta semana';

  const mensaje =
    `📊 *Resumen semanal de leads — DepiMóvil*\n\n` +
    `Leads nuevos (últimos 7 días): *${v(nuevos)}*\n` +
    `Ganados: *${v(ganados)}* — Perdidos: *${v(perdidos)}*\n\n` +
    `Por canal:\n${canalLines}\n\n` +
    `Seguimientos vencidos: *${v(seguimientoVencido)}*\n\n` +
    `Entrá al CRM para revisar el embudo comercial.`;

  await notificarAdminsSistema({ tipo: 'resumen_semanal_leads', mensaje });
  await pool.query(
    `INSERT INTO audit_log (accion, entidad, entidad_id, detalle)
     VALUES ('RESUMEN_SEMANAL_LEADS', 'leads', NULL, $1)`,
    [`Resumen semanal enviado: nuevos ${v(nuevos)}, ganados ${v(ganados)}, perdidos ${v(perdidos)}`]
  );
}

// ══════════════════════════════════════════════
// CRON JOB
// ══════════════════════════════════════════════

/**
 * Inicia el scheduler de recordatorios.
 * Debe llamarse una sola vez al arrancar el servidor.
 */
function iniciarRecordatorios() {
  console.log('⏰ Recordatorios WhatsApp: scheduler iniciado (cada 5 min)');
  console.log('📋 Resumen diario operativo: scheduler iniciado (08:00 America/Montevideo)');
  console.log('📊 Resumen semanal de leads: scheduler iniciado (viernes 08:00 America/Montevideo)');

  cron.schedule('0 8 * * *', async () => {
    try {
      await procesarResumenDiarioOperativo();
    } catch (err) {
      console.error('❌ Error en resumen diario operativo:', err.message);
    }
  }, { timezone: 'America/Montevideo' });

  // Viernes 08:00 — resumen semanal de leads (5 = viernes en cron day-of-week)
  cron.schedule('0 8 * * 5', async () => {
    try {
      await procesarResumenSemanalLeads();
    } catch (err) {
      console.error('❌ Error en resumen semanal de leads:', err.message);
    }
  }, { timezone: 'America/Montevideo' });

  // Corre cada 5 minutos: */5 * * * *
  cron.schedule('*/5 * * * *', async () => {
    const inicio = Date.now();
    try {
      await procesarColaAutomatica();
      await procesarAlertasEnvios();

      // ── Recordatorio 24 horas antes ──
      // Ventana: entre 23h50m y 24h10m desde ahora
      await procesarVentana({
        minutosMin: 23 * 60 + 50,  // 1430 min
        minutosMax: 24 * 60 + 10,  // 1450 min
        campo:     'recordatorio_24h_enviado',
        tipo:      'recordatorio_24h',
        plantilla:  PLANTILLA_24H,
      });

      // ── Recordatorio 2 horas antes ──
      // Ventana: entre 1h50m y 2h10m desde ahora
      // (Solo aplica si las reservas tienen hora; para jornadas completas
      //  este bloque no encontrará coincidencias porque las fechas no incluyen hora)
      await procesarVentana({
        minutosMin: 1 * 60 + 50,   // 110 min
        minutosMax: 2 * 60 + 10,   // 130 min
        campo:     'recordatorio_2h_enviado',
        tipo:      'recordatorio_2h',
        plantilla:  PLANTILLA_2H,
      });

    } catch (err) {
      console.error('❌ Error en cron recordatorios:', err.message);
    } finally {
      const ms = Date.now() - inicio;
      if (ms > 1000) console.log(`⏱ Recordatorios procesados en ${ms}ms`);
    }
  });
}

module.exports = { iniciarRecordatorios };
