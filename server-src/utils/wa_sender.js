/**
 * DepiMóvil — WhatsApp Sender
 *
 * Wrapper sobre WhatsApp.
 * En modo simulacion solo loguea.
 * En produccion envia por Evolution API si esta configurado; si no, usa Meta.
 *
 * Variables de entorno necesarias (modo produccion):
 *   WA_MODO          = 'produccion'
 *   EVOLUTION_URL    = 'https://evolution.tudominio.com'  (URL de Evolution API en Railway)
 *   EVOLUTION_KEY    = 'tu-api-key-de-evolution'
 *   EVOLUTION_INST   = 'depimovil'  (nombre de la instancia creada en Evolution)
 *
 * Para escanear el QR: GET /api/webhook/whatsapp/qr (desde el CRM)
 */

/**
 * Normaliza un número a formato E.164 uruguayo (solo dígitos, sin +).
 * Acepta: 099123456 / 59899123456 / +59899123456
 */
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length <= 9) digits = '598' + digits.slice(1);
  if (!digits.startsWith('598') && digits.length <= 9) digits = '598' + digits;
  return digits;
}

/**
 * Headers de autenticación para Evolution API.
 */
function evoHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': process.env.EVOLUTION_KEY || '',
  };
}

/**
 * URL base de la instancia Evolution.
 */
function evoBase() {
  const url  = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
  const inst = process.env.EVOLUTION_INST || 'depimovil';
  return { url, inst };
}

function metaConfig() {
  return {
    phoneId: process.env.WA_PHONE_ID || '',
    token: process.env.WA_TOKEN || '',
    api: process.env.WA_GRAPH_API || 'https://graph.facebook.com/v19.0',
  };
}

function getProvider() {
  const preferido = String(process.env.WA_PROVIDER || process.env.WHATSAPP_PROVIDER || '').toLowerCase();
  const { phoneId, token } = metaConfig();
  const metaReady = !!(phoneId && token);
  const { url } = evoBase();
  const evolutionReady = !!(url && process.env.EVOLUTION_KEY);

  if (preferido === 'meta' && metaReady) return 'meta';
  if (['evolution', 'evolution_api', 'baileys'].includes(preferido) && evolutionReady) return 'evolution';

  // Mantener coherencia con /api/webhook/whatsapp/status: si Evolution esta configurado,
  // la pantalla y el envio usan el mismo proveedor salvo que WA_PROVIDER fuerce Meta.
  if (evolutionReady) return 'evolution';
  if (metaReady) return 'meta';
  return 'none';
}

/**
 * Envía un mensaje de texto simple.
 * @param {string} to   - Número destino (cualquier formato uruguayo)
 * @param {string} text - Texto del mensaje
 * @returns {Promise<{ok: boolean, messageId?: string, simulado?: boolean, error?: string}>}
 */
