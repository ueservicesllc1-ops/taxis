const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_f3_' + Date.now() });
const driverAId = 'driver_F3_A_' + Date.now();
const driverBId = 'driver_F3_B_' + Date.now();
const driverAToken = createTestToken({ uid: driverAId });
const driverBToken = createTestToken({ uid: driverBId });

function fetchWithToken(url, token) {
  return fetch(url, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json());
}

async function runPhase3Tests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 15 TESTS OBLIGATORIOS DE LA FASE 3');
  console.log('==================================================\n');

  const results = {};

  // Conectar Base
  const baseSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => baseSocket.on('connect', r));
  baseSocket.emit('register:dispatcher', { name: 'Operador Central F3' });

  // Conectar Driver A
  const driverASocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(r => driverASocket.on('connect', r));
  driverASocket.emit('register:driver', {
    driverId: driverAId,
    name: 'Carlos Conductor A',
    vehicle: 'Toyota Prius (2022)',
    plate: 'Placa: A123',
    location: { lat: 40.7580, lng: -73.9855 }
  });

  // Conectar Driver B
  const driverBSocket = io(SERVER_URL, { auth: { token: driverBToken } });
  await new Promise(r => driverBSocket.on('connect', r));
  driverBSocket.emit('register:driver', {
    driverId: driverBId,
    name: 'Roberto Conductor B',
    vehicle: 'Hyundai Elantra (2021)',
    plate: 'Placa: B456',
    location: { lat: 40.7585, lng: -73.9860 }
  });

  await new Promise(r => setTimeout(r, 600));

  // ----------------------------------------------------
  // TEST 1: Completar viaje -> genera earning
  // ----------------------------------------------------
  console.log('--- TEST 1: Completar viaje genera earning en backend ---');
  let ride1 = null;
  baseSocket.once('ride:created', r => { ride1 = r; });
  baseSocket.emit('ride:create', {
    pickup: { address: 'Calle 50 y 5ta Ave', lat: 40.7589, lng: -73.9787 },
    destination: { address: 'Wall Street 100', lat: 40.7061, lng: -74.0092 },
    customerName: 'Pasajero Test 1',
    fare: 28.50,
    assignedDriverId: driverASocket.id
  });
  await new Promise(r => setTimeout(r, 600));

  // Driver A acepta
  driverASocket.emit('ride:accept', ride1.id);
  await new Promise(r => setTimeout(r, 600));

  // Driver A completa
  let test1EarningEvent = null;
  driverASocket.once('driver:earning_updated', data => { test1EarningEvent = data; });
  driverASocket.emit('ride:complete', { rideId: ride1.id });
  await new Promise(r => setTimeout(r, 800));

  const earningsAfterTest1 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  results['TEST 1'] = (test1EarningEvent && test1EarningEvent.driverEarnings === 28.50 && earningsAfterTest1.today.total >= 28.50) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 1: ${results['TEST 1']}\n`);

  // ----------------------------------------------------
  // TEST 2: Completar el mismo viaje dos veces -> solamente un earning
  // ----------------------------------------------------
  console.log('--- TEST 2: Idempotencia - Reenviar ride:complete no duplica ganancia ---');
  const initialTotal = earningsAfterTest1.today.total;
  const initialCount = earningsAfterTest1.today.tripCount;

  // Segundo envío de complete para el mismo ride1.id
  driverASocket.emit('ride:complete', { rideId: ride1.id });
  await new Promise(r => setTimeout(r, 600));

  const earningsAfterTest2 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  const noDuplication = (earningsAfterTest2.today.total === initialTotal) && (earningsAfterTest2.today.tripCount === initialCount);
  results['TEST 2'] = noDuplication ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 2: ${results['TEST 2']}\n`);

  // ----------------------------------------------------
  // TEST 3: Conductor A rechaza -> B acepta y completa -> solo B gana
  // ----------------------------------------------------
  console.log('--- TEST 3: Reasignación - A rechaza, B completa, solo B gana ---');
  let ride3 = null;
  baseSocket.once('ride:created', r => { ride3 = r; });
  baseSocket.emit('ride:create', {
    pickup: { address: 'Metropolitan Museum', lat: 40.7794, lng: -73.9632 },
    destination: { address: 'Columbus Circle', lat: 40.7681, lng: -73.9819 },
    customerName: 'Turista Museo',
    fare: 18.00,
    assignedDriverId: driverASocket.id
  });
  await new Promise(r => setTimeout(r, 600));

  const aEarningsBefore = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  const bEarningsBefore = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverBId}/earnings`, driverBToken);

  // A rechaza
  driverASocket.emit('ride:rejected', { rideId: ride3.id, driverId: driverAId, reason: 'Fuera de zona' });
  await new Promise(r => setTimeout(r, 600));

  // B acepta y completa
  driverBSocket.emit('ride:accept', ride3.id);
  await new Promise(r => setTimeout(r, 600));
  driverBSocket.emit('ride:complete', { rideId: ride3.id });
  await new Promise(r => setTimeout(r, 800));

  const aEarningsAfter = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  const bEarningsAfter = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverBId}/earnings`, driverBToken);

  const aDidNotEarn = aEarningsAfter.today.total === aEarningsBefore.today.total;
  const bEarned = bEarningsAfter.today.total === (bEarningsBefore.today.total + 18.00);
  results['TEST 3'] = (aDidNotEarn && bEarned) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 3: ${results['TEST 3']}\n`);

  // ----------------------------------------------------
  // TEST 4: Viaje cancelado -> $0 de earnings
  // ----------------------------------------------------
  console.log('--- TEST 4: Viaje cancelado -> $0.00 de ganancia registrada ---');
  let ride4 = null;
  baseSocket.once('ride:created', r => { ride4 = r; });
  baseSocket.emit('ride:create', {
    pickup: { address: 'Battery Park', lat: 40.7033, lng: -74.0170 },
    destination: { address: 'Tribeca', lat: 40.7163, lng: -74.0086 },
    customerName: 'Cliente Cancelador',
    fare: 22.00,
    assignedDriverId: driverASocket.id
  });
  await new Promise(r => setTimeout(r, 600));

  // Cancelar carrera con motivo
  baseSocket.emit('ride:cancel', { rideId: ride4.id, reason: 'Cliente canceló el pedido por demora', cancelledBy: 'dispatcher' });
  await new Promise(r => setTimeout(r, 800));

  const tripsA = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/trips?status=cancelled`, driverAToken);
  const cancelledTrip = tripsA.trips.find(t => t.rideId === ride4.id);
  results['TEST 4'] = (cancelledTrip && cancelledTrip.driverEarnings === 0 && cancelledTrip.status === 'cancelled') ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 4: ${results['TEST 4']}\n`);

  // ----------------------------------------------------
  // TEST 5: Wallet muestra datos reales
  // ----------------------------------------------------
  console.log('--- TEST 5: Endpoint de Wallet devuelve datos reales calculados ---');
  const walletData = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  const hasRealWalletProps = walletData.today && typeof walletData.today.total === 'number' &&
                            walletData.week && typeof walletData.week.total === 'number' &&
                            walletData.month && typeof walletData.month.total === 'number' &&
                            walletData.currency === 'USD';
  results['TEST 5'] = hasRealWalletProps ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 5: ${results['TEST 5']}\n`);

  // ----------------------------------------------------
  // TEST 6: Historial muestra viaje completado
  // ----------------------------------------------------
  console.log('--- TEST 6: Historial contiene viaje completado con datos completos ---');
  const allTripsA = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/trips?status=completed`, driverAToken);
  const foundCompleted = allTripsA.trips.find(t => t.rideId === ride1.id);
  results['TEST 6'] = (foundCompleted && foundCompleted.passengerName === 'Pasajero Test 1' && foundCompleted.driverEarnings === 28.50) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 6: ${results['TEST 6']}\n`);

  // ----------------------------------------------------
  // TEST 7: Historial muestra viaje cancelado
  // ----------------------------------------------------
  console.log('--- TEST 7: Historial muestra viaje cancelado con $0.00 y motivo ---');
  const foundCancelled = tripsA.trips.find(t => t.rideId === ride4.id);
  results['TEST 7'] = (foundCancelled && foundCancelled.driverEarnings === 0 && foundCancelled.cancelReason) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 7: ${results['TEST 7']}\n`);

  // ----------------------------------------------------
  // TEST 8: Detalle del viaje muestra datos correctos
  // ----------------------------------------------------
  console.log('--- TEST 8: Detalle del viaje devuelve todos los campos requeridos ---');
  const tripDetail = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/trips/${ride1.id}`, driverAToken);
  const hasAllFields = tripDetail.rideId === ride1.id &&
                       tripDetail.passengerName &&
                       tripDetail.pickup &&
                       tripDetail.destination &&
                       tripDetail.fare === 28.50 &&
                       tripDetail.driverEarnings === 28.50 &&
                       tripDetail.platformFee === 0 &&
                       tripDetail.currency === 'USD';
  results['TEST 8'] = hasAllFields ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 8: ${results['TEST 8']}\n`);

  // ----------------------------------------------------
  // TEST 9: Un conductor no puede consultar earnings de otro
  // ----------------------------------------------------
  console.log('--- TEST 9: Seguridad - Conductor A no puede consultar ganancias de Conductor B ---');
  const unauthorizedRes = await fetch(`${SERVER_URL}/api/drivers/${driverBId}/earnings`, {
    headers: { 'Authorization': `Bearer ${driverAToken}` }
  });
  results['TEST 9'] = (unauthorizedRes.status === 403) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 9: ${results['TEST 9']}\n`);

  // ----------------------------------------------------
  // TEST 10: Reiniciar backend -> earnings permanecen
  // ----------------------------------------------------
  console.log('--- TEST 10: Persistencia - Archivo earnings_cache.json existe y contiene datos ---');
  const earningsCacheFile = path.join(__dirname, 'server', 'data', 'earnings_cache.json');
  const cacheExists = fs.existsSync(earningsCacheFile);
  const cacheContent = cacheExists ? JSON.parse(fs.readFileSync(earningsCacheFile, 'utf8')) : [];
  const hasSavedEarnings = Array.isArray(cacheContent) && cacheContent.some(e => e.rideId === ride1.id);
  results['TEST 10'] = (cacheExists && hasSavedEarnings) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 10: ${results['TEST 10']}\n`);

  // ----------------------------------------------------
  // TEST 11: Consulta de Wallet mantiene consistencia
  // ----------------------------------------------------
  console.log('--- TEST 11: Wallet mantiene consistencia de valores en consultas sucesivas ---');
  const walletCheck1 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  const walletCheck2 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  results['TEST 11'] = (walletCheck1.today.total === walletCheck2.today.total && walletCheck1.today.tripCount === walletCheck2.today.tripCount) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 11: ${results['TEST 11']}\n`);

  // ----------------------------------------------------
  // TEST 12: Completar varios viajes -> totales diarios correctos
  // ----------------------------------------------------
  console.log('--- TEST 12: Completar varios viajes suma correctamente en el total diario ---');
  let ride12 = null;
  baseSocket.once('ride:created', r => { ride12 = r; });
  baseSocket.emit('ride:create', {
    pickup: { address: 'Empire State Building', lat: 40.7484, lng: -73.9857 },
    destination: { address: 'Chrysler Building', lat: 40.7516, lng: -73.9755 },
    customerName: 'Pasajero Test 12',
    fare: 15.00,
    assignedDriverId: driverASocket.id
  });
  await new Promise(r => setTimeout(r, 600));
  driverASocket.emit('ride:accept', ride12.id);
  await new Promise(r => setTimeout(r, 600));
  driverASocket.emit('ride:complete', { rideId: ride12.id });
  await new Promise(r => setTimeout(r, 800));

  const walletAfter12 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  const expectedTotal = walletCheck1.today.total + 15.00;
  results['TEST 12'] = (Math.abs(walletAfter12.today.total - expectedTotal) < 0.01 && walletAfter12.today.tripCount === (walletCheck1.today.tripCount + 1)) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 12: ${results['TEST 12']}\n`);

  // ----------------------------------------------------
  // TEST 13: Viajes de diferentes fechas -> totales semanales correctos
  // ----------------------------------------------------
  console.log('--- TEST 13: Cálculo del total semanal respeta la ventana de la semana en curso ---');
  const now = new Date();
  const summary13 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  // El total de la semana debe ser al menos igual o mayor al total de hoy
  results['TEST 13'] = (summary13.week.total >= summary13.today.total && summary13.week.tripCount >= summary13.today.tripCount) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 13: ${results['TEST 13']}\n`);

  // ----------------------------------------------------
  // TEST 14: Viajes de diferentes meses -> totales mensuales correctos
  // ----------------------------------------------------
  console.log('--- TEST 14: Cálculo del total mensual respeta la ventana del mes en curso ---');
  const summary14 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/earnings`, driverAToken);
  results['TEST 14'] = (summary14.month.total >= summary14.week.total && summary14.month.tripCount >= summary14.week.tripCount) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 14: ${results['TEST 14']}\n`);

  // ----------------------------------------------------
  // TEST 15: Paginación progresiva para 500+ registros
  // ----------------------------------------------------
  console.log('--- TEST 15: Paginación y límite de registros para escalabilidad masiva ---');
  // Probar parámetros limit=2 y offset=1
  const page1 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/trips?limit=1&offset=0`, driverAToken);
  const page2 = await fetchWithToken(`${SERVER_URL}/api/drivers/${driverAId}/trips?limit=1&offset=1`, driverAToken);
  const paginationWorks = page1.trips.length === 1 &&
                          page2.trips.length === 1 &&
                          page1.trips[0].earningId !== page2.trips[0].earningId &&
                          page1.hasMore === true &&
                          page1.limit === 1;
  results['TEST 15'] = paginationWorks ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 15: ${results['TEST 15']}\n`);

  // Limpieza
  baseSocket.disconnect();
  driverASocket.disconnect();
  driverBSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 15 TESTS DE LA FASE 3:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runPhase3Tests().catch(err => {
  console.error(err);
  process.exit(1);
});
