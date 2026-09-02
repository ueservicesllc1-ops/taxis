// ============================================
// IMPORTS Y CONFIGURACIÓN
// ============================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');
const multer = require('multer');
const { uploadToB2 } = require('./utils/b2Storage');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB max
});

// ============================================
// FIREBASE ADMIN SDK Y AUTENTICACIÓN (FASE 2 & FASE 5A)
// ============================================
let fcmMessaging = null;
let firebaseAuthAdmin = null;

try {
  const admin = require('firebase-admin');
  const { getAuth } = require('firebase-admin/auth');
  const { getMessaging } = require('firebase-admin/messaging');
  let credential = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      const saKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim();
      if (saKey.startsWith('{')) {
        credential = admin.credential.cert(JSON.parse(saKey));
      } else if (fs.existsSync(saKey)) {
        credential = admin.credential.cert(require(path.resolve(saKey)));
      }
    } catch (e) {
      logger.warn('Error leyendo FIREBASE_SERVICE_ACCOUNT_KEY:', e.message);
    }
  }

  const apps = admin.apps || (admin.default && admin.default.apps) || [];
  let app = apps.length ? apps[0] : null;
  if (!app) {
    if (credential) {
      app = admin.initializeApp({
        credential,
        projectId: process.env.FIREBASE_PROJECT_ID || 'superprice-fa792'
      });
      logger.info('🔥 Firebase Admin SDK inicializado con credenciales de servicio.');
    } else {
      app = admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'superprice-fa792'
      });
      logger.info('🔥 Firebase Admin SDK inicializado con Project ID.');
    }
  }

  firebaseAuthAdmin = getAuth(app);
  try {
    fcmMessaging = getMessaging(app);
  } catch (mErr) {
    logger.warn('FCM Messaging no disponible sin service account completa:', mErr.message);
  }
} catch (err) {
  logger.warn('Aviso: Firebase Admin SDK no configurado: ' + err.message);
}

// ============================================
// TOKEN VERIFICATION & HELPERS (FASE 5A)
// ============================================
async function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;

  const cleanToken = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (!cleanToken) return null;

  // 1. Verificar Firebase ID Token real
  if (firebaseAuthAdmin && !cleanToken.startsWith('test_token.')) {
    try {
      const decoded = await firebaseAuthAdmin.verifyIdToken(cleanToken);
      if (decoded && decoded.uid) {
        let role = decoded.role;
        if (!role) {
          if (decoded.admin) role = 'admin';
          else if (decoded.dispatcher) role = 'dispatcher';
          else if (decoded.supervisor) role = 'supervisor';
          else if (decoded.driver) role = 'driver';
          else {
            const uidLower = (decoded.uid || '').toLowerCase();
            if (uidLower.startsWith('admin')) role = 'admin';
            else if (uidLower.startsWith('dispatcher')) role = 'dispatcher';
            else if (uidLower.startsWith('supervisor')) role = 'supervisor';
            else if (uidLower.startsWith('driver')) role = 'driver';
            else if (decoded.firebase?.sign_in_provider === 'google.com') {
              // Solo Google OAuth → operadores web de la Central de Despacho
              role = 'dispatcher';
            } else {
              // email/password y otros providers → conductores de la app móvil
              role = 'driver';
            }
          }
        }
        return {
          uid: decoded.uid,
          email: decoded.email || '',
          name: decoded.name || '',
          role: String(role).toLowerCase(),
          claims: decoded,
          firebase: decoded
        };
      }
    } catch (firebaseErr) {
      logger.warn(`Firebase ID Token verify error: ${firebaseErr.message}`);
    }
  }

  // 2. Verificar tokens HMAC para testing y desarrollo
  try {
    if (cleanToken.startsWith('test_token.')) {
      const parts = cleanToken.split('.');
      if (parts.length === 3) {
        const secret = process.env.JWT_SECRET || '48441b493ae87ff9390434467ca504e90ab614f36c4754134cbe2bd9ef681215';
        const expectedSig = crypto.createHmac('sha256', secret)
          .update(parts[0] + '.' + parts[1])
          .digest('hex');
        if (parts[2] === expectedSig) {
          const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
          const payload = JSON.parse(payloadJson);
          if (payload.exp && Date.now() > payload.exp) {
            return null; // Expirado
          }
          if (payload && payload.uid) {
            let role = payload.role;
            if (!role) {
              const uidLower = String(payload.uid).toLowerCase();
              if (uidLower.startsWith('admin')) role = 'admin';
              else if (uidLower.startsWith('dispatcher')) role = 'dispatcher';
              else if (uidLower.startsWith('supervisor')) role = 'supervisor';
              else if (uidLower.startsWith('driver')) role = 'driver';
              else role = 'driver';
            }
            return {
              uid: payload.uid,
              email: payload.email || '',
              name: payload.name || '',
              role: String(role).toLowerCase(),
              claims: payload,
              isTest: true
            };
          }
        }
      }
    }
  } catch (hmacErr) {
    // Token de prueba no válido
  }

  return null;
}

function generateTestToken(payload) {
  const header = 'test_token';
  const secret = process.env.JWT_SECRET || '48441b493ae87ff9390434467ca504e90ab614f36c4754134cbe2bd9ef681215';
  const uid = payload.uid || 'test_user_id';
  let role = payload.role;
  if (!role) {
    const uidLower = uid.toLowerCase();
    if (uidLower.startsWith('admin')) role = 'admin';
    else if (uidLower.startsWith('dispatcher')) role = 'dispatcher';
    else if (uidLower.startsWith('supervisor')) role = 'supervisor';
    else if (uidLower.startsWith('driver')) role = 'driver';
    else role = 'driver';
  }
  const body = Buffer.from(JSON.stringify({
    uid,
    email: payload.email || 'test@example.com',
    name: payload.name || 'Test User',
    role: String(role).toLowerCase(),
    exp: payload.exp || (Date.now() + 3600 * 1000),
    ...payload
  })).toString('base64');
  const sig = crypto.createHmac('sha256', secret)
    .update(header + '.' + body)
    .digest('hex');
  return `${header}.${body}.${sig}`;
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header.' });
    }

    const token = authHeader.slice(7).trim();
    const user = await verifyAuthToken(token);

    if (!user || !user.uid) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired authentication token.' });
    }

    req.user = user;
    next();
  } catch (err) {
    logger.error('Error in requireAuth middleware:', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function requireRole(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map(r => String(r).toLowerCase());
  return (req, res, next) => {
    if (!req.user || !req.user.uid) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }
    const userRole = (req.user.role || '').toLowerCase();
    if (!userRole || !normalizedAllowed.includes(userRole)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions for this resource.' });
    }
    next();
  };
}

async function sendFcmNotificationToDriver(driver, ride) {
  try {
    if (!fcmMessaging || !driver) return;
    const token = driver.fcmToken;
    if (!token) {
      logger.info(`Taxista ${driver.name} no tiene FCM Token registrado aún. Alerta enviada por Socket.io.`);
      return;
    }

    const message = {
      token: token,
      data: {
        type: 'NEW_RIDE',
        rideId: String(ride.id),
        passengerName: String(ride.customerName || 'Pasajero'),
        pickup: String(ride.pickup?.address || 'Punto de recogida'),
        destination: String(ride.destination?.address || 'Destino final'),
        fare: String(ride.fare ? ('$' + Number(ride.fare).toFixed(2)) : '$15.00'),
        distance: String(ride.distance || '5.0 km'),
        estimatedTime: String(ride.duration || '15 min'),
        pLat: String(ride.pickup?.lat || '0.0'),
        pLng: String(ride.pickup?.lng || '0.0'),
        dLat: String(ride.destination?.lat || '0.0'),
        dLng: String(ride.destination?.lng || '0.0'),
        timestamp: String(Date.now())
      },
      android: {
        priority: 'high',
        notification: {
          title: `🚕 Nueva carrera • $${ride.fare ? Number(ride.fare).toFixed(2) : '15.00'}`,
          body: `Recogida: ${ride.pickup?.address || 'Origen'}\nDestino: ${ride.destination?.address || 'Destino'}`,
          channelId: 'ride_alerts_channel',
          priority: 'max',
          defaultSound: false,
          sound: 'ride_alert'
        }
      }
    };

    const response = await fcmMessaging.send(message);
    logger.info(`FCM Notificación de nueva carrera enviada con éxito a ${driver.name} (MsgId: ${response})`);
  } catch (fcmError) {
    logger.warn(`No se pudo enviar notificación FCM a ${driver?.name}: ${fcmError.message}`);
  }
}

// ============================================
// CONFIGURACIÓN DE LA APP
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
    methods: ["GET", "POST"]
  },
  // Railway proxy: evitar desconexiones silenciosas
  pingTimeout: 60000,        // 60s antes de considerar la conexión muerta
  pingInterval: 25000,       // ping cada 25s (< timeout del proxy Railway)
  transports: ['websocket', 'polling'],  // WebSocket primero, polling como fallback
  allowUpgrades: true,
  upgradeTimeout: 30000
});

const PORT = process.env.PORT || 3000;
const isDevelopment = process.env.NODE_ENV === 'development';

// ============================================
// MIDDLEWARE DE SEGURIDAD
// ============================================
app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "https://unpkg.com",
        "https://cdn.socket.io",
        "https://maps.googleapis.com",
        "https://*.googleapis.com",
        "https://apis.google.com",
        "https://www.gstatic.com",
        "https://*.gstatic.com"
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: [
        "'self'",
        "wss:",
        "ws:",
        "https:",
        "https://*.googleapis.com",
        "https://*.firebaseio.com",
        "https://*.cloudfunctions.net",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com"
      ],
      frameSrc: ["'self'", "https://*.firebaseapp.com", "https://accounts.google.com", "https://*.google.com"],
      childSrc: ["'self'", "https://*.firebaseapp.com", "https://accounts.google.com"]
    },
  },
}));

