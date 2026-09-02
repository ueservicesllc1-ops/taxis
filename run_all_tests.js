const { execSync } = require('child_process');

const testSuites = [
  { name: 'FASE 1: Despacho y Asignación', script: 'test_phase1.js', count: 10 },
  { name: 'FASE 2: Alertas Móviles y FCM', script: 'test_phase2.js', count: 12 },
  { name: 'FASE 3: Wallet e Historial', script: 'test_phase3.js', count: 15 },
  { name: 'FASE 4A: Mapa y Telemetría GPS', script: 'test_phase4a.js', count: 16 },
  { name: 'FASE 4B: Dashboard Operativo', script: 'test_phase4b.js', count: 18 },
  { name: 'FASE 4C-1: Scheduler Programados', script: 'test_phase4c1.js', count: 18 },
  { name: 'FASE 4C-2: Formulario Avanzado', script: 'test_phase4c2.js', count: 18 },
  { name: 'FASE 4C-3: Búsqueda de Servicios', script: 'test_phase4c3.js', count: 16 },
  { name: 'FASE 4C-4: Edición Segura', script: 'test_phase4c4.js', count: 30 },
  { name: 'FASE 5A: Autenticación Firebase Auth', script: 'test_phase5a.js', count: 20 },
  { name: 'FASE 5B: Control de Acceso RBAC', script: 'test_phase5b.js', count: 30 },
  { name: 'FASE 5C: Seguridad Firestore Rules', script: 'test_phase5c.js', count: 30 },
  { name: 'FASE 5D: Hardening y Sockets Móviles', script: 'test_phase5d.js', count: 15 }
];

console.log('================================================================');
console.log('EJECUCIÓN INTEGRAL DE TODAS LAS SUITES DE PRUEBA (FASES 1 A 5D)');
console.log('================================================================\n');

const summary = [];
let totalPassed = 0;
let totalExpected = 0;

for (const suite of testSuites) {
  totalExpected += suite.count;
  console.log(`\n>>> Ejecutando ${suite.name} (${suite.script})...`);
  try {
    const output = execSync(`node ${suite.script}`, { encoding: 'utf8', stdio: 'pipe' });
    console.log(output);
    summary.push({ Suite: suite.name, Archivo: suite.script, Tests: `${suite.count}/${suite.count}`, Estado: 'PASSED' });
    totalPassed += suite.count;
  } catch (err) {
    console.error(`Error ejecutando ${suite.script}:`, err.stdout || err.message);
    summary.push({ Suite: suite.name, Archivo: suite.script, Tests: `0/${suite.count}`, Estado: 'FAILED' });
  }
}

console.log('\n================================================================');
console.log('TABLA RESUMEN GLOBAL DE RESULTADOS:');
console.log('================================================================');
console.table(summary);

console.log(`\nTOTAL GENERAL: ${totalPassed} / ${totalExpected} pruebas superadas.`);

if (totalPassed === totalExpected) {
  console.log('\n🎉 ¡TODAS LAS SUITES DE PRUEBAS PASARON AL 100%! (233/233 PASSED)\n');
  process.exit(0);
} else {
  console.error('\n❌ SE DETECTARON REGRESIONES O FALLOS.\n');
  process.exit(1);
}
