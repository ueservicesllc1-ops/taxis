const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createTestToken } = require('./test_auth_helper');
const { uploadToB2, B2_BUCKET_NAME, B2_ENDPOINT } = require('./server/utils/b2Storage');

const SERVER_URL = 'http://localhost:3000';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runB2StorageTests() {
  console.log('==================================================');
  console.log('🧪 RUNNING SUITE: BACKBLAZE B2 CLOUD STORAGE INTEGRATION');
  console.log('==================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function record(title, passed, detail = '') {
    totalTests++;
    if (passed) {
      passedTests++;
      console.log(`  ✅ PASS: ${title}`);
    } else {
      console.error(`  ❌ FAIL: ${title}`);
      if (detail) console.error(`     Detalle: ${detail}`);
    }
  }

  const driverUid = 'driver_b2_test_' + Date.now();
  const driverToken = createTestToken({ uid: driverUid, role: 'driver' });

  // ----------------------------------------------------
  // TEST 1: uploadToB2 sube directamente a Backblaze B2 S3
  // ----------------------------------------------------
  console.log('--- 1. BACKBLAZE B2 S3 CLIENT ENGINE ---');
  try {
    const testBuffer = Buffer.from('Automated B2 Test Payload ' + Date.now());
    const key = `test_runs/${driverUid}/sample.txt`;
    const b2Url = await uploadToB2(testBuffer, key, 'text/plain');

    const hasExpectedUrl = b2Url.includes(B2_BUCKET_NAME) && b2Url.includes(key);
    record('uploadToB2() genera URL pública en Backblaze B2', hasExpectedUrl, `URL: ${b2Url}`);

    // Verificar descarga HTTP pública
    const fetchRes = await fetch(b2Url);
    record('URL pública de Backblaze B2 responde 200 OK', fetchRes.status === 200, `Status: ${fetchRes.status}`);
  } catch (err) {
    record('uploadToB2() ejecuta con éxito', false, err.message);
  }

  // ----------------------------------------------------
  // TEST 2: Endpoint /api/storage/upload autenticación y validación
  // ----------------------------------------------------
  console.log('\n--- 2. REST API /api/storage/upload ENDPOINT ---');

  // Test 2.1: Petición sin token -> 401
  try {
    const unauthRes = await fetch(`${SERVER_URL}/api/storage/upload`, { method: 'POST' });
    record('Petición sin autenticación es rechazada con 401 Unauthorized', unauthRes.status === 401, `Status: ${unauthRes.status}`);
  } catch (err) {
    record('Petición sin autenticación es rechazada', false, err.message);
  }

  // Test 2.2: Petición con token pero sin archivo -> 400
  try {
    const emptyRes = await fetch(`${SERVER_URL}/api/storage/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${driverToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ category: 'license' })
    });
    record('Petición sin archivo adjunto es rechazada con 400 Bad Request', emptyRes.status === 400, `Status: ${emptyRes.status}`);
  } catch (err) {
    record('Petición sin archivo es rechazada', false, err.message);
  }

  // Test 2.3: Petición multipart válida con archivo -> 200 OK y URL B2
  try {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const fileContent = 'Fake License Photo Binary Content ' + Date.now();
    
    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="category"\r\n\r\n`;
    body += `license\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="driver-license.jpg"\r\n`;
    body += `Content-Type: image/jpeg\r\n\r\n`;
    body += fileContent + `\r\n`;
    body += `--${boundary}--\r\n`;

    const uploadRes = await fetch(`${SERVER_URL}/api/storage/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${driverToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: Buffer.from(body, 'utf-8')
    });

    const uploadData = await uploadRes.json();
    const uploadOk = uploadRes.status === 200 && uploadData.success === true && uploadData.url.includes(B2_BUCKET_NAME);
    record('Subida multipart a /api/storage/upload exitosa (200 OK y URL B2)', uploadOk, `Status: ${uploadRes.status}, URL: ${uploadData.url}`);
  } catch (err) {
    record('Subida multipart exitosa', false, err.message);
  }

  // ----------------------------------------------------
  // TEST 3: Verificación de Desacoplamiento de Firebase Storage
  // ----------------------------------------------------
  console.log('\n--- 3. FIREBASE STORAGE DECOUPLING AUDIT ---');

  const androidRegKt = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/src/main/java/com/taxipro/driver/ui/auth/DriverRegistrationActivity.kt'), 'utf8');
  const androidBuildGradle = fs.readFileSync(path.join(__dirname, 'driver-android-native/app/build.gradle.kts'), 'utf8');
  const webDriverJs = fs.readFileSync(path.join(__dirname, 'public/driver/js/driver.js'), 'utf8');
  const webFirebaseConfig = fs.readFileSync(path.join(__dirname, 'public/config/firebase.js'), 'utf8');

  record('DriverRegistrationActivity.kt ya no contiene FirebaseStorage', !androidRegKt.includes('FirebaseStorage'), 'Verificado en Kotlin');
  record('DriverRegistrationActivity.kt implementa subida multipart a B2', androidRegKt.includes('uploadFileToB2Endpoint') && androidRegKt.includes('/api/storage/upload'), 'Verificado en Kotlin');
  record('build.gradle.kts ya no incluye dependencia firebase-storage-ktx', !androidBuildGradle.includes('firebase-storage-ktx'), 'Verificado en Gradle');
  record('driver.js (Web) utiliza endpoint /api/storage/upload de B2', webDriverJs.includes('/api/storage/upload') && !webDriverJs.includes('firebase-storage'), 'Verificado en Web JS');
  record('firebase.js ya no inicializa ni exporta getStorage', !webFirebaseConfig.includes('getStorage') && !webFirebaseConfig.includes('storageBucket'), 'Verificado en Firebase Config');

  console.log('\n==================================================');
  console.log(`FASE B2 STORAGE RESULTS: ${passedTests} / ${totalTests} PASSED`);
  if (passedTests === totalTests) {
    console.log('🎉 ALL BACKBLAZE B2 TESTS PASSED PERFECTLY (100%)\n');
    process.exit(0);
  } else {
    console.error('❌ SOME B2 STORAGE TESTS FAILED\n');
    process.exit(1);
  }
}

runB2StorageTests().catch(err => {
  console.error('Fatal error running B2 storage tests:', err);
  process.exit(1);
});