app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000000,
  skip: (req) => isDevelopment || process.env.NODE_ENV === 'test' || req.ip === '127.0.0.1' || req.ip === '::1',
  message: { error: 'Demasiadas solicitudes desde esta IP, intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files sin caché agresiva para cambios en tiempo real
app.use(express.static('public', {
  maxAge: 0,
  etag: false
}));

// Favicon handler
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ============================================
// ALMACENAMIENTO DE DATOS Y PERSISTENCIA
// ============================================
const rides = new Map();
const drivers = new Map();
const dispatchers = new Map();
const earnings = new Map();

const RIDES_FILE = path.join(__dirname, 'data', 'rides_cache.json');
const EARNINGS_FILE = path.join(__dirname, 'data', 'earnings_cache.json');

function loadRidesFromDisk() {
  try {
    if (fs.existsSync(RIDES_FILE)) {
      const data = fs.readFileSync(RIDES_FILE, 'utf8');
      const arr = JSON.parse(data);
      if (Array.isArray(arr)) {
        arr.forEach(r => {
          if (r && r.id) rides.set(r.id, r);
        });
        logger.info(`Persistencia: Cargadas ${rides.size} carreras previas desde el disco.`);

        // Recuperar y activar viajes programados cuyo tiempo venció durante el reinicio
        const now = Date.now();
        let activatedOnStartup = 0;
        rides.forEach(ride => {
          if (ride && ride.status === 'scheduled' && !ride.dispatchTriggered && ride.dispatchAt) {
            const dispatchTime = new Date(ride.dispatchAt).getTime();
            if (!isNaN(dispatchTime) && dispatchTime <= now) {
              ride.dispatchTriggered = true;
              ride.version = (ride.version || 1) + 1;
              ride.updatedAt = new Date().toISOString();
              ride.status = 'pending';
              activatedOnStartup++;
            }
          }
        });
        if (activatedOnStartup > 0) {
          saveRidesToDisk();
          logger.info(`Scheduler de inicio: Activadas ${activatedOnStartup} carreras programadas vencidas durante el reinicio.`);
        }
      }
    }
  } catch (err) {
    logger.warn('No se pudieron cargar carreras previas de disco:', err.message);
  }
}

function saveRidesToDisk() {
  try {
    const dir = path.dirname(RIDES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RIDES_FILE, JSON.stringify(Array.from(rides.values()), null, 2));
  } catch (err) {
    logger.warn('Error guardando carreras en disco:', err.message);
  }
}

function loadEarningsFromDisk() {
  try {
    if (fs.existsSync(EARNINGS_FILE)) {
      const data = fs.readFileSync(EARNINGS_FILE, 'utf8');
      const arr = JSON.parse(data);
      if (Array.isArray(arr)) {
        arr.forEach(e => {
          if (e && e.earningId) earnings.set(e.earningId, e);
        });
        logger.info(`Persistencia: Cargados ${earnings.size} registros de ganancias desde el disco.`);
      }
    }
  } catch (err) {
    logger.warn('No se pudieron cargar ganancias de disco:', err.message);
  }
}

function saveEarningsToDisk() {
  try {
    const dir = path.dirname(EARNINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(EARNINGS_FILE, JSON.stringify(Array.from(earnings.values()), null, 2));
  } catch (err) {
    logger.warn('Error guardando ganancias en disco:', err.message);
  }
}

async function syncEarningToFirestore(earning) {
  try {
    const admin = require('firebase-admin');
    const db = typeof admin.firestore === 'function' ? admin.firestore() : null;
    if (db) {
      await db.collection('driver_earnings').doc(earning.earningId).set(earning, { merge: true });
    }
  } catch (e) {
    // Fallback silencioso si no hay credenciales de Firestore
  }
}

function getDriverFinancialSummary(driverIdentifier) {
  const now = new Date();
  
  // Inicio de hoy (00:00:00.000)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  
  // Inicio de semana (Lunes de la semana en curso 00:00:00.000)
  const currentDay = now.getDay(); // 0 = Domingo, 1 = Lunes, ...
  const diffToMonday = (currentDay === 0 ? -6 : 1) - currentDay;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0, 0);

  // Inicio de mes (Día 1, 00:00:00.000)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  let todayTotal = 0, todayTrips = 0;
  let weekTotal = 0, weekTrips = 0;
  let monthTotal = 0, monthTrips = 0;
  let allTimeTotal = 0, allTimeTrips = 0;

  earnings.forEach(e => {
    const matchesDriver = e.driverId === driverIdentifier || 
                          e.driverSocketId === driverIdentifier ||
                          (e.driverName && e.driverName.toLowerCase() === driverIdentifier.toLowerCase());
    if (!matchesDriver) return;

    if (e.status === 'completed') {
      const completedDate = new Date(e.completedAt || e.createdAt);
      const amount = Number(e.driverEarnings) || 0;

      allTimeTotal += amount;
      allTimeTrips += 1;

      if (completedDate >= startOfToday) {
        todayTotal += amount;
        todayTrips += 1;
      }
      if (completedDate >= startOfWeek) {
        weekTotal += amount;
        weekTrips += 1;
      }
      if (completedDate >= startOfMonth) {
        monthTotal += amount;
        monthTrips += 1;
      }
    }
  });

  return {
    today: {
      total: Number(todayTotal.toFixed(2)),
      tripCount: todayTrips,
      averageEarnings: todayTrips > 0 ? Number((todayTotal / todayTrips).toFixed(2)) : 0
    },
    week: {
      total: Number(weekTotal.toFixed(2)),
      tripCount: weekTrips,
      averageEarnings: weekTrips > 0 ? Number((weekTotal / weekTrips).toFixed(2)) : 0
    },
    month: {
      total: Number(monthTotal.toFixed(2)),
      tripCount: monthTrips,
      averageEarnings: monthTrips > 0 ? Number((monthTotal / monthTrips).toFixed(2)) : 0
    },
    allTime: {
      total: Number(allTimeTotal.toFixed(2)),
      tripCount: allTimeTrips,
      averageEarnings: allTimeTrips > 0 ? Number((allTimeTotal / allTimeTrips).toFixed(2)) : 0
    },
    currency: 'USD'
  };
}

// Cargar carreras y ganancias guardadas al inicio
loadRidesFromDisk();
loadEarningsFromDisk();

// ============================================
// ESTADOS FORMALES DEL VIAJE (FASE 1)
// ============================================
const RIDE_STATES = {
  SCHEDULED: 'scheduled',
  REQUESTED: 'pending',
  OFFERED: 'offered',
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  DRIVER_EN_ROUTE: 'accepted',
  DRIVER_ARRIVED: 'arrived_at_pickup',
  WAITING_FOR_PASSENGER: 'arrived_at_pickup',
  TRIP_STARTED: 'in_progress',
  DRIVER_EN_ROUTE_TO_DESTINATION: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REASSIGNED: 'reassigned'
};

// ============================================
// RUTAS HTTP
// ============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dispatch/index-v2.html'));
});

app.get('/v1', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dispatch/index.html'));
});

app.get('/driver', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/driver/index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    drivers: drivers.size,
    rides: rides.size
  });
});

// ============================================
// API REST (FASE 5A & 5B - AUTENTICACIÓN Y RBAC)
// ============================================

// Subida segura de documentos y fotos a Backblaze B2 Cloud Storage (S3 API)
app.post('/api/storage/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se ha proporcionado ningún archivo para subir.' });
    }

    const userId = req.user?.uid || 'anonymous';
    const category = (req.body.category || 'doc').replace(/[^a-zA-Z0-9_-]/g, '');
    const originalName = req.file.originalname || 'document.jpg';
    const ext = path.extname(originalName) || '.jpg';
    const timestamp = Date.now();
    const key = `drivers/${userId}/${category}-${timestamp}${ext}`;

    const publicUrl = await uploadToB2(req.file.buffer, key, req.file.mimetype || 'image/jpeg');

    return res.status(200).json({
      success: true,
      url: publicUrl,
      key,
      category,
      size: req.file.size
    });
  } catch (error) {
    logger.error('Error en endpoint /api/storage/upload:', error);
    return res.status(500).json({ error: 'Error al subir archivo a Backblaze B2.' });
  }
});

app.get('/api/rides', requireAuth, requireRole('admin', 'dispatcher', 'supervisor'), (req, res) => {
  try {
    res.json(Array.from(rides.values()));
  } catch (error) {
    logger.error('Error fetching rides:', error);
    res.status(500).json({ error: 'Error al obtener carreras' });
  }
});

app.get('/api/drivers', requireAuth, requireRole('admin', 'dispatcher', 'supervisor'), (req, res) => {
  try {
    const showAll = req.query.all === 'true' || req.query.includeAll === 'true';
    const list = Array.from(drivers.values())
      .filter(d => showAll ? true : d.available)
      .map(d => ({
        id: d.id,
        driverId: d.driverId || d.userId || d.id,
        name: d.name,
        vehicle: d.vehicle,
        plate: d.plate,
        phone: d.phone || '',
        location: d.location || { lat: 0, lng: 0 },
        heading: d.heading || 0,
        available: d.available,
        isOnline: d.isOnline,
        status: d.status || (d.available ? 'available' : (d.currentRide ? 'busy' : 'offline')),
        currentRide: d.currentRide,
        lastUpdate: d.lastUpdate || d.connectedAt
      }));
    res.json(list);
  } catch (error) {
    logger.error('Error fetching drivers:', error);
    res.status(500).json({ error: 'Error al obtener conductores' });
  }
});

// ============================================
// GESTIÓN DE ROLES (ADMIN ONLY)
// ============================================
app.post('/api/admin/set-role', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { uid, role } = req.body || {};
    if (!uid || !role) {
      return res.status(400).json({ error: 'uid y role son requeridos' });
    }

    const normalizedRole = String(role).toLowerCase();
    const VALID_ROLES = ['admin', 'dispatcher', 'supervisor', 'driver'];
    if (!VALID_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: `Rol no válido. Debe ser uno de: ${VALID_ROLES.join(', ')}` });
    }

    if (firebaseAuthAdmin) {
      try {
        await firebaseAuthAdmin.setCustomUserClaims(uid, { role: normalizedRole });
        logger.info(`Custom Claims actualizados para UID ${uid} -> rol: ${normalizedRole}`);
      } catch (claimsErr) {
        logger.warn(`Firebase setCustomUserClaims note: ${claimsErr.message}`);
      }
    }

    res.json({
      success: true,
      uid,
      role: normalizedRole,
      message: `Rol ${normalizedRole} asignado exitosamente a ${uid}. El cliente debe refrescar su token.`
    });
  } catch (error) {
    logger.error('Error in /api/admin/set-role:', error);
    res.status(500).json({ error: 'Error al asignar rol' });
  }
});

// ============================================
// API FINANCIERA Y WALLET (FASE 3, 5A & 5B)
// ============================================
app.get('/api/drivers/:driverId/earnings', requireAuth, (req, res) => {
  try {
    const { driverId } = req.params;
    const authenticatedUid = req.user?.uid;
    const userRole = (req.user?.role || '').toLowerCase();

    const isStaff = userRole === 'admin' || userRole === 'dispatcher' || userRole === 'supervisor';
    const isOwner = userRole === 'driver' && authenticatedUid === driverId;

    if (!isStaff && !isOwner) {
      logger.warn(`Intento no autorizado de consultar ganancias: ${authenticatedUid} (${userRole}) intentó ver a ${driverId}`);
      return res.status(403).json({ error: 'Acceso denegado: No tienes autorización para consultar las ganancias de este conductor.' });
    }

    const summary = getDriverFinancialSummary(driverId);
    res.json(summary);
  } catch (error) {
    logger.error('Error fetching driver earnings:', error);
    res.status(500).json({ error: 'Error al obtener resumen de ganancias' });
  }
});

app.get('/api/drivers/:driverId/trips', requireAuth, (req, res) => {
  try {
    const { driverId } = req.params;
    const authenticatedUid = req.user?.uid;
    const userRole = (req.user?.role || '').toLowerCase();

    const isStaff = userRole === 'admin' || userRole === 'dispatcher' || userRole === 'supervisor';
    const isOwner = userRole === 'driver' && authenticatedUid === driverId;

    if (!isStaff && !isOwner) {
      logger.warn(`Intento no autorizado de consultar viajes: ${authenticatedUid} (${userRole}) intentó ver a ${driverId}`);
      return res.status(403).json({ error: 'Acceso denegado: No tienes autorización para consultar el historial de este conductor.' });
    }

    const statusFilter = (req.query.status || 'all').toLowerCase();
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // Buscar en earnings y en rides para este conductor
    let trips = [];
    earnings.forEach(e => {
      const matchesDriver = e.driverId === driverId || 
                            e.driverSocketId === driverId ||
                            (e.driverName && e.driverName.toLowerCase() === driverId.toLowerCase());
      if (matchesDriver) {
        if (statusFilter === 'all' || e.status === statusFilter) {
          trips.push(e);
        }
      }
    });

    // Ordenar más reciente primero
    trips.sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));

    const totalCount = trips.length;
    const paginatedTrips = trips.slice(offset, offset + limit);

    res.json({
      trips: paginatedTrips,
      totalCount,
      limit,
      offset,
      hasMore: (offset + limit) < totalCount,
      nextOffset: (offset + limit) < totalCount ? (offset + limit) : null
    });
  } catch (error) {
    logger.error('Error fetching driver trips:', error);
    res.status(500).json({ error: 'Error al obtener historial de viajes' });
  }
});

app.get('/api/drivers/:driverId/trips/:tripId', requireAuth, (req, res) => {
  try {
    const { driverId, tripId } = req.params;
    const authenticatedUid = req.user?.uid;
    const userRole = (req.user?.role || '').toLowerCase();

    const isStaff = userRole === 'admin' || userRole === 'dispatcher' || userRole === 'supervisor';
    const isOwner = userRole === 'driver' && authenticatedUid === driverId;

    if (!isStaff && !isOwner) {
      return res.status(403).json({ error: 'Acceso denegado: No tienes autorización para consultar este viaje.' });
    }

    const trip = Array.from(earnings.values()).find(e => e.rideId === tripId || e.earningId === tripId);
    if (!trip) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }

    const matchesDriver = trip.driverId === driverId || 
                          trip.driverSocketId === driverId ||
                          (trip.driverName && trip.driverName.toLowerCase() === driverId.toLowerCase());
    if (!matchesDriver && !isStaff) {
      return res.status(403).json({ error: 'Acceso denegado: Este viaje pertenece a otro conductor.' });
    }

    res.json(trip);
  } catch (error) {
    logger.error('Error fetching trip details:', error);
    res.status(500).json({ error: 'Error al obtener detalle del viaje' });
  }
});

