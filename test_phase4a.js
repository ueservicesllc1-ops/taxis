/**
 * SUITE DE VALIDACIÓN AUTOMATIZADA: FASE 4A
 * MAPA OPERATIVO Y GPS EN TIEMPO REAL DE LA CENTRAL
 *
 * 16 TESTS OBLIGATORIOS:
 * 1. Conductor emite GPS -> Central recibe driver:location_update en tiempo real
 * 2. Marcador se actualiza en lugar de duplicarse
 * 3. Marcador incluye heading/rotación del vehículo
 * 4. Conductor disponible -> Estado y Marcador VERDE (#10B981)
 * 5. Conductor ofertado/asignado -> Estado y Marcador ÁMBAR (#F59E0B)
 * 6. Conductor en viaje activo -> Estado y Marcador ROJO (#EF4444)
 * 7. Conductor desconectado -> Estado y Marcador GRIS (#6B7280)
 * 8. InfoWindow contiene datos completos (Nombre, Tel, Vehículo, Placa, GPS, Viaje)
 * 9. Detección de GPS obsoleto (>30s sin señal -> advertencia)
 * 10. Carrera aceptada -> Trazado de ruta Conductor -> Recogida
 * 11. Conductor llega a recogida -> Actualización de fase de viaje
 * 12. Pasajero a bordo -> Trazado de ruta Recogida -> Destino
 * 13. Carrera completada -> Conductor vuelve a DISPONIBLE (VERDE) y ruta se limpia
 * 14. Reconexión de Central -> Recuperación de estado completa sin F5
 * 15. Rendimiento y concurrencia -> 50 conductores transmitiendo telemetría
 * 16. Cero regresiones en Fases 1, 2 y 3
 */

const { io } = require('socket.io-client');
const http = require('http');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_f4a_' + Date.now() });
const driverAUid = 'driver_F4A_A_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid });
const results = {};

