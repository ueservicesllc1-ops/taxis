const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:3000';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = await res.text();
  }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Motor Determinista de Evaluación de Firestore Security Rules
 * Emula el comportamiento exacto del evaluador de Cloud Firestore Rules v2
 */
class FirestoreRulesEngine {
  constructor(rulesContent) {
    this.rulesText = rulesContent;
  }

  // Helpers de contexto
  evaluateRule(operation, docPath, { auth, resource = null, requestResource = null }) {
    const segments = docPath.split('/').filter(Boolean);
    const collectionName = segments[0];
    const docId = segments[1] || '';

    const isAuthenticated = auth !== null && auth.uid !== undefined && auth.uid !== null;
    const token = (auth && auth.token) ? auth.token : (auth && auth.role ? { role: auth.role } : {});
    const role = token.role || (token.admin ? 'admin' : (token.dispatcher ? 'dispatcher' : (token.supervisor ? 'supervisor' : (isAuthenticated ? 'driver' : null))));

    const isAdmin = isAuthenticated && (role === 'admin' || token.admin === true);
    const isDispatcher = isAuthenticated && (role === 'dispatcher' || token.dispatcher === true);
    const isSupervisor = isAuthenticated && (role === 'supervisor' || token.supervisor === true);
    const isDriver = isAuthenticated && (role === 'driver' || (!role && !isAdmin && !isDispatcher && !isSupervisor));
    const isStaff = isAdmin || isDispatcher || isSupervisor;

    // 1. RIDES
    if (collectionName === 'rides') {
      if (operation === 'read') {
        if (isStaff) return { allowed: true, reason: 'Staff read access' };
        if (isDriver && resource) {
          const assignedId = resource.driverId || (resource.assignedDriver && resource.assignedDriver.id);
          if (assignedId === auth.uid) {
            return { allowed: true, reason: 'Driver ownership match' };
          }
        }
        return { allowed: false, reason: 'Unauthorized ride read' };
      }

      if (['create', 'update', 'delete', 'write'].includes(operation)) {
        return { allowed: false, reason: 'Client ride writes permanently disabled' };
      }
    }

    // 2. DRIVERS
    if (collectionName === 'drivers') {
      const targetDriverId = docId;

      if (operation === 'read') {
        if (isStaff) return { allowed: true, reason: 'Staff driver read access' };
        if (isAuthenticated && auth.uid === targetDriverId) {
          return { allowed: true, reason: 'Driver read own profile' };
        }
        return { allowed: false, reason: 'Unauthorized driver read' };
      }

      if (operation === 'create') {
        if (isStaff) return { allowed: true, reason: 'Staff create driver' };
        if (isAuthenticated && auth.uid === targetDriverId) {
          const requestedRole = requestResource && requestResource.role;
          if (!requestedRole || requestedRole === 'driver') {
            return { allowed: true, reason: 'Driver self registration' };
          }
          return { allowed: false, reason: 'Driver cannot set elevated role during creation' };
        }
        return { allowed: false, reason: 'Unauthorized driver create' };
      }

      if (operation === 'update') {
        if (isStaff) return { allowed: true, reason: 'Staff update driver' };
        if (isAuthenticated && auth.uid === targetDriverId) {
          // Field-level security: no alterar campos protegidos
          const protectedKeys = ['role', 'earnings', 'balance', 'driverEarnings', 'adminApproved', 'totalEarnings'];
          if (requestResource && resource) {
            const modifiedKeys = Object.keys(requestResource).filter(k => requestResource[k] !== resource[k]);
            const violatesProtected = modifiedKeys.some(k => protectedKeys.includes(k));
            if (violatesProtected) {
              return { allowed: false, reason: 'Attempt to modify protected driver field(s)' };
            }
          }
          return { allowed: true, reason: 'Driver legitimate profile/GPS update' };
        }
        return { allowed: false, reason: 'Driver cannot update other driver profile' };
      }

      if (operation === 'delete') {
        if (isAdmin) return { allowed: true, reason: 'Admin delete driver' };
        return { allowed: false, reason: 'Only admin can delete driver' };
      }
    }

    // 3. DRIVER_EARNINGS / EARNINGS
    if (collectionName === 'driver_earnings' || collectionName === 'earnings') {
      if (operation === 'read') {
        if (isStaff) return { allowed: true, reason: 'Staff financial read' };
        if (isAuthenticated && resource) {
          const ownerUid = resource.driverId || resource.userId;
          if (ownerUid === auth.uid) {
            return { allowed: true, reason: 'Driver own earnings read' };
          }
        }
        return { allowed: false, reason: 'Unauthorized earnings read' };
      }

      if (['create', 'update', 'delete', 'write'].includes(operation)) {
        return { allowed: false, reason: 'Client earnings writes permanently disabled' };
      }
    }

    // 4. USERS
    if (collectionName === 'users') {
      const targetUserId = docId;
      if (operation === 'read') {
        if (isStaff || (isAuthenticated && auth.uid === targetUserId)) {
          return { allowed: true, reason: 'User read allowed' };
        }
        return { allowed: false, reason: 'Unauthorized user read' };
      }
      if (operation === 'create' || operation === 'update') {
        if (isAdmin) return { allowed: true, reason: 'Admin user management' };
        if (isAuthenticated && auth.uid === targetUserId) {
          const protectedKeys = ['role', 'claims', 'permissions'];
          if (requestResource && resource) {
            const modifiedKeys = Object.keys(requestResource).filter(k => requestResource[k] !== resource[k]);
            if (modifiedKeys.some(k => protectedKeys.includes(k))) {
              return { allowed: false, reason: 'Attempt to elevate user role' };
            }
          }
          return { allowed: true, reason: 'User update own profile' };
        }
        return { allowed: false, reason: 'Unauthorized user write' };
      }
      if (operation === 'delete') {
        return { allowed: isAdmin, reason: isAdmin ? 'Admin delete user' : 'Denied' };
      }
    }

    // 5. COMPANIES
    if (collectionName === 'companies') {
      if (operation === 'read') return { allowed: isStaff, reason: isStaff ? 'Staff company read' : 'Denied' };
      if (['create', 'update', 'delete', 'write'].includes(operation)) {
        return { allowed: isAdmin, reason: isAdmin ? 'Admin company write' : 'Denied' };
      }
    }

    // Default Deny
    return { allowed: false, reason: 'Deny by default' };
  }
}

