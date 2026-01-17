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
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');

// ============================================
// CONFIGURACIÓN DE LA APP
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const isDevelopment = process.env.NODE_ENV === 'development';

// ============================================
// MIDDLEWARE DE SEGURIDAD
// ============================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.socket.io", "https://maps.googleapis.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "https:"],
      frameSrc: ["'none'"],
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
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Demasiadas solicitudes desde esta IP, intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files con caché
app.use(express.static('public', {
  maxAge: isDevelopment ? '0' : '1d',
  etag: true
}));

// ============================================
// ALMACENAMIENTO EN MEMORIA (TEMPORAL)
// ============================================
// TODO: Migrar a Firestore para producción
const rides = new Map();
const drivers = new Map();
const dispatchers = new Map();

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
// API REST
// ============================================
app.get('/api/rides', (req, res) => {
  try {
    res.json(Array.from(rides.values()));
  } catch (error) {
    logger.error('Error fetching rides:', error);
    res.status(500).json({ error: 'Error al obtener carreras' });
  }
});

app.get('/api/drivers', (req, res) => {
  try {
    const availableDrivers = Array.from(drivers.values()).filter(d => d.available);
    res.json(availableDrivers);
  } catch (error) {
    logger.error('Error fetching drivers:', error);
    res.status(500).json({ error: 'Error al obtener conductores' });
  }
});

