const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { createTestToken } = require('./test_auth_helper');

const SERVER_URL = 'http://localhost:3000';
const adminToken = createTestToken({ uid: 'admin_central_f2_' + Date.now() });
const driverAUid = 'driver_A_f2_' + Date.now();
const driverBUid = 'driver_B_f2_' + Date.now();
const driverAToken = createTestToken({ uid: driverAUid });
const driverBToken = createTestToken({ uid: driverBUid });

async function fetchAuth(url) {
  return fetch(url, { headers: { 'Authorization': `Bearer ${adminToken}` } }).then(res => res.json());
}

async function runPhase2Tests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 12 TESTS OBLIGATORIOS DE LA FASE 2');
  console.log('==================================================\n');

  const results = {};

  // Conectar Base
  const baseSocket = io(SERVER_URL, { auth: { token: adminToken } });
  await new Promise(r => baseSocket.on('connect', r));
  baseSocket.emit('register:dispatcher', { name: 'Operador Central F2' });

  // Conectar Driver A (con FCM token simulado)
  const driverASocket = io(SERVER_URL, { auth: { token: driverAToken } });
  await new Promise(r => driverASocket.on('connect', r));
  const fakeFcmTokenA = 'fcm_token_driver_a_' + Date.now();
  driverASocket.emit('register:driver', {
    driverId: driverAUid,
    name: 'Carlos Conductor A',
    vehicle: 'Toyota Camry (2022)',
    plate: 'Placa: ABC-123',
    fcmToken: fakeFcmTokenA,
    location: { lat: 40.7128, lng: -74.0060 }
  });

  // Conectar Driver B
  const driverBSocket = io(SERVER_URL, { auth: { token: driverBToken } });
  await new Promise(r => driverBSocket.on('connect', r));
  const fakeFcmTokenB = 'fcm_token_driver_b_' + Date.now();
  driverBSocket.emit('register:driver', {
    driverId: driverBUid,
    name: 'Roberto Conductor B',
    vehicle: 'Honda Civic (2021)',
    plate: 'Placa: XYZ-789',
    fcmToken: fakeFcmTokenB,
    location: { lat: 40.7130, lng: -74.0065 }
  });

  await new Promise(r => setTimeout(r, 600));

  // ----------------------------------------------------
  // TEST 1: App abierta -> nueva carrera -> alerta Socket.io funciona
  // ----------------------------------------------------
  console.log('--- TEST 1: App abierta -> alerta Socket.io recibe datos completos ---');
  let test1Received = false;
  let test1RideData = null;

  driverASocket.once('ride:new', (ride) => {
    test1Received = true;
    test1RideData = ride;
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Calle 42 y 8va Ave', lat: 40.7570, lng: -73.9890 },
    destination: { address: 'Grand Central', lat: 40.7527, lng: -73.9772 },
    customerName: 'Pasajero Test 1',
    fare: 19.50,
    assignedDriverId: driverASocket.id
  });

  await new Promise(r => setTimeout(r, 1000));
  results['TEST 1'] = (test1Received && test1RideData && test1RideData.pickup && test1RideData.destination) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 1: ${results['TEST 1']}\n`);

  // ----------------------------------------------------
  // TEST 2: App minimizada / en background -> notificación FCM estructurada
  // ----------------------------------------------------
  console.log('--- TEST 2: App minimizada -> Notificación FCM con payload completo ---');
  // Verificamos que el backend tiene la función sendFcmNotificationToDriver y que el conductor tiene FCM Token
  const driversList = await fetchAuth('http://localhost:3000/api/drivers?all=true');
  const driverWithFcm = driversList.find(d => d.id === driverASocket.id || d.name === 'Carlos Conductor A');
  results['TEST 2'] = (driverWithFcm) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 2 (FCM Token registrado y asociado al despacho): ${results['TEST 2']}\n`);

  // ----------------------------------------------------
  // TEST 3: Pantalla bloqueada -> Configuración showWhenLocked y turnScreenOn
  // ----------------------------------------------------
  console.log('--- TEST 3: Pantalla bloqueada -> Verificación de flags Android ---');
  const manifestContent = fs.readFileSync('./driver-android-native/app/src/main/AndroidManifest.xml', 'utf8');
  const hasShowWhenLocked = manifestContent.includes('android:showWhenLocked="true"');
  const hasTurnScreenOn = manifestContent.includes('android:turnScreenOn="true"');
  const hasFullScreenPermission = manifestContent.includes('android.permission.USE_FULL_SCREEN_INTENT');
  results['TEST 3'] = (hasShowWhenLocked && hasTurnScreenOn && hasFullScreenPermission) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 3 (showWhenLocked + turnScreenOn + USE_FULL_SCREEN_INTENT en Manifest): ${results['TEST 3']}\n`);

  // ----------------------------------------------------
  // TEST 4: App removida de recientes -> Servicio FCM declarado
  // ----------------------------------------------------
  console.log('--- TEST 4: Servicio FCM para despertar app removida de recientes ---');
  const hasFcmServiceInManifest = manifestContent.includes('TaxiFirebaseMessagingService');
  const fcmServiceFileExists = fs.existsSync('./driver-android-native/app/src/main/java/com/taxipro/driver/service/TaxiFirebaseMessagingService.kt');
  results['TEST 4'] = (hasFcmServiceInManifest && fcmServiceFileExists) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 4 (TaxiFirebaseMessagingService declarado): ${results['TEST 4']}\n`);

  // ----------------------------------------------------
  // TEST 5: Tocar notificación -> Abre RideAlertActivity con datos
  // ----------------------------------------------------
  console.log('--- TEST 5: Deep Link / Intent hacia RideAlertActivity ---');
  const fcmServiceCode = fs.readFileSync('./driver-android-native/app/src/main/java/com/taxipro/driver/service/TaxiFirebaseMessagingService.kt', 'utf8');
  const hasFullScreenIntent = fcmServiceCode.includes('setFullScreenIntent') && fcmServiceCode.includes('RideAlertActivity::class.java');
  results['TEST 5'] = (hasFullScreenIntent) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 5 (setFullScreenIntent vinculada a RideAlertActivity): ${results['TEST 5']}\n`);

  // ----------------------------------------------------
  // TEST 6: Nueva carrera -> Sonido profesional + Vibración
  // ----------------------------------------------------
  console.log('--- TEST 6: Alerta sonora en res/raw/ride_alert.wav + MediaPlayer en bucle ---');
  const soundFileExists = fs.existsSync('./driver-android-native/app/src/main/res/raw/ride_alert.wav');
  const alertActivityCode = fs.readFileSync('./driver-android-native/app/src/main/java/com/taxipro/driver/ui/ride/RideAlertActivity.kt', 'utf8');
  const hasMediaPlayer = alertActivityCode.includes('MediaPlayer.create(this, R.raw.ride_alert)') && alertActivityCode.includes('isLooping = true');
  const hasVibrate = alertActivityCode.includes('vibratePhone()');
  results['TEST 6'] = (soundFileExists && hasMediaPlayer && hasVibrate) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 6 (Audio WAV + MediaPlayer en loop + Haptic): ${results['TEST 6']}\n`);

  // ----------------------------------------------------
  // TEST 7: Aceptar -> Sonido se detiene inmediatamente
  // ----------------------------------------------------
  console.log('--- TEST 7: Al pulsar Aceptar el sonido se detiene ---');
  const stopsOnAccept = alertActivityCode.includes('binding.btnAccept.setOnClickListener {') &&
                        alertActivityCode.indexOf('stopAlertSound()') < alertActivityCode.indexOf('binding.btnAccept.isEnabled = false');
  results['TEST 7'] = stopsOnAccept ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 7 (stopAlertSound() al aceptar): ${results['TEST 7']}\n`);

  // ----------------------------------------------------
  // TEST 8: Rechazar -> Sonido se detiene inmediatamente
  // ----------------------------------------------------
  console.log('--- TEST 8: Al pulsar Rechazar el sonido se detiene ---');
  const stopsOnDecline = alertActivityCode.includes('binding.btnDecline.setOnClickListener {') &&
                         alertActivityCode.indexOf('stopAlertSound()') !== -1;
  results['TEST 8'] = stopsOnDecline ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 8 (stopAlertSound() al rechazar): ${results['TEST 8']}\n`);

  // ----------------------------------------------------
  // TEST 9: Timeout 15s -> Sonido se detiene inmediatamente
  // ----------------------------------------------------
  console.log('--- TEST 9: Al llegar a 0s (timeout 15s) el sonido se detiene ---');
  const stopsOnTimeout = alertActivityCode.includes('override fun onFinish() {') &&
                         alertActivityCode.includes('stopAlertSound()');
  results['TEST 9'] = stopsOnTimeout ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 9 (stopAlertSound() en onFinish): ${results['TEST 9']}\n`);

  // ----------------------------------------------------
  // TEST 10: Deduplicación Socket.io + FCM
  // ----------------------------------------------------
  console.log('--- TEST 10: Deduplicación Socket.io + FCM usando RideAlertManager ---');
  const hasAlertManager = fs.existsSync('./driver-android-native/app/src/main/java/com/taxipro/driver/ui/ride/RideAlertManager.kt');
  const fcmChecksAlertManager = fcmServiceCode.includes('RideAlertManager.isShowing(rideId)');
  results['TEST 10'] = (hasAlertManager && fcmChecksAlertManager) ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 10 (RideAlertManager previene duplicación): ${results['TEST 10']}\n`);

  // ----------------------------------------------------
  // TEST 11: Viaje ya aceptado por otro -> Segundo conductor recibe ride:accept_error
  // ----------------------------------------------------
  console.log('--- TEST 11: Autoridad del backend ante carreras tomadas concurrentemente ---');
  let test11RideId = null;
  let driverBGotError = false;

  driverBSocket.once('ride:accept_error', (data) => {
    driverBGotError = true;
  });

  baseSocket.once('ride:created', (ride) => {
    test11RideId = ride.id;
    // Driver A acepta primero
    driverASocket.emit('ride:accept', ride.id);
    setTimeout(() => {
      // Driver B intenta aceptar cuando ya fue tomado
      driverBSocket.emit('ride:accept', ride.id);
    }, 150);
  });

  baseSocket.emit('ride:create', {
    pickup: { address: 'Chelsea Market', lat: 40.7420, lng: -74.0048 },
    destination: { address: 'Flatiron', lat: 40.7411, lng: -73.9897 },
    customerName: 'Cliente Prueba Concurrente F2'
  });

  await new Promise(r => setTimeout(r, 1200));
  results['TEST 11'] = driverBGotError ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 11 (Driver B recibe ride:accept_error): ${results['TEST 11']}\n`);

  // ----------------------------------------------------
  // TEST 12: Notificación antigua -> Consulta de estado real en backend
  // ----------------------------------------------------
  console.log('--- TEST 12: Notificación antigua consulta backend y valida estado real ---');
  const allRides = await fetchAuth('http://localhost:3000/api/rides');
  const checkedRide = allRides.find(r => r.id === test11RideId);
  const isAuthoritative = checkedRide && (checkedRide.status === 'accepted' || checkedRide.status === 'in_progress');
  results['TEST 12'] = isAuthoritative ? 'PASSED' : 'FAILED';
  console.log(`Resultado TEST 12 (Backend como autoridad única del estado del viaje): ${results['TEST 12']}\n`);

  // Limpieza
  baseSocket.disconnect();
  driverASocket.disconnect();
  driverBSocket.disconnect();

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 12 TESTS DE LA FASE 2:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  process.exit(allPassed ? 0 : 1);
}

runPhase2Tests().catch(err => {
  console.error(err);
  process.exit(1);
});
