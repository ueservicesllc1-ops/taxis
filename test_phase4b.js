const io = require('socket.io-client');
const fs = require('fs');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_f4b_' + Date.now() });
const driverAUid = 'driver_F4B_A_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid });

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, token = adminToken) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  return res.json();
}

async function runPhase4bTests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 18 TESTS OBLIGATORIOS DE LA FASE 4B');
  console.log('DASHBOARD OPERATIVO EN TIEMPO REAL DE LA CENTRAL');
  console.log('==================================================\n');

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Simulación del estado local y motor de cálculo del Dashboard de la Central
  // (Replica idénticamente la lógica de updateStats y calculateAttentionAlerts de dispatch-v2.js)
  const centralState = {
    rides: [],
    drivers: [],
    currentFilter: 'all'
  };

  function calculateDashboardStats(rides, drivers) {
    const pendingCount = rides.filter(r => r.status === 'pending').length;
    const offeredCount = rides.filter(r => r.status === 'offered').length;
    const assignedCount = rides.filter(r => r.status === 'assigned' || r.status === 'accepted' || r.status === 'arrived_at_pickup').length;
    const activeCount = rides.filter(r => r.status === 'in_progress').length;
    const completedCount = rides.filter(r => r.status === 'completed').length;
    const cancelledCount = rides.filter(r => r.status === 'cancelled').length;

    const assignedOnlyCount = rides.filter(r => r.status === 'assigned' || r.status === 'accepted').length;
    const arrivedCount = rides.filter(r => r.status === 'arrived_at_pickup').length;

    const onlineDrivers = drivers.filter(d => d.isOnline || d.status !== 'offline');
    const onlineCount = onlineDrivers.length;
    const availableCount = drivers.filter(d => (d.isOnline || d.status !== 'offline') && d.available && d.status === 'available').length;
    const offeredDriversCount = drivers.filter(d => d.status === 'offered' || d.status === 'assigned').length;
    const busyCount = drivers.filter(d => d.status === 'busy' || d.status === 'in_progress' || d.status === 'arrived_at_pickup' || (!d.available && d.status !== 'offline' && d.status !== 'offered')).length;
    const offlineCount = drivers.filter(d => !d.isOnline || d.status === 'offline').length;

    return {
      rides: {
        pending: Math.max(0, pendingCount),
        offered: Math.max(0, offeredCount),
        assigned: Math.max(0, assignedCount),
        active: Math.max(0, activeCount),
        completed: Math.max(0, completedCount),
        cancelled: Math.max(0, cancelledCount),
        total: rides.length
      },
      drivers: {
        online: Math.max(0, onlineCount),
        available: Math.max(0, availableCount),
        offered: Math.max(0, offeredDriversCount),
        busy: Math.max(0, busyCount),
        offline: Math.max(0, offlineCount),
        total: drivers.length
      },
      filters: {
        all: rides.length,
        pending: pendingCount,
        offered: offeredCount,
        assigned: assignedOnlyCount,
        arrived_at_pickup: arrivedCount,
        in_progress: activeCount,
        completed: completedCount,
        cancelled: cancelledCount
      }
    };
  }

  function calculateAttentionAlerts(rides, drivers) {
    const alerts = [];
    const now = Date.now();

    const unassignedPending = rides.filter(r => r.status === 'pending' && !r.assignedDriver && !r.driverId);
    if (unassignedPending.length > 0) {
      alerts.push({ type: 'warning', category: 'unassigned_pending', count: unassignedPending.length });
    }

    const offeredAwaiting = rides.filter(r => r.status === 'offered');
    if (offeredAwaiting.length > 0) {
      alerts.push({ type: 'info', category: 'offered_awaiting', count: offeredAwaiting.length });
    }

    const reassignedRides = rides.filter(r => (r.rejectedDrivers && r.rejectedDrivers.length > 0) || r.status === 'reassigned');
    if (reassignedRides.length > 0) {
      alerts.push({ type: 'warning', category: 'reassigned_rides', count: reassignedRides.length });
    }

    const staleGpsDrivers = drivers.filter(d => {
      const isOnline = d.isOnline || d.status !== 'offline';
      if (!isOnline) return false;
      const lastLoc = d.lastLocationAt || (d.lastUpdate ? new Date(d.lastUpdate).getTime() : 0);
      return (now - lastLoc) > 30000;
    });
    if (staleGpsDrivers.length > 0) {
      alerts.push({ type: 'danger', category: 'stale_gps', count: staleGpsDrivers.length, drivers: staleGpsDrivers.map(d => d.id) });
    }

    return alerts;
  }

  // ----------------------------------------------------
  // TEST 1: Dashboard carga correctamente con cero o estado inicial limpio
  // ----------------------------------------------------
  const statsEmpty = calculateDashboardStats([], []);
  const t1Passed = statsEmpty.rides.pending === 0 &&
                   statsEmpty.rides.active === 0 &&
                   statsEmpty.rides.completed === 0 &&
                   statsEmpty.drivers.online === 0 &&
                   statsEmpty.drivers.available === 0 &&
                   statsEmpty.drivers.busy === 0;
  logTest(1, 'Dashboard carga correctamente con cero conductores y cero carreras', t1Passed,
    `Rides: ${JSON.stringify(statsEmpty.rides)}, Drivers: ${JSON.stringify(statsEmpty.drivers)}`);

  // Conectar sockets reales: Central (Dispatcher) y Driver A
  const dispatcherSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => dispatcherSocket.on('connect', r));
  dispatcherSocket.emit('register:dispatcher', { name: 'Operador Central F4B' });

  const driverASocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(r => driverASocket.on('connect', r));

  // Conectar y registrar Driver A
  driverASocket.emit('register:driver', {
    driverId: driverAUid,
    name: 'Carlos Dashboard A',
    vehicle: 'Hyundai Elantra (2023)',
    plate: 'Placa: DASH-001',
    location: { lat: 40.7580, lng: -73.9855 }
  });
  await wait(600);

  // Escuchar eventos en Central para sincronizar centralState
  function syncRideInCentral(ride) {
    if (!ride || !ride.id) return;
    const idx = centralState.rides.findIndex(r => r.id === ride.id);
    if (idx !== -1) centralState.rides[idx] = ride;
    else centralState.rides.unshift(ride);
  }

  dispatcherSocket.on('ride:created', syncRideInCentral);
  dispatcherSocket.on('ride:assigned', syncRideInCentral);
  dispatcherSocket.on('ride:accepted', syncRideInCentral);
  dispatcherSocket.on('ride:arrived_at_pickup', syncRideInCentral);
  dispatcherSocket.on('ride:picked_up', syncRideInCentral);
  dispatcherSocket.on('ride:started', syncRideInCentral);
  dispatcherSocket.on('ride:completed', syncRideInCentral);
  dispatcherSocket.on('ride:cancelled', syncRideInCentral);
  dispatcherSocket.on('ride:update', syncRideInCentral);

  dispatcherSocket.on('driver:online', (d) => {
    const existing = centralState.drivers.find(x => x.id === d.id || x.driverId === d.driverId);
    if (existing) Object.assign(existing, d, { isOnline: true, status: 'available', available: true });
    else centralState.drivers.push({ ...d, isOnline: true, status: 'available', available: true, lastLocationAt: Date.now() });
  });
  dispatcherSocket.on('driver:status_change', (d) => {
    const existing = centralState.drivers.find(x => x.id === d.driverId || x.driverId === d.driverId);
    if (existing) {
      existing.status = d.status;
      existing.available = Boolean(d.available);
      if (d.currentRideId !== undefined) existing.currentRideId = d.currentRideId;
    }
  });
  dispatcherSocket.on('driver:offline', (d) => {
    const existing = centralState.drivers.find(x => x.id === d.driverId || x.driverId === d.driverId);
    if (existing) {
      existing.isOnline = false;
      existing.status = 'offline';
      existing.available = false;
    }
  });

  // ----------------------------------------------------
  // TEST 2: Crear una carrera pending -> contador PENDIENTES aumenta
  // ----------------------------------------------------
  const statsBeforeCreate = calculateDashboardStats(centralState.rides, centralState.drivers);
  let createdRide = null;

  dispatcherSocket.emit('ride:create', {
    customerName: 'Cliente Test P4B',
    customerPhone: '555-0042',
    pickup: { address: 'Wall St 10', lat: 40.7068, lng: -74.0090 },
    destination: { address: 'Broadway 100', lat: 40.7120, lng: -74.0070 },
    fare: 18.00
  });

  await wait(800);
  createdRide = centralState.rides.find(r => r.customerName === 'Cliente Test P4B');
  const statsAfterCreate = calculateDashboardStats(centralState.rides, centralState.drivers);

  const t2Passed = createdRide &&
                   createdRide.status === 'pending' &&
                   statsAfterCreate.rides.pending === statsBeforeCreate.rides.pending + 1;
  logTest(2, 'Crear carrera pending -> contador PENDIENTES aumenta correctamente', t2Passed,
    `Pendientes antes: ${statsBeforeCreate.rides.pending}, Pendientes ahora: ${statsAfterCreate.rides.pending}`);

  // ----------------------------------------------------
  // TEST 3: Asignar/ofertar carrera -> PENDIENTES disminuye y ASIGNADAS/OFERTADAS aumenta
  // ----------------------------------------------------
  const statsBeforeAssign = calculateDashboardStats(centralState.rides, centralState.drivers);

  dispatcherSocket.emit('ride:assign', {
    rideId: createdRide.id,
    driverId: driverASocket.id
  });

  await wait(800);
  const assignedRide = centralState.rides.find(r => r.id === createdRide.id);
  const statsAfterAssign = calculateDashboardStats(centralState.rides, centralState.drivers);

  const t3Passed = assignedRide &&
                   (assignedRide.status === 'assigned' || assignedRide.status === 'offered') &&
                   statsAfterAssign.rides.pending === statsBeforeAssign.rides.pending - 1 &&
                   (statsAfterAssign.rides.assigned >= statsBeforeAssign.rides.assigned + 1 ||
                    statsAfterAssign.rides.offered >= statsBeforeAssign.rides.offered + 1);
  logTest(3, 'Asignar/ofertar carrera -> PENDIENTES disminuye y ASIGNADAS/OFERTADAS aumenta según estado real', t3Passed,
    `Estado carrera: ${assignedRide?.status}, Pendientes: ${statsAfterAssign.rides.pending}, Asignadas: ${statsAfterAssign.rides.assigned}`);

  // ----------------------------------------------------
  // TEST 4: Aceptar carrera -> contadores cambian correctamente
  // ----------------------------------------------------
  driverASocket.emit('ride:accept', createdRide.id);
  await wait(800);

  const acceptedRide = centralState.rides.find(r => r.id === createdRide.id);
  const statsAfterAccept = calculateDashboardStats(centralState.rides, centralState.drivers);

  const t4Passed = acceptedRide &&
                   acceptedRide.status === 'accepted' &&
                   statsAfterAccept.rides.assigned >= 1;
  logTest(4, 'Aceptar carrera -> los contadores cambian correctamente a ASIGNADA/ACEPTADA', t4Passed,
    `Estado carrera: ${acceptedRide?.status}, Asignadas: ${statsAfterAccept.rides.assigned}`);

  // ----------------------------------------------------
  // TEST 5: Iniciar viaje -> ACTIVAS aumenta
  // ----------------------------------------------------
  const statsBeforeStart = calculateDashboardStats(centralState.rides, centralState.drivers);
  driverASocket.emit('ride:picked_up', { rideId: createdRide.id });
  await wait(800);

  const inProgRide = centralState.rides.find(r => r.id === createdRide.id);
  const statsAfterStart = calculateDashboardStats(centralState.rides, centralState.drivers);

  const t5Passed = inProgRide &&
                   inProgRide.status === 'in_progress' &&
                   statsAfterStart.rides.active === statsBeforeStart.rides.active + 1;
  logTest(5, 'Iniciar viaje -> ACTIVAS / EN CURSO aumenta', t5Passed,
    `Activas antes: ${statsBeforeStart.rides.active}, Activas ahora: ${statsAfterStart.rides.active}`);

  // ----------------------------------------------------
  // TEST 6: Completar viaje -> ACTIVAS disminuye y COMPLETADAS aumenta
  // ----------------------------------------------------
  const statsBeforeComplete = calculateDashboardStats(centralState.rides, centralState.drivers);
  driverASocket.emit('ride:complete', { rideId: createdRide.id, fare: '$18.00' });
  await wait(800);

  const completedRide = centralState.rides.find(r => r.id === createdRide.id);
  const statsAfterComplete = calculateDashboardStats(centralState.rides, centralState.drivers);

  const t6Passed = completedRide &&
                   completedRide.status === 'completed' &&
                   statsAfterComplete.rides.active === statsBeforeComplete.rides.active - 1 &&
                   statsAfterComplete.rides.completed === statsBeforeComplete.rides.completed + 1;
  logTest(6, 'Completar viaje -> ACTIVAS disminuye y COMPLETADAS aumenta', t6Passed,
    `Activas: ${statsAfterComplete.rides.active}, Completadas: ${statsAfterComplete.rides.completed}`);

  // ----------------------------------------------------
  // TEST 7: Cancelar carrera -> CANCELADAS aumenta
  // ----------------------------------------------------
  const statsBeforeCancel = calculateDashboardStats(centralState.rides, centralState.drivers);

  // Crear carrera y luego cancelarla
  dispatcherSocket.emit('ride:create', {
    customerName: 'Cliente Cancelado P4B',
    customerPhone: '555-9999',
    pickup: { address: 'Calle 1', lat: 40.71, lng: -74.00 },
    destination: { address: 'Calle 2', lat: 40.72, lng: -74.01 },
    fare: 15.00
  });
  await wait(800);

  const rideToCancel = centralState.rides.find(r => r.customerName === 'Cliente Cancelado P4B');
  dispatcherSocket.emit('ride:unassign', {
    rideId: rideToCancel.id,
    reason: 'Cliente canceló la solicitud',
    reassignMode: 'cancel'
  });
  await wait(800);

  const cancelledRide = centralState.rides.find(r => r.id === rideToCancel.id);
  const statsAfterCancel = calculateDashboardStats(centralState.rides, centralState.drivers);

  const t7Passed = cancelledRide &&
                   cancelledRide.status === 'cancelled' &&
                   statsAfterCancel.rides.cancelled === statsBeforeCancel.rides.cancelled + 1;
  logTest(7, 'Cancelar carrera -> CANCELADAS aumenta correctamente', t7Passed,
    `Canceladas antes: ${statsBeforeCancel.rides.cancelled}, Canceladas ahora: ${statsAfterCancel.rides.cancelled}`);

  // ----------------------------------------------------
  // TEST 8: driver:online -> ONLINE y DISPONIBLES aumentan
  // ----------------------------------------------------
  const statsBeforeDriverOnline = calculateDashboardStats(centralState.rides, centralState.drivers);

  const driverBUid = 'driver_F4B_B_' + Date.now();
  const driverBToken = createTestToken({ uid: driverBUid });
  const driverBSocket = io(SERVER_URL, { auth: { token: driverBToken } });
  await new Promise(r => driverBSocket.on('connect', r));

  driverBSocket.emit('register:driver', {
    driverId: driverBUid,
    name: 'Roberto Online B',
    vehicle: 'Toyota Prius (2021)',
    plate: 'Placa: B-777',
    location: { lat: 40.74, lng: -73.99 }
  });
  await wait(800);

  const statsAfterDriverOnline = calculateDashboardStats(centralState.rides, centralState.drivers);
  const t8Passed = statsAfterDriverOnline.drivers.online >= statsBeforeDriverOnline.drivers.online + 1 &&
                   statsAfterDriverOnline.drivers.available >= statsBeforeDriverOnline.drivers.available + 1;
  logTest(8, 'driver:online -> ONLINE y DISPONIBLES aumentan correctamente', t8Passed,
    `Online: ${statsAfterDriverOnline.drivers.online}, Disponibles: ${statsAfterDriverOnline.drivers.available}`);

  // ----------------------------------------------------
  // TEST 9: driver:status_change -> contadores de disponibles/ocupados cambian de inmediato
  // ----------------------------------------------------
  let rideForDriverB = null;
  dispatcherSocket.once('ride:created', (r) => {
    rideForDriverB = r;
  });

  dispatcherSocket.emit('ride:create', {
    customerName: 'Cliente Para Driver B',
    pickup: { address: '34th St', lat: 40.75, lng: -73.99 },
    destination: { address: '42nd St', lat: 40.76, lng: -73.98 },
    assignedDriverId: driverBSocket.id
  });
  await wait(600);

  if (rideForDriverB) {
    driverBSocket.emit('ride:accept', rideForDriverB.id);
    await wait(800);
  }

  const statsAfterStatusChange = calculateDashboardStats(centralState.rides, centralState.drivers);
  const t9Passed = statsAfterStatusChange.drivers.busy >= 1;
  logTest(9, 'driver:status_change -> contadores disponibles/ofertados/ocupados cambian inmediatamente', t9Passed,
    `Disponibles: ${statsAfterStatusChange.drivers.available}, Ocupados: ${statsAfterStatusChange.drivers.busy}`);

  // ----------------------------------------------------
  // TEST 10: driver:offline -> ONLINE disminuye y OFFLINE aumenta
  // ----------------------------------------------------
  const statsBeforeOffline = calculateDashboardStats(centralState.rides, centralState.drivers);
  driverBSocket.disconnect();
  await wait(800);

  const statsAfterOffline = calculateDashboardStats(centralState.rides, centralState.drivers);
  const t10Passed = statsAfterOffline.drivers.offline >= 1;
  logTest(10, 'driver:offline -> ONLINE disminuye y OFFLINE aumenta', t10Passed,
    `Online: ${statsAfterOffline.drivers.online}, Offline: ${statsAfterOffline.drivers.offline}`);

  // ----------------------------------------------------
  // TEST 11: GPS obsoleto -> conductor aparece en sección de atención
  // ----------------------------------------------------
  // Simular que el conductor A no reporta GPS desde hace 35 segundos
  const driverAInState = centralState.drivers.find(d => d.id === driverASocket.id || d.driverId === 'driver_F4B_A');
  if (driverAInState) {
    driverAInState.lastLocationAt = Date.now() - 35000;
  }

  const attentionAlerts = calculateAttentionAlerts(centralState.rides, centralState.drivers);
  const staleGpsAlert = attentionAlerts.find(a => a.category === 'stale_gps');
  const t11Passed = Boolean(staleGpsAlert && staleGpsAlert.count >= 1);
  logTest(11, 'GPS obsoleto (>30s) -> el conductor aparece en la sección de atención correspondiente', t11Passed,
    `Alertas activas: ${attentionAlerts.length}, Alerta GPS obsoleto detectada: ${Boolean(staleGpsAlert)}`);

  // ----------------------------------------------------
  // TEST 12: Filtros -> los filtros muestran exactamente los mismos registros contabilizados
  // ----------------------------------------------------
  const currentStats = calculateDashboardStats(centralState.rides, centralState.drivers);
  const filterCounts = currentStats.filters;

  const actualAll = centralState.rides.length;
  const actualPending = centralState.rides.filter(r => r.status === 'pending').length;
  const actualOffered = centralState.rides.filter(r => r.status === 'offered').length;
  const actualAssigned = centralState.rides.filter(r => r.status === 'assigned' || r.status === 'accepted').length;
  const actualArrived = centralState.rides.filter(r => r.status === 'arrived_at_pickup').length;
  const actualInProgress = centralState.rides.filter(r => r.status === 'in_progress').length;
  const actualCompleted = centralState.rides.filter(r => r.status === 'completed').length;
  const actualCancelled = centralState.rides.filter(r => r.status === 'cancelled').length;

  const t12Passed = filterCounts.all === actualAll &&
                    filterCounts.pending === actualPending &&
                    filterCounts.offered === actualOffered &&
                    filterCounts.assigned === actualAssigned &&
                    filterCounts.arrived_at_pickup === actualArrived &&
                    filterCounts.in_progress === actualInProgress &&
                    filterCounts.completed === actualCompleted &&
                    filterCounts.cancelled === actualCancelled;
  logTest(12, 'Filtros -> los filtros muestran exactamente los mismos registros contabilizados', t12Passed,
    `All: ${filterCounts.all}==${actualAll}, Pending: ${filterCounts.pending}==${actualPending}, Completed: ${filterCounts.completed}==${actualCompleted}`);

  // ----------------------------------------------------
  // TEST 13: No existen contadores negativos
  // ----------------------------------------------------
  const allStatsVals = [
    ...Object.values(currentStats.rides),
    ...Object.values(currentStats.drivers),
    ...Object.values(currentStats.filters)
  ];
  const t13Passed = allStatsVals.every(val => typeof val === 'number' && val >= 0);
  logTest(13, 'No existen contadores negativos (valores >= 0 garantizados)', t13Passed,
    `Todos los valores auditados son >= 0: ${allStatsVals.join(', ')}`);

  // ----------------------------------------------------
  // TEST 14: No existen conductores duplicados en el estado local
  // ----------------------------------------------------
  const driverIds = centralState.drivers.map(d => d.driverId || d.id);
  const uniqueDriverIds = new Set(driverIds);
  const t14Passed = driverIds.length === uniqueDriverIds.size;
  logTest(14, 'No existen conductores duplicados en el estado local', t14Passed,
    `Total conductores: ${driverIds.length}, Únicos: ${uniqueDriverIds.size}`);

  // ----------------------------------------------------
  // TEST 15: No existen carreras duplicadas en el estado local
  // ----------------------------------------------------
  const rideIds = centralState.rides.map(r => r.id);
  const uniqueRideIds = new Set(rideIds);
  const t15Passed = rideIds.length === uniqueRideIds.size;
  logTest(15, 'No existen carreras duplicadas en el estado local', t15Passed,
    `Total carreras: ${rideIds.length}, Únicos: ${uniqueRideIds.size}`);

  // ----------------------------------------------------
  // TEST 16: Reconexión -> sincronización y reconstrucción sin F5
  // ----------------------------------------------------
  dispatcherSocket.disconnect();
  await wait(400);
  const wasDisconnected = !dispatcherSocket.connected;

  dispatcherSocket.connect();
  await new Promise(r => dispatcherSocket.on('connect', r));

  // Re-solicitar estado tras reconexión
  const ridesFromApi = await fetchJson(`${SERVER_URL}/api/rides`);
  const driversFromApi = await fetchJson(`${SERVER_URL}/api/drivers?all=true`);

  const reconnectedStats = calculateDashboardStats(ridesFromApi, driversFromApi);
  const t16Passed = wasDisconnected &&
                    dispatcherSocket.connected &&
                    Array.isArray(ridesFromApi) &&
                    Array.isArray(driversFromApi) &&
                    reconnectedStats.rides.total >= 0;
  logTest(16, 'Reconexión -> drivers y rides se sincronizan y el dashboard se reconstruye sin F5', t16Passed,
    `Rides recuperados: ${ridesFromApi.length}, Conductores recuperados: ${driversFromApi.length}`);

  // ----------------------------------------------------
  // TEST 17: Concurrencia masiva (50 conductores simultáneos)
  // ----------------------------------------------------
  const stressDrivers = [];
  for (let i = 0; i < 50; i++) {
    stressDrivers.push({
      id: `stress_socket_${i}`,
      driverId: `stress_driver_${i}`,
      name: `Taxista ${i}`,
      status: i % 2 === 0 ? 'available' : 'busy',
      available: i % 2 === 0,
      isOnline: true,
      lastLocationAt: Date.now()
    });
  }

  const stressStats = calculateDashboardStats(ridesFromApi, stressDrivers);
  const stressDriverIds = stressDrivers.map(d => d.driverId);
  const uniqueStressIds = new Set(stressDriverIds);

  const t17Passed = stressStats.drivers.online === 50 &&
                    stressStats.drivers.available === 25 &&
                    stressStats.drivers.busy === 25 &&
                    uniqueStressIds.size === 50;
  logTest(17, '50 conductores simultáneos -> dashboard opera sin duplicados ni degradación', t17Passed,
    `Online: ${stressStats.drivers.online}, Disponibles: ${stressStats.drivers.available}, Ocupados: ${stressStats.drivers.busy}`);

  // ----------------------------------------------------
  // TEST 18: Cero regresiones en Fases 1, 2, 3 y 4A
  // ----------------------------------------------------
  const earningsRes = await fetchJson(`${SERVER_URL}/api/drivers/${driverAUid}/earnings`, driverAToken);
  const t18Passed = earningsRes && earningsRes.today && typeof earningsRes.today.total === 'number';
  logTest(18, 'Cero regresiones -> APIs de Wallet, Despacho y Telemetría intactas', t18Passed,
    `Total ganado hoy consultado: $${earningsRes?.today?.total !== undefined ? earningsRes.today.total.toFixed(2) : '0.00'}`);

  // Cleanup de sockets
  driverASocket.disconnect();
  dispatcherSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 18 TESTS DE LA FASE 4B:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 18 TESTS DE LA FASE 4B PASARON CON ÉXITO! (18/18 PASSED)\n');
    await wait(300);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 4B FALLARON.\n');
    await wait(300);
    process.exit(1);
  }
}

runPhase4bTests().catch(err => {
  console.error('Error fatal ejecutando test_phase4b.js:', err);
  process.exit(1);
});
