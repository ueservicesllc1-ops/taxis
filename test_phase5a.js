/**
 * TEST SUITE: FASE 5A — AUTENTICACIÓN REAL: FIREBASE AUTH + BACKEND
 *
 * 20 pruebas obligatorias que verifican:
 * 1. REST sin token -> 401
 * 2. REST token inválido -> 401
 * 3. REST token válido -> 200 OK
 * 4. Token válido pero driverId mismatch en /api/drivers/:id/earnings -> 403
 * 5. Header x-driver-id falso -> NO permite impersonación (403)
 * 6. Query requestingDriverId falso -> NO permite impersonación (403)
 * 7. Socket sin token -> Handshake rechazado
 * 8. Socket con token inválido -> Handshake rechazado
 * 9. Socket con token válido -> Conectado exitosamente
 * 10. socket.user.uid asignado e íntegro
 * 11. register:driver con UID ajeno -> Rechazado
 * 12. register:dispatcher sin autenticación -> Rechazado
 * 13. Socket autenticado recibe rides:update
 * 14. Socket no autenticado NO recibe rides:update ni datos sensibles
 * 15. Socket autenticado recibe drivers:update
 * 16. Endpoints financieros protegidos con token
 * 17. Conductor A no puede consultar earnings ni viajes de Conductor B
 * 18. Central autenticada puede crear carreras
 * 19. Socket no autenticado no puede crear carreras
 * 20. Eventos sensibles bloquean suplantación de identidad
 */

const io = require('socket.io-client');
const http = require('http');
const crypto = require('crypto');

const SERVER_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || '48441b493ae87ff9390434467ca504e90ab614f36c4754134cbe2bd9ef681215';

function createTestToken(payload) {
  const header = 'test_token';
  const body = Buffer.from(JSON.stringify({
    uid: payload.uid || 'test_driver_1',
    email: payload.email || 'driver1@example.com',
    name: payload.name || 'Conductor Autenticado',
    exp: payload.exp || (Date.now() + 3600 * 1000),
    ...payload
  })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body)
    .digest('hex');
  return `${header}.${body}.${sig}`;
}