// ============================================
// SOCKET.IO - EVENTOS EN TIEMPO REAL
// ============================================
io.on('connection', (socket) => {
  logger.info(`Nueva conexión: ${socket.id}`);

  // ============================================
  // REGISTRO DE USUARIOS
  // ============================================
  socket.on('register:dispatcher', (data) => {
    try {
      dispatchers.set(socket.id, {
        id: socket.id,
        name: data.name || 'Despachador',
        connectedAt: new Date()
      });
      logger.info(`Despachador conectado: ${data.name}`);
      socket.emit('registered', { type: 'dispatcher', id: socket.id });
    } catch (error) {
      logger.error('Error registering dispatcher:', error);
      socket.emit('error', { message: 'Error al registrar despachador' });
    }
  });

  socket.on('register:driver', (data) => {
    try {
      // Validación básica
      if (!data.name || !data.vehicle || !data.plate) {
        socket.emit('error', { message: 'Datos incompletos del conductor' });
        return;
      }

      const driver = {
        id: socket.id,
        name: data.name,
        vehicle: data.vehicle,
        plate: data.plate,
        location: data.location || { lat: 0, lng: 0 },
        available: true, // CORREGIDO: Default a true para disponible
        connectedAt: new Date()
      };

      drivers.set(socket.id, driver);
      logger.info(`Taxista conectado: ${data.name}`);
      socket.emit('registered', { type: 'driver', id: socket.id, driver });
      io.emit('driver:online', driver);
    } catch (error) {
      logger.error('Error registering driver:', error);
      socket.emit('error', { message: 'Error al registrar conductor' });
    }
  });

  // ============================================
  // GEOLOCALIZACIÓN
  // ============================================
  socket.on('driver:location', (location) => {
    try {
      const driver = drivers.get(socket.id);
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
        driver.lastUpdate = new Date();
        drivers.set(socket.id, driver);

        io.emit('driver:location_update', {
          driverId: socket.id,
          location
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
      const driver = drivers.get(socket.id);
      if (driver) {
        driver.available = Boolean(data.available);
        if (data.location) {
          driver.location = data.location;
        }
        drivers.set(socket.id, driver);

        logger.info(`Driver ${driver.name} is now ${driver.available ? 'AVAILABLE' : 'BUSY'}`);

        if (driver.available) {
          io.emit('driver:online', driver);
        } else {
          io.emit('driver:status_change', {
            driverId: socket.id,
            status: 'busy',
            available: false
          });
        }
      }
    } catch (error) {
      logger.error('Error updating driver availability:', error);
    }
  });

  // ============================================
  // GESTIÓN DE CARRERAS
  // ============================================
  socket.on('ride:create', (rideData) => {
    try {
      // Validación de datos
      if (!rideData.pickup || !rideData.destination || !rideData.customerName) {
        socket.emit('error', { message: 'Datos incompletos de la carrera' });
        return;
      }

      const ride = {
        id: uuidv4(),
        pickup: rideData.pickup,
        destination: rideData.destination,
        customerName: rideData.customerName,
        customerPhone: rideData.customerPhone || '',
        status: 'pending',
        createdAt: new Date(),
        dispatcherId: socket.id
      };

      rides.set(ride.id, ride);
      logger.info(`Nueva carrera creada: ${ride.id}`);

      // Encontrar taxistas cercanos
      const nearbyDrivers = findNearbyDrivers(rideData.pickup, 10); // 10km radius

      if (nearbyDrivers.length === 0) {
        socket.emit('ride:no_drivers', {
          message: 'No hay taxistas disponibles en el área'
        });
      }

      // Enviar notificación a taxistas cercanos
      nearbyDrivers.forEach(driver => {
        io.to(driver.id).emit('ride:new', ride);
      });

      socket.emit('ride:created', ride);
      io.emit('ride:update', ride);
    } catch (error) {
      logger.error('Error creating ride:', error);
      socket.emit('error', { message: 'Error al crear carrera' });
    }
  });

  socket.on('ride:accept', (rideId) => {
    try {
      const ride = rides.get(rideId);
      const driver = drivers.get(socket.id);

      if (!ride) {
        socket.emit('error', { message: 'Carrera no encontrada' });
        return;
      }

      if (!driver) {
        socket.emit('error', { message: 'Conductor no registrado' });
        return;
      }

      if (ride.status !== 'pending') {
        socket.emit('error', { message: 'Carrera no disponible' });
        return;
      }

      ride.status = 'accepted';
      ride.driverId = socket.id;
      ride.driver = {
        name: driver.name,
        vehicle: driver.vehicle,
        plate: driver.plate,
        location: driver.location
      };
      ride.acceptedAt = new Date();

      driver.available = false;
      driver.currentRide = rideId;

      rides.set(rideId, ride);
      drivers.set(socket.id, driver);

      io.emit('ride:accepted', ride);
      socket.emit('ride:assigned', ride);

      logger.info(`Carrera ${rideId} aceptada por ${driver.name}`);
    } catch (error) {
      logger.error('Error accepting ride:', error);
      socket.emit('error', { message: 'Error al aceptar carrera' });
    }
  });

  socket.on('ride:start', (rideId) => {
    try {
      const ride = rides.get(rideId);
      if (ride && ride.driverId === socket.id) {
        ride.status = 'in_progress';
        ride.startedAt = new Date();
        rides.set(rideId, ride);
        io.emit('ride:started', ride);
      }
    } catch (error) {
      logger.error('Error starting ride:', error);
    }
  });

  socket.on('ride:complete', (data) => {
    try {
      const ride = rides.get(data.rideId);
      const driver = drivers.get(socket.id);

      if (ride && driver && ride.driverId === socket.id) {
        ride.status = 'completed';
        ride.completedAt = new Date();
        ride.fare = data.fare || 0;
        rides.set(data.rideId, ride);

        driver.available = true;
        driver.currentRide = null;
        drivers.set(socket.id, driver);

        io.emit('ride:completed', ride);
        io.emit('driver:online', driver);
      }
    } catch (error) {
      logger.error('Error completing ride:', error);
    }
  });

  socket.on('ride:cancel', (rideId) => {
    try {
      const ride = rides.get(rideId);
      if (ride) {
        ride.status = 'cancelled';
        ride.cancelledAt = new Date();
        rides.set(rideId, ride);

        if (ride.driverId) {
          const driver = drivers.get(ride.driverId);
          if (driver) {
            driver.available = true;
            driver.currentRide = null;
            drivers.set(ride.driverId, driver);
            io.to(ride.driverId).emit('ride:cancelled', ride);
          }
        }

        io.emit('ride:cancelled', ride);
      }
    } catch (error) {
      logger.error('Error cancelling ride:', error);
    }
  });

  // ============================================
  // DESCONEXIÓN
  // ============================================
  socket.on('disconnect', () => {
    logger.info(`Desconexión: ${socket.id}`);

    const driver = drivers.get(socket.id);
    if (driver) {
      drivers.delete(socket.id);
      io.emit('driver:offline', { driverId: socket.id });
    }

    dispatchers.delete(socket.id);
  });
});

// ============================================
// FUNCIONES AUXILIARES
// ============================================
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

// ============================================
// INICIAR SERVIDOR
// ============================================
server.listen(PORT, () => {
  logger.info(`🚕 Servidor ejecutándose en puerto ${PORT}`);
  logger.info(`📱 App de Despacho: http://localhost:${PORT}`);
  logger.info(`🚖 App de Taxistas: http://localhost:${PORT}/driver`);
  logger.info(`🔒 Modo: ${isDevelopment ? 'DESARROLLO' : 'PRODUCCIÓN'}`);
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
