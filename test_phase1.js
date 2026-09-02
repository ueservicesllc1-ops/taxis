const io = require('socket.io-client');
const fs = require('fs');
const http = require('http');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_central_' + Date.now(), role: 'admin' });
const driverAUid = 'driver_A_' + Date.now();
const driverBUid = 'driver_B_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid, role: 'driver' });
const driverBToken = createTestToken({ uid: driverBUid, role: 'driver' });

function fetchAuth(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    http.get({
      hostname: parsed.hostname,
      port: parsed.port || 3000,
      path: parsed.pathname + parsed.search,
      headers: { 'Authorization': `Bearer ${adminToken}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 10 TESTS OBLIGATORIOS DE LA FASE 1');
  console.log('==================================================\n');

  const results = {};

  // Conectar Base
  const baseSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => baseSocket.on('connect', r));
  baseSocket.emit('register:dispatcher', { name: 'Operador Central' });

  // Conectar Driver A
  const driverASocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(r => driverASocket.on('connect', r));
  driverASocket.emit('register:driver', {
    driverId: driverAUid,
    name: 'Carlos Conductor A',
    vehicle: 'Toyota Camry (2022)',
    plate: 'Placa: ABC-123',
    location: { lat: 40.7128, lng: -74.0060 }
  });

  // Conectar Driver B
  const driverBSocket = io(SERVER_URL, { auth: { token: driverBToken } });
  await new Promise(r => driverBSocket.on('connect', r));
  driverBSocket.emit('register:driver', {
    driverId: driverBUid,
    name: 'Roberto Conductor B',
    vehicle: 'Honda Civic (2021)',
    plate: 'Placa: XYZ-789',
    location: { lat: 40.7661, lng: -73.9771 }
  });

  await new Promise(r => setTimeout(r, 600));

  // ----------------------------------------------------
  // TEST 1: Base crea viaje -> Driver A recibe -> A acepta.
  // ----------------------------------------------------
  console.log('--- TEST 1: Base crea viaje -> Driver A recibe -> A acepta ---');
  let test1RideId = null;
  let driverAReceived = false;
  let rideAccepted = false;

  driverASocket.once('ride:new', (ride) => {
    test1RideId = ride.id;
    driverAReceived = true;
    driverASocket.emit('ride:accept', ride.id);
  });

  baseSocket.once('ride:accepted', (ride) => {
    if (ride.id === test1RideId && ride.driverId === driverASocket.id) {
      rideAccepted = true;
    }
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Calle 10 y Broadway', lat: 40.7128, lng: -74.0060 },
    destination: { address: 'Times Square', lat: 40.7580, lng: -73.9855 },
    customerName: 'Juan Perez',
    customerPhone: '+15551234567',
    fare: 22.50,
    assignedDriverId: driverASocket.id
  });

  await new Promise(r => setTimeout(r, 1200));
  results['TEST 1'] = driverAReceived && rideAccepted ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 1: ${results['TEST 1']}\n`);

  // ----------------------------------------------------
  // TEST 5: Driver acepta -> pasa a BUSY.
  // ----------------------------------------------------
  console.log('--- TEST 5: Driver acepta -> pasa a BUSY ---');
  const driverADocRes = await fetchAuth('http://localhost:3000/api/drivers');
  const driverAInList = Array.isArray(driverADocRes) ? driverADocRes.find(d => d.id === driverASocket.id) : null;
  // driverADocRes only contains available drivers; therefore driverA should NOT be available
  results['TEST 5'] = (Array.isArray(driverADocRes) && !driverAInList) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 5 (Driver A está BUSY y no aparece disponible): ${results['TEST 5']}\n`);

  // ----------------------------------------------------
  // TEST 6: Driver completa -> vuelve a AVAILABLE.
  // ----------------------------------------------------
  console.log('--- TEST 6: Driver completa -> vuelve a AVAILABLE ---');
  driverASocket.emit('ride:complete', { rideId: test1RideId, fare: '$22.50' });
  await new Promise(r => setTimeout(r, 600));
  const driversAfterComplete = await fetchAuth('http://localhost:3000/api/drivers?all=true');
  const driverABackAvailable = driversAfterComplete.find(d => d.id === driverASocket.id || d.driverId === driverAUid);
  results['TEST 6'] = driverABackAvailable && (driverABackAvailable.available || driverABackAvailable.status === 'available') ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 6 (Driver A completó y vuelve a AVAILABLE): ${results['TEST 6']}\n`);

  // ----------------------------------------------------
  // TEST 2: Base crea viaje -> Driver A recibe -> A rechaza -> Driver B recibe automáticamente.
  // ----------------------------------------------------
  console.log('--- TEST 2: Driver A rechaza -> Driver B recibe automáticamente ---');
  let test2RideId = null;
  let driverBGotReassigned = false;

  driverASocket.once('ride:new', (ride) => {
    test2RideId = ride.id;
    // Driver A rechaza
    driverASocket.emit('ride:rejected', {
      rideId: ride.id,
      driverId: driverAUid,
      reason: 'Muy lejos de mi zona'
    });
  });

  driverBSocket.once('ride:new', (ride) => {
    if (ride.id === test2RideId) {
      driverBGotReassigned = true;
      driverBSocket.emit('ride:accept', ride.id);
    }
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Central Park South', lat: 40.7660, lng: -73.9770 },
    destination: { address: 'Wall Street', lat: 40.7068, lng: -74.0090 },
    customerName: 'Maria Rodriguez',
    assignedDriverId: driverASocket.id
  });

  await new Promise(r => setTimeout(r, 1500));
  results['TEST 2'] = driverBGotReassigned ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 2: ${results['TEST 2']}\n`);

  // Liberar Driver B
  driverBSocket.emit('ride:complete', { rideId: test2RideId, fare: '$30.00' });
  await new Promise(r => setTimeout(r, 600));

  // ----------------------------------------------------
  // TEST 3: Base crea viaje -> Driver A recibe -> expira (15s) -> Driver B recibe.
  // ----------------------------------------------------
  console.log('--- TEST 3: Driver A expira -> Driver B recibe automáticamente ---');
  let test3RideId = null;
  let driverBGotAfterExpire = false;

  driverBSocket.emit('driver:location', { lat: 40.7062, lng: -73.9968 });
  await new Promise(r => setTimeout(r, 200));

  driverASocket.once('ride:new', (ride) => {
    test3RideId = ride.id;
    // Simular que el temporizador llegó a 0
    driverASocket.emit('ride:expired', {
      rideId: ride.id,
      driverId: driverAUid
    });
  });

  driverBSocket.once('ride:new', (ride) => {
    if (ride.id === test3RideId) {
      driverBGotAfterExpire = true;
    }
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Brooklyn Bridge', lat: 40.7061, lng: -73.9969 },
    destination: { address: 'SoHo', lat: 40.7233, lng: -74.0030 },
    customerName: 'David Smith',
    assignedDriverId: driverASocket.id
  });

  await new Promise(r => setTimeout(r, 1500));
  results['TEST 3'] = driverBGotAfterExpire ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 3: ${results['TEST 3']}\n`);

  // ----------------------------------------------------
  // TEST 4: Concurrencia segura (Driver A y B intentan aceptar simultáneamente)
  // ----------------------------------------------------
  console.log('--- TEST 4: Aceptación simultánea -> Sólo UNO gana y el otro recibe ride:accept_error ---');
  let test4RideId = null;
  let onlyOneAccepted = false;
  let oneReceivedError = false;

  driverBSocket.once('ride:accept_error', (err) => {
    oneReceivedError = true;
  });
  driverASocket.once('ride:accept_error', (err) => {
    oneReceivedError = true;
  });

  // Crear carrera difundiéndola a ambos
  baseSocket.once('ride:created', (ride) => {
    test4RideId = ride.id;
    // Ambos intentan aceptar simultáneamente
    driverASocket.emit('ride:accept', ride.id);
    driverBSocket.emit('ride:accept', ride.id);
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'LaGuardia Airport', lat: 40.7769, lng: -73.8740 },
    destination: { address: 'Midtown', lat: 40.7549, lng: -73.9840 },
    customerName: 'Cliente Concurrente'
  });

  await new Promise(r => setTimeout(r, 1500));
  const ridesList = await fetchAuth('http://localhost:3000/api/rides');
  const r4 = ridesList.find(r => r.id === test4RideId);
  onlyOneAccepted = r4 && r4.status === 'accepted' && (r4.driverId === driverASocket.id || r4.driverId === driverBSocket.id);
  results['TEST 4'] = (onlyOneAccepted && oneReceivedError) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 4: ${results['TEST 4']}\n`);

  // ----------------------------------------------------
  // TEST 7: Driver cancela por problema mecánico -> Central recibe cancelación -> chofer liberado
  // ----------------------------------------------------
  console.log('--- TEST 7: Driver cancela por problema mecánico -> Chofer se libera ---');
  let centralGotCancel = false;
  baseSocket.once('ride:driver_cancelled', (data) => {
    if (data.rideId === test4RideId && data.reason.includes('Problema mecánico')) {
      centralGotCancel = true;
    }
  });

  const assignedSocket = r4.driverId === driverASocket.id ? driverASocket : driverBSocket;
  assignedSocket.emit('ride:cancel', {
    rideId: test4RideId,
    driverId: assignedSocket.id,
    reason: 'Problema mecánico / Avería'
  });

  await new Promise(r => setTimeout(r, 1200));
  const driversAfterDriverCancel = await fetchAuth('http://localhost:3000/api/drivers');
  const freedDriver = driversAfterDriverCancel.find(d => d.id === assignedSocket.id);
  results['TEST 7'] = (centralGotCancel && freedDriver && freedDriver.available) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 7: ${results['TEST 7']}\n`);

  // ----------------------------------------------------
  // TEST 8: Driver pierde conexión temporal -> reconecta -> recupera sesión
  // ----------------------------------------------------
  console.log('--- TEST 8: Reconexión y recuperación de carrera activa ---');
  let test8RideId = null;

  baseSocket.once('ride:created', (createdRide) => {
    test8RideId = createdRide.id;
    driverASocket.emit('ride:accept', createdRide.id);
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Queens Plaza', lat: 40.7490, lng: -73.9370 },
    destination: { address: 'Astoria', lat: 40.7644, lng: -73.9235 },
    customerName: 'Elena Rostova ' + Date.now(),
    assignedDriverId: driverASocket.id
  });

  await new Promise(r => setTimeout(r, 800));

  // Desconectar Driver A simulando corte de red
  driverASocket.disconnect();
  await new Promise(r => setTimeout(r, 800));

  // Reconectar nuevo socket para Driver A con su mismo driverId/userId
  const reconnectedDriverA = io(SERVER_URL, { auth: { token: driverAToken } });
  let rideRecoveredOnConnect = false;

  reconnectedDriverA.on('ride:assigned', (recoveredRide) => {
    if (recoveredRide.id === test8RideId) {
      rideRecoveredOnConnect = true;
    }
  });

  reconnectedDriverA.emit('register:driver', {
    driverId: driverAUid,
    name: 'Carlos Conductor A',
    vehicle: 'Toyota Camry (2022)',
    plate: 'Placa: ABC-123',
    location: { lat: 40.7128, lng: -74.0060 }
  });

  await new Promise(r => setTimeout(r, 1200));
  results['TEST 8'] = rideRecoveredOnConnect ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 8: ${results['TEST 8']}\n`);

  // Liberar carrera 8
  reconnectedDriverA.emit('ride:complete', { rideId: test8RideId, fare: '$18.00' });
  await new Promise(r => setTimeout(r, 600));

  // ----------------------------------------------------
  // TEST 9: Driver OFFLINE -> no recibe nuevas carreras
  // ----------------------------------------------------
  console.log('--- TEST 9: Driver OFFLINE -> No recibe carreras ---');
  reconnectedDriverA.emit('driver:availability', { available: false });
  await new Promise(r => setTimeout(r, 600));

  let driverGotWhileOffline = false;
  reconnectedDriverA.once('ride:new', () => {
    driverGotWhileOffline = true;
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Harlem', lat: 40.8116, lng: -73.9465 },
    destination: { address: 'Bronx', lat: 40.8448, lng: -73.8648 },
    customerName: 'Pasajero Test OFFLINE'
  });

  await new Promise(r => setTimeout(r, 1200));
  results['TEST 9'] = (!driverGotWhileOffline) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 9: ${results['TEST 9']}\n`);

  // ----------------------------------------------------
  // TEST 10: Persistencia de disco
  // ----------------------------------------------------
  console.log('--- TEST 10: Verificación de persistencia en disco rides_cache.json ---');
  const cacheExists = fs.existsSync('./server/data/rides_cache.json');
  const cacheData = cacheExists ? JSON.parse(fs.readFileSync('./server/data/rides_cache.json', 'utf8')) : [];
  const foundSavedRides = cacheData.length > 0;
  results['TEST 10'] = (cacheExists && foundSavedRides) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 10 (rides_cache.json contiene ${cacheData.length} viajes persistidos): ${results['TEST 10']}\n`);

  // Limpieza de sockets de prueba
  baseSocket.disconnect();
  reconnectedDriverA.disconnect();
  driverBSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 10 TESTS:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