async function enviarMensaje(to, text) {
  const modo  = process.env.WA_MODO || 'simulacion';
  const phone = normalizePhone(to);

  if (!phone) {
    console.warn('⚠️ wa_sender: número inválido:', to);
    return { ok: false, error: 'Número inválido' };
  }

  if (modo === 'simulacion') {
    console.log(`📱 [WA SIMULACION] → ${phone}\n${text}\n`);
    return { ok: true, simulado: true, phone };
  }

  const provider = getProvider();
  if (provider === 'none') {
    console.error('❌ wa_sender: falta configurar proveedor WhatsApp');
    return { ok: false, error: 'Configuración incompleta' };
  }

  try {
    if (provider === 'meta') {
      const { phoneId, token, api } = metaConfig();
      const res = await fetch(`${api}/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: text },
        }),
      });
      const data = await res.json().catch(() => ({}));
      const msgId = data?.messages?.[0]?.id;
      if (!res.ok || !msgId) {
        const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
        console.error('❌ wa_sender error Meta:', msg);
        return { ok: false, error: msg };
      }
      return { ok: true, messageId: msgId, phone, provider };
    }

    const { url, inst } = evoBase();
    // Evolution API v2 acepta el número solo con código de país (sin @s.whatsapp.net)
    const res = await fetch(`${url}/message/sendText/${inst}`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({
        number: phone,          // ej: 59892787479
        text,                   // v2 usa "text" directo
        textMessage: { text },  // compatibilidad v1
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = Array.isArray(data?.message)
        ? data.message.join(', ')
        : data?.message || data?.error || `HTTP ${res.status}`;
      console.error('❌ wa_sender error Evolution:', msg, JSON.stringify(data));
      return { ok: false, error: msg };
    }

    return { ok: true, messageId: data?.key?.id || data?.id, phone, provider };
  } catch (err) {
    console.error('❌ wa_sender fetch error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía un mensaje con botones (Evolution API soporta hasta 3).
 * Si la instancia no admite botones, cae a texto plano numerado.
 */
async function enviarBotones(to, body, buttons) {
  const modo  = process.env.WA_MODO || 'simulacion';
  const phone = normalizePhone(to);

  if (!phone) return { ok: false, error: 'Número inválido' };

  if (modo === 'simulacion') {
    const btnText = buttons.map((b, i) => `  [${i + 1}] ${b.title}`).join('\n');
    console.log(`📱 [WA SIMULACION BOTONES] → ${phone}\n${body}\n${btnText}\n`);
    return { ok: true, simulado: true, phone };
  }

  const { url, inst } = evoBase();
  if (!url || !process.env.EVOLUTION_KEY) return { ok: false, error: 'Configuración incompleta' };

  // Intentar con botones nativos
  try {
    const res = await fetch(`${url}/message/sendButtons/${inst}`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({
        number: phone + '@s.whatsapp.net',
        title: '',
        description: body,
        footer: 'DepiMóvil',
        buttons: buttons.slice(0, 3).map((b, i) => ({
          buttonId: b.id || String(i + 1),
          buttonText: { displayText: b.title.slice(0, 20) },
          type: 1,
        })),
      }),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: true, messageId: data?.key?.id, phone };
    }
  } catch (_) {}

  // Fallback: texto plano numerado
  const textoFallback = body + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  return enviarMensaje(to, textoFallback);
}

/**
 * Envía un mensaje con lista de opciones.
 * Si la instancia no admite listas, cae a texto plano numerado.
 */
async function enviarLista(to, body, buttonText, rows) {
  const modo  = process.env.WA_MODO || 'simulacion';
  const phone = normalizePhone(to);

  if (!phone) return { ok: false, error: 'Número inválido' };

  if (modo === 'simulacion') {
    const rowText = rows.map((r, i) => `  ${i + 1}. ${r.title}${r.description ? ' — ' + r.description : ''}`).join('\n');
    console.log(`📱 [WA SIMULACION LISTA] → ${phone}\n${body}\n${rowText}\n`);
    return { ok: true, simulado: true, phone };
  }

  const { url, inst } = evoBase();
  if (!url || !process.env.EVOLUTION_KEY) return { ok: false, error: 'Configuración incompleta' };

  // Intentar con lista nativa
  try {
    const res = await fetch(`${url}/message/sendList/${inst}`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({
        number: phone + '@s.whatsapp.net',
        title: '',
        description: body,
        footer: 'DepiMóvil',
        buttonText: buttonText.slice(0, 20),
        sections: [{
          title: 'Opciones',
          rows: rows.slice(0, 10).map(r => ({
            title: String(r.title).slice(0, 24),
            description: r.description ? String(r.description).slice(0, 72) : '',
            rowId: String(r.id),
          })),
        }],
      }),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: true, messageId: data?.key?.id, phone };
    }
  } catch (_) {}

  // Fallback: texto plano numerado
  const textoFallback = body + '\n\n' + rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
  return enviarMensaje(to, textoFallback);
}

/**
 * Obtiene el QR de la instancia para escanear.
 * Devuelve { ok, qrcode, status } — qrcode es una imagen base64.
 */
async function obtenerQR() {
  const { url, inst } = evoBase();
  if (!url || !process.env.EVOLUTION_KEY) {
    return { ok: false, error: 'EVOLUTION_URL o EVOLUTION_KEY no configurados' };
  }

  try {
    // Primero verificar si ya está conectado
    const statusRes = await fetch(`${url}/instance/connectionState/${inst}`, {
      headers: evoHeaders(),
    });
    if (statusRes.ok) {
      const statusData = await statusRes.json().catch(() => ({}));
      const state = statusData?.instance?.state || statusData?.state;
      if (state === 'open') {
        return { ok: true, status: 'conectado', qrcode: null };
      }
    }

    // Obtener QR
    const res = await fetch(`${url}/instance/connect/${inst}`, {
      headers: evoHeaders(),
    });
    const data = await res.json().catch(() => ({}));

    if (data?.base64) {
      return { ok: true, status: 'pendiente_escaneo', qrcode: data.base64 };
    }
    if (data?.qrcode?.base64) {
      return { ok: true, status: 'pendiente_escaneo', qrcode: data.qrcode.base64 };
    }

    return { ok: false, error: 'No se pudo obtener el QR', raw: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Crea la instancia en Evolution API si no existe.
 * Llamar una sola vez al configurar.
 */
async function crearInstancia() {
  const { url, inst } = evoBase();
  if (!url || !process.env.EVOLUTION_KEY) return { ok: false, error: 'Config incompleta' };

  try {
    const res = await fetch(`${url}/instance/create`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({
        instanceName: inst,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { enviarMensaje, enviarBotones, enviarLista, normalizePhone, obtenerQR, crearInstancia };
