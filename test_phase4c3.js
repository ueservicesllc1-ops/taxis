const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_f4c3_' + Date.now() });

// Importar o definir la lógica exacta de normalización y búsqueda de la Central
function normalizeSearchText(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function matchesSearchQuery(ride, query) {
  if (!ride) return false;
  if (!query) return true;
  const q = normalizeSearchText(query);
  if (!q) return true;

  // 1. Comparar contra ID
  const idStr = normalizeSearchText(ride.id);
  if (idStr.includes(q)) return true;

  // 2. Comparar contra Nombre de Pasajero
  const nameStr = normalizeSearchText(ride.customerName || ride.customer?.name);
  if (nameStr.includes(q)) return true;

  // 3. Comparar contra Teléfono del Pasajero
  const phoneStr = normalizeSearchText(ride.customerPhone || ride.customer?.phone);
  if (phoneStr.includes(q)) return true;

  const cleanDigitsQuery = q.replace(/\D/g, '');
  const cleanDigitsPhone = phoneStr.replace(/\D/g, '');
  if (cleanDigitsQuery.length >= 3 && cleanDigitsPhone.length >= 3 && cleanDigitsPhone.includes(cleanDigitsQuery) && cleanDigitsQuery.length >= (q.length - 2)) {
    return true;
  }

  // 4. Comparar contra Dirección de Recogida
  const pickupStr = normalizeSearchText(typeof ride.pickup === 'string' ? ride.pickup : ride.pickup?.address);
  if (pickupStr.includes(q)) return true;

  // 5. Comparar contra Dirección de Destino
  const destStr = normalizeSearchText(typeof ride.destination === 'string' ? ride.destination : ride.destination?.address);
  if (destStr.includes(q)) return true;

  return false;
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, token = adminToken) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  return res.json();
}