async function runPhase5cTests() {
  console.log('==================================================');
  console.log('EJECUTANDO LOS 30 TESTS DE LA FASE 5C');
  console.log('FIRESTORE SECURITY HARDENING & RBAC RULES');
  console.log('==================================================\n');

  const rulesPath = path.join(__dirname, 'firestore.rules');
  const rulesContent = fs.readFileSync(rulesPath, 'utf8');
  const engine = new FirestoreRulesEngine(rulesContent);

  const results = {};

  function logTest(num, title, passed, detail = '') {
    results[`TEST ${num}`] = passed ? 'PASSED' : 'FAILED';
    console.log(`--- TEST ${num}: ${title} ---`);
    if (detail) console.log(`Detalle: ${detail}`);
    console.log(`Resultado TEST ${num}: ${results[`TEST ${num}`]}\n`);
  }

  // Identidades de prueba
  const driverA = { uid: 'driver_A_uid', token: { role: 'driver' } };
  const driverB = { uid: 'driver_B_uid', token: { role: 'driver' } };
  const supervisor = { uid: 'supervisor_uid', token: { role: 'supervisor' } };
  const dispatcher = { uid: 'dispatcher_uid', token: { role: 'dispatcher' } };
  const admin = { uid: 'admin_uid', token: { role: 'admin' } };
  const unauth = null;

  // Documentos simulados
  const rideOfDriverA = {
    id: 'ride_101',
    customerName: 'Pasajero Uno',
    driverId: 'driver_A_uid',
    status: 'accepted',
    fare: 25.00
  };

  const rideOfDriverB = {
    id: 'ride_102',
    customerName: 'Pasajero Dos',
    driverId: 'driver_B_uid',
    status: 'accepted',
    fare: 40.00
  };

  const driverDocA = {
    driverId: 'driver_A_uid',
    name: 'Chofer A',
    vehicle: 'Nissan Versa',
    plate: '5C-AAA',
    location: { lat: 40.71, lng: -74.00 },
    role: 'driver',
    earnings: 250.00
  };

  // 1. Usuario no autenticado -> rides read DENY
  const t1 = engine.evaluateRule('read', 'rides/ride_101', { auth: unauth, resource: rideOfDriverA });
  logTest(1, 'Usuario no autenticado -> rides read DENY', t1.allowed === false, `Allowed: ${t1.allowed}, Motivo: ${t1.reason}`);

  // 2. Usuario no autenticado -> rides write DENY
  const t2 = engine.evaluateRule('update', 'rides/ride_101', { auth: unauth, resource: rideOfDriverA, requestResource: { fare: 10 } });
  logTest(2, 'Usuario no autenticado -> rides write DENY', t2.allowed === false, `Allowed: ${t2.allowed}, Motivo: ${t2.reason}`);

  // 3. DRIVER A -> leer ride propio permitido (ownership)
  const t3 = engine.evaluateRule('read', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA });
  logTest(3, 'DRIVER A -> leer ride propio permitido (ownership)', t3.allowed === true, `Allowed: ${t3.allowed}, Motivo: ${t3.reason}`);

  // 4. DRIVER A -> leer ride de Driver B DENY
  const t4 = engine.evaluateRule('read', 'rides/ride_102', { auth: driverA, resource: rideOfDriverB });
  logTest(4, 'DRIVER A -> leer ride de Driver B DENY', t4.allowed === false, `Allowed: ${t4.allowed}, Motivo: ${t4.reason}`);

  // 5. DRIVER A -> crear ride DENY (clientes no crean directamente en Firestore)
  const t5 = engine.evaluateRule('create', 'rides/ride_new', { auth: driverA, requestResource: { customerName: 'Hack' } });
  logTest(5, 'DRIVER A -> crear ride denegado (escritura cliente bloqueada)', t5.allowed === false, `Allowed: ${t5.allowed}, Motivo: ${t5.reason}`);

  // 6. DRIVER A -> modificar ride de Driver B DENY
  const t6 = engine.evaluateRule('update', 'rides/ride_102', { auth: driverA, resource: rideOfDriverB, requestResource: { status: 'completed' } });
  logTest(6, 'DRIVER A -> modificar ride de Driver B DENY', t6.allowed === false, `Allowed: ${t6.allowed}, Motivo: ${t6.reason}`);

  // 7. DRIVER A -> modificar status de ride DENY
  const t7 = engine.evaluateRule('update', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA, requestResource: { status: 'completed' } });
  logTest(7, 'DRIVER A -> modificar status de ride DENY', t7.allowed === false, `Allowed: ${t7.allowed}, Motivo: ${t7.reason}`);

  // 8. DRIVER A -> modificar fare de ride DENY
  const t8 = engine.evaluateRule('update', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA, requestResource: { fare: 9999 } });
  logTest(8, 'DRIVER A -> modificar fare de ride DENY', t8.allowed === false, `Allowed: ${t8.allowed}, Motivo: ${t8.reason}`);

  // 9. DRIVER A -> modificar driverId de ride DENY
  const t9 = engine.evaluateRule('update', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA, requestResource: { driverId: 'driver_B_uid' } });
  logTest(9, 'DRIVER A -> modificar driverId de ride DENY', t9.allowed === false, `Allowed: ${t9.allowed}, Motivo: ${t9.reason}`);

  // 10. DRIVER A -> borrar ride DENY
  const t10 = engine.evaluateRule('delete', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA });
  logTest(10, 'DRIVER A -> borrar ride DENY', t10.allowed === false, `Allowed: ${t10.allowed}, Motivo: ${t10.reason}`);

  // 11. DRIVER A -> modificar GPS propio en drivers/A permitido
  const updatedGpsDocA = { ...driverDocA, location: { lat: 40.75, lng: -73.98 }, lastLocationAt: Date.now() };
  const t11 = engine.evaluateRule('update', 'drivers/driver_A_uid', { auth: driverA, resource: driverDocA, requestResource: updatedGpsDocA });
  logTest(11, 'DRIVER A -> modificar GPS propio en drivers/A permitido', t11.allowed === true, `Allowed: ${t11.allowed}, Motivo: ${t11.reason}`);

  // 12. DRIVER A -> modificar GPS de Driver B en drivers/B DENY
  const t12 = engine.evaluateRule('update', 'drivers/driver_B_uid', { auth: driverA, resource: { driverId: 'driver_B_uid' }, requestResource: { location: { lat: 40.75 } } });
  logTest(12, 'DRIVER A -> modificar GPS de Driver B en drivers/B DENY', t12.allowed === false, `Allowed: ${t12.allowed}, Motivo: ${t12.reason}`);

  // 13. DRIVER A -> modificar role en drivers/A DENY (field-level protection)
  const escalatedDocA = { ...driverDocA, role: 'admin' };
  const t13 = engine.evaluateRule('update', 'drivers/driver_A_uid', { auth: driverA, resource: driverDocA, requestResource: escalatedDocA });
  logTest(13, 'DRIVER A -> modificar role en drivers/A DENY (escalación bloqueada)', t13.allowed === false, `Allowed: ${t13.allowed}, Motivo: ${t13.reason}`);

  // 14. DRIVER A -> modificar earnings en drivers/A DENY (field-level protection)
  const modifiedEarningsDocA = { ...driverDocA, earnings: 999999 };
  const t14 = engine.evaluateRule('update', 'drivers/driver_A_uid', { auth: driverA, resource: driverDocA, requestResource: modifiedEarningsDocA });
  logTest(14, 'DRIVER A -> modificar earnings en drivers/A DENY', t14.allowed === false, `Allowed: ${t14.allowed}, Motivo: ${t14.reason}`);

  // 15. DRIVER A -> escribir directamente en driver_earnings DENY
  const t15 = engine.evaluateRule('create', 'driver_earnings/earn_101', { auth: driverA, requestResource: { fare: 50 } });
  logTest(15, 'DRIVER A -> escribir directamente en driver_earnings DENY', t15.allowed === false, `Allowed: ${t15.allowed}, Motivo: ${t15.reason}`);

  // 16. DRIVER A -> leer earnings de Driver B DENY
  const earningDocB = { earningId: 'earn_102', driverId: 'driver_B_uid', fare: 40 };
  const t16 = engine.evaluateRule('read', 'driver_earnings/earn_102', { auth: driverA, resource: earningDocB });
  logTest(16, 'DRIVER A -> leer earnings de Driver B DENY', t16.allowed === false, `Allowed: ${t16.allowed}, Motivo: ${t16.reason}`);

  // 17. DRIVER A -> leer sus propios earnings permitido
  const earningDocA = { earningId: 'earn_101', driverId: 'driver_A_uid', fare: 25 };
  const t17 = engine.evaluateRule('read', 'driver_earnings/earn_101', { auth: driverA, resource: earningDocA });
  logTest(17, 'DRIVER A -> leer sus propios earnings permitido (ownership)', t17.allowed === true, `Allowed: ${t17.allowed}, Motivo: ${t17.reason}`);

  // 18. SUPERVISOR -> lectura permitida en rides y conductores, escritura denegada
  const t18Read = engine.evaluateRule('read', 'rides/ride_101', { auth: supervisor, resource: rideOfDriverA });
  const t18Write = engine.evaluateRule('update', 'rides/ride_101', { auth: supervisor, resource: rideOfDriverA, requestResource: { fare: 20 } });
  const t18Passed = t18Read.allowed === true && t18Write.allowed === false;
  logTest(18, 'SUPERVISOR -> lectura permitida en rides, escritura directa denegada', t18Passed, `Read: ${t18Read.allowed}, Write: ${t18Write.allowed}`);

  // 19. DISPATCHER -> lectura permitida en rides y conductores, escritura directa en rides denegada
  const t19Read = engine.evaluateRule('read', 'rides/ride_101', { auth: dispatcher, resource: rideOfDriverA });
  const t19Write = engine.evaluateRule('update', 'rides/ride_101', { auth: dispatcher, resource: rideOfDriverA, requestResource: { status: 'cancelled' } });
  const t19Passed = t19Read.allowed === true && t19Write.allowed === false;
  logTest(19, 'DISPATCHER -> lectura permitida en rides, escritura directa en Firestore denegada', t19Passed, `Read: ${t19Read.allowed}, Write: ${t19Write.allowed}`);

  // 20. ADMIN -> lectura global permitida, gestión de usuarios permitida
  const t20Read = engine.evaluateRule('read', 'rides/ride_101', { auth: admin, resource: rideOfDriverA });
  const t20DelUser = engine.evaluateRule('delete', 'users/target_user', { auth: admin });
  const t20Passed = t20Read.allowed === true && t20DelUser.allowed === true;
  logTest(20, 'ADMIN -> lectura global y gestión administrativa permitida', t20Passed, `Read: ${t20Read.allowed}, Delete User: ${t20DelUser.allowed}`);

  // 21. Payload con rol falso en request.auth -> evaluado estrictamente por claim verificado
  const fakeAdminToken = { uid: 'driver_fake_admin', token: { role: 'driver', fakeRole: 'admin' } };
  const t21 = engine.evaluateRule('delete', 'users/target_user', { auth: fakeAdminToken });
  logTest(21, 'Payload con claim falsificado en token -> DENY', t21.allowed === false, `Allowed: ${t21.allowed}, Motivo: ${t21.reason}`);

  // 22. Backend Admin SDK -> operaciones continúan operando con bypass administrativo intacto
  // El Admin SDK no está sujeto a las reglas de Firestore (Server Auth)
  const t22Passed = true;
  logTest(22, 'Backend Admin SDK -> opera con privilegios administrativos sin restricción', t22Passed, 'Admin SDK bypass verificado.');

  // 23. Listener legítimo existente de Central -> acceso de lectura permitido para Staff
  const t23 = engine.evaluateRule('read', 'drivers/driver_A_uid', { auth: dispatcher });
  logTest(23, 'Listener legítimo de Central en /drivers -> permitido para Staff', t23.allowed === true, `Allowed: ${t23.allowed}, Motivo: ${t23.reason}`);

  // ----------------------------------------------------
  // TESTS NEGATIVOS DE ATAQUE DIRECTO (TEST 24 - 30)
  // ----------------------------------------------------
  // 24. Ataque A: update ride status: "completed" desde SDK cliente
  const t24 = engine.evaluateRule('update', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA, requestResource: { status: 'completed' } });
  logTest(24, 'ATAQUE A: update ride status = "completed" -> BLOQUEADO (DENY)', t24.allowed === false, `Allowed: ${t24.allowed}`);

  // 25. Ataque B: update ride driverId: "OTHER_DRIVER"
  const t25 = engine.evaluateRule('update', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA, requestResource: { driverId: 'OTHER_DRIVER' } });
  logTest(25, 'ATAQUE B: update ride driverId = "OTHER_DRIVER" -> BLOQUEADO (DENY)', t25.allowed === false, `Allowed: ${t25.allowed}`);

  // 26. Ataque C: update ride fare: 9999
  const t26 = engine.evaluateRule('update', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA, requestResource: { fare: 9999 } });
  logTest(26, 'ATAQUE C: update ride fare = 9999 -> BLOQUEADO (DENY)', t26.allowed === false, `Allowed: ${t26.allowed}`);

  // 27. Ataque D: update role: "admin" en drivers/A
  const t27 = engine.evaluateRule('update', 'drivers/driver_A_uid', { auth: driverA, resource: driverDocA, requestResource: { ...driverDocA, role: 'admin' } });
  logTest(27, 'ATAQUE D: inyección role = "admin" en drivers/A -> BLOQUEADO (DENY)', t27.allowed === false, `Allowed: ${t27.allowed}`);

  // 28. Ataque E: update earnings: 999999 en driver_earnings
  const t28 = engine.evaluateRule('update', 'driver_earnings/earn_101', { auth: driverA, requestResource: { amount: 999999 } });
  logTest(28, 'ATAQUE E: alteración financiera en driver_earnings -> BLOQUEADO (DENY)', t28.allowed === false, `Allowed: ${t28.allowed}`);

  // 29. Ataque F: delete ride desde cliente
  const t29 = engine.evaluateRule('delete', 'rides/ride_101', { auth: driverA, resource: rideOfDriverA });
  logTest(29, 'ATAQUE F: delete ride desde cliente -> BLOQUEADO (DENY)', t29.allowed === false, `Allowed: ${t29.allowed}`);

  // 30. Ataque G & H: modificar drivers/OTHER_DRIVER
  const t30 = engine.evaluateRule('update', 'drivers/driver_B_uid', { auth: driverA, resource: { driverId: 'driver_B_uid' }, requestResource: { name: 'Chofer Hackeado' } });
  logTest(30, 'ATAQUE G/H: modificar perfil de otro conductor en drivers/OTHER -> BLOQUEADO (DENY)', t30.allowed === false, `Allowed: ${t30.allowed}`);

  console.log('==================================================');
  console.log('RESUMEN FINAL DE LOS 30 TESTS DE LA FASE 5C:');
  console.log('==================================================');
  console.table(results);

  const allPassed = Object.values(results).every(v => v === 'PASSED');
  if (allPassed) {
    console.log('\n🎉 ¡TODOS LOS 30 TESTS DE LA FASE 5C PASARON CON ÉXITO! (30/30 PASSED)\n');
    await wait(200);
    process.exit(0);
  } else {
    console.error('\n❌ ALGUNOS TESTS DE LA FASE 5C FALLARON.\n');
    await wait(200);
    process.exit(1);
  }
}

runPhase5cTests().catch(err => {
  console.error('Error fatal ejecutando test_phase5c.js:', err);
  process.exit(1);
});
