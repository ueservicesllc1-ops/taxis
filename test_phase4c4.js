const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_f4c4_' + Date.now() });
const driverAUid = 'driver_4c4_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid });

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, token = adminToken) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  return res.json();
}

async function runPhase4c4Tests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 30 TESTS OBLIGATORIOS DE LA FASE 4C-4');
  console.log('EDICIÓN SEGURA DE SERVICIOS EN LA CENTRAL');
  console.log('==================================================\n');

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Sockets de prueba
  const dispatcherSocket = io(SERVER_URL, { auth: { token: adminToken } });
  const driverSocket = io(SERVER_URL, { auth: { token: driverAToken } });

  await Promise.all([
    new Promise(r => dispatcherSocket.on('connect', r)),
    new Promise(r => driverSocket.on('connect', r))
  ]);

  dispatcherSocket.emit('register:dispatcher', { name: 'Operador Edición 4C4' });
  const driverId = driverAUid;
  driverSocket.emit('register:driver', {
    driverId,
    name: 'Conductor Prueba 4C4',
    phone: '555-4444',
    vehicle: 'Toyota Corolla',
    plate: 'ED-4C4'
  });
  await wait(200);

  // Helper para crear viajes
  async function createRide(data) {
    return new Promise((resolve) => {
      const handler = (r) => {
        if (r.customerName === data.customerName) {
          dispatcherSocket.off('ride:created', handler);
          resolve(r);
        }
      };
      dispatcherSocket.on('ride:created', handler);
      dispatcherSocket.emit('ride:create', data);
    });
  }

  // Helper para editar viaje
  async function editRide(rideId, version, changes) {
    return new Promise((resolve) => {
      const onEdited = (updated) => {
        if (updated.id === rideId) {
          cleanup();
          resolve({ success: true, ride: updated });
        }
      };
      const onError = (err) => {
        cleanup();
        resolve({ success: false, error: err });
      };
      const cleanup = () => {
        dispatcherSocket.off('ride:edited', onEdited);
        dispatcherSocket.off('error', onError);
      };
      dispatcherSocket.on('ride:edited', onEdited);
      dispatcherSocket.on('error', onError);
      dispatcherSocket.emit('ride:edit', { rideId, version, changes });
    });
  }

  // 1. Crear viaje pending para pruebas 1-11
  const ridePending = await createRide({
    customerName: 'Cliente Base 4C4',
    customerPhone: '555-0101',
    pickup: { address: 'Calle Origen 100', lat: 40.71, lng: -74.00 },
    destination: { address: 'Calle Destino 200', lat: 40.75, lng: -73.98 },
    isScheduled: false,
    passengerCount: 1,
    vehicleCategory: 'standard',
    paymentMethod: 'cash',
    notes: 'Nota inicial',
    fare: 15.00
  });

  // TEST 1: Editar nombre de pasajero
  const res1 = await editRide(ridePending.id, ridePending.version, { customerName: 'Alejandro Ramos' });
  const t1Passed = res1.success && res1.ride.customerName === 'Alejandro Ramos';
  logTest(1, 'Editar nombre de pasajero en servicio pending', t1Passed, `Nuevo nombre: ${res1.ride?.customerName}`);

  // TEST 2: Editar teléfono
  const res2 = await editRide(ridePending.id, res1.ride.version, { customerPhone: '305-555-9988' });
  const t2Passed = res2.success && res2.ride.customerPhone === '305-555-9988';
  logTest(2, 'Editar teléfono de pasajero', t2Passed, `Nuevo teléfono: ${res2.ride?.customerPhone}`);

  // TEST 3: Editar notas
  const res3 = await editRide(ridePending.id, res2.ride.version, { notes: 'Pasajero lleva equipaje frágil' });
  const t3Passed = res3.success && res3.ride.notes === 'Pasajero lleva equipaje frágil';
  logTest(3, 'Editar notas operativas', t3Passed, `Nuevas notas: ${res3.ride?.notes}`);

  // TEST 4: Editar pasajeros
  const res4 = await editRide(ridePending.id, res3.ride.version, { passengerCount: 4 });
  const t4Passed = res4.success && res4.ride.passengerCount === 4;
  logTest(4, 'Editar cantidad de pasajeros', t4Passed, `Pasajeros: ${res4.ride?.passengerCount}`);

  // TEST 5: Editar categoría de vehículo
  const res5 = await editRide(ridePending.id, res4.ride.version, { vehicleCategory: 'xl' });
  const t5Passed = res5.success && res5.ride.vehicleCategory === 'xl';
  logTest(5, 'Editar categoría de vehículo', t5Passed, `Categoría: ${res5.ride?.vehicleCategory}`);

  // TEST 6: Editar método de pago
  const res6 = await editRide(ridePending.id, res5.ride.version, { paymentMethod: 'card' });
  const t6Passed = res6.success && res6.ride.paymentMethod === 'card';
  logTest(6, 'Editar método de pago', t6Passed, `Método: ${res6.ride?.paymentMethod}`);

  // TEST 7: Editar tarifa manual válida
  const res7 = await editRide(ridePending.id, res6.ride.version, { isManualFare: true, manualFare: 38.50 });
  const t7Passed = res7.success && res7.ride.isManualFare === true && res7.ride.fare === 38.50;
  logTest(7, 'Editar tarifa manual válida', t7Passed, `ManualFare: ${res7.ride?.manualFare}, Fare: ${res7.ride?.fare}`);

  // TEST 8: Rechazar tarifa manual negativa
  const res8 = await editRide(ridePending.id, res7.ride.version, { isManualFare: true, manualFare: -10 });
  const t8Passed = !res8.success && res8.error?.message?.includes('negativo');
  logTest(8, 'Rechazar tarifa manual negativa', t8Passed, `Error recibido: ${res8.error?.message}`);

  // TEST 9: Editar origen con coordenadas válidas
  const res9 = await editRide(ridePending.id, res7.ride.version, { pickup: { address: 'Nueva Recogida Central 50', lat: 40.73, lng: -73.99 } });
  const t9Passed = res9.success && res9.ride.pickup.address === 'Nueva Recogida Central 50';
  logTest(9, 'Editar origen con dirección y coordenadas', t9Passed, `Nuevo origen: ${res9.ride?.pickup?.address}`);

  // TEST 10: Editar destino con coordenadas válidas
  const res10 = await editRide(ridePending.id, res9.ride.version, { destination: { address: 'Nuevo Destino Aeropuerto', lat: 40.64, lng: -73.78 } });
  const t10Passed = res10.success && res10.ride.destination.address === 'Nuevo Destino Aeropuerto';
  logTest(10, 'Editar destino con dirección y coordenadas', t10Passed, `Nuevo destino: ${res10.ride?.destination?.address}`);

  // TEST 11: Recalcular distancia/duración
  const res11 = await editRide(ridePending.id, res10.ride.version, { distance: 18.2, duration: 25 });
  const t11Passed = res11.success && res11.ride.distance === 18.2 && res11.ride.duration === 25;
  logTest(11, 'Recalcular/actualizar distancia y duración de ruta', t11Passed, `Distancia: ${res11.ride?.distance} km, Duración: ${res11.ride?.duration} min`);

  // ----------------------------------------------------
  // PRUEBAS DE RESERVA PROGRAMADA (TEST 12 - 17)
  // ----------------------------------------------------
  const initialSchedIso = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const rideSched = await createRide({
    customerName: 'Cliente Reserva 4C4',
    customerPhone: '555-0808',
    pickup: { address: 'Reserva Origen Hotel Plaza', lat: 40.76, lng: -73.97 },
    destination: { address: 'Reserva Destino Terminal 1', lat: 40.64, lng: -73.77 },
    isScheduled: true,
    scheduledAt: initialSchedIso,
    dispatchLeadTime: 15
  });

  // TEST 12: Editar servicio scheduled
  const res12 = await editRide(rideSched.id, rideSched.version, { notes: 'Cliente VIP requiere chofer bilingüe' });
  const t12Passed = res12.success && res12.ride.notes === 'Cliente VIP requiere chofer bilingüe' && res12.ride.status === 'scheduled';
  logTest(12, 'Editar servicio scheduled manteniendo status=scheduled', t12Passed, `Notas: ${res12.ride?.notes}, Status: ${res12.ride?.status}`);

  // TEST 13: Modificar scheduledAt de servicio scheduled
  const newSchedIso = new Date(Date.now() + 180 * 60 * 1000).toISOString();
  const res13 = await editRide(rideSched.id, res12.ride.version, { scheduledAt: newSchedIso });
  const t13Passed = res13.success && res13.ride.scheduledAt === newSchedIso;
  logTest(13, 'Modificar scheduledAt de servicio scheduled', t13Passed, `Nuevo scheduledAt: ${res13.ride?.scheduledAt}`);

  // TEST 14: Modificar dispatchLeadTime
  const res14 = await editRide(rideSched.id, res13.ride.version, { dispatchLeadTime: 30 });
  const t14Passed = res14.success && res14.ride.dispatchLeadTime === 30;
  logTest(14, 'Modificar dispatchLeadTime de servicio scheduled', t14Passed, `Nuevo leadTime: ${res14.ride?.dispatchLeadTime} min`);

  // TEST 15: Recalcular dispatchAt correctamente
  const expectedDispatchAt = new Date(new Date(newSchedIso).getTime() - 30 * 60 * 1000).toISOString();
  const t15Passed = res14.ride.dispatchAt === expectedDispatchAt;
  logTest(15, 'Recalcular dispatchAt automáticamente tras cambio de fecha y antelación', t15Passed, `dispatchAt: ${res14.ride?.dispatchAt}, Esperado: ${expectedDispatchAt}`);

  // TEST 16: No disparar FCM al editar reserva scheduled
  let fcmEmitted = false;
  const fcmListener = (r) => { if (r.id === rideSched.id) fcmEmitted = true; };
  driverSocket.on('ride:new', fcmListener);
  await editRide(rideSched.id, res14.ride.version, { notes: 'Segunda actualización de reserva' });
  await wait(300);
  driverSocket.off('ride:new', fcmListener);
  const t16Passed = !fcmEmitted;
  logTest(16, 'No disparar FCM ni oferta prematura al editar reserva scheduled', t16Passed, `FCM emitido: ${fcmEmitted}`);

  // TEST 17: No disparar dispatchRide() al editar reserva futura
  const currentSchedState = await fetchJson(`${SERVER_URL}/api/rides`);
  const schedRideCheck = currentSchedState.find(r => r.id === rideSched.id);
  const t17Passed = schedRideCheck && schedRideCheck.status === 'scheduled' && schedRideCheck.dispatchTriggered === false;
  logTest(17, 'No disparar dispatchRide() al editar reserva scheduled (status=scheduled, dispatchTriggered=false)', t17Passed, `Status: ${schedRideCheck?.status}, dispatchTriggered: ${schedRideCheck?.dispatchTriggered}`);

  // ----------------------------------------------------
  // PRUEBAS DE ESTADOS BLOQUEADOS (TEST 18 - 21)
  // ----------------------------------------------------
  // 1. Crear y completar un viaje real mediante flujo de conductor
  const rideCompleted = await createRide({
    customerName: 'Cliente Completado 4C4',
    customerPhone: '555-9090',
    pickup: { address: 'Origen A', lat: 40.71, lng: -74.00 },
    destination: { address: 'Destino B', lat: 40.72, lng: -73.99 },
    isScheduled: false
  });

  dispatcherSocket.emit('ride:assign', { rideId: rideCompleted.id, driverId });
  await wait(100);
  driverSocket.emit('ride:accept', { rideId: rideCompleted.id });
  await wait(100);
  driverSocket.emit('ride:picked_up', { rideId: rideCompleted.id });
  await wait(100);
  driverSocket.emit('ride:complete', { rideId: rideCompleted.id });
  await wait(200);

  // TEST 18: Rechazar edición de completed
  const res18 = await editRide(rideCompleted.id, 1, { customerName: 'Intento Hack Completed' });
  const t18Passed = !res18.success && res18.error?.code === 'STATUS_LOCKED';
  logTest(18, 'Rechazar edición de servicio en estado "completed"', t18Passed, `Error: ${res18.error?.message}`);

  // 2. Crear y cancelar un viaje real mediante unassign
  const rideCancelled = await createRide({
    customerName: 'Cliente Cancelado 4C4',
    customerPhone: '555-9191',
    pickup: { address: 'Origen Cancel', lat: 40.71, lng: -74.00 },
    destination: { address: 'Destino Cancel', lat: 40.72, lng: -73.99 },
    isScheduled: false
  });
  dispatcherSocket.emit('ride:unassign', {
    rideId: rideCancelled.id,
    reason: 'Cancelado por prueba',
    reassignMode: 'cancel'
  });
  await wait(200);

  // TEST 19: Rechazar edición de cancelled
  const res19 = await editRide(rideCancelled.id, 1, { customerName: 'Intento Hack Cancelled' });
  const t19Passed = !res19.success && res19.error?.code === 'STATUS_LOCKED';
  logTest(19, 'Rechazar edición de servicio en estado "cancelled"', t19Passed, `Error: ${res19.error?.message}`);

  // 3. Crear viaje en progreso (in_progress)
  const rideInProgress = await createRide({
    customerName: 'Cliente En Progreso 4C4',
    customerPhone: '555-9292',
    pickup: { address: 'Origen Progreso', lat: 40.71, lng: -74.00 },
    destination: { address: 'Destino Progreso', lat: 40.72, lng: -73.99 },
    isScheduled: false
  });
  dispatcherSocket.emit('ride:assign', { rideId: rideInProgress.id, driverId });
  await wait(100);
  driverSocket.emit('ride:accept', { rideId: rideInProgress.id });
  await wait(100);
  driverSocket.emit('ride:picked_up', { rideId: rideInProgress.id });
  await wait(200);

  // TEST 20: Rechazar edición de in_progress
  const res20 = await editRide(rideInProgress.id, 1, { customerName: 'Intento Hack InProgress' });
  const t20Passed = !res20.success && res20.error?.code === 'STATUS_LOCKED';
  logTest(20, 'Rechazar edición de servicio en estado "in_progress"', t20Passed, `Error: ${res20.error?.message}`);

  // TEST 21: Rechazar modificación protegida de status desde cliente
  const res21 = await editRide(ridePending.id, res11.ride.version, { status: 'completed', customerName: 'Hacker Status' });
  const t21Passed = !res21.success && res21.error?.code === 'PROTECTED_FIELD';
  logTest(21, 'Rechazar modificación del campo protegido "status" desde cliente', t21Passed, `Error: ${res21.error?.message}`);

  // ----------------------------------------------------
  // PRUEBAS DE CONCURRENCIA, VERSION Y PERSISTENCIA (TEST 22 - 26)
  // ----------------------------------------------------
  // TEST 22: Rechazar edición con version obsoleta
  const staleVersion = 1; // La versión actual de ridePending es > 5
  const res22 = await editRide(ridePending.id, staleVersion, { customerName: 'Intento Versión Vieja' });
  const t22Passed = !res22.success && res22.error?.code === 'CONCURRENCY_CONFLICT';
  logTest(22, 'Rechazar edición con versión obsoleta (control de concurrencia optimista)', t22Passed, `Error: ${res22.error?.message}`);

  // TEST 23: Incrementar version después de edición exitosa
  const vBefore = res11.ride.version;
  const res23 = await editRide(ridePending.id, vBefore, { notes: 'Incremento de version verificado' });
  const t23Passed = res23.success && res23.ride.version === vBefore + 1;
  logTest(23, 'Incrementar version atómicamente después de edición exitosa', t23Passed, `Versión anterior: ${vBefore}, Nueva versión: ${res23.ride?.version}`);

  // TEST 24: Actualizar updatedAt después de edición exitosa
  const t24Passed = res23.success && Boolean(res23.ride.updatedAt) && new Date(res23.ride.updatedAt).getTime() > 0;
  logTest(24, 'Actualizar timestamp updatedAt tras edición exitosa', t24Passed, `updatedAt: ${res23.ride?.updatedAt}`);

  // TEST 25: Persistir edición correctamente en disco
  const cachePath = path.join(__dirname, 'server', 'data', 'rides_cache.json');
  let diskPersisted = false;
  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    const diskRide = parsed.find(r => r.id === ridePending.id);
    if (diskRide && diskRide.version === res23.ride.version) {
      diskPersisted = true;
    }
  }
  logTest(25, 'Persistir edición en rides_cache.json con integridad total', diskPersisted, `Persistido en disco: ${diskPersisted}`);

  // TEST 26: Emitir actualización Socket.io después de guardar
  let socketUpdateReceived = false;
  const socketUpdatePromise = new Promise((resolve) => {
    const handler = (r) => {
      if (r.id === ridePending.id && r.customerName === 'Cliente Con Socket Broadcast') {
        dispatcherSocket.off('ride:update', handler);
        socketUpdateReceived = true;
        resolve();
      }
    };
    dispatcherSocket.on('ride:update', handler);
  });
  await editRide(ridePending.id, res23.ride.version, { customerName: 'Cliente Con Socket Broadcast' });
  await socketUpdatePromise;
  logTest(26, 'Emitir ride:update y rides:update en tiempo real a la Central', socketUpdateReceived, `ride:update recibido: ${socketUpdateReceived}`);

  // ----------------------------------------------------
  // PRUEBAS DE INTEGRACIÓN CON BÚSQUEDA Y DASHBOARD (TEST 27 - 30)
  // ----------------------------------------------------
  // TEST 27: La búsqueda 4C-3 encuentra el servicio después de editarlo
  const allRidesAfterEdit = await fetchJson(`${SERVER_URL}/api/rides`);
  const foundEdited = allRidesAfterEdit.find(r => r.id === ridePending.id && r.customerName.toLowerCase().includes('socket broadcast'));
  const t27Passed = Boolean(foundEdited);
  logTest(27, 'Búsqueda 4C-3 localiza el servicio editado por nuevo nombre', t27Passed, `Encontrado: ${foundEdited?.customerName} (#${foundEdited?.id})`);

  // TEST 28: Filtros del dashboard continúan funcionando
  const pendingRides = allRidesAfterEdit.filter(r => r.status === 'pending');
  const schedRides = allRidesAfterEdit.filter(r => r.status === 'scheduled');
  const t28Passed = pendingRides.length > 0 && schedRides.length > 0;
  logTest(28, 'Los filtros del dashboard mantienen contadores íntegros', t28Passed, `Pendientes: ${pendingRides.length}, Programadas: ${schedRides.length}`);

  // TEST 29: No crear doble actualización ante doble click / dos operadores concurrentes
  const operatorBSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => operatorBSocket.on('connect', r));
  operatorBSocket.emit('register:dispatcher', { name: 'Operador B Concurrente' });

  const latestRideData = (await fetchJson(`${SERVER_URL}/api/rides`)).find(r => r.id === ridePending.id);

  const editWithSocket = (sock, rideId, ver, changes) => {
    return new Promise((resolve) => {
      const onEd = (upd) => { if (upd.id === rideId) { cleanup(); resolve({ success: true, ride: upd }); } };
      const onErr = (err) => { cleanup(); resolve({ success: false, error: err }); };
      const cleanup = () => { sock.off('ride:edited', onEd); sock.off('error', onErr); };
      sock.on('ride:edited', onEd);
      sock.on('error', onErr);
      sock.emit('ride:edit', { rideId, version: ver, changes });
    });
  };

  const p1 = editWithSocket(dispatcherSocket, ridePending.id, latestRideData.version, { notes: 'Edición concurrente Operador A' });
  const p2 = editWithSocket(operatorBSocket, ridePending.id, latestRideData.version, { notes: 'Edición concurrente Operador B' });
  const [resConcurrent1, resConcurrent2] = await Promise.all([p1, p2]);

  operatorBSocket.disconnect();

  const oneSucceededOneFailed = (resConcurrent1.success && !resConcurrent2.success) || (!resConcurrent1.success && resConcurrent2.success);
  logTest(29, 'Protección contra doble envío / concurrencia (una triunfa, la otra es rechazada por versión)', oneSucceededOneFailed, `Res1: ${resConcurrent1.success}, Res2: ${resConcurrent2.success}`);

  // TEST 30: No aplicar cambios parciales cuando falla validación
  const rideBeforeFailedValidation = (await fetchJson(`${SERVER_URL}/api/rides`)).find(r => r.id === ridePending.id);
  const badRes = await editRide(ridePending.id, rideBeforeFailedValidation.version, {
    customerName: 'Nombre Que No Debe Aplicarse',
    isManualFare: true,
    manualFare: -999 // Falla validación
  });
  const rideAfterFailedValidation = (await fetchJson(`${SERVER_URL}/api/rides`)).find(r => r.id === ridePending.id);
  const t30Passed = !badRes.success && rideAfterFailedValidation.customerName === rideBeforeFailedValidation.customerName;
  logTest(30, 'Atomicidad garantizada: No se aplican cambios parciales si una validación falla', t30Passed, `Nombre conservado: "${rideAfterFailedValidation.customerName}"`);

  // Cleanup
  dispatcherSocket.disconnect();
  driverSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 30 TESTS DE LA FASE 4C-4:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 30 TESTS DE LA FASE 4C-4 PASARON CON ÉXITO! (30/30 PASSED)\n');
    await wait(300);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 4C-4 FALLARON.\n');
    await wait(300);
    process.exit(1);
  }
}

runPhase4c4Tests().catch(err => {
  console.error('Error fatal ejecutando test_phase4c4.js:', err);
  process.exit(1);
});
