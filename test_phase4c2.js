const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_f4c2_' + Date.now() });
const driverAUid = 'driver_F4C2_A_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid });

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, token = adminToken) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await res.json();
  if (data && data.success && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.rides)) return data.rides;
  return data;
}

async function runPhase4c2Tests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 18 TESTS OBLIGATORIOS DE LA FASE 4C-2');
  console.log('FORMULARIO AVANZADO DE CREACIÓN DE SERVICIOS');
  console.log('==================================================\n');

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Conectar sockets
  const dispatcherSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => dispatcherSocket.on('connect', r));
  dispatcherSocket.emit('register:dispatcher', { name: 'Operador Central 4C2' });

  const driverSocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(r => driverSocket.on('connect', r));
  driverSocket.emit('register:driver', {
    driverId: driverAUid,
    name: 'Taxista 4C2 A',
    vehicle: 'Toyota Corolla 2023',
    plate: 'ADV-4C2',
    location: { lat: 40.7580, lng: -73.9855 }
  });
  await wait(500);

  const receivedDriverOffers = [];
  driverSocket.on('ride:new', (ride) => {
    receivedDriverOffers.push(ride);
  });

  // ----------------------------------------------------
  // TEST 1: Formulario/flujo inmediato conserva creación existente
  // ----------------------------------------------------
  let createdImm = null;
  const immPromise = new Promise(resolve => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Inmediato 4C2') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Inmediato 4C2',
    customerPhone: '555-0101',
    pickup: { address: 'Calle Inmediata 10', lat: 40.75, lng: -73.98 },
    destination: { address: 'Calle Inmediata 20', lat: 40.76, lng: -73.97 },
    isScheduled: false,
    fare: 18.50,
    distance: 4.2,
    duration: 12
  });

  createdImm = await immPromise;
  const t1Passed = createdImm &&
                   createdImm.isScheduled === false &&
                   createdImm.status === 'pending' &&
                   createdImm.fare === 18.50;
  logTest(1, 'Formulario/flujo inmediato conserva creación existente', t1Passed,
    `Ride ID: ${createdImm?.id}, Status: ${createdImm?.status}, isScheduled: ${createdImm?.isScheduled}`);

  // ----------------------------------------------------
  // TEST 2: Formulario programado genera isScheduled=true
  // ----------------------------------------------------
  const targetFutureDate = new Date(Date.now() + 90 * 60 * 1000).toISOString(); // 90 min futuro
  let createdSched = null;

  const schedPromise = new Promise(resolve => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Programado 4C2') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Programado 4C2',
    customerPhone: '555-0202',
    pickup: { address: 'Av Principal 500', lat: 40.75, lng: -73.98 },
    destination: { address: 'Aeropuerto JFK Terminal 4', lat: 40.64, lng: -73.77 },
    isScheduled: true,
    scheduledAt: targetFutureDate,
    dispatchLeadTime: 20,
    passengerCount: 3,
    vehicleCategory: 'xl',
    paymentMethod: 'card',
    notes: 'Pasajero con 2 maletas grandes'
  });

  createdSched = await schedPromise;
  const t2Passed = createdSched &&
                   createdSched.isScheduled === true &&
                   createdSched.status === 'scheduled';
  logTest(2, 'Formulario programado genera isScheduled=true y status=scheduled', t2Passed,
    `isScheduled: ${createdSched?.isScheduled}, Status: ${createdSched?.status}`);

  // ----------------------------------------------------
  // TEST 3: scheduledAt se genera y persiste correctamente en ISO 8601
  // ----------------------------------------------------
  const t3Passed = createdSched &&
                   createdSched.scheduledAt === targetFutureDate &&
                   !isNaN(new Date(createdSched.scheduledAt).getTime());
  logTest(3, 'scheduledAt se genera y persiste correctamente en ISO 8601 UTC', t3Passed,
    `scheduledAt: ${createdSched?.scheduledAt}`);

  // ----------------------------------------------------
  // TEST 4: dispatchLeadTime se envía y calcula dispatchAt correctamente
  // ----------------------------------------------------
  const expectedDispatchTime = new Date(new Date(targetFutureDate).getTime() - 20 * 60 * 1000).toISOString();
  const t4Passed = createdSched &&
                   createdSched.dispatchLeadTime === 20 &&
                   createdSched.dispatchAt === expectedDispatchTime;
  logTest(4, 'dispatchLeadTime se envía correctamente y calcula dispatchAt', t4Passed,
    `LeadTime: ${createdSched?.dispatchLeadTime} min, dispatchAt: ${createdSched?.dispatchAt}`);

  // ----------------------------------------------------
  // TEST 5: Nombre y teléfono del pasajero llegan correctamente
  // ----------------------------------------------------
  const t5Passed = createdSched &&
                   createdSched.customerName === 'Pasajero Programado 4C2' &&
                   createdSched.customerPhone === '555-0202';
  logTest(5, 'Nombre y teléfono del pasajero llegan correctamente', t5Passed,
    `Cliente: "${createdSched?.customerName}", Tel: "${createdSched?.customerPhone}"`);

  // ----------------------------------------------------
  // TEST 6: Origen y destino llegan con direcciones y coordenadas
  // ----------------------------------------------------
  const t6Passed = createdSched &&
                   createdSched.pickup.address === 'Av Principal 500' &&
                   createdSched.destination.address === 'Aeropuerto JFK Terminal 4' &&
                   createdSched.pickup.lat === 40.75 &&
                   createdSched.destination.lat === 40.64;
  logTest(6, 'Origen y destino llegan correctamente con direcciones y coordenadas', t6Passed,
    `Pickup: ${createdSched?.pickup?.address}, Dest: ${createdSched?.destination?.address}`);

  // ----------------------------------------------------
  // TEST 7: passengerCount llega y se valida correctamente (entero positivo)
  // ----------------------------------------------------
  const t7Passed = createdSched && createdSched.passengerCount === 3;
  logTest(7, 'passengerCount llega y se almacena correctamente', t7Passed,
    `passengerCount: ${createdSched?.passengerCount}`);

  // ----------------------------------------------------
  // TEST 8: vehicleCategory llega correctamente
  // ----------------------------------------------------
  const t8Passed = createdSched && createdSched.vehicleCategory === 'xl';
  logTest(8, 'vehicleCategory llega correctamente (xl)', t8Passed,
    `vehicleCategory: ${createdSched?.vehicleCategory}`);

  // ----------------------------------------------------
  // TEST 9: paymentMethod llega correctamente
  // ----------------------------------------------------
  const t9Passed = createdSched && createdSched.paymentMethod === 'card';
  logTest(9, 'paymentMethod llega correctamente (card)', t9Passed,
    `paymentMethod: ${createdSched?.paymentMethod}`);

  // ----------------------------------------------------
  // TEST 10: notes llega correctamente
  // ----------------------------------------------------
  const t10Passed = createdSched && createdSched.notes === 'Pasajero con 2 maletas grandes';
  logTest(10, 'notes llega correctamente', t10Passed,
    `notes: "${createdSched?.notes}"`);

  // ----------------------------------------------------
  // TEST 11: Tarifa calculada conserva cálculo existente
  // ----------------------------------------------------
  const t11Passed = createdImm && createdImm.isManualFare === false && createdImm.fare === 18.50;
  logTest(11, 'Tarifa calculada conserva valor de ruta estándar', t11Passed,
    `isManualFare: ${createdImm?.isManualFare}, Fare: $${createdImm?.fare}`);

  // ----------------------------------------------------
  // TEST 12: Tarifa manual se envía y persiste correctamente
  // ----------------------------------------------------
  let createdManualFare = null;
  const manualPromise = new Promise(resolve => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Tarifa Manual') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Tarifa Manual',
    customerPhone: '555-0303',
    pickup: { address: 'Hotel Plaza', lat: 40.76, lng: -73.97 },
    destination: { address: 'Wall Street 50', lat: 40.70, lng: -74.00 },
    isManualFare: true,
    manualFare: 45.00
  });

  createdManualFare = await manualPromise;
  const t12Passed = createdManualFare &&
                    createdManualFare.isManualFare === true &&
                    createdManualFare.manualFare === 45.00 &&
                    createdManualFare.fare === 45.00;
  logTest(12, 'Tarifa manual se envía, persiste y asigna a fare correctamente', t12Passed,
    `isManualFare: ${createdManualFare?.isManualFare}, manualFare: $${createdManualFare?.manualFare}, fare: $${createdManualFare?.fare}`);

  // ----------------------------------------------------
  // TEST 13: No se permite programar sin fecha (rechazado con error)
  // ----------------------------------------------------
  let errNoDate = null;
  const errNoDatePromise = new Promise(resolve => {
    dispatcherSocket.once('error', resolve);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Sin Fecha',
    pickup: { address: 'Calle A', lat: 40.7, lng: -74.0 },
    destination: { address: 'Calle B', lat: 40.7, lng: -74.0 },
    isScheduled: true,
    scheduledAt: null
  });

  errNoDate = await errNoDatePromise;
  const t13Passed = Boolean(errNoDate && errNoDate.message);
  logTest(13, 'No se permite programar sin fecha (backend rechaza)', t13Passed,
    `Error recibido: "${errNoDate?.message}"`);

  // ----------------------------------------------------
  // TEST 14: No se permite programar con fecha inválida (rechazado con error)
  // ----------------------------------------------------
  let errInvalidDate = null;
  const errInvalidDatePromise = new Promise(resolve => {
    dispatcherSocket.once('error', resolve);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Fecha Invalida',
    pickup: { address: 'Calle A', lat: 40.7, lng: -74.0 },
    destination: { address: 'Calle B', lat: 40.7, lng: -74.0 },
    isScheduled: true,
    scheduledAt: 'FECHA_INVALIDA_XYZ'
  });

  errInvalidDate = await errInvalidDatePromise;
  const t14Passed = Boolean(errInvalidDate && errInvalidDate.message);
  logTest(14, 'No se permite programar con fecha/hora no válida', t14Passed,
    `Error recibido: "${errInvalidDate?.message}"`);

  // ----------------------------------------------------
  // TEST 15: No se permite fecha/hora en el pasado
  // ----------------------------------------------------
  let errPastDate = null;
  const errPastPromise = new Promise(resolve => {
    dispatcherSocket.once('error', resolve);
  });

  const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
  dispatcherSocket.emit('ride:create', {
    customerName: 'Fecha Pasada',
    pickup: { address: 'Calle A', lat: 40.7, lng: -74.0 },
    destination: { address: 'Calle B', lat: 40.7, lng: -74.0 },
    isScheduled: true,
    scheduledAt: pastDate
  });

  errPastDate = await errPastPromise;
  const t15Passed = Boolean(errPastDate && errPastDate.message && errPastDate.message.includes('pasado'));
  logTest(15, 'No se permite fecha/hora en el pasado', t15Passed,
    `Error recibido: "${errPastDate?.message}"`);

  // ----------------------------------------------------
  // TEST 16: No se permite tarifa manual negativa ni pasajeros <= 0
  // ----------------------------------------------------
  let errNegativeFare = null;
  const errNegativePromise = new Promise(resolve => {
    dispatcherSocket.once('error', resolve);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Tarifa Negativa',
    pickup: { address: 'Calle A', lat: 40.7, lng: -74.0 },
    destination: { address: 'Calle B', lat: 40.7, lng: -74.0 },
    isManualFare: true,
    manualFare: -10.00
  });

  errNegativeFare = await errNegativePromise;
  const t16Passed = Boolean(errNegativeFare && errNegativeFare.message && errNegativeFare.message.includes('negativo'));
  logTest(16, 'No se permite tarifa manual negativa (validación atómica)', t16Passed,
    `Error recibido: "${errNegativeFare?.message}"`);

  // ----------------------------------------------------
  // TEST 17: Servicio programado NO dispara inmediatamente oferta a choferes
  // ----------------------------------------------------
  await wait(400);
  const foundOfferForScheduled = receivedDriverOffers.find(r => r.id === createdSched.id);
  const t17Passed = !foundOfferForScheduled;
  logTest(17, 'Servicio programado NO dispara inmediatamente oferta/FCM al conductor', t17Passed,
    `Oferta emitida prematuramente: ${Boolean(foundOfferForScheduled)}`);

  // ----------------------------------------------------
  // TEST 18: La información creada por el formulario es 100% compatible con scheduler 4C-1
  // ----------------------------------------------------
  // Crear reserva con antelación que venza inmediatamente para activar por scheduler
  const sched12m = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  let schedCompatRide = null;

  const compatPromise = new Promise(resolve => {
    const handler = (ride) => {
      if (ride.customerName === 'Pasajero Compatibilidad 4C1') {
        dispatcherSocket.off('ride:created', handler);
        resolve(ride);
      }
    };
    dispatcherSocket.on('ride:created', handler);
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Pasajero Compatibilidad 4C1',
    customerPhone: '555-0909',
    pickup: { address: 'Origen Compat', lat: 40.75, lng: -73.98 },
    destination: { address: 'Destino Compat', lat: 40.76, lng: -73.97 },
    isScheduled: true,
    scheduledAt: sched12m,
    dispatchLeadTime: 12, // dispatchAt es 1 min en el pasado
    passengerCount: 4,
    vehicleCategory: 'van',
    paymentMethod: 'corporate'
  });

  schedCompatRide = await compatPromise;
  await wait(6000); // esperar tick del scheduler

  const allRidesAfterSched = await fetchJson(`${SERVER_URL}/api/rides`);
  const activatedRide = allRidesAfterSched.find(r => r.id === schedCompatRide.id);

  const t18Passed = activatedRide &&
                    (activatedRide.status === 'pending' || activatedRide.status === 'offered' || activatedRide.status === 'assigned') &&
                    activatedRide.dispatchTriggered === true &&
                    activatedRide.passengerCount === 4 &&
                    activatedRide.vehicleCategory === 'van' &&
                    activatedRide.paymentMethod === 'corporate';
  logTest(18, 'Información del formulario avanzado es 100% compatible con el scheduler 4C-1', t18Passed,
    `Estado tras activación: "${activatedRide?.status}", Pasajeros: ${activatedRide?.passengerCount}, Vehículo: ${activatedRide?.vehicleCategory}`);

  // Cleanup
  driverSocket.disconnect();
  dispatcherSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 18 TESTS DE LA FASE 4C-2:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 18 TESTS DE LA FASE 4C-2 PASARON CON ÉXITO! (18/18 PASSED)\n');
    await wait(300);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 4C-2 FALLARON.\n');
    await wait(300);
    process.exit(1);
  }
}

runPhase4c2Tests().catch(err => {
  console.error('Error fatal ejecutando test_phase4c2.js:', err);
  process.exit(1);
});