// ============================================
// GESTIÓN DE TIMEOUTS DE OFERTA Y REASIGNACIÓN (FASE 5D)
// ============================================
const offerTimers = new Map();

function clearOfferTimeout(rideId) {
  if (offerTimers.has(rideId)) {
    clearTimeout(offerTimers.get(rideId));
    offerTimers.delete(rideId);
    logger.info(`Offer timer cancelado para carrera ${rideId}`);
  }
}

function startOfferTimeout(ride, driverId, timeoutMs = 15000) {
  clearOfferTimeout(ride.id);
  const timer = setTimeout(() => {
    offerTimers.delete(ride.id);
    const currentRide = rides.get(ride.id);
    if (!currentRide || ['accepted', 'in_progress', 'completed', 'cancelled'].includes(currentRide.status)) {
      return;
    }
    logger.info(`⏰ [SERVER TIMEOUT] Oferta de carrera ${ride.id} expiró tras ${timeoutMs}ms para el conductor ${driverId}`);
    
    // Registrar conductor como expirado
    currentRide.expiredDrivers = currentRide.expiredDrivers || [];
    if (!currentRide.expiredDrivers.includes(driverId)) {
      currentRide.expiredDrivers.push(driverId);
    }
    
    const driver = drivers.get(driverId);
    if (driver) {
      driver.available = true;
      driver.currentRide = null;
      drivers.set(driverId, driver);
      io.emit('driver:online', driver);
    }

    io.to(driverId).emit('ride:expired', {
      rideId: ride.id,
      driverId: driverId,
      message: 'El tiempo para aceptar esta carrera ha expirado.'
    });

    reassignNextAvailableDriver(currentRide);
  }, timeoutMs);

  offerTimers.set(ride.id, timer);
  logger.info(`Offer timer de ${timeoutMs}ms iniciado en servidor para carrera ${ride.id} -> conductor ${driverId}`);
}

function reassignNextAvailableDriver(ride) {
  if (!ride || ['completed', 'cancelled', 'in_progress', 'accepted'].includes(ride.status)) return;
  
  clearOfferTimeout(ride.id);

  const excludedIds = [
    ...(ride.rejectedDrivers || []),
    ...(ride.expiredDrivers || [])
  ];

  const availableDrivers = Array.from(drivers.values()).filter(d => 
    d.isOnline && 
    d.available && 
    !excludedIds.includes(d.id) &&
    !excludedIds.includes(d.userId) &&
    !excludedIds.includes(d.driverId)
  );

  if (availableDrivers.length > 0) {
    let nextDriver = availableDrivers[0];
    if (ride.pickup && typeof ride.pickup === 'object' && ride.pickup.lat && ride.pickup.lng) {
      let minDistance = Infinity;
      availableDrivers.forEach(d => {
        if (d.location && d.location.lat && d.location.lng) {
          const dist = calculateDistance(ride.pickup.lat, ride.pickup.lng, d.location.lat, d.location.lng);
          if (dist < minDistance) {
            minDistance = dist;
            nextDriver = d;
          }
        }
      });
    }

    ride.status = 'assigned';
    ride.assignedDriver = {
      id: nextDriver.id,
      name: nextDriver.name,
      vehicle: nextDriver.vehicle,
      phone: nextDriver.phone
    };
    ride.assignedDriverId = nextDriver.id;
    ride.driverId = nextDriver.id;
    ride.version = (ride.version || 1) + 1;
    ride.updatedAt = new Date().toISOString();

    nextDriver.status = 'offered';
    nextDriver.available = true;
    nextDriver.currentRide = ride.id;
    drivers.set(nextDriver.id, nextDriver);

    rides.set(ride.id, ride);
    saveRidesToDisk();

    io.to(nextDriver.id).emit('ride:new', ride);
    io.to(nextDriver.id).emit('ride:assigned', ride);
    sendFcmNotificationToDriver(nextDriver, ride);
    startOfferTimeout(ride, nextDriver.id, 15000);

    io.emit('ride:update', ride);
    io.emit('rides:update', Array.from(rides.values()));
    logger.info(`Carrera ${ride.id} reasignada automáticamente al siguiente conductor disponible: ${nextDriver.name}`);
  } else {
    ride.status = 'pending';
    ride.assignedDriver = null;
    ride.assignedDriverId = null;
    ride.driverId = null;
    ride.version = (ride.version || 1) + 1;
    ride.updatedAt = new Date().toISOString();

    rides.set(ride.id, ride);
    saveRidesToDisk();

    io.emit('ride:no_drivers_available', { rideId: ride.id, message: 'No hay más conductores disponibles para esta solicitud.' });
    io.emit('ride:update', ride);
    io.emit('rides:update', Array.from(rides.values()));
    logger.warn(`Carrera ${ride.id} sin más conductores disponibles. Estado cambiado a pending.`);
  }
}

// ============================================
// MOTOR DE DESPACHO Y ACTIVACIÓN (FASE 1 & FASE 4C-1)
// ============================================
function dispatchRide(ride) {
  if (!ride || ride.status === 'completed' || ride.status === 'cancelled') return;

  const targetDriverId = ride.assignedDriverId || ride.driverId || (ride.assignedDriver?.id);
  let assignedDriver = null;
  if (targetDriverId) {
    assignedDriver = drivers.get(targetDriverId) || 
                     Array.from(drivers.values()).find(d => d.id === targetDriverId || d.userId === targetDriverId || d.driverId === targetDriverId);
  }

  if (assignedDriver) {
    ride.status = 'assigned';
    ride.assignedDriver = {
      id: assignedDriver.id,
      name: assignedDriver.name,
      vehicle: assignedDriver.vehicle,
      phone: assignedDriver.phone
    };
    ride.driverId = assignedDriver.id;

    assignedDriver.status = 'offered';
    assignedDriver.available = true;
    assignedDriver.currentRide = ride.id;
    drivers.set(assignedDriver.id, assignedDriver);
    io.emit('driver:status_change', {
      driverId: assignedDriver.id,
      status: 'offered',
      available: true,
      currentRideId: ride.id
    });

    // Enviar directamente al taxista elegido (Socket.io + FCM)
    io.to(assignedDriver.id).emit('ride:new', ride);
    io.to(assignedDriver.id).emit('ride:assigned', ride);
    sendFcmNotificationToDriver(assignedDriver, ride);
    startOfferTimeout(ride, assignedDriver.id, 15000);
    logger.info(`Carrera ${ride.id} despachada y asignada al taxista ${assignedDriver.name}`);
  } else {
    ride.status = 'pending';
    // Enviar únicamente a taxistas activos y disponibles
    const nearbyDrivers = findNearbyDrivers(ride.pickup, 15);
    const availableNearby = nearbyDrivers.filter(d => d.available && d.isOnline);
    if (availableNearby.length > 0) {
      availableNearby.forEach(driver => {
        io.to(driver.id).emit('ride:new', ride);
        sendFcmNotificationToDriver(driver, ride);
      });
    } else {
      drivers.forEach(driver => {
        if (driver.available && driver.isOnline) {
          io.to(driver.id).emit('ride:new', ride);
          sendFcmNotificationToDriver(driver, ride);
        }
      });
    }
    logger.info(`Carrera ${ride.id} despachada como pendiente a la flota activa.`);
  }

  rides.set(ride.id, ride);
  saveRidesToDisk();
  io.emit('ride:update', ride);
  io.emit('rides:update', Array.from(rides.values()));
}

// SCHEDULER DE VIAJES PROGRAMADOS (FASE 4C-1)
function checkScheduledRides() {
  const now = Date.now();
  rides.forEach(ride => {
    if (ride && ride.status === 'scheduled' && !ride.dispatchTriggered && ride.dispatchAt) {
      const dispatchTime = new Date(ride.dispatchAt).getTime();
      if (!isNaN(dispatchTime) && dispatchTime <= now) {
        // Bloqueo atómico contra doble despacho
        ride.dispatchTriggered = true;
        ride.version = (ride.version || 1) + 1;
        ride.updatedAt = new Date().toISOString();
        logger.info(`Scheduler: Activando viaje programado ${ride.id} (Recogida programada: ${ride.scheduledAt}, LeadTime: ${ride.dispatchLeadTime} min)`);
        dispatchRide(ride);
      }
    }
  });
}

// Intervalo periódico nativo del scheduler (cada 5 segundos)
const scheduledRidesInterval = setInterval(checkScheduledRides, 5000);

// ============================================
// SOCKET.IO - HANDSHAKE AUTHENTICATION (FASE 5A)
// ============================================
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || 
                  (socket.handshake.headers?.authorization && socket.handshake.headers.authorization.startsWith('Bearer ') ? socket.handshake.headers.authorization.slice(7) : null);

    if (!token) {
      logger.warn(`Conexión Socket.io rechazada (${socket.id}): Falta token de autenticación.`);
      return next(new Error('Unauthorized: Authentication token required'));
    }

    const user = await verifyAuthToken(token);
    if (!user || !user.uid) {
      logger.warn(`Conexión Socket.io rechazada (${socket.id}): Token inválido o expirado.`);
      return next(new Error('Unauthorized: Invalid or expired token'));
    }

    socket.user = user;
    logger.info(`Socket.io handshake autenticado con éxito: ${user.uid} (Socket: ${socket.id})`);
    next();
  } catch (err) {
    logger.error('Error en middleware de autenticación Socket.io:', err);
    return next(new Error('Unauthorized'));
  }
});