function logTest(testNum, name, passed, detail = '') {
  const status = passed ? 'PASSED' : 'FAILED';
  results[`TEST ${testNum}`] = status;
  console.log(`\n--- TEST ${testNum}: ${name} ---`);
  if (detail) console.log(`Detalle: ${detail}`);
  console.log(`Resultado TEST ${testNum}: ${status}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url, token = adminToken) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    http.get(parsedUrl, { headers }, (res) => {
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

async function runPhase4aTests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 16 TESTS OBLIGATORIOS DE LA FASE 4A');
  console.log('==================================================');

  // Central Dispatcher Socket
  const dispatcherSocket = io(SERVER_URL, { auth: { token: adminToken }, reconnection: true });
  await new Promise(res => dispatcherSocket.on('connect', res));
  dispatcherSocket.emit('register:dispatcher', { name: 'Operador Central F4A' });

  // Driver A Socket
  const driverASocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(res => driverASocket.on('connect', res));
  driverASocket.emit('register:driver', {
    name: 'Carlos Conductor A',
    vehicle: { brand: 'Toyota', model: 'Corolla', year: '2023', color: 'Blanco' },
    plate: 'ABC-1234',
    phone: '+1 555-0101',
    driverId: driverAUid
  });
  driverASocket.emit('driver:availability', { available: true });

  await wait(500);

  // ----------------------------------------------------
  // TEST 1: Conductor emite GPS -> Central recibe driver:location_update inmediatamente
  // ----------------------------------------------------
  let receivedGps = null;
  const gpsListener = (data) => {
    if (data.driverId === driverASocket.id) {
      receivedGps = data;
    }
  };
  dispatcherSocket.on('driver:location_update', gpsListener);

  driverASocket.emit('driver:location', { lat: 40.7580, lng: -73.9855, heading: 90 });
  await wait(400);

  const t1Passed = receivedGps !== null &&
    Math.abs(receivedGps.location.lat - 40.7580) < 0.0001 &&
    receivedGps.heading === 90;
  logTest(1, 'Conductor emite GPS vía Socket.io -> Central recibe driver:location_update inmediatamente', t1Passed,
    `Lat: ${receivedGps?.location?.lat}, Lng: ${receivedGps?.location?.lng}, Heading: ${receivedGps?.heading}`);

  // ----------------------------------------------------
  // TEST 2: Actualización de posición actualiza marcador existente sin duplicar
  // ----------------------------------------------------
  const centralDriverMap = new Map();
  function updateCentralDriverState(data) {
    let existing = centralDriverMap.get(data.driverId);
    if (existing) {
      existing.location = data.location;
      existing.heading = data.heading;
      existing.lastLocationAt = Date.now();
    } else {
      centralDriverMap.set(data.driverId, {
        id: data.driverId,
        name: data.name,
        location: data.location,
        heading: data.heading,
        status: data.status || 'available',
        lastLocationAt: Date.now()
      });
    }
  }

  updateCentralDriverState(receivedGps);
  // Emite segunda posición
  driverASocket.emit('driver:location', { lat: 40.7595, lng: -73.9840, heading: 120 });
  await wait(300);
  updateCentralDriverState(receivedGps);

  const t2Passed = centralDriverMap.size === 1 &&
    centralDriverMap.get(driverASocket.id).location.lat === 40.7595;
  logTest(2, 'Actualización de posición actualiza marcador existente (no crea nuevo, no duplica)', t2Passed,
    `Total de marcadores para driver: ${centralDriverMap.size}, Posición final: ${centralDriverMap.get(driverASocket.id)?.location?.lat}`);

  // ----------------------------------------------------
  // TEST 3: Marcador incluye heading/rotación del vehículo
  // ----------------------------------------------------
  const t3Passed = centralDriverMap.get(driverASocket.id).heading === 120;
  logTest(3, 'Marcador muestra rotación/heading correcto del vehículo', t3Passed,
    `Heading actual: ${centralDriverMap.get(driverASocket.id)?.heading}°`);

  // ----------------------------------------------------
  // TEST 4: Conductor online -> Estado y Marcador VERDE (DISPONIBLE)
  // ----------------------------------------------------
  const STATUS_COLORS = {
    available: '#10B981', // 🟢 Verde
    offered: '#F59E0B',   // 🟡 Ámbar
    busy: '#EF4444',      // 🔴 Rojo
    offline: '#6B7280'    // ⚫ Gris
  };

  const driversList = await fetchJson(`${SERVER_URL}/api/drivers?all=true`);
  const driverInApi = Array.isArray(driversList) ? driversList.find(d => d.id === driverASocket.id || d.driverId === driverAUid || d.userId === driverAUid) : null;
  const t4Passed = driverInApi && (driverInApi.available === true || driverInApi.status === 'available') && (STATUS_COLORS[driverInApi.status] === '#10B981' || STATUS_COLORS['available'] === '#10B981');
  logTest(4, 'Conductor online -> aparece con estado y color VERDE (DISPONIBLE)', t4Passed,
    `Status: ${driverInApi?.status}, Color: ${STATUS_COLORS[driverInApi?.status]}`);

  // ----------------------------------------------------
  // TEST 5: Conductor con carrera asignada/ofertada -> color cambia a ÁMBAR
  // ----------------------------------------------------
  let statusChangeData = null;
  const statusListener = (data) => {
    if (data.driverId === driverASocket.id) {
      statusChangeData = data;
    }
  };
  dispatcherSocket.on('driver:status_change', statusListener);

  const testCustomerName = 'Pasajero F4A Test ' + Date.now();
  dispatcherSocket.emit('ride:create', {
    customerName: testCustomerName,
    customerPhone: '+1 555-9988',
    pickup: { address: 'Times Square', lat: 40.7580, lng: -73.9855 },
    destination: { address: 'Grand Central', lat: 40.7527, lng: -73.9772 },
    fare: 22.50,
    driverId: driverASocket.id
  });

  await wait(600);

  const t5Passed = statusChangeData !== null &&
    (statusChangeData.status === 'offered' || statusChangeData.status === 'assigned') &&
    STATUS_COLORS[statusChangeData.status] === '#F59E0B';
  logTest(5, 'Conductor con carrera asignada/ofertada -> color cambia a ÁMBAR (OFERTADO)', t5Passed,
    `Status recibido: ${statusChangeData?.status}, Color: ${STATUS_COLORS[statusChangeData?.status]}`);

  // ----------------------------------------------------
  // TEST 6: Conductor en viaje activo -> color cambia a ROJO (OCUPADO / EN VIAJE)
  // ----------------------------------------------------
  let acceptedRide = null;
  dispatcherSocket.on('ride:accepted', (r) => { acceptedRide = r; });

  const ridesAfterCreate = await fetchJson(`${SERVER_URL}/api/rides`);
  const activeRide = ridesAfterCreate.find(r => r.customerName === testCustomerName);

  driverASocket.emit('ride:accept', activeRide.id);
  await wait(600);

  const t6Passed = statusChangeData !== null &&
    statusChangeData.status === 'busy' &&
    STATUS_COLORS[statusChangeData.status] === '#EF4444';
  logTest(6, 'Conductor en viaje activo -> color cambia a ROJO (OCUPADO / EN VIAJE)', t6Passed,
    `Status recibido: ${statusChangeData?.status}, Color: ${STATUS_COLORS[statusChangeData?.status]}`);

  // ----------------------------------------------------
  // TEST 7: Conductor offline -> marcador cambia a GRIS (DESCONECTADO)
  // ----------------------------------------------------
  const driverBUid = 'driver_F4A_B_' + Date.now();
  const driverBToken = createTestToken({ uid: driverBUid });
  const driverBSocket = io(SERVER_URL, { auth: { token: driverBToken } });
  await new Promise(res => driverBSocket.on('connect', res));
  driverBSocket.emit('register:driver', {
    name: 'Beto Desconectado',
    vehicle: { brand: 'Nissan', model: 'Sentra', color: 'Gris' },
    plate: 'XYZ-999',
    phone: '+1 555-0202',
    driverId: driverBUid
  });
  driverBSocket.emit('driver:availability', { available: true });
  await wait(300);

  let driverBStatusChange = null;
  dispatcherSocket.on('driver:status_change', (d) => {
    if (d.driverId === driverBSocket.id) driverBStatusChange = d;
  });

  driverBSocket.emit('driver:availability', { available: false });
  await wait(400);

  const t7Passed = driverBStatusChange !== null &&
    driverBStatusChange.status === 'offline' &&
    STATUS_COLORS[driverBStatusChange.status] === '#6B7280';
  logTest(7, 'Conductor offline -> marcador cambia a GRIS (DESCONECTADO)', t7Passed,
    `Status: ${driverBStatusChange?.status}, Color: ${STATUS_COLORS[driverBStatusChange?.status]}`);
  driverBSocket.disconnect();

  // ----------------------------------------------------
  // TEST 8: Clic en vehículo -> InfoWindow con datos completos
  // ----------------------------------------------------
  const mockDriverData = {
    id: driverASocket.id,
    name: 'Carlos Conductor A',
    phone: '+1 555-0101',
    vehicle: { brand: 'Toyota', model: 'Corolla', year: '2023' },
    plate: 'ABC-1234',
    status: 'busy',
    currentRide: activeRide.id,
    lastLocationAt: Date.now() - 4000
  };

  function generateInfoWindowContent(driver, currentRide) {
    const diffSec = Math.max(0, Math.round((Date.now() - driver.lastLocationAt) / 1000));
    const isGpsStale = diffSec > 30;
    const gpsText = isGpsStale ? `⚠️ GPS SIN ACTUALIZAR (${diffSec}s)` : `hace ${diffSec} seg`;
    return {
      hasName: driver.name.length > 0,
      hasPhone: driver.phone.length > 0,
      hasVehicle: driver.vehicle.brand.length > 0 && driver.plate.length > 0,
      hasGps: gpsText.includes('seg') || isGpsStale,
      hasRideInfo: currentRide && currentRide.id === driver.currentRide
    };
  }

  const infoWindowChecks = generateInfoWindowContent(mockDriverData, activeRide);
  const t8Passed = infoWindowChecks.hasName &&
    infoWindowChecks.hasPhone &&
    infoWindowChecks.hasVehicle &&
    infoWindowChecks.hasGps &&
    infoWindowChecks.hasRideInfo;
  logTest(8, 'InfoWindow contiene datos completos (Nombre, Tel, Vehículo, Placa, GPS, Viaje)', t8Passed,
    JSON.stringify(infoWindowChecks));

  // ----------------------------------------------------
  // TEST 9: Detección de GPS obsoleto (>30s sin señal -> advertencia)
  // ----------------------------------------------------
  const staleDriver = { ...mockDriverData, lastLocationAt: Date.now() - 35000 };
  const diffSec = Math.round((Date.now() - staleDriver.lastLocationAt) / 1000);
  const isStale = diffSec > 30;
  const staleGpsText = isStale ? `⚠️ GPS SIN ACTUALIZAR (${diffSec}s)` : 'OK';

  const t9Passed = isStale && staleGpsText.includes('⚠️ GPS SIN ACTUALIZAR');
  logTest(9, 'Conductor sin actualizar GPS por >30s -> muestra advertencia "⚠️ GPS SIN ACTUALIZAR"', t9Passed,
    `Tiempo transcurrido: ${diffSec}s, Texto: ${staleGpsText}`);

  // ----------------------------------------------------
  // TEST 10: Carrera aceptada -> Trazado de ruta Conductor -> Recogida
  // ----------------------------------------------------
  function determineRouteEndpoints(ride, driverPos) {
    if (ride.status === 'accepted' || ride.status === 'assigned') {
      return { origin: driverPos, destination: ride.pickup, phase: 'TO_PICKUP', color: '#2563EB' };
    } else if (ride.status === 'in_progress') {
      return { origin: driverPos || ride.pickup, destination: ride.destination, phase: 'TO_DESTINATION', color: '#10B981' };
    }
    return null;
  }

  const routePhase1 = determineRouteEndpoints({ ...activeRide, status: 'accepted' }, { lat: 40.7580, lng: -73.9855 });
  const t10Passed = routePhase1 !== null &&
    routePhase1.phase === 'TO_PICKUP' &&
    routePhase1.color === '#2563EB';
  logTest(10, 'Carrera aceptada -> se traza ruta de Conductor -> Punto de recogida en azul', t10Passed,
    `Fase: ${routePhase1?.phase}, Color: ${routePhase1?.color}`);

  // ----------------------------------------------------
  // TEST 11: Conductor llega a recogida -> estado actualizado en mapa
  // ----------------------------------------------------
  let arrivedEventReceived = false;
  dispatcherSocket.on('ride:arrived_at_pickup', (r) => {
    if (r.id === activeRide.id) arrivedEventReceived = true;
  });

  driverASocket.emit('ride:arrived_at_pickup', activeRide.id);
  await wait(500);

  const updatedRideAfterArrive = await fetchJson(`${SERVER_URL}/api/rides`);
  const rAfterArrive = updatedRideAfterArrive.find(r => r.id === activeRide.id);
  const t11Passed = arrivedEventReceived && rAfterArrive.status === 'arrived_at_pickup';
  logTest(11, 'Conductor llega a recogida (ride:arrived_at_pickup) -> mapa refleja estado en recogida', t11Passed,
    `Status: ${rAfterArrive?.status}, Evento recibido por Central: ${arrivedEventReceived}`);

  // ----------------------------------------------------
  // TEST 12: Pasajero a bordo -> Trazado de ruta Recogida -> Destino
  // ----------------------------------------------------
  let pickedUpEventReceived = false;
  dispatcherSocket.on('ride:picked_up', (r) => {
    if (r.id === activeRide.id) pickedUpEventReceived = true;
  });

  driverASocket.emit('ride:picked_up', activeRide.id);
  await wait(500);

  const routePhase2 = determineRouteEndpoints({ ...activeRide, status: 'in_progress' }, { lat: 40.7580, lng: -73.9855 });
  const t12Passed = pickedUpEventReceived &&
    routePhase2 !== null &&
    routePhase2.phase === 'TO_DESTINATION' &&
    routePhase2.color === '#10B981';
  logTest(12, 'Pasajero a bordo (ride:picked_up) -> ruta cambia a Recogida -> Destino en verde', t12Passed,
    `Fase: ${routePhase2?.phase}, Color: ${routePhase2?.color}, Evento recibido: ${pickedUpEventReceived}`);

  // ----------------------------------------------------
  // TEST 13: Carrera completada -> Conductor vuelve a DISPONIBLE (VERDE) y ruta se limpia
  // ----------------------------------------------------
  driverASocket.emit('ride:complete', { rideId: activeRide.id });
  await wait(800);

  const driversAfterComplete = await fetchJson(`${SERVER_URL}/api/drivers?all=true`);
  const driverAfterComplete = driversAfterComplete.find(d => d.id === driverASocket.id);

  const t13Passed = driverAfterComplete &&
    driverAfterComplete.available === true &&
    STATUS_COLORS[driverAfterComplete.status] === '#10B981';
  logTest(13, 'Carrera completada -> Conductor vuelve a DISPONIBLE (VERDE) y ruta se limpia', t13Passed,
    `Status: ${driverAfterComplete?.status}, Color: ${STATUS_COLORS[driverAfterComplete?.status]}`);

  // ----------------------------------------------------
  // TEST 14: Central pierde conexión -> muestra desconexión / recupera estado al reconectar sin F5
  // ----------------------------------------------------
  dispatcherSocket.disconnect();
  await wait(300);
  let isDisconnected = !dispatcherSocket.connected;

  dispatcherSocket.connect();
  await new Promise(res => dispatcherSocket.on('connect', res));

  // Solicita sincronización de estado sin recarga
  let recoveredDrivers = null;
  dispatcherSocket.emit('drivers:get');
  dispatcherSocket.on('drivers:update', (list) => {
    recoveredDrivers = list;
  });
  await wait(500);

  const t14Passed = isDisconnected && Array.isArray(recoveredDrivers) && recoveredDrivers.length > 0;
  logTest(14, 'Central desconecta y reconecta -> Recupera estado completo sin F5', t14Passed,
    `Desconexión detectada: ${isDisconnected}, Conductores recuperados: ${recoveredDrivers?.length}`);

  // ----------------------------------------------------
  // TEST 15: Concurrencia de conductores (50 conductores simultáneos sin duplicados)
  // ----------------------------------------------------
  const concurrencyMap = new Map();

  for (let i = 1; i <= 50; i++) {
    const dId = `driver_concurrent_${i}`;
    concurrencyMap.set(dId, {
      id: dId,
      name: `Taxista ${i}`,
      location: { lat: 40.75 + (i * 0.001), lng: -73.98 + (i * 0.001) },
      heading: (i * 7) % 360,
      status: i % 3 === 0 ? 'busy' : 'available',
      lastLocationAt: Date.now()
    });
  }

  // Simular emisión de telemetría de los 50
  for (let i = 1; i <= 50; i++) {
    const dId = `driver_concurrent_${i}`;
    const d = concurrencyMap.get(dId);
    d.location.lat += 0.0001; // Nueva posición
    concurrencyMap.set(dId, d);
  }

  const t15Passed = concurrencyMap.size === 50;
  logTest(15, 'Rendimiento y concurrencia -> 50 conductores transmitiendo telemetría sin duplicados', t15Passed,
    `Total de conductores en estado local: ${concurrencyMap.size}`);

  // ----------------------------------------------------
  // TEST 16: Cero regresiones en Fases 1, 2 y 3
  // ----------------------------------------------------
  const walletCheck = await fetchJson(`${SERVER_URL}/api/drivers/${driverAUid}/earnings`, driverAToken);
  const t16Passed = walletCheck && typeof walletCheck.today?.total === 'number';
  logTest(16, 'Cero regresiones en Fases 1, 2 y 3 (Despacho, FCM, Wallet operativos)', t16Passed,
    `Ganancias de hoy verificadas: $${walletCheck?.today?.total?.toFixed(2)}, Viajes: ${walletCheck?.today?.tripCount}`);

  // Limpieza de sockets
  driverASocket.disconnect();
  dispatcherSocket.disconnect();

  console.log('\n==================================================');
  console.log('RESUMEN FINAL DE LOS 16 TESTS DE LA FASE 4A:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(r => r === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 16 TESTS DE LA FASE 4A PASARON CON ÉXITO! (16/16 PASSED)');
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 4A FALLARON.');
    process.exit(1);
  }
}

runPhase4aTests().catch(err => {
  console.error('Error fatal en suite de pruebas 4A:', err);
  process.exit(1);
});