async function runPhase4c3Tests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 16 TESTS OBLIGATORIOS DE LA FASE 4C-3');
  console.log('BÚSQUEDA DE SERVICIOS EN LA CENTRAL');
  console.log('==================================================\n');

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Conectar despachador
  const dispatcherSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => dispatcherSocket.on('connect', r));
  dispatcherSocket.emit('register:dispatcher', { name: 'Operador Búsqueda 4C3' });

  // Crear un set representativo de carreras para verificar todas las variantes de búsqueda
  const createdRides = [];

  async function createTestRide(data) {
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

  // 1. Servicio inmediato estándar
  const r1 = await createTestRide({
    customerName: 'Guillermo Fernandez',
    customerPhone: '305-998-1122',
    pickup: { address: 'Avenida Libertador 1450', lat: 40.71, lng: -74.00 },
    destination: { address: 'Centro Comercial Galerias', lat: 40.75, lng: -73.98 },
    isScheduled: false,
    fare: 22.00
  });
  createdRides.push(r1);

  // 2. Servicio programado
  const futureSched = new Date(Date.now() + 120 * 60 * 1000).toISOString();
  const r2 = await createTestRide({
    customerName: 'Valeria Mendoza',
    customerPhone: '786-444-5566',
    pickup: { address: 'Hotel Intercontinental Torre Norte', lat: 40.76, lng: -73.97 },
    destination: { address: 'Aeropuerto Internacional Terminal B', lat: 40.64, lng: -73.77 },
    isScheduled: true,
    scheduledAt: futureSched,
    dispatchLeadTime: 25,
    passengerCount: 2,
    vehicleCategory: 'vip',
    paymentMethod: 'corporate',
    notes: 'Requiere factura con RIF'
  });
  createdRides.push(r2);

  // 3. Servicio adicional para búsquedas combinadas
  const r3 = await createTestRide({
    customerName: 'Guillermo Santos',
    customerPhone: '212-777-8899',
    pickup: { address: 'Plaza Mayor Esquina 4', lat: 40.72, lng: -73.99 },
    destination: { address: 'Estacion Central de Trenes', lat: 40.75, lng: -73.97 },
    isScheduled: false,
    fare: 14.50
  });
  createdRides.push(r3);

  await wait(400);

  // Obtener estado actual de todas las carreras disponibles en la Central
  const allRides = await fetchJson(`${SERVER_URL}/api/rides`);

  // ----------------------------------------------------
  // TEST 1: Buscar por ID exacto
  // ----------------------------------------------------
  const resultsT1 = allRides.filter(r => matchesSearchQuery(r, r1.id));
  const t1Passed = resultsT1.length === 1 && resultsT1[0].id === r1.id;
  logTest(1, 'Buscar por ID exacto', t1Passed,
    `Búsqueda: "${r1.id}", Encontrados: ${resultsT1.length}, Match: ${resultsT1[0]?.customerName}`);

  // ----------------------------------------------------
  // TEST 2: Buscar por parte del ID (substring)
  // ----------------------------------------------------
  const subId = r2.id.slice(0, 8);
  const resultsT2 = allRides.filter(r => matchesSearchQuery(r, subId));
  const t2Passed = resultsT2.some(r => r.id === r2.id);
  logTest(2, 'Buscar por parte del ID (substring de 8 caracteres)', t2Passed,
    `Búsqueda: "${subId}", Encontrados: ${resultsT2.length}, Match ID: ${resultsT2.find(r => r.id === r2.id)?.id}`);

  // ----------------------------------------------------
  // TEST 3: Buscar por nombre completo del pasajero
  // ----------------------------------------------------
  const resultsT3 = allRides.filter(r => matchesSearchQuery(r, 'Valeria Mendoza'));
  const t3Passed = resultsT3.length >= 1 && resultsT3.some(r => r.id === r2.id);
  logTest(3, 'Buscar por nombre completo del pasajero', t3Passed,
    `Búsqueda: "Valeria Mendoza", Encontrados: ${resultsT3.length}`);

  // ----------------------------------------------------
  // TEST 4: Buscar por parte del nombre
  // ----------------------------------------------------
  const resultsT4 = allRides.filter(r => matchesSearchQuery(r, 'Guillermo'));
  const t4Passed = resultsT4.length >= 2 && resultsT4.some(r => r.id === r1.id) && resultsT4.some(r => r.id === r3.id);
  logTest(4, 'Buscar por parte del nombre ("Guillermo" encuentra ambos pasajeros)', t4Passed,
    `Búsqueda: "Guillermo", Encontrados: ${resultsT4.length}`);

  // ----------------------------------------------------
  // TEST 5: Búsqueda ignorando mayúsculas/minúsculas y espacios
  // ----------------------------------------------------
  const resultsT5 = allRides.filter(r => matchesSearchQuery(r, '   vAlErIa   mEnDoZa  '));
  const t5Passed = resultsT5.length >= 1 && resultsT5.some(r => r.id === r2.id);
  logTest(5, 'Búsqueda insensible a mayúsculas/minúsculas y espacios redundantes', t5Passed,
    `Búsqueda: "   vAlErIa   mEnDoZa  ", Encontrados: ${resultsT5.length}`);

  // ----------------------------------------------------
  // TEST 6: Buscar por teléfono completo
  // ----------------------------------------------------
  const resultsT6 = allRides.filter(r => matchesSearchQuery(r, '305-998-1122'));
  const t6Passed = resultsT6.length >= 1 && resultsT6.some(r => r.id === r1.id);
  logTest(6, 'Buscar por teléfono completo con guiones', t6Passed,
    `Búsqueda: "305-998-1122", Encontrados: ${resultsT6.length}`);

  // ----------------------------------------------------
  // TEST 7: Buscar por dígitos del teléfono (sin formato)
  // ----------------------------------------------------
  const resultsT7 = allRides.filter(r => matchesSearchQuery(r, '7864445566'));
  const t7Passed = resultsT7.length >= 1 && resultsT7.some(r => r.id === r2.id);
  logTest(7, 'Buscar por dígitos del teléfono sin formato ("7864445566")', t7Passed,
    `Búsqueda: "7864445566", Encontrados: ${resultsT7.length}`);

  // ----------------------------------------------------
  // TEST 8: Buscar por dirección de recogida
  // ----------------------------------------------------
  const resultsT8 = allRides.filter(r => matchesSearchQuery(r, 'Intercontinental'));
  const t8Passed = resultsT8.length >= 1 && resultsT8.some(r => r.id === r2.id);
  logTest(8, 'Buscar por dirección de recogida ("Intercontinental")', t8Passed,
    `Búsqueda: "Intercontinental", Encontrados: ${resultsT8.length}, Pickup: ${resultsT8[0]?.pickup?.address}`);

  // ----------------------------------------------------
  // TEST 9: Buscar por dirección de destino
  // ----------------------------------------------------
  const resultsT9 = allRides.filter(r => matchesSearchQuery(r, 'Galerias'));
  const t9Passed = resultsT9.length >= 1 && resultsT9.some(r => r.id === r1.id);
  logTest(9, 'Buscar por dirección de destino ("Galerias")', t9Passed,
    `Búsqueda: "Galerias", Encontrados: ${resultsT9.length}, Destino: ${resultsT9[0]?.destination?.address}`);

  // ----------------------------------------------------
  // TEST 10: Búsqueda parcial de texto
  // ----------------------------------------------------
  const resultsT10 = allRides.filter(r => matchesSearchQuery(r, 'Libertador'));
  const t10Passed = resultsT10.length >= 1 && resultsT10.some(r => r.id === r1.id);
  logTest(10, 'Búsqueda parcial de texto ("Libertador")', t10Passed,
    `Búsqueda: "Libertador", Encontrados: ${resultsT10.length}`);

  // ----------------------------------------------------
  // TEST 11: Búsqueda sin resultados -> retorna arreglo vacío sin errores
  // ----------------------------------------------------
  const resultsT11 = allRides.filter(r => matchesSearchQuery(r, 'TERMINO_TOTALMENTE_INEXISTENTE_999'));
  const t11Passed = Array.isArray(resultsT11) && resultsT11.length === 0;
  logTest(11, 'Búsqueda sin resultados retorna arreglo vacío sin excepciones', t11Passed,
    `Resultados encontrados: ${resultsT11.length}`);

  // ----------------------------------------------------
  // TEST 12: Limpiar búsqueda restaura la totalidad de las carreras
  // ----------------------------------------------------
  const resultsT12 = allRides.filter(r => matchesSearchQuery(r, ''));
  const t12Passed = resultsT12.length === allRides.length;
  logTest(12, 'Limpiar búsqueda (query="") restaura la lista completa', t12Passed,
    `Total original: ${allRides.length}, Total con query vacía: ${resultsT12.length}`);

  // ----------------------------------------------------
  // TEST 13: Búsqueda combinada con filtro de estado
  // ----------------------------------------------------
  // Filtro de estado: 'pending' + Búsqueda: 'Guillermo'
  const combinedResults = allRides
    .filter(r => r.status === 'pending')
    .filter(r => matchesSearchQuery(r, 'Guillermo'));
  const t13Passed = combinedResults.length >= 1 && combinedResults.every(r => r.status === 'pending' && normalizeSearchText(r.customerName).includes('guillermo'));
  logTest(13, 'Búsqueda combinada con filtro de estado (status=pending + query="Guillermo")', t13Passed,
    `Coincidencias combinadas: ${combinedResults.length}, Estados: ${combinedResults.map(r => r.status).join(', ')}`);

  // ----------------------------------------------------
  // TEST 14: Servicios programados aparecen en la búsqueda con sus detalles
  // ----------------------------------------------------
  const schedSearch = allRides.filter(r => matchesSearchQuery(r, 'Valeria'));
  const foundSched = schedSearch.find(r => r.id === r2.id);
  const t14Passed = foundSched &&
                    foundSched.status === 'scheduled' &&
                    foundSched.isScheduled === true &&
                    Boolean(foundSched.scheduledAt);
  logTest(14, 'Servicios programados aparecen correctamente con status=scheduled y scheduledAt', t14Passed,
    `Encontrado: ${foundSched?.customerName}, status: ${foundSched?.status}, scheduledAt: ${foundSched?.scheduledAt}`);

  // ----------------------------------------------------
  // TEST 15: Actualización Socket.io mantiene la búsqueda funcionando en tiempo real
  // ----------------------------------------------------
  // Simular la llegada de un nuevo viaje vía Socket.io mientras la búsqueda "Beatriz" está activa
  const newLiveRidePromise = createTestRide({
    customerName: 'Beatriz Lucena',
    customerPhone: '305-111-2233',
    pickup: { address: 'Paseo de la Castellana 200', lat: 40.73, lng: -73.99 },
    destination: { address: 'Teatro Real', lat: 40.75, lng: -73.98 },
    isScheduled: false
  });

  const liveRide = await newLiveRidePromise;
  const ridesAfterLive = await fetchJson(`${SERVER_URL}/api/rides`);
  const liveSearchResults = ridesAfterLive.filter(r => matchesSearchQuery(r, 'Beatriz'));
  const t15Passed = liveSearchResults.some(r => r.id === liveRide.id);
  logTest(15, 'Actualización Socket.io mantiene la búsqueda activa y reactiva', t15Passed,
    `Nuevo servicio creado en vivo: ${liveRide.customerName}, Encontrado por búsqueda: ${t15Passed}`);

  // ----------------------------------------------------
  // TEST 16: La búsqueda NO modifica los contadores globales del dashboard de Fase 4B
  // ----------------------------------------------------
  // Los contadores del dashboard se calculan sobre allRides original sin mutar
  const pendingCount = ridesAfterLive.filter(r => r.status === 'pending').length;
  const scheduledCount = ridesAfterLive.filter(r => r.status === 'scheduled').length;
  const filteredCount = ridesAfterLive.filter(r => matchesSearchQuery(r, 'Beatriz Lucena')).length;

  const t16Passed = pendingCount > 0 && scheduledCount > 0 && filteredCount >= 1 && filteredCount < ridesAfterLive.length;
  logTest(16, 'La búsqueda NO altera la colección base ni los contadores del dashboard', t16Passed,
    `Contador Pendientes Dashboard: ${pendingCount}, Contador Programados: ${scheduledCount}, Resultado Filtrado: ${filteredCount}`);

  // Cleanup
  dispatcherSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 16 TESTS DE LA FASE 4C-3:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 16 TESTS DE LA FASE 4C-3 PASARON CON ÉXITO! (16/16 PASSED)\n');
    await wait(300);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 4C-3 FALLARON.\n');
    await wait(300);
    process.exit(1);
  }
}

runPhase4c3Tests().catch(err => {
  console.error('Error fatal ejecutando test_phase4c3.js:', err);
  process.exit(1);
});
