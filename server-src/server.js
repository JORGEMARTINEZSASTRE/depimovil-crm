/**
 * DepiMóvil API — Servidor principal
 * 
 * Ejecutar:
 *   npm start        (producción)
 *   npm run dev      (desarrollo con auto-reload)
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ensureAuthTables = require('./utils/ensure_auth_tables');

const app = express();
app.set('trust proxy', 1); // Trust Nginx proxy
const PORT = process.env.PORT || 3004;

ensureAuthTables().catch(err => {
  console.error('Error preparando tablas de autenticación:', err.message);
});

// ══════════════════════════════════
// SEGURIDAD
// ══════════════════════════════════
app.use(helmet());

// CORS — permitir CRM admin y portal de operadoras
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Permitir requests sin origin (apps móviles, curl, etc.)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // En desarrollo, permitir localhost
    if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) return cb(null, true);
    cb(new Error('Bloqueado por CORS'));
  },
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 2000, // el CRM carga muchos módulos y puede superar 200 en uso normal
  message: { error: 'Demasiadas solicitudes, intentá en unos minutos' },
});
app.use('/api/', limiter);

// Rate limit más estricto para login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login' },
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/whatsapp/request', loginLimiter);
app.use('/api/auth/whatsapp/verify', loginLimiter);

// Body parsing
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(require('path').join(__dirname, '../uploads')));

// ══════════════════════════════════
// RUTAS
// ══════════════════════════════════
app.use('/api/auth', require('./routes/auth'));
app.use('/api/operadoras', require('./routes/operadoras'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/maquinas', require('./routes/maquinas'));
app.use('/api/mantenimientos', require('./routes/mantenimientos'));
app.use('/api/reservas', require('./routes/reservas'));
app.use('/api/pagos', require('./routes/pagos'));
app.use('/api/finanzas', require('./routes/finanzas'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/envios', require('./routes/envios'));
app.use('/api/transportistas', require('./routes/transportistas'));
app.use('/api/webhook/whatsapp', require('./routes/wa_queue_admin'));
app.use('/api/webhook/whatsapp', require('./routes/whatsapp'));
app.use('/api/contratos', require('./routes/contratos'));
app.use('/api/permisos', require('./routes/permisos'));
app.use('/api/automatizaciones', require('./routes/automatizaciones'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'depimovil-api',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 404 para rutas API no encontradas
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('❌ Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ══════════════════════════════════
// INICIO
// ══════════════════════════════════
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   DepiMóvil API v1.0                  ║
  ║   Puerto: ${PORT}                         ║
  ║   Entorno: ${process.env.NODE_ENV || 'development'}             ║
  ╚═══════════════════════════════════════╝
  `);
});

module.exports = app;
