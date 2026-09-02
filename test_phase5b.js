const io = require('socket.io-client');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = await res.text();
  }
  return { status: res.status, ok: res.ok, data };
}

async function runPhase5bTests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 30 TESTS OBLIGATORIOS DE LA FASE 5B');
  console.log('ROLE-BASED ACCESS CONTROL (RBAC)');
  console.log('==================================================\n');

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Tokens para diferentes roles
  const adminUid = 'admin_user_' + Date.now();
  const adminToken = createTestToken({ uid: adminUid, role: 'admin' });

  const dispatcherUid = 'dispatcher_user_' + Date.now();
  const dispatcherToken = createTestToken({ uid: dispatcherUid, role: 'dispatcher' });

  const supervisorUid = 'supervisor_user_' + Date.now();
  const supervisorToken = createTestToken({ uid: supervisorUid, role: 'supervisor' });

  const driverAUid = 'driver_user_A_' + Date.now();
  const driverAToken = createTestToken({ uid: driverAUid, role: 'driver' });

  const driverBUid = 'driver_user_B_' + Date.now();
  const driverBToken = createTestToken({ uid: driverBUid, role: 'driver' });

  const unassignedRoleUid = 'user_norole_' + Date.now();
  const unassignedRoleToken = createTestToken({ uid: unassignedRoleUid, role: 'guest' });

  // ----------------------------------------------------
  // TEST 1: ADMIN autenticado -> endpoint administrativo permitido
  // ----------------------------------------------------
  const targetUserUid = 'target_user_' + Date.now();
  const t1Res = await request(`${SERVER_URL}/api/admin/set-role`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uid: targetUserUid, role: 'dispatcher' })
  });
  const t1Passed = t1Res.status === 200 && t1Res.data.success === true && t1Res.data.role === 'dispatcher';
  logTest(1, 'ADMIN autenticado -> endpoint administrativo permitido (200 OK)', t1Passed, `Status: ${t1Res.status}, Rol asignado: ${t1Res.data?.role}`);

  // ----------------------------------------------------
  // TEST 2: DISPATCHER -> operaciones de despacho permitidas
  // ----------------------------------------------------
  const t2Rides = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${dispatcherToken}` }
  });
  const t2Drivers = await request(`${SERVER_URL}/api/drivers`, {
    headers: { 'Authorization': `Bearer ${dispatcherToken}` }
  });
  const t2Passed = t2Rides.status === 200 && Array.isArray(t2Rides.data) && t2Drivers.status === 200 && Array.isArray(t2Drivers.data);
  logTest(2, 'DISPATCHER -> operaciones de despacho permitidas (GET /api/rides y /api/drivers)', t2Passed, `Rides: ${t2Rides.status}, Drivers: ${t2Drivers.status}`);

  // ----------------------------------------------------
  // TEST 3: DRIVER -> endpoint administrativo rechazado 403
  // ----------------------------------------------------
  const t3Res = await request(`${SERVER_URL}/api/admin/set-role`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${driverAToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uid: targetUserUid, role: 'admin' })
  });
  const t3Passed = t3Res.status === 403;
  logTest(3, 'DRIVER -> endpoint administrativo rechazado (403 Forbidden)', t3Passed, `Status: ${t3Res.status}`);

  // ----------------------------------------------------
  // TEST 4: SUPERVISOR -> operaciones permitidas según matriz
  // ----------------------------------------------------
  const t4Rides = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${supervisorToken}` }
  });
  const t4Earnings = await request(`${SERVER_URL}/api/drivers/${driverAUid}/earnings`, {
    headers: { 'Authorization': `Bearer ${supervisorToken}` }
  });
  const t4Passed = t4Rides.status === 200 && t4Earnings.status === 200;
  logTest(4, 'SUPERVISOR -> consulta de flota y ganancias permitida según matriz', t4Passed, `Rides: ${t4Rides.status}, Earnings: ${t4Earnings.status}`);

  // ----------------------------------------------------
  // TEST 5: DRIVER A -> earnings de A permitido
  // ----------------------------------------------------
  const t5Res = await request(`${SERVER_URL}/api/drivers/${driverAUid}/earnings`, {
    headers: { 'Authorization': `Bearer ${driverAToken}` }
  });
  const t5Passed = t5Res.status === 200 && t5Res.data && t5Res.data.today !== undefined;
  logTest(5, 'DRIVER A -> earnings de A permitido (200 OK)', t5Passed, `Status: ${t5Res.status}`);

  // ----------------------------------------------------
  // TEST 6: DRIVER A -> earnings de B rechazado 403
  // ----------------------------------------------------
  const t6Res = await request(`${SERVER_URL}/api/drivers/${driverBUid}/earnings`, {
    headers: { 'Authorization': `Bearer ${driverAToken}` }
  });
  const t6Passed = t6Res.status === 403;
  logTest(6, 'DRIVER A -> earnings de B rechazado (403 Forbidden)', t6Passed, `Status: ${t6Res.status}`);

  // ----------------------------------------------------
  // TEST 7: DRIVER A -> trips de B rechazado
  // ----------------------------------------------------
  const t7Res = await request(`${SERVER_URL}/api/drivers/${driverBUid}/trips`, {
    headers: { 'Authorization': `Bearer ${driverAToken}` }
  });
  const t7Passed = t7Res.status === 403;
  logTest(7, 'DRIVER A -> trips de B rechazado (403 Forbidden)', t7Passed, `Status: ${t7Res.status}`);

  // Configurar sockets para pruebas en tiempo real
  const dispatcherSock = io(SERVER_URL, { auth: { token: dispatcherToken } });
  const driverASock = io(SERVER_URL, { auth: { token: driverAToken } });
  const driverBSock = io(SERVER_URL, { auth: { token: driverBToken } });

  await Promise.all([
    new Promise(r => dispatcherSock.on('connect', r)),
    new Promise(r => driverASock.on('connect', r)),
    new Promise(r => driverBSock.on('connect', r))
  ]);

  dispatcherSock.emit('register:dispatcher', { name: 'Despachador 5B' });
  driverASock.emit('register:driver', {
    driverId: driverAUid,
    name: 'Chofer A 5B',
    vehicle: 'Nissan Versa',
    plate: '5B-AAA',
    location: { lat: 40.71, lng: -74.00 }
  });
  driverBSock.emit('register:driver', {
    driverId: driverBUid,
    name: 'Chofer B 5B',
    vehicle: 'Toyota Corolla',
    plate: '5B-BBB',
    location: { lat: 40.72, lng: -74.01 }
  });
  await wait(400);

  // Crear una carrera y asignarla a Driver B
  let rideForB = null;
  const rideCreatedPromise = new Promise((resolve) => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Asignado a B') {
        dispatcherSock.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSock.on('ride:created', handler);
  });

  dispatcherSock.emit('ride:create', {
    customerName: 'Pasajero Asignado a B',
    customerPhone: '555-1212',
    pickup: { address: 'Origen B', lat: 40.72, lng: -74.01 },
    destination: { address: 'Destino B', lat: 40.73, lng: -74.02 },
    assignedDriverId: driverBSock.id,
    fare: 25.00
  });

  rideForB = await rideCreatedPromise;
  await wait(400);

  // ----------------------------------------------------
  // TEST 8: DRIVER A -> ride:complete de B rechazado
  // ----------------------------------------------------
  const t8Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err?.message || err });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:complete', { rideId: rideForB.id });
    setTimeout(() => resolve({ rejected: false }), 800);
  });
  const t8Res = await t8Promise;
  const t8Passed = t8Res.rejected === true;
  logTest(8, 'DRIVER A -> ride:complete de B rechazado por falta de ownership', t8Passed, `Mensaje recibido: "${t8Res.message}"`);

  // ----------------------------------------------------
  // TEST 10: DRIVER A -> ride:accept de ride ya asignado a B rechazado
  // ----------------------------------------------------
  const t10Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('ride:accept_error', handler);
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err?.message || err });
    };
    driverASock.on('ride:accept_error', handler);
    driverASock.on('error', handler);
    driverASock.emit('ride:accept', rideForB.id);
    setTimeout(() => resolve({ rejected: false }), 800);
  });
  const t10Res = await t10Promise;
  const t10Passed = t10Res.rejected === true;
  logTest(10, 'DRIVER A -> ride:accept de ride no asignado / ajeno rechazado', t10Passed, `Respuesta: "${t10Res.message}"`);

  // ----------------------------------------------------
  // TEST 9: DRIVER B -> ride:accept de ride asignado/ofrecido permitido
  // ----------------------------------------------------
  const t9Promise = new Promise((resolve) => {
    const handler = (ride) => {
      if (ride.id === rideForB.id) {
        driverBSock.off('ride:assigned', handler);
        resolve(ride);
      }
    };
    driverBSock.on('ride:assigned', handler);
    driverBSock.emit('ride:accept', rideForB.id);
  });
  const t9Accepted = await Promise.race([t9Promise, wait(2500).then(() => null)]);
  const t9Passed = t9Accepted && t9Accepted.status === 'accepted';
  logTest(9, 'DRIVER B -> ride:accept de ride asignado/ofrecido permitido', t9Passed, `Status: ${t9Accepted?.status}`);

  await wait(300);

  // ----------------------------------------------------
  // TEST 11: DRIVER -> ride:create rechazado
  // ----------------------------------------------------
  const t11Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:create', {
      customerName: 'Ataque Driver Crear Carrera',
      pickup: { address: 'Origen Ataque', lat: 40.71, lng: -74.00 },
      destination: { address: 'Destino Ataque', lat: 40.72, lng: -74.01 }
    });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t11Res = await t11Promise;
  const t11Passed = t11Res.rejected === true && t11Res.message.includes('permisos');
  logTest(11, 'DRIVER -> ride:create rechazado por rol no autorizado', t11Passed, `Mensaje: "${t11Res.message}"`);

  // ----------------------------------------------------
  // TEST 12: DRIVER -> ride:assign rechazado
  // ----------------------------------------------------
  const t12Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:assign', { rideId: rideForB.id, driverId: driverASock.id });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t12Res = await t12Promise;
  const t12Passed = t12Res.rejected === true;
  logTest(12, 'DRIVER -> ride:assign rechazado por rol no autorizado', t12Passed, `Mensaje: "${t12Res.message}"`);

  // ----------------------------------------------------
  // TEST 13: DRIVER -> ride:unassign rechazado
  // ----------------------------------------------------
  const t13Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:unassign', { rideId: rideForB.id, reason: 'Ataque cancelación' });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t13Res = await t13Promise;
  const t13Passed = t13Res.rejected === true;
  logTest(13, 'DRIVER -> ride:unassign rechazado por rol no autorizado', t13Passed, `Mensaje: "${t13Res.message}"`);

  // ----------------------------------------------------
  // TEST 14: DRIVER -> ride:edit administrativo rechazado
  // ----------------------------------------------------
  const t14Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:edit', { rideId: rideForB.id, changes: { customerName: 'Nombre Modificado por Driver' } });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t14Res = await t14Promise;
  const t14Passed = t14Res.rejected === true;
  logTest(14, 'DRIVER -> ride:edit administrativo rechazado por rol', t14Passed, `Mensaje: "${t14Res.message}"`);

  // ----------------------------------------------------
  // TEST 15: DRIVER -> register:dispatcher rechazado
  // ----------------------------------------------------
  const t15Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('register:dispatcher', { name: 'Driver Falso Despachador' });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t15Res = await t15Promise;
  const t15Passed = t15Res.rejected === true;
  logTest(15, 'DRIVER -> register:dispatcher rechazado tajantemente', t15Passed, `Mensaje: "${t15Res.message}"`);

  // ----------------------------------------------------
  // TEST 16: DRIVER -> register:driver como Driver B rechazado por suplantación
  // ----------------------------------------------------
  const t16Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('register:driver', {
      driverId: driverBUid, // Suplantación
      name: 'Chofer Falso B',
      vehicle: 'Auto',
      plate: 'FAKE'
    });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t16Res = await t16Promise;
  const t16Passed = t16Res.rejected === true;
  logTest(16, 'DRIVER -> register:driver como Driver B rechazado por suplantación', t16Passed, `Mensaje: "${t16Res.message}"`);

  // ----------------------------------------------------
  // TEST 17: DISPATCHER -> register:dispatcher permitido
  // ----------------------------------------------------
  const t17Promise = new Promise((resolve) => {
    const handler = (reg) => {
      dispatcherSock.off('registered', handler);
      resolve({ success: true, reg });
    };
    dispatcherSock.on('registered', handler);
    dispatcherSock.emit('register:dispatcher', { name: 'Despachador Oficial' });
  });
  const t17Res = await t17Promise;
  const t17Passed = t17Res.success && t17Res.reg.type === 'dispatcher' && t17Res.reg.role === 'dispatcher';
  logTest(17, 'DISPATCHER -> register:dispatcher permitido con rol oficial', t17Passed, `Registrado como: ${t17Res.reg?.type}, Rol: ${t17Res.reg?.role}`);

  // ----------------------------------------------------
  // TEST 18: ADMIN -> operación administrativa permitida
  // ----------------------------------------------------
  const t18Res = await request(`${SERVER_URL}/api/admin/set-role`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uid: driverBUid, role: 'driver' })
  });
  const t18Passed = t18Res.status === 200 && t18Res.data.success === true;
  logTest(18, 'ADMIN -> asignación administrativa de roles permitida', t18Passed, `Status: ${t18Res.status}`);

  // ----------------------------------------------------
  // TEST 19: usuario autenticado sin role -> 403
  // ----------------------------------------------------
  const t19Res = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${unassignedRoleToken}` }
  });
  const t19Passed = t19Res.status === 403;
  logTest(19, 'Usuario autenticado sin rol autorizado recibe 403 Forbidden', t19Passed, `Status: ${t19Res.status}`);

  // ----------------------------------------------------
  // TEST 20: role enviado falsamente en payload -> ignorado
  // ----------------------------------------------------
  const t20Res = await request(`${SERVER_URL}/api/admin/set-role`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${driverAToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'admin', uid: driverAUid, targetRole: 'admin' })
  });
  const t20Passed = t20Res.status === 403;
  logTest(20, 'Role falsificado en payload JSON es ignorado y rechazado (403)', t20Passed, `Status: ${t20Res.status}`);

  // ----------------------------------------------------
  // TEST 21: role enviado falsamente en header -> ignorado
  // ----------------------------------------------------
  const t21Res = await request(`${SERVER_URL}/api/admin/set-role`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${driverAToken}`,
      'X-User-Role': 'admin',
      'Role': 'admin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uid: driverAUid, role: 'admin' })
  });
  const t21Passed = t21Res.status === 403;
  logTest(21, 'Role falsificado en headers personalizados es ignorado y rechazado (403)', t21Passed, `Status: ${t21Res.status}`);

  // ----------------------------------------------------
  // TEST 22: role enviado en query -> ignorado
  // ----------------------------------------------------
  const t22Res = await request(`${SERVER_URL}/api/rides?role=admin&userRole=dispatcher`, {
    headers: { 'Authorization': `Bearer ${driverAToken}` }
  });
  const t22Passed = t22Res.status === 403;
  logTest(22, 'Role falsificado en query parameters es ignorado y rechazado (403)', t22Passed, `Status: ${t22Res.status}`);

  // ----------------------------------------------------
  // TEST 23: socket con role falso en evento -> no obtiene permisos
  // ----------------------------------------------------
  const t23Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err.message });
    };
    driverASock.on('error', handler);
    driverASock.emit('register:dispatcher', { name: 'Atacante', role: 'admin' });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t23Res = await t23Promise;
  const t23Passed = t23Res.rejected === true;
  logTest(23, 'Socket con role falso en evento emitido no obtiene permisos de central', t23Passed, `Rechazo verificado: ${t23Passed}`);

  // ----------------------------------------------------
  // TEST 24: socket driver intentando evento administrativo -> rechazado
  // ----------------------------------------------------
  const t24Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:assign', { rideId: 'alguna_carrera', driverId: 'algun_chofer' });
    setTimeout(() => resolve({ rejected: false }), 600);
  });
  const t24Res = await t24Promise;
  const t24Passed = t24Res.rejected === true;
  logTest(24, 'Socket driver intentando evento administrativo de asignación es rechazado', t24Passed, `Rechazado: ${t24Passed}`);

  // ----------------------------------------------------
  // TEST 25: socket driver manipulando driverId en evento de llegada -> rechazado
  // ----------------------------------------------------
  const t25Promise = new Promise((resolve) => {
    const handler = (err) => {
      driverASock.off('error', handler);
      resolve({ rejected: true, message: err?.message || err });
    };
    driverASock.on('error', handler);
    driverASock.emit('ride:arrived_at_pickup', { rideId: rideForB.id });
    setTimeout(() => resolve({ rejected: false }), 800);
  });
  const t25Res = await t25Promise;
  const t25Passed = t25Res.rejected === true;
  logTest(25, 'Socket driver manipulando rideId ajeno en arrived_at_pickup es bloqueado', t25Passed, `Mensaje: "${t25Res.message}"`);

  // ----------------------------------------------------
  // TEST 26: socket dispatcher ejecutando ride:create -> permitido
  // ----------------------------------------------------
  let dispCreatedRide = null;
  const t26Promise = new Promise((resolve) => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Dispatcher 5B') {
        dispatcherSock.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSock.on('ride:created', handler);
    dispatcherSock.emit('ride:create', {
      customerName: 'Pasajero Dispatcher 5B',
      customerPhone: '555-8888',
      pickup: { address: 'Calle 10', lat: 40.71, lng: -74.00 },
      destination: { address: 'Calle 20', lat: 40.72, lng: -74.01 },
      fare: 18.00
    });
  });
  dispCreatedRide = await t26Promise;
  const t26Passed = dispCreatedRide && dispCreatedRide.status === 'pending';
  logTest(26, 'Socket dispatcher autenticado ejecutando ride:create -> permitido (creado)', t26Passed, `Ride ID: ${dispCreatedRide?.id}, Status: ${dispCreatedRide?.status}`);

  // ----------------------------------------------------
  // TEST 27: socket no autenticado -> 5A debe seguir rechazándolo
  // ----------------------------------------------------
  const unauthSocket = io(SERVER_URL);
  const t27Promise = new Promise((resolve) => {
    unauthSocket.on('connect_error', (err) => {
      resolve({ rejected: true, message: err.message });
    });
    unauthSocket.on('connect', () => {
      resolve({ rejected: false });
    });
  });
  const t27Res = await t27Promise;
  unauthSocket.disconnect();
  const t27Passed = t27Res.rejected === true;
  logTest(27, 'Socket no autenticado es rechazado en el handshake por 5A/5B', t27Passed, `Mensaje: "${t27Res.message}"`);

  // ----------------------------------------------------
  // TEST 28: token válido con role válido -> acceso correcto
  // ----------------------------------------------------
  const t28Res = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const t28Passed = t28Res.status === 200 && Array.isArray(t28Res.data);
  logTest(28, 'Token válido con role ADMIN obtiene acceso completo a recursos protegidos', t28Passed, `Status: ${t28Res.status}, Total Carreras: ${t28Res.data?.length}`);

  // ----------------------------------------------------
  // TEST 29: token expirado -> 5A/5B rechaza correctamente (401)
  // ----------------------------------------------------
  const expiredToken = createTestToken({
    uid: 'expired_admin',
    role: 'admin',
    exp: Date.now() - 10000 // Expirado hace 10 seg
  });
  const t29Res = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${expiredToken}` }
  });
  const t29Passed = t29Res.status === 401;
  logTest(29, 'Token con timestamp expirado es rechazado con 401 Unauthorized', t29Passed, `Status: ${t29Res.status}`);

  // ----------------------------------------------------
  // TEST 30: cambio de role + refresh token -> nuevo permiso aplicado
  // ----------------------------------------------------
  const promotedUserUid = 'promoted_user_' + Date.now();
  // 1. Inicia como DRIVER
  const oldDriverToken = createTestToken({ uid: promotedUserUid, role: 'driver' });
  const step1Res = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${oldDriverToken}` }
  });
  // 2. Admin actualiza su rol a DISPATCHER
  await request(`${SERVER_URL}/api/admin/set-role`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uid: promotedUserUid, role: 'dispatcher' })
  });
  // 3. Simular token refrescado con el nuevo claim
  const refreshedToken = createTestToken({ uid: promotedUserUid, role: 'dispatcher' });
  const step2Res = await request(`${SERVER_URL}/api/rides`, {
    headers: { 'Authorization': `Bearer ${refreshedToken}` }
  });

  const t30Passed = step1Res.status === 403 && step2Res.status === 200;
  logTest(30, 'Cambio de role + refresh token -> nuevo permiso aplicado exitosamente', t30Passed, `Antes del refresh: ${step1Res.status} (Forbidden), Después del refresh: ${step2Res.status} (OK)`);

  // Cleanup sockets
  dispatcherSock.disconnect();
  driverASock.disconnect();
  driverBSock.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 30 TESTS DE LA FASE 5B:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 30 TESTS DE LA FASE 5B PASARON CON ÉXITO! (30/30 PASSED)\n');
    await wait(300);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 5B FALLARON.\n');
    await wait(300);
    process.exit(1);
  }
}

runPhase5bTests().catch(err => {
  console.error('Error fatal ejecutando test_phase5b.js:', err);
  process.exit(1);
});