// ============================================
// SOCKET.IO - EVENTOS EN TIEMPO REAL
// ============================================
io.on('connection', (socket) => {
  logger.info(`Nueva conexión autenticada: ${socket.id} (UID: ${socket.user?.uid})`);

  // Enviar inmediatamente todas las carreras y conductores a la conexión autenticada
  socket.emit('rides:update', Array.from(rides.values()));
  socket.emit('drivers:update', Array.from(drivers.values()));

  socket.on('rides:get', () => {
    socket.emit('rides:update', Array.from(rides.values()));
  });

  socket.on('drivers:get', () => {
    socket.emit('drivers:update', Array.from(drivers.values()));
  });

  // ============================================
  // REGISTRO DE USUARIOS (RBAC)
  // ============================================
  socket.on('register:dispatcher', (data) => {
    try {
      const userRole = (socket.user?.role || '').toLowerCase();
      const ALLOWED = ['admin', 'dispatcher', 'supervisor'];
      if (!ALLOWED.includes(userRole)) {
        logger.warn(`Intento no autorizado de registrarse como despachador: ${socket.user?.uid} con rol ${userRole}`);
        socket.emit('error', { message: 'Acceso denegado: Se requiere rol de despachador, supervisor o administrador.' });
        return;
      }

      dispatchers.set(socket.id, {
        id: socket.id,
        uid: socket.user?.uid,
        role: userRole,
        name: data.name || socket.user?.name || 'Despachador',
        connectedAt: new Date()
      });
      logger.info(`Despachador conectado: ${data.name || socket.user?.name || 'Despachador'} (UID: ${socket.user?.uid}, Rol: ${userRole})`);
      socket.emit('registered', { type: 'dispatcher', id: socket.id, uid: socket.user?.uid, role: userRole });
    } catch (error) {
      logger.error('Error registering dispatcher:', error);
      socket.emit('error', { message: 'Error al registrar despachador' });
    }
  });

  socket.on('register:driver', (data) => {
    try {
      const authenticatedUid = socket.user?.uid;
      if (!authenticatedUid) {
        logger.warn(`Conexión sin UID intentó registrarse como conductor: ${socket.id}`);
        socket.emit('error', { message: 'Acceso denegado: Usuario no autenticado.' });
        return;
      }

      // Validar identidad contra suplantación
      if ((data.driverId && data.driverId !== authenticatedUid) || (data.userId && data.userId !== authenticatedUid)) {
        logger.warn(`Intento de suplantación en register:driver: Socket ${socket.id} (${authenticatedUid}) intentó registrarse como ${data.driverId || data.userId}`);
        socket.emit('error', { message: 'Identidad no válida. driverId debe coincidir con el usuario autenticado.' });
        return;
      }

      // Normalización robusta de datos de conductor
      const driverName = data.name || socket.user?.name || 'Socio Conductor';
      let vehicleStr = 'Vehículo Taxi';
      let plateStr = 'Placa Taxi';
      if (typeof data.vehicle === 'string' && data.vehicle.trim()) {
        vehicleStr = data.vehicle.trim();
      } else if (data.vehicle && typeof data.vehicle === 'object') {
        vehicleStr = `${data.vehicle.brand || ''} ${data.vehicle.model || ''}`.trim() || 'Vehículo Taxi';
        plateStr = data.vehicle.plate || plateStr;
      }
      if (data.plate && typeof data.plate === 'string' && data.plate.trim()) {
        plateStr = data.plate.trim();
      }

      const driverUid = authenticatedUid;

      // Buscar si el conductor ya tenía una carrera activa en curso para recuperar la sesión
      let existingActiveRide = null;
      rides.forEach((r) => {
        const isOngoing = r.status === 'accepted' || r.status === 'arrived_at_pickup' || r.status === 'in_progress';
        if (isOngoing) {
          if (r.driverId === socket.id || 
              (driverUid && (r.driverId === driverUid || r.assignedDriver?.id === driverUid || r.assignedDriver?.driverId === driverUid))) {
            existingActiveRide = r;
          }
        }
      });

      // Preservar FCM token si ya había un registro previo
      const prevDriver = drivers.get(driverUid);
      const fcmToken = data.fcmToken || prevDriver?.fcmToken || null;

      const driver = {
        id: driverUid,          // ID estable = UID de Firebase (no cambia en reconexiones)
        socketId: socket.id,    // Socket actual (cambia en cada reconexión)
        driverId: driverUid,
        userId: driverUid,
        name: driverName,
        vehicle: vehicleStr,
        plate: plateStr,
        phone: data.phone || socket.user?.phone || '',
        location: data.location || prevDriver?.location || { lat: 0, lng: 0 },
        heading: data.heading || prevDriver?.heading || 0,
        available: existingActiveRide ? false : true,
        currentRide: existingActiveRide ? existingActiveRide.id : null,
        fcmToken,
        isOnline: true,
        status: existingActiveRide ? 'busy' : 'available',
        connectedAt: new Date(),
        lastUpdate: new Date()
      };

      // Unirse a la sala de UID permanente para garantizar que ride:new siempre llegue
      socket.join(driverUid);

      // Indexar por UID estable
      drivers.set(driverUid, driver);

      // Mantener también el mapeo socket → uid para el cleanup en disconnect
      socket._driverUid = driverUid;

      logger.info(`Taxista conectado y autenticado: ${driverName} (Socket: ${socket.id}, UID: ${driverUid})${fcmToken ? ' [FCM Token OK]' : ''}${existingActiveRide ? ' [Recuperando carrera: ' + existingActiveRide.id + ']' : ''}`);
      socket.emit('registered', { type: 'driver', id: driverUid, driver, uid: driverUid });

      // Señal inmediata a la Central de Despacho
      io.emit('driver:online', driver);
      io.emit('driver:status_change', {
        driverId: driverUid,
        id: driverUid,
        status: driver.status,
        available: driver.available,
        isOnline: true
      });
      io.emit('drivers:update', Array.from(drivers.values()));

      // Si tenía una carrera en curso, sincronizar y recuperarla de inmediato en el móvil
      if (existingActiveRide) {
        existingActiveRide.driverId = driverUid;
        if (existingActiveRide.assignedDriver) existingActiveRide.assignedDriver.id = driverUid;
        rides.set(existingActiveRide.id, existingActiveRide);
        saveRidesToDisk();
        socket.emit('ride:assigned', existingActiveRide);
        socket.emit('ride:update', existingActiveRide);
      }
    } catch (error) {
      logger.error('Error registering driver:', error);
      socket.emit('error', { message: 'Error al registrar conductor' });
    }
  });

  socket.on('driver:fcm_token', ({ driverId, fcmToken }) => {
    try {
      const uid = socket._driverUid || driverId;
      const driver = (uid && drivers.get(uid)) || drivers.get(socket.id);
      if (driver && fcmToken) {
        driver.fcmToken = fcmToken;
        const key = driver.id || uid;
        drivers.set(key, driver);
        logger.info(`FCM Token actualizado para ${driver.name}: ${fcmToken.slice(0, 15)}...`);
      }
    } catch (e) {
      logger.error('Error en driver:fcm_token:', e);
    }
  });

  // ============================================
  // GEOLOCALIZACIÓN
  // ============================================
  socket.on('driver:location', (location) => {
    try {
      const uid = socket._driverUid;
      const driver = (uid && drivers.get(uid)) || drivers.get(socket.id);
      if (driver) {
        // Validar coordenadas
        if (!location ||
          typeof location.lat !== 'number' ||
          typeof location.lng !== 'number' ||
          Math.abs(location.lat) > 90 ||
          Math.abs(location.lng) > 180) {
          socket.emit('error', { message: 'Coordenadas inválidas' });
          return;
        }

        driver.location = location;
        driver.heading = location.heading !== undefined ? location.heading : (driver.heading || 0);
        driver.lastUpdate = new Date();
        drivers.set(driver.id || uid || socket.id, driver);

        io.emit('driver:location_update', {
          driverId: driver.driverId || driver.userId || driver.id,
          userId: driver.driverId || driver.userId,
          name: driver.name,
          location,
          heading: driver.heading,
          status: driver.status || (driver.available ? 'available' : (driver.currentRide ? 'busy' : 'offline')),
          available: driver.available,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Error updating driver location:', error);
    }
  });

  // ============================================
  // DISPONIBILIDAD
  // ============================================
  socket.on('driver:availability', (data) => {
    try {
      const uid = socket._driverUid || data?.driverId || data?.userId || socket.user?.uid;
      let driver = (uid && drivers.get(uid)) || drivers.get(socket.id);
      const isAvail = Boolean(data?.available);

      if (driver) {
        driver.available = isAvail;
        driver.isOnline = isAvail;
        driver.status = isAvail ? 'available' : 'offline';
        if (data?.location) {
          driver.location = data.location;
        }
        driver.lastUpdate = new Date();
        const key = driver.id || uid;

        if (isAvail) {
          drivers.set(key, driver);
          logger.info(`Taxista disponible y online: ${driver.name} (UID: ${key})`);
          io.emit('driver:online', driver);
          io.emit('driver:status_change', {
            driverId: key,
            id: key,
            status: 'available',
            available: true,
            isOnline: true
          });
        } else {
          logger.info(`Taxista no disponible / desconectado: ${driver.name} (UID: ${key})`);
          if (!driver.currentRide) {
            drivers.delete(key);
            if (drivers.has(socket.id)) drivers.delete(socket.id);
          } else {
            drivers.set(key, driver);
          }
          io.emit('driver:offline', { driverId: key, id: key });
          io.emit('driver:status_change', {
            driverId: key,
            id: key,
            status: 'offline',
            available: false,
            isOnline: false
          });
        }
        io.emit('drivers:update', Array.from(drivers.values()));
      }
    } catch (error) {
      logger.error('Error updating driver availability:', error);
    }
  });

  // ============================================
  // GESTIÓN DE CARRERAS (RBAC: ADMIN / DISPATCHER)
  // ============================================
  socket.on('ride:create', (rideData) => {
    try {
      const userRole = (socket.user?.role || '').toLowerCase();
      const ALLOWED = ['admin', 'dispatcher', 'supervisor'];
      if (!ALLOWED.includes(userRole)) {
        logger.warn(`Intento no autorizado de crear carrera: ${socket.user?.uid} con rol ${userRole}`);
        socket.emit('error', { message: 'Acceso denegado: No tienes permisos para crear carreras.' });
        return;
      }
      // Normalizar datos de recogida y destino
      const pickupAddress = typeof rideData.pickup === 'string' ? rideData.pickup : (rideData.pickup?.address || '');
      const destAddress = typeof rideData.destination === 'string' ? rideData.destination : (rideData.destination?.address || '');

      if (!pickupAddress || !destAddress) {
        socket.emit('error', { message: 'Por favor ingresa punto de recogida y destino' });
        return;
      }

      const isScheduled = Boolean(rideData.isScheduled);
      let scheduledAtIso = null;
      let dispatchAtIso = null;
      let leadTimeMinutes = 15;

      if (isScheduled) {
        if (!rideData.scheduledAt) {
          socket.emit('error', { message: 'La fecha y hora de la reserva (scheduledAt) es requerida' });
          return;
        }

        const scheduledTime = new Date(rideData.scheduledAt).getTime();
        if (isNaN(scheduledTime)) {
          socket.emit('error', { message: 'La fecha y hora de la reserva (scheduledAt) no tiene un formato ISO válido' });
          return;
        }

        const now = Date.now();
        if (scheduledTime <= now) {
          socket.emit('error', { message: 'La fecha programada no puede ser en el pasado' });
          return;
        }

        const diffMinutes = (scheduledTime - now) / (60 * 1000);
        if (diffMinutes < 10) {
          socket.emit('error', { message: 'La fecha programada debe tener al menos 10 minutos de anticipación' });
          return;
        }

        leadTimeMinutes = Number(rideData.dispatchLeadTime) > 0 ? Number(rideData.dispatchLeadTime) : 15;
        const dispatchTimeMs = scheduledTime - (leadTimeMinutes * 60 * 1000);
        dispatchAtIso = new Date(dispatchTimeMs).toISOString();
        scheduledAtIso = new Date(scheduledTime).toISOString();
      }

      // Validaciones de pasajeros y tarifa manual
      if (rideData.passengerCount !== undefined && Number(rideData.passengerCount) <= 0) {
        socket.emit('error', { message: 'La cantidad de pasajeros debe ser al menos 1' });
        return;
      }

      if (rideData.isManualFare && rideData.manualFare !== undefined && Number(rideData.manualFare) < 0) {
        socket.emit('error', { message: 'La tarifa manual no puede ser un valor negativo' });
        return;
      }

      const isManualFare = Boolean(rideData.isManualFare);
      const manualFareVal = (rideData.manualFare !== undefined && rideData.manualFare !== null && !isNaN(Number(rideData.manualFare))) ? Number(rideData.manualFare) : null;
      const finalFare = (isManualFare && manualFareVal !== null && manualFareVal >= 0) ? manualFareVal : (Number(rideData.fare) || 15.00);

      const pickupObj = typeof rideData.pickup === 'object' ? rideData.pickup : { address: pickupAddress, lat: 0, lng: 0 };
      const destObj = typeof rideData.destination === 'object' ? rideData.destination : { address: destAddress, lat: 0, lng: 0 };

      // Verificar si se eligió un taxista manualmente
      let assignedDriver = null;
      const targetDriverId = rideData.assignedDriverId || rideData.driverId || (rideData.assignedDriver && rideData.assignedDriver.id);
      if (targetDriverId) {
        assignedDriver = drivers.get(targetDriverId) || 
                         Array.from(drivers.values()).find(d => d.id === targetDriverId || d.userId === targetDriverId || d.driverId === targetDriverId);
      }

      const nowIso = new Date().toISOString();
      const ride = {
        id: rideData.id || uuidv4(),
        pickup: pickupObj,
        destination: destObj,
        customerName: rideData.customerName || 'Cliente en Espera',
        customerPhone: rideData.customerPhone || '',
        fare: finalFare,
        isManualFare: isManualFare,
        manualFare: manualFareVal,
        passengerCount: Math.max(1, parseInt(rideData.passengerCount) || 1),
        vehicleCategory: rideData.vehicleCategory || 'standard',
        paymentMethod: rideData.paymentMethod || 'cash',
        distance: rideData.distance || 5.0,
        duration: rideData.duration || 15,
        notes: rideData.notes || '',
        status: isScheduled ? 'scheduled' : (assignedDriver ? 'assigned' : 'pending'),
        isScheduled: isScheduled,
        scheduledAt: scheduledAtIso,
        dispatchLeadTime: isScheduled ? leadTimeMinutes : 0,
        dispatchAt: dispatchAtIso,
        dispatchTriggered: false,
        assignedDriver: assignedDriver ? {
          id: assignedDriver.id,
          name: assignedDriver.name,
          vehicle: assignedDriver.vehicle,
          phone: assignedDriver.phone
        } : null,
        assignedDriverId: assignedDriver ? assignedDriver.id : null,
        driverId: (!isScheduled && assignedDriver) ? assignedDriver.id : null,
        rejectedDrivers: [],
        expiredDrivers: [],
        cancellationHistory: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        version: 1,
        dispatcherId: socket.id
      };

      rides.set(ride.id, ride);
      saveRidesToDisk();
      logger.info(`Nueva carrera ${isScheduled ? 'PROGRAMADA' : 'INMEDIATA'} creada: ${ride.id} (${pickupAddress} -> ${destAddress})${assignedDriver ? ' [Pre-asignada a ' + assignedDriver.name + ']' : ''}`);

      if (isScheduled) {
        // Para carreras programadas: NO despachar de inmediato, registrar y confirmar
        socket.emit('ride:created', ride);
        io.emit('ride:update', ride);
        io.emit('rides:update', Array.from(rides.values()));
      } else {
        // Para carreras inmediatas (con o sin taxista pre-asignado): emitir creación y despachar a los taxistas
        socket.emit('ride:created', ride);
        dispatchRide(ride);
      }
    } catch (error) {
      logger.error('Error creating ride:', error);
      socket.emit('error', { message: 'Error al crear carrera: ' + (error.message || error) });
    }
  });

  // ============================================
  // EDICIÓN SEGURA DE SERVICIOS (RBAC: ADMIN / DISPATCHER)
  // ============================================
  socket.on('ride:edit', ({ rideId, version: expectedVersion, changes }) => {
    try {
      const userRole = (socket.user?.role || '').toLowerCase();
      const ALLOWED = ['admin', 'dispatcher'];
      if (!ALLOWED.includes(userRole)) {
        logger.warn(`Intento no autorizado de editar carrera: ${socket.user?.uid} con rol ${userRole}`);
        socket.emit('error', { message: 'Acceso denegado: No tienes permisos para editar carreras.' });
        return;
      }

      if (!rideId || !changes || typeof changes !== 'object') {
        socket.emit('error', { message: 'Parámetros de edición inválidos' });
        return;
      }

      const ride = rides.get(rideId);
      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      // 1. Control de Estados Permitidos
      const currentStatus = ride.status;
      const BLOCKED_STATES = ['in_progress', 'completed', 'cancelled', 'expired'];
      if (BLOCKED_STATES.includes(currentStatus)) {
        socket.emit('error', {
          code: 'STATUS_LOCKED',
          message: `El servicio se encuentra en estado "${currentStatus}" y no puede ser editado.`
        });
        return;
      }

      // 2. Control de Concurrencia Optimista
      if (expectedVersion !== undefined && expectedVersion !== null) {
        const rideVer = Number(ride.version || 1);
        if (Number(expectedVersion) !== rideVer) {
          socket.emit('error', {
            code: 'CONCURRENCY_CONFLICT',
            message: `El servicio cambió mientras lo estabas editando (versión actual: ${rideVer}, esperada: ${expectedVersion}). Recarga la información antes de guardar.`
          });
          return;
        }
      }

      // 3. Matriz de Permisos por Estado
      const CRITICAL_FIELDS = ['pickup', 'destination', 'scheduledAt', 'dispatchLeadTime', 'vehicleCategory', 'fare', 'isManualFare', 'manualFare'];

      if (['offered', 'assigned'].includes(currentStatus)) {
        const attemptedCritical = CRITICAL_FIELDS.filter(f => changes[f] !== undefined);
        if (attemptedCritical.length > 0) {
          socket.emit('error', {
            code: 'CRITICAL_FIELD_LOCKED',
            message: `Este servicio ya tiene una oferta/asignación activa a un conductor y los campos críticos (${attemptedCritical.join(', ')}) no pueden modificarse en este momento.`
          });
          return;
        }
      }

      if (['accepted', 'arrived_at_pickup'].includes(currentStatus)) {
        const ALLOWED_IN_ACCEPTED = ['customerName', 'customerPhone', 'notes'];
        const attemptedDisallowed = Object.keys(changes).filter(f => !ALLOWED_IN_ACCEPTED.includes(f));
        if (attemptedDisallowed.length > 0) {
          socket.emit('error', {
            code: 'OPERATIONAL_LOCKED',
            message: `El servicio ya está en proceso de recogida por el conductor. Solo se permiten notas o teléfono de contacto.`
          });
          return;
        }
      }

      // 4. Bloqueo de Campos Protegidos del Sistema
      const PROTECTED_SYSTEM_FIELDS = [
        'status', 'version', 'createdAt', 'updatedAt', 'dispatchTriggered', 'dispatchAt',
        'driverId', 'assignedDriver', 'assignedDriverId', 'acceptedAt', 'arrivedAt',
        'startedAt', 'completedAt', 'cancellationHistory', 'rejectedDrivers', 'expiredDrivers'
      ];
      for (const field of PROTECTED_SYSTEM_FIELDS) {
        if (changes[field] !== undefined) {
          socket.emit('error', {
            code: 'PROTECTED_FIELD',
            message: `El campo protegido "${field}" no puede modificarse desde la edición.`
          });
          return;
        }
      }

      // 5. Validaciones Específicas de Campos
      // Pasajeros
      if (changes.passengerCount !== undefined) {
        const pCount = parseInt(changes.passengerCount);
        if (isNaN(pCount) || pCount < 1 || pCount > 8) {
          socket.emit('error', { message: 'La cantidad de pasajeros debe estar entre 1 y 8' });
          return;
        }
      }

      // Tarifa Manual
      if (changes.isManualFare && changes.manualFare !== undefined) {
        const mFare = parseFloat(changes.manualFare);
        if (isNaN(mFare) || mFare < 0) {
          socket.emit('error', { message: 'La tarifa manual no puede ser un valor negativo' });
          return;
        }
      }

      // Origen / Destino
      if (changes.pickup !== undefined) {
        if (typeof changes.pickup === 'string') {
          if (!changes.pickup.trim()) {
            socket.emit('error', { message: 'La dirección de recogida no puede estar vacía' });
            return;
          }
        } else if (typeof changes.pickup === 'object') {
          if (!changes.pickup.address || !changes.pickup.address.trim()) {
            socket.emit('error', { message: 'La dirección de recogida no puede estar vacía' });
            return;
          }
        }
      }

      if (changes.destination !== undefined) {
        if (typeof changes.destination === 'string') {
          if (!changes.destination.trim()) {
            socket.emit('error', { message: 'La dirección de destino no puede estar vacía' });
            return;
          }
        } else if (typeof changes.destination === 'object') {
          if (!changes.destination.address || !changes.destination.address.trim()) {
            socket.emit('error', { message: 'La dirección de destino no puede estar vacía' });
            return;
          }
        }
      }

      // Modificación de Fecha / Hora en reservas scheduled
      let newDispatchAtIso = ride.dispatchAt;
      let newScheduledAtIso = ride.scheduledAt;
      let newLeadTime = ride.dispatchLeadTime;

      if (ride.isScheduled && ride.status === 'scheduled') {
        if (changes.scheduledAt !== undefined) {
          if (!changes.scheduledAt) {
            socket.emit('error', { message: 'La fecha y hora de la reserva es requerida' });
            return;
          }
          const schedTime = new Date(changes.scheduledAt).getTime();
          if (isNaN(schedTime)) {
            socket.emit('error', { message: 'La fecha y hora de la reserva no tiene un formato ISO válido' });
            return;
          }
          const now = Date.now();
          if (schedTime <= now) {
            socket.emit('error', { message: 'La fecha programada no puede ser en el pasado' });
            return;
          }
          const diffMinutes = (schedTime - now) / (60 * 1000);
          if (diffMinutes < 10) {
            socket.emit('error', { message: 'La fecha programada debe tener al menos 10 minutos de anticipación' });
            return;
          }

          newScheduledAtIso = new Date(schedTime).toISOString();
        }

        if (changes.dispatchLeadTime !== undefined) {
          const lt = parseInt(changes.dispatchLeadTime);
          if (lt > 0) newLeadTime = lt;
        }

        // Recalcular dispatchAt si cambió scheduledAt o dispatchLeadTime
        if (changes.scheduledAt !== undefined || changes.dispatchLeadTime !== undefined) {
          const sTimeMs = new Date(newScheduledAtIso).getTime();
          newDispatchAtIso = new Date(sTimeMs - (newLeadTime * 60 * 1000)).toISOString();
        }
      }

      // 6. Aplicar Cambios de Forma Atómica
      if (changes.customerName !== undefined) ride.customerName = String(changes.customerName).trim() || 'Cliente en Espera';
      if (changes.customerPhone !== undefined) ride.customerPhone = String(changes.customerPhone).trim();
      if (changes.notes !== undefined) ride.notes = String(changes.notes).trim();
      if (changes.passengerCount !== undefined) ride.passengerCount = Math.max(1, parseInt(changes.passengerCount) || 1);
      if (changes.vehicleCategory !== undefined) ride.vehicleCategory = String(changes.vehicleCategory);
      if (changes.paymentMethod !== undefined) ride.paymentMethod = String(changes.paymentMethod);

      if (changes.pickup !== undefined) {
        ride.pickup = typeof changes.pickup === 'object' ? changes.pickup : { address: changes.pickup, lat: ride.pickup?.lat || 0, lng: ride.pickup?.lng || 0 };
      }
      if (changes.destination !== undefined) {
        ride.destination = typeof changes.destination === 'object' ? changes.destination : { address: changes.destination, lat: ride.destination?.lat || 0, lng: ride.destination?.lng || 0 };
      }

      if (changes.distance !== undefined) ride.distance = parseFloat(changes.distance) || ride.distance;
      if (changes.duration !== undefined) ride.duration = parseInt(changes.duration) || ride.duration;

      if (changes.isManualFare !== undefined) {
        ride.isManualFare = Boolean(changes.isManualFare);
        if (ride.isManualFare) {
          if (changes.manualFare !== undefined && changes.manualFare !== null) {
            ride.manualFare = parseFloat(changes.manualFare);
            ride.fare = ride.manualFare;
          }
        } else {
          ride.manualFare = null;
          if (changes.fare !== undefined) {
            ride.fare = parseFloat(changes.fare) || 15.00;
          }
        }
      } else if (changes.manualFare !== undefined && ride.isManualFare) {
        ride.manualFare = parseFloat(changes.manualFare);
        ride.fare = ride.manualFare;
      } else if (changes.fare !== undefined && !ride.isManualFare) {
        ride.fare = parseFloat(changes.fare) || ride.fare;
      }

      if (ride.isScheduled && ride.status === 'scheduled') {
        ride.scheduledAt = newScheduledAtIso;
        ride.dispatchLeadTime = newLeadTime;
        ride.dispatchAt = newDispatchAtIso;
        ride.dispatchTriggered = false; // Mantiene protección
      }

      // 7. Incrementar Versión y Actualizar Timestamp
      const prevVersion = ride.version || 1;
      ride.version = prevVersion + 1;
      ride.updatedAt = new Date().toISOString();

      rides.set(ride.id, ride);
      saveRidesToDisk();

      logger.info(`Carrera ${ride.id} editada exitosamente (v${prevVersion} -> v${ride.version}). Campos: ${Object.keys(changes).join(', ')}`);

      // 8. Confirmación y Emisión Socket.io
      socket.emit('ride:edited', ride);
      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));

    } catch (error) {
      logger.error('Error editing ride:', error);
      socket.emit('error', { message: 'Error al editar carrera: ' + (error.message || error) });
    }
  });

  socket.on('ride:assign', ({ rideId, driverId }) => {
    try {
      const userRole = (socket.user?.role || '').toLowerCase();
      const ALLOWED = ['admin', 'dispatcher', 'supervisor'];
      if (!ALLOWED.includes(userRole)) {
        logger.warn(`Intento no autorizado de asignar carrera: ${socket.user?.uid} con rol ${userRole}`);
        socket.emit('error', { message: 'Acceso denegado: No tienes permisos para asignar carreras.' });
        return;
      }

      const ride = rides.get(rideId);
      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      const driver = drivers.get(driverId) || Array.from(drivers.values()).find(d => d.id === driverId || d.driverId === driverId || d.userId === driverId);
      if (!driver) {
        socket.emit('error', { message: 'Taxista no encontrado o no conectado' });
        return;
      }

      ride.status = 'assigned';
      ride.assignedDriver = {
        id: driver.id,
        name: driver.name,
        vehicle: driver.vehicle,
        phone: driver.phone
      };
      ride.driverId = driver.id;
      rides.set(ride.id, ride);
      saveRidesToDisk();

      driver.status = 'offered';
      driver.available = true;
      driver.currentRide = ride.id;
      drivers.set(driver.id, driver);
      io.emit('driver:status_change', {
        driverId: driver.id,
        status: 'offered',
        available: true,
        currentRideId: ride.id
      });

      io.to(driver.id).emit('ride:new', ride);
      io.to(driver.id).emit('ride:assigned', ride);
      sendFcmNotificationToDriver(driver, ride);
      startOfferTimeout(ride, driver.id, 15000);

      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));

      logger.info(`Carrera ${rideId} asignada manualmente a ${driver.name}`);
    } catch (error) {
      logger.error('Error assigning ride:', error);
      socket.emit('error', { message: 'Error al asignar carrera' });
    }
  });

  socket.on('ride:unassign', ({ rideId, reason, reassignMode, newDriverId }) => {
    try {
      const userRole = (socket.user?.role || '').toLowerCase();
      const ALLOWED = ['admin', 'dispatcher', 'supervisor'];
      if (!ALLOWED.includes(userRole)) {
        logger.warn(`Intento no autorizado de desasignar/cancelar carrera: ${socket.user?.uid} con rol ${userRole}`);
        socket.emit('error', { message: 'Acceso denegado: No tienes permisos para desasignar o cancelar carreras.' });
        return;
      }

      const ride = rides.get(rideId);
      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      clearOfferTimeout(rideId);
      const prevDriver = ride.assignedDriver || ride.driver;
      const prevDriverId = ride.driverId || ride.assignedDriver?.id;

      // Liberar al taxista anterior y notificarle
      if (prevDriverId) {
        io.to(prevDriverId).emit('ride:cancelled', {
          rideId,
          reason: reason || 'Asignación cancelada por la central'
        });
        const d = drivers.get(prevDriverId) || Array.from(drivers.values()).find(x => x.id === prevDriverId || x.driverId === prevDriverId || x.userId === prevDriverId);
        if (d) {
          d.available = true;
          d.currentRide = null;
          drivers.set(d.id, d);
          io.emit('driver:online', d);
        }
      }

      ride.cancellationHistory = ride.cancellationHistory || [];
      ride.cancellationHistory.push({
        previousDriver: prevDriver?.name || 'Conductor previo',
        reason: reason || 'Cancelado por despachador',
        timestamp: new Date().toISOString()
      });

      if (reassignMode === 'auto') {
        // Reasignar automáticamente a otro taxista activo
        ride.status = 'pending';
        ride.assignedDriver = null;
        ride.driver = null;
        ride.driverId = null;

        // Difundir a la flota disponible activa
        drivers.forEach(driver => {
          if (driver.available && driver.id !== prevDriverId) {
            io.to(driver.id).emit('ride:new', ride);
          }
        });
        io.emit('ride:new', ride);
        logger.info(`Carrera ${rideId} desasignada por "${reason}". Reasignando automáticamente a la flota activa.`);
      } else if (reassignMode === 'manual' && newDriverId) {
        // Asignar inmediatamente a un taxista específico
        const newDriver = drivers.get(newDriverId) || Array.from(drivers.values()).find(d => d.id === newDriverId || d.driverId === newDriverId || d.userId === newDriverId);
        if (newDriver) {
          ride.status = 'assigned';
          ride.assignedDriver = {
            id: newDriver.id,
            name: newDriver.name,
            vehicle: newDriver.vehicle,
            phone: newDriver.phone
          };
          ride.driverId = newDriver.id;
          io.to(newDriver.id).emit('ride:new', ride);
          io.to(newDriver.id).emit('ride:assigned', ride);
          logger.info(`Carrera ${rideId} reasignada manualmente al taxista ${newDriver.name}. Motivo anterior: ${reason}`);
        } else {
          ride.status = 'pending';
          ride.assignedDriver = null;
          ride.driverId = null;
          io.emit('ride:new', ride);
        }
      } else {
        // Cancelar carrera por completo
        ride.status = 'cancelled';
        ride.cancelledAt = new Date();
        ride.cancelReason = reason;
        ride.dispatchTriggered = true;
        ride.updatedAt = new Date().toISOString();
        ride.version = (ride.version || 1) + 1;
        logger.info(`Carrera ${rideId} cancelada definitivamente. Motivo: ${reason}`);
      }

      rides.set(ride.id, ride);
      saveRidesToDisk();

      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));
    } catch (error) {
      logger.error('Error in ride:unassign:', error);
      socket.emit('error', { message: 'Error al cancelar asignación' });
    }
  });

  // ============================================
  // RECHAZO DE CARRERA POR EL CONDUCTOR
  // ============================================
  socket.on('ride:rejected', (data) => {
    try {
      const rideId = typeof data === 'string' ? data : data?.rideId;
      const reason = data?.reason || 'Rechazado por el conductor';
      const ride = rides.get(rideId);
      const driver = drivers.get(socket.id);

      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      // El conductor debe seguir disponible
      if (driver) {
        driver.available = true;
        driver.currentRide = null;
        drivers.set(socket.id, driver);
        io.emit('driver:online', driver);
      }

      ride.rejectedDrivers = ride.rejectedDrivers || [];
      if (!ride.rejectedDrivers.includes(socket.id)) {
        ride.rejectedDrivers.push(socket.id);
      }
      if (driver?.userId && !ride.rejectedDrivers.includes(driver.userId)) {
        ride.rejectedDrivers.push(driver.userId);
      }

      ride.cancellationHistory = ride.cancellationHistory || [];
      ride.cancellationHistory.push({
        driverName: driver?.name || 'Conductor',
        driverId: socket.id,
        action: 'rejected',
        reason,
        timestamp: new Date().toISOString()
      });

      logger.info(`Conductor ${driver?.name || socket.id} rechazó la carrera ${rideId}. Motivo: ${reason}`);

      io.emit('ride:rejected', {
        rideId,
        driverId: socket.id,
        driverName: driver?.name || 'Conductor',
        reason
      });

      // Reasignar automáticamente al siguiente conductor disponible
      reassignNextAvailableDriver(ride);
    } catch (error) {
      logger.error('Error handling ride:rejected:', error);
    }
  });

  // ============================================
  // EXPIRACIÓN DE SOLICITUD (15s)
  // ============================================
  socket.on('ride:expired', (data) => {
    try {
      const rideId = typeof data === 'string' ? data : data?.rideId;
      const ride = rides.get(rideId);
      const driver = drivers.get(socket.id);

      if (!ride) return;

      // El conductor debe continuar disponible
      if (driver) {
        driver.available = true;
        driver.currentRide = null;
        drivers.set(socket.id, driver);
        io.emit('driver:online', driver);
      }

      ride.expiredDrivers = ride.expiredDrivers || [];
      if (!ride.expiredDrivers.includes(socket.id)) {
        ride.expiredDrivers.push(socket.id);
      }
      if (driver?.userId && !ride.expiredDrivers.includes(driver.userId)) {
        ride.expiredDrivers.push(driver.userId);
      }

      ride.cancellationHistory = ride.cancellationHistory || [];
      ride.cancellationHistory.push({
        driverName: driver?.name || 'Conductor',
        driverId: socket.id,
        action: 'expired',
        reason: 'Oferta expirada sin respuesta (15s)',
        timestamp: new Date().toISOString()
      });

      logger.info(`Oferta de carrera ${rideId} expiró sin respuesta para el conductor ${driver?.name || socket.id}`);

      io.emit('ride:expired', {
        rideId,
        driverId: socket.id,
        driverName: driver?.name || 'Conductor'
      });

      // Reasignar automáticamente al siguiente conductor disponible
      reassignNextAvailableDriver(ride);
    } catch (error) {
      logger.error('Error handling ride:expired:', error);
    }
  });

  // ============================================
  // ACEPTACIÓN SEGURA (AUTORIDAD DEL SERVIDOR Y RBAC)
  // ============================================
  socket.on('ride:accept', (data) => {
    try {
      const authenticatedUid = socket.user?.uid;
      if (!authenticatedUid) {
        logger.warn(`Conexión sin UID intentó aceptar carrera: ${socket.id}`);
        socket.emit('error', { message: 'Acceso denegado: Usuario no autenticado.' });
        return;
      }

      const rideId = typeof data === 'object' ? data?.rideId : data;
      const ride = rides.get(rideId);
      const driverUid = socket._driverUid || authenticatedUid;
      const driver = (driverUid && drivers.get(driverUid)) || drivers.get(socket.id) || {
        id: driverUid,
        driverId: driverUid,
        userId: driverUid,
        name: socket.user?.name || 'Socio Conductor',
        vehicle: 'Vehículo Taxi',
        plate: 'Placa Taxi'
      };

      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      // AUTORIDAD FINAL: Permitir si está pending, offered o asignada a este chofer
      const isTargetDriver = (ride.driverId === socket.id) || 
                             (ride.driverId === driverUid) ||
                             (ride.driverUid === driverUid) ||
                             (ride.assignedDriver && (
                               ride.assignedDriver.id === socket.id || 
                               ride.assignedDriver.id === driverUid ||
                               ride.assignedDriver.driverId === driverUid ||
                               ride.assignedDriver.userId === driverUid
                             )) ||
                             (ride.assignedDriverId === socket.id || ride.assignedDriverId === driverUid);

      const isAssignableToMe = (ride.status === 'pending') || 
                               (ride.status === 'offered') ||
                               (ride.status === 'assigned' && isTargetDriver) ||
                               (socket.user?.role === 'admin');

      if (!isAssignableToMe && ride.status !== 'pending' && ride.status !== 'offered') {
        logger.warn(`Conductor ${driver?.name || driverUid} intentó aceptar carrera ${rideId} pero ya está en estado "${ride.status}".`);
        socket.emit('ride:accept_error', { message: 'El viaje ya fue asignado a otro conductor.' });
        return;
      }

      clearOfferTimeout(ride.id);
      ride.status = 'accepted';
      ride.driverId = driverUid;
      ride.driverUid = driverUid;
      ride.driver = {
        name: driver?.name || socket.user?.name || 'Conductor',
        vehicle: driver?.vehicle || 'Vehículo',
        plate: driver?.plate || 'Placa',
        location: driver?.location || { lat: 0, lng: 0 }
      };
      ride.assignedDriver = {
        id: driverUid,
        driverId: driverUid,
        userId: driverUid,
        name: driver?.name || socket.user?.name || 'Conductor',
        vehicle: driver?.vehicle || 'Vehículo',
        plate: driver?.plate || 'Placa',
        phone: driver?.phone || ''
      };
      ride.acceptedAt = new Date();

      // Cambiar conductor a OCUPADO
      if (driver) {
        driver.available = false;
        driver.status = 'busy';
        driver.currentRide = rideId;
        drivers.set(driverUid, driver);
      }

      rides.set(rideId, ride);
      saveRidesToDisk();

      io.emit('driver:status_change', { driverId: driverUid, status: 'busy', available: false, currentRideId: rideId });
      io.emit('ride:accepted', ride);
      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));

      // Notificación directa garantizada al socket y a la sala del UID
      socket.emit('ride:assigned', ride);
      socket.emit('ride:accepted', ride);
      io.to(driverUid).emit('ride:assigned', ride);
      io.to(driverUid).emit('ride:accepted', ride);

      logger.info(`Carrera ${rideId} asignada y aceptada exclusivamente por ${driver?.name || driverUid} (Socket: ${socket.id}, UID: ${driverUid})`);
    } catch (error) {
      logger.error('Error accepting ride:', error);
      socket.emit('error', { message: 'Error al aceptar carrera: ' + (error.message || error) });
    }
  });

  socket.on('ride:arrived_at_pickup', (data) => {
    try {
      const authenticatedUid = socket.user?.uid;
      if (!authenticatedUid) return;

      const rideId = typeof data === 'string' ? data : (data?.rideId || '');
      const ride = rides.get(rideId);
      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      const driverUid = socket._driverUid || authenticatedUid;
      const isAssigned = (ride.driverId === socket.id) || 
                         (ride.driverId === driverUid) ||
                         (ride.driverUid === driverUid) ||
                         (ride.assignedDriver && (ride.assignedDriver.id === socket.id || ride.assignedDriver.id === driverUid || ride.assignedDriver.driverId === driverUid));
      if (!isAssigned && socket.user?.role !== 'admin') {
        socket.emit('error', { message: 'No estás asignado a esta carrera.' });
        return;
      }

      ride.status = 'arrived_at_pickup';
      ride.arrivedAt = new Date();
      rides.set(rideId, ride);
      saveRidesToDisk();
      io.emit('ride:arrived_at_pickup', ride);
      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));
      logger.info(`Conductor llegó al punto de recogida para carrera: ${rideId}`);
    } catch (error) {
      logger.error('Error in ride:arrived_at_pickup:', error);
    }
  });

  socket.on('ride:picked_up', (data) => {
    try {
      const authenticatedUid = socket.user?.uid;
      if (!authenticatedUid) return;

      const rideId = typeof data === 'string' ? data : (data?.rideId || '');
      const ride = rides.get(rideId);
      if (ride) {
        const driverUid = socket._driverUid || authenticatedUid;
        const isAssigned = (ride.driverId === socket.id) || 
                           (ride.driverId === driverUid) ||
                           (ride.driverUid === driverUid) ||
                           (ride.assignedDriver && (ride.assignedDriver.id === socket.id || ride.assignedDriver.id === driverUid || ride.assignedDriver.driverId === driverUid));
        if (!isAssigned && socket.user?.role !== 'admin') {
          socket.emit('error', { message: 'No estás asignado a esta carrera.' });
          return;
        }

        ride.status = 'in_progress';
        ride.passengerPickedUp = true;
        ride.pickedUpAt = new Date();
        rides.set(rideId, ride);
        saveRidesToDisk();
        io.emit('ride:picked_up', ride);
        io.emit('ride:started', ride);
        io.emit('ride:update', ride);
        io.emit('rides:update', Array.from(rides.values()));
        logger.info(`Pasajero a bordo. Carrera en curso hacia destino: ${rideId}`);
      }
    } catch (error) {
      logger.error('Error in ride:picked_up:', error);
    }
  });

  socket.on('ride:start', (rideId) => {
    try {
      const authenticatedUid = socket.user?.uid;
      if (!authenticatedUid) return;

      const ride = rides.get(rideId);
      if (ride) {
        const driverUid = socket._driverUid || authenticatedUid;
        const isAssigned = (ride.driverId === socket.id) || 
                           (ride.driverId === driverUid) ||
                           (ride.driverUid === driverUid) ||
                           (ride.assignedDriver && (ride.assignedDriver.id === socket.id || ride.assignedDriver.id === driverUid || ride.assignedDriver.driverId === driverUid));
        if (!isAssigned && socket.user?.role !== 'admin') {
          socket.emit('error', { message: 'No estás asignado a esta carrera.' });
          return;
        }

        ride.status = 'in_progress';
        ride.startedAt = new Date();
        rides.set(rideId, ride);
        saveRidesToDisk();
        io.emit('ride:started', ride);
        io.emit('ride:update', ride);
        io.emit('rides:update', Array.from(rides.values()));
      }
    } catch (error) {
      logger.error('Error starting ride:', error);
    }
  });

  socket.on('ride:complete', async (data) => {
    try {
      const authenticatedUid = socket.user?.uid;
      if (!authenticatedUid) return;

      const rideId = typeof data === 'object' ? data?.rideId : data;
      const ride = rides.get(rideId);
      const driverUid = socket._driverUid || authenticatedUid;
      const driver = (driverUid && drivers.get(driverUid)) || drivers.get(socket.id);

      if (!ride) {
        logger.warn(`Intento de completar carrera no existente: ${rideId}`);
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      // Validar asignación de conductor (Socket ID o UID)
      const isAssigned = (ride.driverId === socket.id) || 
                         (ride.driverId === driverUid) ||
                         (ride.driverUid === driverUid) ||
                         (driver && (ride.driverId === driver.driverId || ride.driverId === driver.userId)) ||
                         (ride.assignedDriver && ((ride.assignedDriver.id === socket.id || ride.assignedDriver.id === driverUid) || (driver && ride.assignedDriver.name === driver.name)));

      if (!isAssigned && socket.user?.role !== 'admin') {
        logger.warn(`Conductor ${driver?.name || driverUid} no autorizado para completar carrera ${rideId}.`);
        socket.emit('error', { message: 'No estás asignado a esta carrera.' });
        return;
      }

      // PROTECCIÓN DE IDEMPOTENCIA: Verificar si ya existe earning para este rideId
      const existingEarning = Array.from(earnings.values()).find(e => e.rideId === ride.id);
      if (existingEarning) {
        logger.info(`Idempotencia: Carrera ${ride.id} ya tiene earning registrado (${existingEarning.earningId}). Retornando datos sin duplicar.`);
        socket.emit('driver:earning_updated', {
          rideId: ride.id,
          fare: existingEarning.fare,
          driverEarnings: existingEarning.driverEarnings,
          completedAt: existingEarning.completedAt
        });
        return;
      }

      // AUTORIDAD FINANCIERA DEL BACKEND: La tarifa es determinada por el sistema, NUNCA por el cliente
      const authoritativeFare = Number(ride.fare) || 15.00;
      const platformFee = 0.00; // Fase 3: Sin comisión por el momento
      const driverEarnings = authoritativeFare - platformFee;

      ride.status = 'completed';
      ride.completedAt = new Date();
      ride.fare = authoritativeFare;
      rides.set(ride.id, ride);
      saveRidesToDisk();

      if (driver) {
        driver.available = true;
        driver.status = 'available';
        driver.currentRide = null;
        drivers.set(driverUid, driver);
        io.emit('driver:status_change', {
          driverId: driverUid,
          status: 'available',
          available: true,
          currentRideId: null
        });
      }

      const earningRecord = {
        earningId: uuidv4(),
        rideId: ride.id,
        driverId: driverUid,
        driverSocketId: socket.id,
        driverName: driver ? driver.name : (ride.assignedDriver?.name || 'Conductor'),
        passengerName: ride.customerName || 'Pasajero',
        pickup: ride.pickup,
        destination: ride.destination,
        distance: ride.distance || '5.0 km',
        duration: ride.duration || '15 min',
        fare: authoritativeFare,
        platformFee: platformFee,
        driverEarnings: driverEarnings,
        currency: 'USD',
        status: 'completed',
        completedAt: ride.completedAt,
        createdAt: new Date()
      };

      earnings.set(earningRecord.earningId, earningRecord);
      saveEarningsToDisk();
      syncEarningToFirestore(earningRecord);

      logger.info(`💰 Ganancia registrada para ${earningRecord.driverName} por carrera ${ride.id}: $${driverEarnings.toFixed(2)} (Tarifa: $${authoritativeFare.toFixed(2)})`);

      // Notificar al conductor con evento en tiempo real
      socket.emit('driver:earning_updated', {
        rideId: ride.id,
        fare: authoritativeFare,
        driverEarnings: driverEarnings,
        completedAt: ride.completedAt
      });

      io.emit('ride:completed', ride);
      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));
      if (driver) io.emit('driver:online', driver);
    } catch (error) {
      logger.error('Error completing ride:', error);
    }
  });

  socket.on('ride:cancel', (data) => {
    try {
      const rideId = typeof data === 'string' ? data : data?.rideId;
      const reason = data?.reason || 'Cancelado por el conductor o la central';
      const cancelledBy = data?.cancelledBy || 'central';
      const ride = rides.get(rideId);
      if (ride) {
        clearOfferTimeout(rideId);
        ride.status = 'cancelled';
        ride.cancelledAt = new Date();
        ride.cancelReason = reason;

        ride.cancellationHistory = ride.cancellationHistory || [];
        ride.cancellationHistory.push({
          action: 'cancelled',
          cancelledBy: data?.driverId ? 'driver' : cancelledBy,
          reason,
          timestamp: new Date().toISOString()
        });

        // Registrar al conductor en la lista de exclusión para que JAMÁS vuelva a recibir esta carrera
        ride.rejectedDrivers = ride.rejectedDrivers || [];
        const driverUid = socket._driverUid || socket.user?.uid;
        if (socket.id && !ride.rejectedDrivers.includes(socket.id)) ride.rejectedDrivers.push(socket.id);
        if (driverUid && !ride.rejectedDrivers.includes(driverUid)) ride.rejectedDrivers.push(driverUid);

        // Liberar al conductor si estaba asignado
        const driverToFree = (ride.driverId ? drivers.get(ride.driverId) : null) || (driverUid ? drivers.get(driverUid) : null) || drivers.get(socket.id);
        if (driverToFree) {
          if (driverToFree.id && !ride.rejectedDrivers.includes(driverToFree.id)) ride.rejectedDrivers.push(driverToFree.id);
          if (driverToFree.driverId && !ride.rejectedDrivers.includes(driverToFree.driverId)) ride.rejectedDrivers.push(driverToFree.driverId);
          if (driverToFree.userId && !ride.rejectedDrivers.includes(driverToFree.userId)) ride.rejectedDrivers.push(driverToFree.userId);

          driverToFree.available = true;
          driverToFree.currentRide = null;
          drivers.set(driverToFree.id, driverToFree);
          if (driverUid) drivers.set(driverUid, driverToFree);
          io.to(driverToFree.id).emit('ride:cancelled', ride);
          if (driverUid) io.to(driverUid).emit('ride:cancelled', ride);
          io.emit('driver:online', driverToFree);
          io.emit('driver:status_change', { driverId: driverUid || driverToFree.id, status: 'available', available: true });
        }

        rides.set(rideId, ride);
        saveRidesToDisk();

        // Registrar viaje cancelado con $0.00 en historial si no existe registro
        const existingEarning = Array.from(earnings.values()).find(e => e.rideId === ride.id);
        if (!existingEarning) {
          const targetDriverId = driverToFree ? (driverToFree.driverId || driverToFree.userId || driverToFree.id) : (ride.assignedDriver?.id || ride.driverId || 'unassigned');
          const cancelledRecord = {
            earningId: uuidv4(),
            rideId: ride.id,
            driverId: targetDriverId,
            driverSocketId: driverToFree?.id || null,
            driverName: driverToFree ? driverToFree.name : (ride.assignedDriver?.name || 'Conductor'),
            passengerName: ride.customerName || 'Pasajero',
            pickup: ride.pickup,
            destination: ride.destination,
            distance: ride.distance || '0 km',
            duration: ride.duration || '0 min',
            fare: 0.00,
            platformFee: 0.00,
            driverEarnings: 0.00,
            currency: 'USD',
            status: 'cancelled',
            cancelReason: reason,
            cancelledBy: data?.driverId ? 'driver' : cancelledBy,
            cancelledAt: ride.cancelledAt,
            createdAt: new Date()
          };
          earnings.set(cancelledRecord.earningId, cancelledRecord);
          saveEarningsToDisk();
          syncEarningToFirestore(cancelledRecord);
        }

        io.emit('ride:driver_cancelled', { rideId, reason, driverName: driverToFree?.name || 'Conductor' });
        io.emit('ride:cancelled', ride);
        io.emit('ride:update', ride);
        io.emit('rides:update', Array.from(rides.values()));
        logger.info(`Carrera ${rideId} cancelada. Motivo: ${reason}`);
      }
    } catch (error) {
      logger.error('Error cancelling ride:', error);
    }
  });

  // ============================================
  // ALERTA DE DESVÍO DE RUTA Y JUSTIFICACIÓN
  // ============================================
  socket.on('ride:off_route_warning', (data) => {
    try {
      const rideId = data?.rideId;
      const level = data?.warningLevel || 1;
      const dist = data?.distanceOffRoute || 0;
      logger.warn(`⚠️ Alerta de desvío de ruta (Nivel ${level}) para carrera ${rideId}: Conductor a ${Math.round(dist)}m fuera de ruta.`);
      io.emit('ride:off_route_alert', {
        rideId,
        driverId: socket._driverUid || socket.id,
        driverName: socket.user?.name || 'Conductor',
        warningLevel: level,
        distanceOffRoute: dist,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error('Error handling ride:off_route_warning:', err);
    }
  });

  socket.on('ride:route_detour_justified', (data) => {
    try {
      const rideId = data?.rideId;
      const reason = data?.reason || 'Desvío justificado por el conductor';
      const dist = data?.offRouteDistance || 0;
      logger.info(`🗺️ Desvío justificado para carrera ${rideId}: "${reason}" (${Math.round(dist)}m fuera de ruta). Central notificada.`);
      io.emit('ride:detour_reported', {
        rideId,
        driverId: socket._driverUid || socket.id,
        driverName: socket.user?.name || 'Conductor',
        reason,
        offRouteDistance: dist,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error('Error handling ride:route_detour_justified:', err);
    }
  });

  // ============================================
  // DESCONEXIÓN Y RECONEXIÓN
  // ============================================
  socket.on('disconnect', () => {
    logger.info(`Desconexión: ${socket.id}`);

    // Buscar conductor por UID estable primero, luego por socket.id como fallback
    const driverUid = socket._driverUid;
    const driver = (driverUid && drivers.get(driverUid)) || drivers.get(socket.id);

    if (driver) {
      driver.isOnline = false;
      driver.available = false;
      const stableId = driver.id || driverUid;

      // Notificar desconexión en tiempo real a la Central Web
      io.emit('driver:offline', { driverId: stableId, id: stableId });
      io.emit('driver:status_change', {
        driverId: stableId,
        id: stableId,
        status: 'offline',
        available: false,
        isOnline: false
      });

      // Si no tiene viaje activo en curso, eliminar del Map
      if (!driver.currentRide) {
        if (driverUid) drivers.delete(driverUid);
        if (drivers.has(socket.id)) drivers.delete(socket.id);
        logger.info(`Conductor ${driver.name} desconectado y eliminado del mapa activo.`);
      } else {
        // Actualizar el registro pero mantenerlo por el viaje activo
        if (driverUid) drivers.set(driverUid, driver);
        logger.info(`Conductor ${driver.name} desconectado pero tiene viaje activo ${driver.currentRide}. Reteniendo sesión.`);
      }

      // Emitir lista actualizada de conductores
      io.emit('drivers:update', Array.from(drivers.values()));
    }

    dispatchers.delete(socket.id);
  });
});

// ============================================
// TEMPORIZADORES DE OFERTA SERVER-SIDE (FASE 5D - P0-2)
// ============================================
const offerTimeouts = new Map(); // Map<rideId, { timer, driverId, offeredAt, version }>

function clearOfferTimeout(rideId) {
  const existing = offerTimeouts.get(rideId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    offerTimeouts.delete(rideId);
    logger.info(`Offer timer cancelado para carrera ${rideId}`);
  }
}

function startOfferTimeout(ride, driverId, timeoutMs = 15000) {
  if (!ride || !ride.id) return;
  clearOfferTimeout(ride.id);

  const offerVersion = Number(ride.version || 1);
  const offeredAt = Date.now();
  ride.offeredAt = new Date(offeredAt).toISOString();

  const timer = setTimeout(() => {
    try {
      const currentRide = rides.get(ride.id);
      if (!currentRide) {
        offerTimeouts.delete(ride.id);
        return;
      }

      // ATOMICIDAD: Solo expirar si sigue en 'offered', asignado al mismo chofer
      const matchesDriver = currentRide.driverId === driverId || 
                            currentRide.assignedDriver?.id === driverId ||
                            currentRide.assignedDriverId === driverId;

      if (currentRide.status === 'offered' && matchesDriver) {
        logger.info(`⏰ [SERVER TIMEOUT] Oferta de carrera ${ride.id} expiró tras 15s para el conductor ${driverId}`);

        const driver = drivers.get(driverId);
        if (driver) {
          driver.available = true;
          driver.currentRide = null;
          driver.status = 'available';
          drivers.set(driverId, driver);
          io.emit('driver:online', driver);
          io.emit('driver:status_change', {
            driverId,
            status: 'available',
            available: true
          });
        }

        currentRide.expiredDrivers = currentRide.expiredDrivers || [];
        if (!currentRide.expiredDrivers.includes(driverId)) {
          currentRide.expiredDrivers.push(driverId);
        }
        if (driver?.userId && !currentRide.expiredDrivers.includes(driver.userId)) {
          currentRide.expiredDrivers.push(driver.userId);
        }

        currentRide.cancellationHistory = currentRide.cancellationHistory || [];
        currentRide.cancellationHistory.push({
          driverName: driver?.name || 'Conductor',
          driverId: driverId,
          action: 'expired',
          reason: 'Oferta expirada automáticamente por servidor (15s timeout)',
          timestamp: new Date().toISOString()
        });

        io.to(driverId).emit('ride:expired', {
          rideId: currentRide.id,
          driverId,
          message: 'La oferta ha expirado automáticamente.'
        });

        io.emit('ride:expired', {
          rideId: currentRide.id,
          driverId,
          driverName: driver?.name || 'Conductor'
        });

        offerTimeouts.delete(ride.id);
        reassignNextAvailableDriver(currentRide);
      } else {
        logger.info(`Offer timer ignorado para carrera ${ride.id}: estado actual es "${currentRide?.status}"`);
        offerTimeouts.delete(ride.id);
      }
    } catch (err) {
      logger.error('Error en server-side offer timeout:', err);
      offerTimeouts.delete(ride.id);
    }
  }, timeoutMs);

  offerTimeouts.set(ride.id, {
    timer,
    driverId,
    offeredAt,
    version: offerVersion
  });

  logger.info(`Offer timer de ${timeoutMs}ms iniciado en servidor para carrera ${ride.id} -> conductor ${driverId}`);
}

function dispatchRide(ride) {
  if (ride.assignedDriver && (ride.assignedDriver.id || ride.driverId)) {
    const targetDriverId = ride.assignedDriver.id || ride.driverId;
    const targetDriver = drivers.get(targetDriverId) || Array.from(drivers.values()).find(d => d.id === targetDriverId || d.userId === targetDriverId || d.driverId === targetDriverId);
    if (targetDriver) {
      targetDriver.status = 'offered';
      targetDriver.available = false;
      targetDriver.currentRide = ride.id;
      const targetDriverUid = targetDriver.driverId || targetDriver.userId || targetDriver.id;
      drivers.set(targetDriverUid, targetDriver);

      ride.status = 'offered';
      ride.driverId = targetDriverUid;
      rides.set(ride.id, ride);
      saveRidesToDisk();

      if (targetDriver.socketId) io.to(targetDriver.socketId).emit('ride:new', ride);
      if (targetDriverUid) io.to(targetDriverUid).emit('ride:new', ride);
      if (targetDriver.id) io.to(targetDriver.id).emit('ride:new', ride);
      sendFcmNotificationToDriver(targetDriver, ride);
      startOfferTimeout(ride, targetDriverUid, 20000);

      io.emit('driver:status_change', {
        driverId: targetDriverUid,
        status: 'offered',
        available: false,
        currentRideId: ride.id
      });

      io.emit('ride:update', ride);
      io.emit('rides:update', Array.from(rides.values()));
      return true;
    }
  }
  return reassignNextAvailableDriver(ride);
}

// ============================================
// FUNCIONES AUXILIARES
// ============================================
function reassignNextAvailableDriver(ride) {
  clearOfferTimeout(ride.id);
  ride.rejectedDrivers = ride.rejectedDrivers || [];
  ride.expiredDrivers = ride.expiredDrivers || [];

  const excluded = new Set([...ride.rejectedDrivers, ...ride.expiredDrivers]);

  // Candidatos: conductores online y disponibles que no hayan rechazado, cancelado ni expirado
  const availableCandidates = [];
  drivers.forEach((driver) => {
    const isExcluded = excluded.has(driver.id) ||
                       excluded.has(driver.driverId) ||
                       excluded.has(driver.userId) ||
                       (driver.socketId && excluded.has(driver.socketId));
    if (driver.isOnline && driver.available && !isExcluded) {
      availableCandidates.push(driver);
    }
  });

  if (availableCandidates.length > 0) {
    // Si tenemos lat/lng del punto de recogida, ordenar por cercanía
    if (ride.pickup && typeof ride.pickup.lat === 'number' && ride.pickup.lat !== 0) {
      availableCandidates.sort((a, b) => {
        const distA = a.location ? calculateDistance(ride.pickup.lat, ride.pickup.lng, a.location.lat, a.location.lng) : 9999;
        const distB = b.location ? calculateDistance(ride.pickup.lat, ride.pickup.lng, b.location.lat, b.location.lng) : 9999;
        return distA - distB;
      });
    }

    const nextDriver = availableCandidates[0];
    const nextDriverUid = nextDriver.driverId || nextDriver.userId || nextDriver.id;
    nextDriver.status = 'offered';
    nextDriver.available = false;
    nextDriver.currentRide = ride.id;
    drivers.set(nextDriverUid, nextDriver);
    io.emit('driver:status_change', {
      driverId: nextDriverUid,
      status: 'offered',
      available: false,
      currentRideId: ride.id
    });

    ride.status = 'offered';
    ride.assignedDriver = {
      id: nextDriverUid,
      name: nextDriver.name,
      vehicle: nextDriver.vehicle,
      phone: nextDriver.phone || ''
    };
    ride.driverId = nextDriverUid;
    rides.set(ride.id, ride);
    saveRidesToDisk();

    if (nextDriver.socketId) io.to(nextDriver.socketId).emit('ride:new', ride);
    if (nextDriverUid) io.to(nextDriverUid).emit('ride:new', ride);
    if (nextDriver.id) io.to(nextDriver.id).emit('ride:new', ride);
    sendFcmNotificationToDriver(nextDriver, ride);
    startOfferTimeout(ride, nextDriverUid, 20000);

    io.emit('ride:reassigned', { rideId: ride.id, driverName: nextDriver.name, driverId: nextDriverUid });
    io.emit('ride:update', ride);
    io.emit('rides:update', Array.from(rides.values()));
    logger.info(`Carrera ${ride.id} reasignada automáticamente al siguiente conductor disponible: ${nextDriver.name}`);
    return true;
  } else {
    // No hay más conductores disponibles
    ride.status = 'pending';
    ride.assignedDriver = null;
    ride.driverId = null;
    rides.set(ride.id, ride);
    saveRidesToDisk();

    io.emit('ride:no_drivers_available', { rideId: ride.id, message: 'Todos los conductores cercanos han rechazado o no respondieron.' });
    io.emit('ride:update', ride);
    io.emit('rides:update', Array.from(rides.values()));
    logger.warn(`Carrera ${ride.id}: No quedan conductores disponibles para reasignar automáticamente.`);
    return false;
  }
}
function findNearbyDrivers(location, radiusKm) {
  const nearby = [];
  drivers.forEach((driver, id) => {
    if (driver.available && driver.location) {
      const distance = calculateDistance(
        location.lat,
        location.lng,
        driver.location.lat,
        driver.location.lng
      );
      if (distance <= radiusKm) {
        nearby.push(driver);
      }
    }
  });
  return nearby;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radio de la Tierra en km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

// ============================================
// MANEJO DE ERRORES GLOBAL
// ============================================
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({
    error: isDevelopment ? err.message : 'Error interno del servidor'
  });
});

function recoverActiveOffersOnStartup() {
  const now = Date.now();
  rides.forEach(ride => {
    if (ride.status === 'offered' && (ride.driverId || ride.assignedDriver?.id)) {
      const targetDriverId = ride.driverId || ride.assignedDriver?.id;
      const offeredTime = ride.offeredAt ? new Date(ride.offeredAt).getTime() : new Date(ride.updatedAt || ride.createdAt).getTime();
      const elapsedMs = now - offeredTime;
      const remainingMs = Math.max(0, 15000 - elapsedMs);

      logger.info(`Recuperando oferta activa al arrancar: Carrera ${ride.id}, tiempo restante: ${remainingMs}ms`);
      if (remainingMs > 0) {
        startOfferTimeout(ride, targetDriverId, remainingMs);
      } else {
        startOfferTimeout(ride, targetDriverId, 100);
      }
    }
  });
}

// ============================================
// INICIAR SERVIDOR
// ============================================
server.listen(PORT, () => {
  logger.info(`🚕 Servidor ejecutándose en puerto ${PORT}`);
  logger.info(`📱 App de Despacho: http://localhost:${PORT}`);
  logger.info(`🚖 App de Taxistas: http://localhost:${PORT}/driver`);
  logger.info(`🔒 Modo: ${isDevelopment ? 'DESARROLLO' : 'PRODUCCIÓN'}`);
  recoverActiveOffersOnStartup();
});

// Manejo de señales de terminación
process.on('SIGTERM', () => {
  logger.info('SIGTERM recibido. Cerrando servidor...');
  server.close(() => {
    logger.info('Servidor cerrado');
    process.exit(0);
  });
});

module.exports = server;