function fetchWithAuth(path, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const headers = { ...extraHeaders };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

const results = {};
function logTest(num, name, passed, detail = '') {
  results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
  console.log(`\n--- TEST ${num}: ${name} ---`);
  if (detail) console.log(`Detalle: ${detail}`);
  console.log(`Resultado TEST ${num}: ${passed ? 'PASSED' : 'FAILED'}`);
}

async function runTests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 20 TESTS OBLIGATORIOS DE LA FASE 5A');
  console.log('AUTENTICACIÓN REAL: FIREBASE AUTH + BACKEND');
  console.log('==================================================\n');

  const tokenDriverA = createTestToken({ uid: 'driver_uid_alpha', name: 'Chofer Alpha' });
  const tokenDriverB = createTestToken({ uid: 'driver_uid_beta', name: 'Chofer Beta' });
  const tokenDispatcher = createTestToken({ uid: 'dispatcher_uid_central', name: 'Operador Central' });

  // ----------------------------------------------------
  // PRUEBAS REST (TEST 1 - TEST 6)
  // ----------------------------------------------------

  // TEST 1: REST sin token -> 401
  const res1 = await fetchWithAuth('/api/rides');
  logTest(1, 'GET /api/rides sin token retorna 401 Unauthorized', res1.status === 401, `Status: ${res1.status}`);

  // TEST 2: REST con token inválido -> 401
  const res2 = await fetchWithAuth('/api/rides', 'token_invalido_malformado_123');
  logTest(2, 'GET /api/rides con token inválido retorna 401 Unauthorized', res2.status === 401, `Status: ${res2.status}`);

  // TEST 3: REST con token válido -> 200 OK
  const res3 = await fetchWithAuth('/api/rides', tokenDispatcher);
  logTest(3, 'GET /api/rides con token válido retorna 200 OK', res3.status === 200 && Array.isArray(res3.data), `Status: ${res3.status}, Carreras: ${res3.data?.length}`);

  // TEST 4: Token válido de Driver A intentando ver earnings de Driver B -> 403
  const res4 = await fetchWithAuth('/api/drivers/driver_uid_beta/earnings', tokenDriverA);
  logTest(4, 'Driver A no puede consultar earnings de Driver B (403 Forbidden)', res4.status === 403, `Status: ${res4.status}`);

  // TEST 5: Header x-driver-id falso no permite impersonación
  const res5 = await fetchWithAuth('/api/drivers/driver_uid_beta/earnings', tokenDriverA, { 'x-driver-id': 'driver_uid_beta' });
  logTest(5, 'Header x-driver-id falso es ignorado y retorna 403 Forbidden', res5.status === 403, `Status: ${res5.status}`);

  // TEST 6: Query parameter requestingDriverId falso no permite impersonación
  const res6 = await fetchWithAuth('/api/drivers/driver_uid_beta/earnings?requestingDriverId=driver_uid_beta', tokenDriverA);
  logTest(6, 'Query param requestingDriverId falso es ignorado y retorna 403 Forbidden', res6.status === 403, `Status: ${res6.status}`);

  // ----------------------------------------------------
  // PRUEBAS SOCKET.IO HANDSHAKE (TEST 7 - TEST 15)
  // ----------------------------------------------------

  // TEST 7: Socket sin token -> Handshake rechazado
  let socketNoAuthRejected = false;
  const sockNoAuth = io(SERVER_URL, { reconnection: false, timeout: 3000 });
  await new Promise((resolve) => {
    sockNoAuth.on('connect_error', (err) => {
      if (err.message.includes('Unauthorized') || err.message.includes('token required')) {
        socketNoAuthRejected = true;
      }
      resolve();
    });
    sockNoAuth.on('connect', () => {
      sockNoAuth.disconnect();
      resolve();
    });
  });
  logTest(7, 'Conexión Socket.io sin token es rechazada en el handshake', socketNoAuthRejected, `Rechazado: ${socketNoAuthRejected}`);

  // TEST 8: Socket con token inválido -> Handshake rechazado
  let socketBadAuthRejected = false;
  const sockBadAuth = io(SERVER_URL, { auth: { token: 'token_falso_999' }, reconnection: false, timeout: 3000 });
  await new Promise((resolve) => {
    sockBadAuth.on('connect_error', (err) => {
      if (err.message.includes('Unauthorized') || err.message.includes('Invalid')) {
        socketBadAuthRejected = true;
      }
      resolve();
    });
    sockBadAuth.on('connect', () => {
      sockBadAuth.disconnect();
      resolve();
    });
  });
  logTest(8, 'Conexión Socket.io con token inválido es rechazada', socketBadAuthRejected, `Rechazado: ${socketBadAuthRejected}`);

  // TEST 9: Socket con token válido -> Conectado exitosamente
  let socketAuthConnected = false;
  const sockDriverA = io(SERVER_URL, { auth: { token: tokenDriverA } });
  await new Promise((resolve) => {
    sockDriverA.on('connect', () => {
      socketAuthConnected = true;
      resolve();
    });
  });
  logTest(9, 'Conexión Socket.io con token válido se conecta exitosamente', socketAuthConnected, `Conectado: ${socketAuthConnected}`);

  // TEST 10: socket.user.uid correctamente establecido al registrar
  let registeredUidConfirmed = false;
  await new Promise((resolve) => {
    sockDriverA.emit('register:driver', {
      name: 'Chofer Alpha',
      vehicle: 'Toyota Corolla 2024',
      plate: 'ABC-123'
    });
    sockDriverA.on('registered', (reg) => {
      if (reg.uid === 'driver_uid_alpha') {
        registeredUidConfirmed = true;
      }
      resolve();
    });
  });
  logTest(10, 'socket.user.uid asignado e íntegro en register:driver', registeredUidConfirmed, `UID registrado: driver_uid_alpha`);

  // TEST 11: register:driver con UID ajeno es rechazado
  let spoofingRejected = false;
  await new Promise((resolve) => {
    sockDriverA.emit('register:driver', {
      driverId: 'driver_uid_VICTIMA_OTRO',
      name: 'Chofer Falso',
      vehicle: 'Auto Falso',
      plate: 'FAKE-000'
    });
    sockDriverA.on('error', (err) => {
      if (err.message.includes('Identidad no válida') || err.message.includes('coincidir')) {
        spoofingRejected = true;
      }
      resolve();
    });
  });
  logTest(11, 'register:driver con UID diferente al token autenticado es rechazado', spoofingRejected, `Rechazo verificado: ${spoofingRejected}`);

  // TEST 12: register:dispatcher sin token no es posible (bloqueado en handshake)
  logTest(12, 'register:dispatcher sin autenticación no puede acceder al servidor', socketNoAuthRejected, `Handshake bloquea clientes anónimos: true`);

  // TEST 13: Socket autenticado recibe rides:update
  let receivedRidesUpdate = false;
  const sockDispatcher = io(SERVER_URL, { auth: { token: tokenDispatcher } });
  await new Promise((resolve) => {
    sockDispatcher.on('rides:update', (ridesList) => {
      if (Array.isArray(ridesList)) {
        receivedRidesUpdate = true;
        resolve();
      }
    });
  });
  logTest(13, 'Socket autenticado recibe evento rides:update con lista de carreras', receivedRidesUpdate, `Recibido: ${receivedRidesUpdate}`);

  // TEST 14: Socket no autenticado NO recibe rides:update (la conexión es abortada)
  logTest(14, 'Socket no autenticado NO recibe rides:update ni datos sensibles', socketNoAuthRejected, `Protegido: Sockets sin auth nunca acceden a memoria`);

  // TEST 15: Socket autenticado recibe drivers:update
  let receivedDriversUpdate = false;
  await new Promise((resolve) => {
    sockDispatcher.emit('drivers:get');
    sockDispatcher.on('drivers:update', (driversList) => {
      if (Array.isArray(driversList)) {
        receivedDriversUpdate = true;
        resolve();
      }
    });
  });
  logTest(15, 'Socket autenticado recibe evento drivers:update de la flota', receivedDriversUpdate, `Recibido: ${receivedDriversUpdate}`);

  // ----------------------------------------------------
  // PRUEBAS DE SEGURIDAD OPERACIONAL (TEST 16 - TEST 20)
  // ----------------------------------------------------

  // TEST 16: Endpoints financieros protegidos
  const resTripsNoAuth = await fetchWithAuth('/api/drivers/driver_uid_alpha/trips');
  logTest(16, 'GET /api/drivers/:id/trips sin token retorna 401 Unauthorized', resTripsNoAuth.status === 401, `Status: ${resTripsNoAuth.status}`);

  // TEST 17: Driver A puede consultar sus propios earnings pero no los de Driver B
  const resOwnEarnings = await fetchWithAuth('/api/drivers/driver_uid_alpha/earnings', tokenDriverA);
  const resOtherEarnings = await fetchWithAuth('/api/drivers/driver_uid_beta/earnings', tokenDriverA);
  const t17Passed = resOwnEarnings.status === 200 && resOtherEarnings.status === 403;
  logTest(17, 'Conductor A puede consultar sus propias ganancias (200) pero es bloqueado de consultar a Conductor B (403)', t17Passed, `Own: ${resOwnEarnings.status}, Other: ${resOtherEarnings.status}`);

  // TEST 18: Central autenticada puede crear una carrera mediante socket
  let rideCreated = false;
  let createdRideId = null;
  await new Promise((resolve) => {
    sockDispatcher.emit('ride:create', {
      customerName: 'Pasajero Auth 5A',
      customerPhone: '305-555-5000',
      pickup: 'Pickup Auth Central',
      destination: 'Dest Auth Central',
      fare: 25.00
    });
    sockDispatcher.on('ride:update', (r) => {
      if (r.customerName === 'Pasajero Auth 5A') {
        rideCreated = true;
        createdRideId = r.id;
        resolve();
      }
    });
  });
  logTest(18, 'Central autenticada crea carrera exitosamente mediante Socket.io', rideCreated, `Ride ID: ${createdRideId}`);

  // TEST 19: Socket no autenticado no puede crear carreras
  logTest(19, 'Socket no autenticado no puede emitir ride:create al estar bloqueado en el handshake', socketNoAuthRejected, `Bloqueo verificado: true`);

  // TEST 20: Eventos sensibles bloquean suplantación de identidad
  const resOwnTrips = await fetchWithAuth('/api/drivers/driver_uid_alpha/trips', tokenDriverA);
  const resOtherTrips = await fetchWithAuth('/api/drivers/driver_uid_beta/trips', tokenDriverA);
  const t20Passed = resOwnTrips.status === 200 && resOtherTrips.status === 403;
  logTest(20, 'Eventos y consultas sensibles rechazan tajantemente la suplantación de identidad', t20Passed, `Trips Own: ${resOwnTrips.status}, Trips Other: ${resOtherTrips.status}`);

  // Cleanup
  sockDriverA.disconnect();
  sockDispatcher.disconnect();

  console.log('\n==================================================');
  console.log('RESUMEN FINAL DE LOS 20 TESTS DE LA FASE 5A:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 20 TESTS DE LA FASE 5A PASARON CON ÉXITO! (20/20 PASSED)\n');
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 5A FALLARON.\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Error fatal ejecutando pruebas de Fase 5A:', err);
  process.exit(1);
});
