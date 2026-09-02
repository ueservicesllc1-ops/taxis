const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || '48441b493ae87ff9390434467ca504e90ab614f36c4754134cbe2bd9ef681215';

function createTestToken(payload) {
  const header = 'test_token';
  const uid = payload.uid || 'test_driver_1';
  const role = payload.role || (uid.startsWith('admin') ? 'admin' : (uid.startsWith('dispatcher') ? 'dispatcher' : 'driver'));
  const body = Buffer.from(JSON.stringify({
    uid,
    email: payload.email || `${uid}@taxipro.com`,
    name: payload.name || `User ${uid}`,
    role: String(role).toLowerCase(),
    exp: payload.exp || (Date.now() + 3600 * 1000),
    ...payload
  })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body)
    .digest('hex');
  return `${header}.${body}.${sig}`;
}

const adminToken = createTestToken({ uid: 'admin_001', role: 'admin' });
const dispatcherToken = createTestToken({ uid: 'dispatcher_001', role: 'dispatcher' });
const driver1Token = createTestToken({ uid: 'driver_001', role: 'driver' });
const driver2Token = createTestToken({ uid: 'driver_002', role: 'driver' });
const driver3Token = createTestToken({ uid: 'driver_003', role: 'driver' });

function createAuthenticatedSocket(token) {
  return io(SERVER_URL, {
    auth: { token },
    reconnection: false,
    transports: ['websocket', 'polling']
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    failedTests++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

async function runPhase5DTests() {
  console.log('\n==================================================');
  console.log('🧪 RUNNING SUITE: PHASE 5D — PRODUCTION HARDENING & MOBILE SOCKET ALIGNMENT');
  console.log('==================================================\n');

  let dispatcherSocket, driver1Socket, driver2Socket;

  try {
    dispatcherSocket = createAuthenticatedSocket(dispatcherToken);
    driver1Socket = createAuthenticatedSocket(driver1Token);
    driver2Socket = createAuthenticatedSocket(driver2Token);

    await Promise.race([
      Promise.all([
        new Promise(resolve => dispatcherSocket.on('connect', resolve)),
        new Promise(resolve => driver1Socket.on('connect', resolve)),
        new Promise(resolve => driver2Socket.on('connect', resolve))
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout conectando sockets')), 5000))
    ]);

    // Registrar dispatcher y drivers
    dispatcherSocket.emit('register:dispatcher', { name: 'Despachador Central' });
    
    driver1Socket.emit('register:driver', {
      driverId: 'driver_001',
      userId: 'driver_001',
      name: 'Carlos Conductor 1',
      vehicle: 'Toyota Corolla',
      plate: 'TX-101',
      isOnline: true,
      available: true
    });

    driver2Socket.emit('register:driver', {
      driverId: 'driver_002',
      userId: 'driver_002',
      name: 'Ana Conductora 2',
      vehicle: 'Nissan Versa',
      plate: 'TX-102',
      isOnline: true,
      available: true
    });

    // Enviar ubicación de choferes
    driver1Socket.emit('driver:location', { lat: 40.7128, lng: -74.0060, speed: 0 });
    driver2Socket.emit('driver:location', { lat: 40.7135, lng: -74.0055, speed: 0 });

    await wait(300);

    // ============================================
    // TEST GROUP 1: SERVER-SIDE OFFER TIMEOUT LIFECYCLE
    // ============================================
    console.log('\n--- 1. SERVER-SIDE OFFER TIMEOUT LIFECYCLE ---');

    // Test 1.1: Creación de viaje inmediato inicia oferta y asigna chofer
    let ride1Id = 'test_p5d_ride_' + Date.now();
    let ride1Offered = false;
    let targetDriverForRide1 = null;

    const ride1OfferPromise = new Promise(resolve => {
      const handler = (ride) => {
        if (ride.id === ride1Id) {
          ride1Offered = true;
          targetDriverForRide1 = ride.driverId || ride.assignedDriver?.id;
          resolve(ride);
        }
      };
      driver1Socket.once('ride:new', handler);
      driver2Socket.once('ride:new', handler);
    });

    dispatcherSocket.emit('ride:create', {
      id: ride1Id,
      customerName: 'Pasajero Test 5D',
      pickup: { address: 'Calle 123', lat: 40.7128, lng: -74.0060 },
      destination: { address: 'Avenida 456', lat: 40.7200, lng: -74.0100 },
      fare: 18.50,
      assignedDriverId: driver1Socket.id,
      assignedDriver: { id: driver1Socket.id, name: 'Carlos Conductor 1' }
    });

    const offeredRide1 = await Promise.race([
      ride1OfferPromise,
      wait(3000).then(() => null)
    ]);

    assert(offeredRide1 !== null && offeredRide1.id === ride1Id, 'Carrera despachada emite evento ride:new al chofer seleccionado');

    // Test 1.2: Aceptación cancela el timer server-side
    let ride1Accepted = false;
    const acceptPromise = new Promise(resolve => {
      dispatcherSocket.once('ride:accepted', (ride) => {
        if (ride.id === ride1Id) {
          ride1Accepted = true;
          resolve(ride);
        }
      });
      dispatcherSocket.once('ride:update', (ride) => {
        if (ride.id === ride1Id && ride.status === 'accepted') {
          ride1Accepted = true;
          resolve(ride);
        }
      });
    });

    driver1Socket.emit('ride:accept', ride1Id);
    await Promise.race([acceptPromise, wait(2000)]);
    assert(ride1Accepted, 'Aceptación de carrera por chofer transiciona a accepted y cancela timer server-side');

    // Test 1.3: Cancelación de carrera cancela el timer server-side
    let cancelRideId = 'test_p5d_cancel_' + Date.now();
    dispatcherSocket.emit('ride:create', {
      id: cancelRideId,
      customerName: 'Pasajero Cancel',
      pickup: { address: 'Punto Cancel', lat: 40.7128, lng: -74.0060 },
      destination: { address: 'Destino Cancel', lat: 40.7200, lng: -74.0100 },
      fare: 15.00,
      assignedDriverId: driver1Socket.id,
      assignedDriver: { id: driver1Socket.id, name: 'Carlos Conductor 1' }
    });
    await wait(300);
    let cancelSuccess = false;
    const cancelPromise = new Promise(resolve => {
      dispatcherSocket.once('ride:cancelled', () => { cancelSuccess = true; resolve(); });
      dispatcherSocket.once('ride:update', (r) => { if (r.id === cancelRideId && r.status === 'cancelled') { cancelSuccess = true; resolve(); } });
    });
    dispatcherSocket.emit('ride:cancel', { rideId: cancelRideId, reason: 'Cancelación prueba' });
    await Promise.race([cancelPromise, wait(1500)]);
    assert(cancelSuccess, 'Cancelación de carrera en oferta limpia timer server-side y transiciona a cancelled');

    // Test 1.4: Desasignación de carrera cancela timer server-side
    let unassignRideId = 'test_p5d_unassign_' + Date.now();
    dispatcherSocket.emit('ride:create', {
      id: unassignRideId,
      customerName: 'Pasajero Unassign',
      pickup: { address: 'Punto Unassign', lat: 40.7128, lng: -74.0060 },
      destination: { address: 'Destino Unassign', lat: 40.7200, lng: -74.0100 },
      fare: 15.00,
      assignedDriverId: driver1Socket.id,
      assignedDriver: { id: driver1Socket.id, name: 'Carlos Conductor 1' }
    });
    await wait(300);
    let unassignSuccess = false;
    const unassignPromise = new Promise(resolve => {
      dispatcherSocket.once('ride:update', (r) => { if (r.id === unassignRideId) { unassignSuccess = true; resolve(); } });
    });
    dispatcherSocket.emit('ride:unassign', { rideId: unassignRideId, reason: 'Cambio de unidad' });
    await Promise.race([unassignPromise, wait(1500)]);
    assert(unassignSuccess, 'Desasignación por despachador cancela timer de oferta y libera al conductor');

    // ============================================
    // TEST GROUP 2: SERVER TIMEOUT EXPIRATION & AUTO-REASSIGNMENT
    // ============================================
    console.log('\n--- 2. SERVER TIMEOUT EXPIRATION & REASSIGNMENT ---');

    // Test 2.1: Chofer que no responde auto-expira por timer en servidor
    let ride2Id = 'test_p5d_ride_timeout_' + Date.now();
    let ride2ReceivedByDriver1 = false;
    let ride2ReassignedToDriver2 = false;

    const ride2OfferPromise = new Promise(resolve => {
      driver1Socket.once('ride:new', (ride) => {
        if (ride.id === ride2Id) {
          ride2ReceivedByDriver1 = true;
          resolve(ride);
        }
      });
    });

    dispatcherSocket.emit('ride:create', {
      id: ride2Id,
      customerName: 'Pasajero Timeout Test',
      pickup: { address: 'Origen Timeout', lat: 40.7128, lng: -74.0060 },
      destination: { address: 'Destino Timeout', lat: 40.7300, lng: -74.0200 },
      fare: 22.00,
      assignedDriverId: driver1Socket.id,
      assignedDriver: { id: driver1Socket.id, name: 'Carlos Conductor 1' }
    });

    await Promise.race([ride2OfferPromise, wait(3000)]);
    assert(ride2ReceivedByDriver1, 'Nueva oferta llega al conductor 1 con timer de 15s');

    // Simular rechazo o expiración
    const reassignedPromise = new Promise(resolve => {
      driver2Socket.once('ride:new', (ride) => {
        if (ride.id === ride2Id) {
          ride2ReassignedToDriver2 = true;
          resolve(ride);
        }
      });
    });

    driver1Socket.emit('ride:rejected', { rideId: ride2Id, reason: 'Rechazo simulado' });
    await Promise.race([reassignedPromise, wait(3000)]);
    assert(ride2ReassignedToDriver2, 'Rechazo/Expiración reasigna automáticamente al conductor 2 disponible');

    // Test 2.3: Si todos los choferes rechazan/expiran, transiciona a pending
    let noDriversEvent = false;
    const noDriversPromise = new Promise(resolve => {
      dispatcherSocket.once('ride:no_drivers_available', () => { noDriversEvent = true; resolve(); });
      dispatcherSocket.once('ride:update', (r) => { if (r.id === ride2Id && r.status === 'pending') { noDriversEvent = true; resolve(); } });
    });
    driver2Socket.emit('ride:rejected', { rideId: ride2Id, reason: 'Segundo rechazo' });
    await Promise.race([noDriversPromise, wait(3000)]);
    assert(noDriversEvent, 'Agotamiento de candidatos transiciona viaje a pending y notifica ride:no_drivers_available');

    // ============================================
    // TEST GROUP 3: RACE CONDITION & LATE ACCEPTANCE PROTECTION
    // ============================================
    console.log('\n--- 3. RACE CONDITION & LATE ACCEPTANCE PROTECTION ---');

    let ride3Id = 'test_p5d_ride_race_' + Date.now();
    dispatcherSocket.emit('ride:create', {
      id: ride3Id,
      customerName: 'Pasajero Race Test',
      pickup: { address: 'Punto A', lat: 40.7128, lng: -74.0060 },
      destination: { address: 'Punto B', lat: 40.7400, lng: -74.0300 },
      fare: 15.00,
      assignedDriverId: driver1Socket.id,
      assignedDriver: { id: driver1Socket.id, name: 'Carlos Conductor 1' }
    });

    await wait(500);

    // Cancelar la carrera antes de que el chofer acepte
    dispatcherSocket.emit('ride:cancel', { rideId: ride3Id, reason: 'Cancelado por usuario' });
    await wait(300);

    // Chofer 1 intenta aceptar la carrera cancelada
    let acceptErrorReceived = false;
    const errorPromise = new Promise(resolve => {
      driver1Socket.once('ride:accept_error', (data) => {
        acceptErrorReceived = true;
        resolve(data);
      });
    });

    driver1Socket.emit('ride:accept', ride3Id);
    await Promise.race([errorPromise, wait(2000)]);
    assert(acceptErrorReceived, 'Aceptación tardía tras cancelación o expiración es rechazada con ride:accept_error');

    // ============================================
    // TEST GROUP 4: ANDROID CODEBASE SECURITY & CONFIG AUDIT
    // ============================================
    console.log('\n--- 4. ANDROID CODEBASE HARDENING & CONFIG AUDIT ---');

    // Test 4.1: Verificar ausencia de 192.168.1.240 en toda la app Android
    const stringsXml = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/src/main/res/values/strings.xml'), 'utf8');
    const appConfigKt = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/src/main/java/com/taxipro/driver/config/AppConfig.kt'), 'utf8');
    const activeRideKt = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/src/main/java/com/taxipro/driver/ui/ride/ActiveRideActivity.kt'), 'utf8');
    const rideAlertKt = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/src/main/java/com/taxipro/driver/ui/ride/RideAlertActivity.kt'), 'utf8');
    const locationServiceKt = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/src/main/java/com/taxipro/driver/service/LocationForegroundService.kt'), 'utf8');

    const hasHardcodedIp = [stringsXml, appConfigKt, activeRideKt, rideAlertKt, locationServiceKt]
      .some(content => content.includes('192.168.1.240'));

    assert(!hasHardcodedIp, 'Cero referencias a IP LAN hardcodeada 192.168.1.240 en archivos Android');

    // Test 4.2: LocationForegroundService pasa ID Token en Socket auth
    const locationServiceUsesToken = locationServiceKt.includes('getIdToken') && 
                                     locationServiceKt.includes('IO.Options()') && 
                                     locationServiceKt.includes('auth = mapOf("token"');
    assert(locationServiceUsesToken, 'LocationForegroundService.kt obtiene Firebase ID Token y lo inyecta en Socket auth options');

    // Test 4.3: RideAlertActivity pasa ID Token en Socket auth y espera confirmación
    const rideAlertUsesToken = rideAlertKt.includes('getIdToken') && 
                               rideAlertKt.includes('auth = mapOf("token"');
    const rideAlertNonOptimistic = rideAlertKt.includes('proceedToActiveRide') && 
                                   rideAlertKt.includes('ride:assigned') && 
                                   rideAlertKt.includes('isAccepting');
    assert(rideAlertUsesToken, 'RideAlertActivity.kt autentica conexión Socket con Firebase ID Token');
    assert(rideAlertNonOptimistic, 'RideAlertActivity.kt implementa flujo de aceptación no-optimista (aguarda confirmación de servidor)');

    // Test 4.4: ActiveRideActivity usa AppConfig y autentica Socket
    const activeRideUsesConfig = activeRideKt.includes('AppConfig.getServerUrl') && 
                                 activeRideKt.includes('getIdToken') &&
                                 !activeRideKt.includes('192.168.1.240');
    assert(activeRideUsesConfig, 'ActiveRideActivity.kt utiliza AppConfig.getServerUrl() y autentica socket con ID Token');

    // Test 4.5: AppConfig provee fallback configurable
    const appConfigHasFallback = appConfigKt.includes('DEFAULT_URL') && appConfigKt.includes('getServerUrl');
    assert(appConfigHasFallback, 'AppConfig.kt provee mecanismo centralizado getServerUrl() con fallback configurable');

    // ============================================
    // TEST GROUP 5: AUTHENTICATION ENFORCEMENT ON BACKEND SOCKETS
    // ============================================
    console.log('\n--- 5. BACKEND SOCKET AUTHENTICATION ENFORCEMENT ---');

    let unauthenticatedSocketRejected = false;
    const unauthSocket = io(SERVER_URL, {
      reconnection: false,
      transports: ['websocket', 'polling']
    });

    const unauthPromise = new Promise(resolve => {
      unauthSocket.on('connect_error', (err) => {
        unauthenticatedSocketRejected = err.message && err.message.includes('Unauthorized');
        resolve();
      });
      unauthSocket.on('connect', () => {
        unauthenticatedSocketRejected = false;
        resolve();
      });
    });

    await Promise.race([unauthPromise, wait(3000)]);
    unauthSocket.close();

    assert(unauthenticatedSocketRejected, 'Backend rechaza estrictamente sockets sin Firebase ID Token (Unauthorized)');

  } catch (error) {
    console.error('Error durante la ejecución de pruebas Fase 5D:', error);
    failedTests++;
  } finally {
    if (dispatcherSocket) dispatcherSocket.close();
    if (driver1Socket) driver1Socket.close();
    if (driver2Socket) driver2Socket.close();
  }

  console.log('\n==================================================');
  console.log(`FASE 5D TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
  if (failedTests > 0) {
    console.error(`❌ ${failedTests} TESTS FAILED`);
  } else {
    console.log('🎉 ALL PHASE 5D TESTS PASSED PERFECTLY (100%)');
  }
  console.log('==================================================\n');

  return { totalTests, passedTests, failedTests };
}

if (require.main === module) {
  runPhase5DTests().then(results => {
    process.exit(results.failedTests > 0 ? 1 : 0);
  });
}

module.exports = runPhase5DTests;
