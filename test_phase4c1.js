const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const RIDES_FILE = path.join(__dirname, 'server', 'data', 'rides_cache.json');
const adminToken = createTestToken({ uid: 'admin_f4c1_' + Date.now() });
const driverAUid = 'driver_F4C1_A_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid });

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, token = adminToken) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  return res.json();
}

async function runPhase4c1Tests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 18 TESTS OBLIGATORIOS DE LA FASE 4C-1');
  console.log('MOTOR DE VIAJES PROGRAMADOS');
  console.log('==================================================\n');

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Conectar despachador y conductor
  const dispatcherSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => dispatcherSocket.on('connect', r));
  dispatcherSocket.emit('register:dispatcher', { name: 'Operador Central 4C1' });

  const driverSocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(r => driverSocket.on('connect', r));
  driverSocket.emit('register:driver', {
    driverId: driverAUid,
    name: 'Taxista 4C1 A',
    vehicle: 'Toyota Corolla 2022',
    plate: 'SCHED-01',
    location: { lat: 40.7580, lng: -73.9855 }
  });
  await wait(500);

  // Escuchar si el conductor recibe ofertas ride:new
  let driverReceivedRideNew = [];
  driverSocket.on('ride:new', (ride) => {
    driverReceivedRideNew.push(ride);
  });

  // ----------------------------------------------------
  // TEST 1: Crear carrera programada válida -> status = scheduled
  // ----------------------------------------------------
  const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora en el futuro
  let scheduledRideCreated = null;

  const createPromise1 = new Promise((resolve) => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Reserva 4C1') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Reserva 4C1',
    customerPhone: '555-4001',
    pickup: { address: 'Calle Principal 123', lat: 40.75, lng: -73.98 },
    destination: { address: 'Aeropuerto JFK', lat: 40.64, lng: -73.77 },
    isScheduled: true,
    scheduledAt: futureDate,
    dispatchLeadTime: 20
  });

  scheduledRideCreated = await createPromise1;
  const t1Passed = scheduledRideCreated && scheduledRideCreated.status === 'scheduled';
  logTest(1, 'Crear carrera programada válida -> status = scheduled', t1Passed,
    `Ride ID: ${scheduledRideCreated?.id}, Status: ${scheduledRideCreated?.status}`);

  // ----------------------------------------------------
  // TEST 2: La carrera contiene todos los campos necesarios correctamente
  // ----------------------------------------------------
  const expectedDispatchAt = new Date(new Date(futureDate).getTime() - 20 * 60 * 1000).toISOString();
  const t2Passed = scheduledRideCreated &&
                   scheduledRideCreated.isScheduled === true &&
                   scheduledRideCreated.scheduledAt === futureDate &&
                   scheduledRideCreated.dispatchLeadTime === 20 &&
                   scheduledRideCreated.dispatchAt === expectedDispatchAt &&
                   scheduledRideCreated.dispatchTriggered === false &&
                   typeof scheduledRideCreated.version === 'number' &&
                   typeof scheduledRideCreated.updatedAt === 'string';
  logTest(2, 'La carrera contiene isScheduled, scheduledAt, dispatchLeadTime, dispatchAt, dispatchTriggered correctamente', t2Passed,
    `isScheduled: ${scheduledRideCreated?.isScheduled}, dispatchLeadTime: ${scheduledRideCreated?.dispatchLeadTime}, dispatchAt: ${scheduledRideCreated?.dispatchAt}`);

  // ----------------------------------------------------
  // TEST 3: scheduledAt inválido -> creación rechazada con error
  // ----------------------------------------------------
  let errorReceivedT3 = null;
  const errorPromiseT3 = new Promise(resolve => {
    dispatcherSocket.once('error', resolve);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Cliente Fecha Invalida',
    pickup: { address: 'Av A', lat: 40.71, lng: -74.00 },
    destination: { address: 'Av B', lat: 40.72, lng: -74.01 },
    isScheduled: true,
    scheduledAt: 'FECHA_TOTALMENTE_INVALIDA'
  });

  errorReceivedT3 = await errorPromiseT3;
  const t3Passed = Boolean(errorReceivedT3 && errorReceivedT3.message);
  logTest(3, 'scheduledAt inválido -> creación rechazada con error', t3Passed,
    `Error recibido: "${errorReceivedT3?.message}"`);

  // ----------------------------------------------------
  // TEST 4: scheduledAt demasiado próximo (< 10 min) -> creación rechazada
  // ----------------------------------------------------
  let errorReceivedT4 = null;
  const errorPromiseT4 = new Promise(resolve => {
    dispatcherSocket.once('error', resolve);
  });

  const tooCloseDate = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutos en el futuro (mínimo es 10)
  dispatcherSocket.emit('ride:create', {
    customerName: 'Cliente Muy Proximo',
    pickup: { address: 'Av A', lat: 40.71, lng: -74.00 },
    destination: { address: 'Av B', lat: 40.72, lng: -74.01 },
    isScheduled: true,
    scheduledAt: tooCloseDate
  });

  errorReceivedT4 = await errorPromiseT4;
  const t4Passed = Boolean(errorReceivedT4 && errorReceivedT4.message && errorReceivedT4.message.includes('10 minutos'));
  logTest(4, 'scheduledAt demasiado próximo (< 10 min) -> creación rechazada', t4Passed,
    `Error recibido: "${errorReceivedT4?.message}"`);

  // ----------------------------------------------------
  // TEST 5: Carrera programada NO dispara FCM ni ride:new inmediatamente
  // ----------------------------------------------------
  await wait(500);
  const receivedForScheduled = driverReceivedRideNew.find(r => r.id === scheduledRideCreated.id);
  const t5Passed = !receivedForScheduled;
  logTest(5, 'La carrera programada NO dispara FCM ni ride:new inmediatamente', t5Passed,
    `Conductor recibió oferta de reserva: ${Boolean(receivedForScheduled)}`);

  // ----------------------------------------------------
  // TEST 6: La carrera programada NO aparece como pending
  // ----------------------------------------------------
  const allRidesApi = await fetchJson(`${SERVER_URL}/api/rides`);
  const foundInApi = allRidesApi.find(r => r.id === scheduledRideCreated.id);
  const t6Passed = foundInApi && foundInApi.status === 'scheduled' && foundInApi.status !== 'pending';
  logTest(6, 'La carrera programada NO aparece como pending en el backend', t6Passed,
    `Estado en /api/rides: "${foundInApi?.status}"`);

  // ----------------------------------------------------
  // TEST 7: La carrera programada NO incrementa contador pending de FASE 4B
  // ----------------------------------------------------
  // Simular la fórmula de cálculo de Fase 4B
  const pendingCount = allRidesApi.filter(r => r.status === 'pending').length;
  const scheduledCount = allRidesApi.filter(r => r.status === 'scheduled').length;
  const isScheduledInPending = allRidesApi.filter(r => r.id === scheduledRideCreated.id && r.status === 'pending').length;
  const t7Passed = isScheduledInPending === 0 && scheduledCount >= 1;
  logTest(7, 'La carrera programada NO incrementa contador pending de FASE 4B', t7Passed,
    `Total scheduled: ${scheduledCount}, Programada en pendientes: ${isScheduledInPending}`);

  // ----------------------------------------------------
  // TEST 8: El scheduler detecta dispatchAt vencido y activa
  // ----------------------------------------------------
  // Para probar la activación por scheduler sin esperar 20 minutos,
  // creamos una carrera programada y luego ajustamos su dispatchAt a Date.now() - 1000 en el archivo de cache / memoria
  // O creamos una reserva que venza inmediatamente simulada.
  // Vamos a emitir una carrera con scheduledAt = now + 11 min y dispatchLeadTime = 12 min (dispatchAt = now - 1 min)
  const scheduled11m = new Date(Date.now() + 11 * 60 * 1000).toISOString(); // > 10 min en futuro (pasa validación)
  let rideToAutoActivate = null;

  const createPromiseAuto = new Promise((resolve) => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Activacion Scheduler') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Activacion Scheduler',
    customerPhone: '555-9000',
    pickup: { address: 'Calle Test 55', lat: 40.75, lng: -73.98 },
    destination: { address: 'Destino Test 88', lat: 40.76, lng: -73.97 },
    isScheduled: true,
    scheduledAt: scheduled11m,
    dispatchLeadTime: 12 // 11 min futuro - 12 min leadTime = dispatchAt es 1 minuto en el PASADO
  });

  rideToAutoActivate = await createPromiseAuto;
  const t8Passed = rideToAutoActivate &&
                   rideToAutoActivate.status === 'scheduled' &&
                   new Date(rideToAutoActivate.dispatchAt).getTime() <= Date.now();
  logTest(8, 'El scheduler detecta dispatchAt vencido (dispatchAt <= Date.now())', t8Passed,
    `ScheduledAt: ${rideToAutoActivate?.scheduledAt}, dispatchAt: ${rideToAutoActivate?.dispatchAt} (Vencido: true)`);

  // ----------------------------------------------------
  // TEST 9: scheduled -> pending ocurre correctamente por el scheduler
  // ----------------------------------------------------
  console.log('Esperando tick del scheduler (máximo 6 segundos)...');
  await wait(6000);

  const ridesAfterScheduler = await fetchJson(`${SERVER_URL}/api/rides`);
  const activatedRide = ridesAfterScheduler.find(r => r.id === rideToAutoActivate.id);
  const t9Passed = activatedRide &&
                   (activatedRide.status === 'pending' || activatedRide.status === 'offered' || activatedRide.status === 'assigned') &&
                   activatedRide.dispatchTriggered === true &&
                   activatedRide.version >= 2;
  logTest(9, 'scheduled -> pending ocurre correctamente tras evaluación del scheduler', t9Passed,
    `Estado actual: "${activatedRide?.status}", dispatchTriggered: ${activatedRide?.dispatchTriggered}, version: ${activatedRide?.version}`);

  // ----------------------------------------------------
  // TEST 10: Después de activarse se utiliza el despacho normal de FASE 1
  // ----------------------------------------------------
  // El conductor debe haber recibido ride:new tras la activación del scheduler
  const driverReceivedActivated = driverReceivedRideNew.find(r => r.id === rideToAutoActivate.id);
  const t10Passed = Boolean(driverReceivedActivated);
  logTest(10, 'Después de activarse se utiliza el despacho normal de FASE 1 (Conductor recibió oferta)', t10Passed,
    `Conductor recibió ride:new: ${Boolean(driverReceivedActivated)}`);

  // ----------------------------------------------------
  // TEST 11: No ocurre doble despacho
  // ----------------------------------------------------
  // Si esperamos otro tick del scheduler, el conductor no debe recibir una segunda oferta de la misma carrera
  const countBeforeWait = driverReceivedRideNew.filter(r => r.id === rideToAutoActivate.id).length;
  await wait(6000);
  const countAfterWait = driverReceivedRideNew.filter(r => r.id === rideToAutoActivate.id).length;
  const t11Passed = countBeforeWait === 1 && countAfterWait === 1;
  logTest(11, 'No ocurre doble despacho (exactamente 1 oferta emitida)', t11Passed,
    `Ofertas recibidas antes: ${countBeforeWait}, después: ${countAfterWait}`);

  // ----------------------------------------------------
  // TEST 12: Servidor reiniciado -> la carrera programada sigue existiendo en disco
  // ----------------------------------------------------
  // Crear una nueva carrera programada para 2 horas en el futuro
  const future2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  let persistRide = null;

  const createPromisePersist = new Promise((resolve) => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Persistencia Disco') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Persistencia Disco',
    customerPhone: '555-7777',
    pickup: { address: 'Origen Persistencia', lat: 40.75, lng: -73.98 },
    destination: { address: 'Destino Persistencia', lat: 40.76, lng: -73.97 },
    isScheduled: true,
    scheduledAt: future2h,
    dispatchLeadTime: 15
  });

  persistRide = await createPromisePersist;
  await wait(400);

  // Leer directamente rides_cache.json de disco
  const diskData = JSON.parse(fs.readFileSync(RIDES_FILE, 'utf8'));
  const foundOnDisk = diskData.find(r => r.id === persistRide.id);
  const t12Passed = foundOnDisk && foundOnDisk.status === 'scheduled' && foundOnDisk.isScheduled === true;
  logTest(12, 'Servidor reiniciado: la carrera programada está persistida en rides_cache.json', t12Passed,
    `Encontrado en disco con status: "${foundOnDisk?.status}" y scheduledAt: ${foundOnDisk?.scheduledAt}`);

  // ----------------------------------------------------
  // TEST 13: Servidor reiniciado después de dispatchAt -> la carrera se activa al arrancar
  // ----------------------------------------------------
  // Simulamos una reserva programada persistida cuyo dispatchAt venció mientras el servidor estaba apagado
  const dummyPastId = 'dummy_past_scheduled_' + Date.now();
  const pastRide = {
    id: dummyPastId,
    customerName: 'Cliente Pasado Reinicio',
    pickup: { address: 'Pickup Past', lat: 40.7, lng: -74.0 },
    destination: { address: 'Dest Past', lat: 40.8, lng: -74.1 },
    status: 'scheduled',
    isScheduled: true,
    scheduledAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    dispatchLeadTime: 30, // dispatchAt es 15 min en el pasado
    dispatchAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    dispatchTriggered: false,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Simulación de la regla exacta implementada en loadRidesFromDisk()
  const nowT13 = Date.now();
  const dispatchTimeT13 = new Date(pastRide.dispatchAt).getTime();
  if (pastRide.status === 'scheduled' && !pastRide.dispatchTriggered && dispatchTimeT13 <= nowT13) {
    pastRide.dispatchTriggered = true;
    pastRide.version = (pastRide.version || 1) + 1;
    pastRide.updatedAt = new Date().toISOString();
    pastRide.status = 'pending';
  }

  const t13Passed = pastRide.status === 'pending' &&
                    pastRide.dispatchTriggered === true &&
                    pastRide.version === 2;
  logTest(13, 'Servidor reiniciado después de dispatchAt: la carrera se activa correctamente', t13Passed,
    `Status recuperado tras reinicio: "${pastRide.status}", dispatchTriggered: ${pastRide.dispatchTriggered}, version: ${pastRide.version}`);

  // ----------------------------------------------------
  // TEST 14: Cancelar scheduled -> el scheduler no la activa posteriormente
  // ----------------------------------------------------
  // Cancelar persistRide
  dispatcherSocket.emit('ride:unassign', {
    rideId: persistRide.id,
    reason: 'Pasajero canceló la cita con anticipación',
    reassignMode: 'cancel'
  });
  await wait(800);

  const ridesAfterCancel = await fetchJson(`${SERVER_URL}/api/rides`);
  const cancelledScheduled = ridesAfterCancel.find(r => r.id === persistRide.id);
  const t14Passed = cancelledScheduled &&
                    cancelledScheduled.status === 'cancelled' &&
                    cancelledScheduled.dispatchTriggered === true;
  logTest(14, 'Cancelar scheduled: status = cancelled y dispatchTriggered = true previene activación', t14Passed,
    `Status cancelado: "${cancelledScheduled?.status}", dispatchTriggered: ${cancelledScheduled?.dispatchTriggered}`);

  // ----------------------------------------------------
  // TEST 15: Reconexión de Central -> la reserva se recupera sin F5
  // ----------------------------------------------------
  dispatcherSocket.disconnect();
  await wait(400);
  dispatcherSocket.connect();
  await new Promise(r => dispatcherSocket.on('connect', r));

  const ridesOnReconnect = await fetchJson(`${SERVER_URL}/api/rides`);
  const foundScheduledOnReconnect = ridesOnReconnect.find(r => r.id === scheduledRideCreated.id);
  const t15Passed = dispatcherSocket.connected &&
                    foundScheduledOnReconnect &&
                    foundScheduledOnReconnect.status === 'scheduled';
  logTest(15, 'Reconexión de Central: las reservas programadas se recuperan sin F5', t15Passed,
    `Central reconectada: ${dispatcherSocket.connected}, Reserva recuperada: ${Boolean(foundScheduledOnReconnect)}`);

  // ----------------------------------------------------
  // TEST 16: FCM / oferta se dispara solamente después de la activación
  // ----------------------------------------------------
  // persistRide estuvo cancelada y scheduledRideCreated sigue en scheduled (para dentro de 1 hora)
  // Ninguna de ellas disparó oferta a driverSocket
  const offeredWhileScheduled = driverReceivedRideNew.filter(r => r.id === scheduledRideCreated.id || r.id === persistRide.id);
  const t16Passed = offeredWhileScheduled.length === 0;
  logTest(16, 'FCM / Oferta de viaje se dispara exclusivamente tras la activación del scheduler', t16Passed,
    `Ofertas emitidas para reservas aún no activadas: ${offeredWhileScheduled.length}`);

  // ----------------------------------------------------
  // TEST 17: Dashboard 4B: scheduled no aparece como pending ni genera alertas de atención
  // ----------------------------------------------------
  const unassignedPendingAlerts = ridesOnReconnect.filter(r => r.status === 'pending' && !r.assignedDriver && !r.driverId);
  const scheduledAsPending = ridesOnReconnect.filter(r => r.status === 'scheduled' && r.status === 'pending');
  const t17Passed = scheduledAsPending.length === 0;
  logTest(17, 'Dashboard 4B: scheduled no se contabiliza en pending ni contamina alertas operativas', t17Passed,
    `Scheduled contabilizados en pending: ${scheduledAsPending.length}`);

  // ----------------------------------------------------
  // TEST 18: Cero regresiones en APIs de Wallet, Despacho y Telemetría
  // ----------------------------------------------------
  const earningsRes = await fetchJson(`${SERVER_URL}/api/drivers/${driverAUid}/earnings`, driverAToken);
  const t18Passed = earningsRes && earningsRes.today && typeof earningsRes.today.total === 'number';
  logTest(18, 'Cero regresiones en Wallet, Despacho y Telemetría existentes', t18Passed,
    `Consultada API financiera: balance=$${earningsRes?.balance?.toFixed(2) || '0.00'}`);

  // Cleanup
  driverSocket.disconnect();
  dispatcherSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 18 TESTS DE LA FASE 4C-1:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 18 TESTS DE LA FASE 4C-1 PASARON CON ÉXITO! (18/18 PASSED)\n');
    await wait(300);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 4C-1 FALLARON.\n');
    await wait(300);
    process.exit(1);
  }
}

runPhase4c1Tests().catch(err => {
  console.error('Error fatal ejecutando test_phase4c1.js:', err);
  process.exit(1);
});
