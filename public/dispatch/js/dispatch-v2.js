import { db, auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged, collection, query, where, onSnapshot, doc, updateDoc } from '../../config/firebase.js';

// Conexión Socket.io autenticada (FASE 5A)
export let socket = null;

// Helper para obtener ID Token actual o refrescado de Firebase Auth (FASE 5A)
export async function getAuthToken(forceRefresh = false) {
    try {
        if (auth && auth.currentUser) {
            return await auth.currentUser.getIdToken(forceRefresh);
        }
    } catch (e) {
        console.warn("Error obteniendo Firebase ID Token:", e);
    }
    return null;
}

// Wrapper fetch autenticado con manejo de renovación automática (FASE 5A)
export async function authFetch(url, options = {}) {
    let token = await getAuthToken(false);
    const headers = { ...(options.headers || {}) };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    let response = await fetch(url, { ...options, headers });

    // Si recibimos 401 Unauthorized, intentar renovar el token y reintentar una sola vez
    if (response.status === 401 && auth && auth.currentUser) {
        const freshToken = await getAuthToken(true);
        if (freshToken) {
            headers['Authorization'] = `Bearer ${freshToken}`;
            response = await fetch(url, { ...options, headers });
        }
    }

    return response;
}

// Estado
const state = {
    drivers: [],
    pendingDrivers: [],
    rides: [],
    currentFilter: 'all',
    searchQuery: '',
    selectedRideId: null,
    activeTripRenderer: null,
    driverInfoWindow: null,
    currentInspectedDriverId: null,
    markers: {
        drivers: new Map(),
        pickup: null,
        destination: null
    },
    map: null,
    trafficLayer: null,
    connected: false,
    hasPannedToDriver: false
};

// Normalizador reutilizable para búsquedas textuales (FASE 4C-3)
export function normalizeSearchText(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

// Comparador de búsqueda para carreras (FASE 4C-3)
export function matchesSearchQuery(ride, query) {
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

if (typeof window !== 'undefined') {
    window.normalizeSearchText = normalizeSearchText;
    window.matchesSearchQuery = matchesSearchQuery;
    window.authFetch = authFetch;
    window.getAuthToken = getAuthToken;
}

// Cargar datos iniciales protegidos (FASE 5A)
async function loadAuthenticatedData() {
    try {
        const [ridesRes, driversRes] = await Promise.all([
            authFetch('/api/rides'),
            authFetch('/api/drivers?all=true')
        ]);

        if (ridesRes.ok) {
            const rides = await ridesRes.json();
            if (Array.isArray(rides)) {
                state.rides = rides;
                renderJobsList();
                updateStats();
            }
        }

        if (driversRes.ok) {
            const driversList = await driversRes.json();
            if (Array.isArray(driversList)) {
                driversList.forEach(d => {
                    const existing = state.drivers.find(x => x.id === d.id || x.driverId === d.driverId);
                    if (existing) {
                        Object.assign(existing, d);
                        updateDriverMarker(existing);
                    } else {
                        state.drivers.push(d);
                        updateDriverMarker(d);
                    }
                });
                renderDriversList();
                updateDriverSelectOptions();
                updateStats();
            }
        }
    } catch (err) {
        console.warn("Error cargando datos autenticados:", err);
    }
}

// Inicialización
function init() {
    setupAuth();
    setupEventListeners();
    setupCancelModalListeners();
    setupEditModalListeners();
    initMap();
    startClock();

    // Timer periódico para actualizar frescura GPS ("hace 2 seg", "⚠️ GPS SIN ACTUALIZAR")
    setInterval(updateGpsFreshnessTimer, 2000);

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Autenticación de Despachador con Google (FASE 5A)
function setupAuth() {
    const loginOverlay = document.getElementById('loginOverlay');
    const googleLoginBtn = document.getElementById('googleLoginBtn');

    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', async () => {
            try {
                const result = await signInWithPopup(auth, googleProvider);
                console.log("Despachador autenticado con Google:", result.user.displayName || result.user.email);
            } catch (err) {
                console.error("Error al iniciar sesión con Google:", err);
                alert("Error al iniciar sesión con Google: " + (err.message || err));
            }
        });
    }

    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
            try {
                await signOut(auth);
                state.drivers = [];
                state.rides = [];
                if (typeof renderDriversList === 'function') renderDriversList();
                if (typeof renderJobsList === 'function') renderJobsList();
                if (typeof updateStats === 'function') updateStats();
                if (loginOverlay) loginOverlay.classList.remove('hidden');
                console.log("Sesión cerrada por el operador.");
            } catch (err) {
                console.error("Error al cerrar sesión:", err);
            }
        });
    }

    let firestoreStarted = false;
    onAuthStateChanged(auth, async (user) => {
        if (user && user.isAnonymous) {
            console.log("Cerrando sesión anónima previa para exigir Google Login...");
            signOut(auth);
            return;
        }

        if (user && !user.isAnonymous) {
            console.log("Operador autenticado activo con Google:", user.displayName || user.email);
            if (loginOverlay) loginOverlay.classList.add('hidden');

            const dispatcherName = document.getElementById('dispatcherName');
            if (dispatcherName) {
                const name = user.displayName || (user.email ? user.email.split('@')[0] : 'Operador');
                dispatcherName.textContent = name;
            }

            // Obtener rol del ID Token y reflejarlo en la interfaz
            try {
                const tokenResult = await user.getIdTokenResult();
                const role = (tokenResult.claims.role || (tokenResult.claims.admin ? 'admin' : (tokenResult.claims.dispatcher ? 'dispatcher' : (tokenResult.claims.supervisor ? 'supervisor' : 'dispatcher')))).toLowerCase();
                const dispatcherRole = document.getElementById('dispatcherRole');
                if (dispatcherRole) {
                    dispatcherRole.textContent = role.toUpperCase();
                    if (role === 'admin') {
                        dispatcherRole.style.background = '#dc2626'; // Rojo Admin
                    } else if (role === 'supervisor') {
                        dispatcherRole.style.background = '#d97706'; // Ámbar Supervisor
                    } else {
                        dispatcherRole.style.background = '#2563eb'; // Azul Despachador
                    }
                }
            } catch (roleErr) {
                console.warn("No se pudo obtener el rol detallado:", roleErr);
            }

            // Inicializar Socket autenticado con ID Token
            await initAuthenticatedSocket(user);

            // Cargar datos REST protegidos
            await loadAuthenticatedData();

            if (!firestoreStarted) {
                firestoreStarted = true;
                setupFirestoreListeners();
            }
        } else {
            console.log("Esperando inicio de sesión con Google en el Despacho...");
            if (loginOverlay) loginOverlay.classList.remove('hidden');
            if (socket) {
                socket.disconnect();
                socket = null;
            }
        }
    });
}

// Inicializar / Reconectar Socket autenticado (FASE 5A)
async function initAuthenticatedSocket(user) {
    const token = await user.getIdToken();
    if (socket && socket.connected) {
        socket.auth = { token };
        socket.emit('register:dispatcher', { name: user.displayName || user.email });
        return;
    }

    if (socket) {
        socket.auth = { token };
        socket.connect();
    } else {
        socket = io({
            auth: { token },
            reconnection: true,
            reconnectionAttempts: 20,
            reconnectionDelay: 1000
        });

        setupSocketListeners();
    }
}

// 1. FIRESTORE LISTENERS (Metadatos de conductores y pendientes)
function setupFirestoreListeners() {
    const driversRef = collection(db, "drivers");

    onSnapshot(driversRef, (snapshot) => {
        state.pendingDrivers = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            data.id = doc.id;
            data.driverId = doc.id;

            if (data.status === 'pending') {
                state.pendingDrivers.push(data);
            } else if (data.status === 'approved' || data.status === 'provisional_approved' || data.status === 'provisional' || data.provisionalApproved === true || data.isOnline === true || data.available === true) {
                const existing = state.drivers.find(d => d.id === doc.id || d.driverId === doc.id || d.userId === doc.id);
                if (existing) {
                    if (data.phone) existing.phone = data.phone;
                    if (data.vehicle) existing.vehicle = data.vehicle;
                    if (data.plate) existing.plate = data.plate;
                    if (data.name) existing.name = data.name;
                    // Solo actualizar ubicación si no tenemos telemetría viva de socket reciente
                    if (!existing.lastLocationAt && data.location && typeof data.location.lat === 'number') {
                        existing.location = data.location;
                        updateDriverMarker(existing);
                    }
                } else {
                    const isOnline = data.available === true || data.isOnline === true;
                    const driver = {
                        ...data,
                        isOnline,
                        status: isOnline ? (data.available ? 'available' : 'busy') : 'offline'
                    };
                    state.drivers.push(driver);
                    updateDriverMarker(driver);
                }
            }
        });

        renderDriversList();
        updateDriverSelectOptions();
        updateStats();
    }, (error) => {
        console.warn("Firestore listener warning:", error.message);
    });
}

// 2. SOCKET LISTENERS (TELEMETRÍA EN TIEMPO REAL Y DESPACHO)
function setupSocketListeners() {
    if (!socket) return;

    socket.on('connect', () => {
        state.connected = true;
        updateConnectionStatus();

        if (auth && auth.currentUser) {
            socket.emit('register:dispatcher', { name: auth.currentUser.displayName || auth.currentUser.email });
        }

        // Recuperar estado completo sin recarga F5
        socket.emit('rides:get');
        socket.emit('drivers:get');

        loadAuthenticatedData();
    });

    socket.io?.on('reconnect_attempt', async () => {
        if (auth && auth.currentUser) {
            const token = await auth.currentUser.getIdToken(true);
            if (socket) socket.auth = { token };
        }
    });

    socket.on('connect_error', async (err) => {
        console.warn("Socket connection error:", err.message);
        if (err.message && err.message.includes("Unauthorized") && auth && auth.currentUser) {
            const token = await auth.currentUser.getIdToken(true);
            if (socket) {
                socket.auth = { token };
            }
        }
    });

    socket.on('disconnect', () => {
        state.connected = false;
        updateConnectionStatus();
    });

    // Telemetría GPS en tiempo real
    socket.on('driver:location_update', (data) => {
        const driverId = data.driverId || data.id;
        let driver = state.drivers.find(d => d.id === driverId || d.driverId === driverId || (d.userId && d.userId === data.userId));
        if (driver) {
            driver.location = data.location;
            if (data.heading !== undefined) driver.heading = data.heading;
            driver.lastLocationAt = Date.now();
            let changed = false;
            if (data.status && driver.status !== data.status) {
                driver.status = data.status;
                changed = true;
            }
            if (data.available !== undefined && driver.available !== data.available) {
                driver.available = data.available;
                changed = true;
            }
            updateDriverMarker(driver);
            if (changed) updateStats();
        } else {
            driver = {
                id: driverId,
                driverId: data.userId || driverId,
                name: data.name || 'Conductor',
                location: data.location,
                heading: data.heading || 0,
                status: data.status || (data.available ? 'available' : 'busy'),
                available: data.available !== undefined ? data.available : true,
                isOnline: true,
                lastLocationAt: Date.now()
            };
            state.drivers.push(driver);
            updateDriverMarker(driver);
            renderDriversList();
            updateDriverSelectOptions();
            updateStats();
        }

        // Si la InfoWindow está abierta para este conductor, actualizar su texto en vivo
        if (state.currentInspectedDriverId === driver.id && state.driverInfoWindow) {
            updateDriverInfoWindowContent(driver);
        }

        // Si este conductor está asignado a la carrera activa seleccionada, actualizar polilínea viva
        if (state.selectedRideId) {
            const selectedRide = state.rides.find(r => r.id === state.selectedRideId);
            if (selectedRide && (selectedRide.driverId === driverId || selectedRide.assignedDriver?.id === driverId)) {
                trackActiveRideOnMap(selectedRide);
            }
        }
    });

    socket.on('driver:online', (driverData) => {
        let driver = state.drivers.find(d => d.id === driverData.id || d.driverId === driverData.driverId);
        if (driver) {
            Object.assign(driver, driverData);
            driver.isOnline = true;
            driver.status = driverData.status || (driverData.available ? 'available' : 'busy');
            if (!driver.lastLocationAt) driver.lastLocationAt = Date.now();
        } else {
            driver = { ...driverData, isOnline: true, lastLocationAt: Date.now() };
            state.drivers.push(driver);
        }
        updateDriverMarker(driver);
        renderDriversList();
        updateDriverSelectOptions();
        updateStats();
    });

    socket.on('driver:offline', (data) => {
        const offlineId = data.driverId || data.id;
        const driverIdx = state.drivers.findIndex(d => d.id === offlineId || d.driverId === offlineId || d.userId === offlineId);
        if (driverIdx !== -1) {
            const driver = state.drivers[driverIdx];
            driver.isOnline = false;
            driver.available = false;
            driver.status = 'offline';

            // Eliminar marcador del mapa
            const marker = state.markers.drivers.get(driver.id) || state.markers.drivers.get(offlineId);
            if (marker) {
                marker.setMap(null);
                state.markers.drivers.delete(driver.id);
                state.markers.drivers.delete(offlineId);
            }

            // Si no tiene carrera activa, eliminar de la lista; si tiene, dejarlo pero marcarlo offline
            if (!driver.currentRide && !driver.currentRideId) {
                state.drivers.splice(driverIdx, 1);
            }
        }
        renderDriversList();
        updateDriverSelectOptions();
        updateStats();
    });

    socket.on('driver:status_change', (data) => {
        const driver = state.drivers.find(d => d.id === data.driverId || d.driverId === data.driverId);
        if (driver) {
            driver.status = data.status;
            driver.available = Boolean(data.available);
            if (data.currentRideId !== undefined) driver.currentRideId = data.currentRideId;
            updateDriverMarker(driver);
            renderDriversList();
            updateDriverSelectOptions();
            updateStats();
        }
    });

    socket.on('drivers:update', (driversList) => {
        if (Array.isArray(driversList)) {
            driversList.forEach(d => {
                const existing = state.drivers.find(x => x.id === d.id || x.driverId === d.driverId || (x.userId && (x.userId === d.userId || x.userId === d.driverId)));
                if (existing) {
                    const lastLoc = existing.lastLocationAt;
                    Object.assign(existing, d);
                    existing.isOnline = d.isOnline !== undefined ? d.isOnline : true;
                    if (d.location && typeof d.location.lat === 'number' && d.location.lat !== 0) {
                        existing.location = d.location;
                        existing.lastLocationAt = Date.now();
                    } else if (lastLoc) {
                        existing.lastLocationAt = lastLoc;
                    }
                    updateDriverMarker(existing);
                } else {
                    const newD = { ...d, isOnline: d.isOnline !== undefined ? d.isOnline : true, lastLocationAt: Date.now() };
                    state.drivers.push(newD);
                    updateDriverMarker(newD);
                }
            });
            renderDriversList();
            updateDriverSelectOptions();
            updateStats();
        }
    });

    socket.on('rides:update', (rides) => {
        state.rides = rides || [];
        renderJobsList();
        updateStats();
        if (state.selectedRideId) {
            const selectedRide = state.rides.find(r => r.id === state.selectedRideId);
            if (selectedRide) trackActiveRideOnMap(selectedRide);
        }
    });

    socket.on('ride:created', (ride) => {
        const tempIdx = state.rides.findIndex(r => r.id === ride.id || r.id.startsWith('temp_'));
        if (tempIdx !== -1) {
            state.rides[tempIdx] = ride;
        } else {
            state.rides.unshift(ride);
        }
        renderJobsList();
        updateStats();
        showToast('Carrera Despachada', `ID #${ride.id.slice(0, 8)} asignada a la red`);
    });

    socket.on('ride:new', (ride) => {
        showToast('Nueva Carrera Activa', `De: ${ride.pickup?.address || 'Origen'}`);
        if (document.getElementById('notificationSound')) {
            document.getElementById('notificationSound').play().catch(e => { });
        }
    });

    socket.on('ride:assigned', (ride) => {
        updateRideInState(ride);
        showToast('Taxista Asignado', `Carrera asignada a ${ride.assignedDriver?.name || 'conductor'}`);
        state.selectedRideId = ride.id;
        trackActiveRideOnMap(ride);
    });

    socket.on('ride:accepted', (ride) => {
        updateRideInState(ride);
        showToast('🎉 Carrera Aceptada', `${ride.driver?.name || 'Un conductor'} aceptó la carrera`);
        if (document.getElementById('notificationSound')) {
            document.getElementById('notificationSound').play().catch(e => { });
        }
        state.selectedRideId = ride.id;
        trackActiveRideOnMap(ride);
    });

    socket.on('ride:arrived_at_pickup', (ride) => {
        updateRideInState(ride);
        showToast('📍 En Recogida', `El conductor llegó al punto de recogida`);
        state.selectedRideId = ride.id;
        trackActiveRideOnMap(ride);
    });

    socket.on('ride:picked_up', (ride) => {
        updateRideInState(ride);
        showToast('🚖 Pasajero a Bordo', `Viaje en curso hacia el destino`);
        state.selectedRideId = ride.id;
        trackActiveRideOnMap(ride);
    });

    socket.on('ride:started', (ride) => {
        updateRideInState(ride);
        showToast('🚖 En Curso', `El conductor inició el viaje`);
        state.selectedRideId = ride.id;
        trackActiveRideOnMap(ride);
    });

    socket.on('ride:completed', (ride) => {
        updateRideInState(ride);
        showToast('✅ Completada', `Carrera finalizada con éxito`);
        if (state.selectedRideId === ride.id) {
            trackActiveRideOnMap(ride);
            state.selectedRideId = null;
        }
    });

    socket.on('ride:cancelled', (ride) => {
        updateRideInState(ride);
        showToast('❌ Cancelada', `La carrera fue cancelada`);
        if (state.selectedRideId === ride.id) {
            trackActiveRideOnMap(ride);
            state.selectedRideId = null;
        }
    });

    socket.on('ride:rejected', (data) => {
        showToast('Oferta Rechazada', `Conductor ${data.driverName || 'asignado'} rechazó la carrera. Reasignando...`);
    });

    socket.on('ride:expired', (data) => {
        showToast('Oferta Expirada', `Oferta expiró para ${data.driverName || 'el conductor'} (15s). Reasignando...`);
    });

    socket.on('ride:reassigned', (data) => {
        showToast('🔄 Reasignada', `Carrera reasignada al conductor: ${data.driverName}`);
    });

    socket.on('ride:driver_cancelled', (data) => {
        showToast('⚠️ Cancelada por Conductor', `Conductor ${data.driverName} canceló viaje: ${data.reason}`);
    });

    socket.on('ride:no_drivers_available', (data) => {
        showToast('⚠️ Sin Conductores', data.message || 'No hay más conductores disponibles.');
    });

    socket.on('ride:update', (ride) => {
        updateRideInState(ride);
    });

    socket.on('ride:no_drivers', (data) => {
        showToast('Aviso de Despacho', data.message || 'Esperando que los conductores se conecten');
    });

    socket.on('error', (err) => {
        showToast('Aviso', err.message || 'Error en el sistema');
    });
}

function updateRideInState(updatedRide) {
    const idx = state.rides.findIndex(r => r.id === updatedRide.id);
    if (idx !== -1) {
        state.rides[idx] = updatedRide;
    } else {
        state.rides.unshift(updatedRide);
    }
    renderJobsList();
    updateStats();
}

// ============================================
// SERVICIOS DE GOOGLE MAPS Y TRAZADO DE RUTA
// ============================================
let directionsService;
let directionsRenderer;
let geocoder;

function initMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl) return;

    if (typeof google === 'undefined' || !google.maps || typeof google.maps.Map !== 'function') {
        setTimeout(initMap, 150);
        return;
    }

    state.map = new google.maps.Map(mapEl, {
        center: { lat: 40.7128, lng: -74.0060 },
        zoom: 12,
        styles: [
            { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] }
        ],
        disableDefaultUI: true,
        zoomControl: true,
    });

    geocoder = new google.maps.Geocoder();
    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: state.map,
        suppressMarkers: false,
        polylineOptions: { strokeColor: '#2563eb', strokeWeight: 5, strokeOpacity: 0.9 }
    });

    setupAutocomplete();
}

function setupAutocomplete() {
    if (typeof google === 'undefined' || !google.maps || !google.maps.places) {
        setTimeout(setupAutocomplete, 200);
        return;
    }

    const pickupInput = document.getElementById('pickupAddress');
    const destInput = document.getElementById('destinationAddress');

    if (pickupInput) {
        const pickupAutocomplete = new google.maps.places.Autocomplete(pickupInput, {
            fields: ["formatted_address", "geometry"]
        });
        pickupAutocomplete.addListener("place_changed", () => {
            const place = pickupAutocomplete.getPlace();
            if (place.geometry) {
                pickupInput.dataset.lat = place.geometry.location.lat();
                pickupInput.dataset.lng = place.geometry.location.lng();
                checkAndTraceRoute();
            }
        });

        // Prevenir Enter y mover cursor a destino
        pickupInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                ensureGeocodeAndTrace('pickup');
                if (destInput) destInput.focus();
            }
        });

        pickupInput.addEventListener('blur', () => ensureGeocodeAndTrace('pickup'));
        pickupInput.addEventListener('change', () => ensureGeocodeAndTrace('pickup'));
    }

    if (destInput) {
        const destAutocomplete = new google.maps.places.Autocomplete(destInput, {
            fields: ["formatted_address", "geometry"]
        });
        destAutocomplete.addListener("place_changed", () => {
            const place = destAutocomplete.getPlace();
            if (place.geometry) {
                destInput.dataset.lat = place.geometry.location.lat();
                destInput.dataset.lng = place.geometry.location.lng();
                checkAndTraceRoute();
            }
        });

        // Prevenir Enter y trazar ruta de inmediato
        destInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                ensureGeocodeAndTrace('destination');
            }
        });

        destInput.addEventListener('blur', () => ensureGeocodeAndTrace('destination'));
        destInput.addEventListener('change', () => ensureGeocodeAndTrace('destination'));
    }
}

function ensureGeocodeAndTrace(type) {
    const input = type === 'pickup' ? document.getElementById('pickupAddress') : document.getElementById('destinationAddress');
    const text = input ? input.value.trim() : '';

    if (!text) return;

    if (!geocoder) geocoder = new google.maps.Geocoder();

    geocoder.geocode({ address: text }, (results, status) => {
        if (status === 'OK' && results[0] && results[0].geometry) {
            input.dataset.lat = results[0].geometry.location.lat();
            input.dataset.lng = results[0].geometry.location.lng();
            checkAndTraceRoute();
        } else {
            checkAndTraceRoute();
        }
    });
}

function checkAndTraceRoute() {
    const pickupInput = document.getElementById('pickupAddress');
    const destInput = document.getElementById('destinationAddress');

    const pickupVal = pickupInput ? pickupInput.value.trim() : '';
    const destVal = destInput ? destInput.value.trim() : '';

    if (!pickupVal || !destVal) return;

    const pLat = pickupInput?.dataset?.lat;
    const pLng = pickupInput?.dataset?.lng;
    const dLat = destInput?.dataset?.lat;
    const dLng = destInput?.dataset?.lng;

    const origin = (pLat && pLng) ? { lat: parseFloat(pLat), lng: parseFloat(pLng) } : pickupVal;
    const destination = (dLat && dLng) ? { lat: parseFloat(dLat), lng: parseFloat(dLng) } : destVal;

    calculateRoute(origin, destination);
}

function calculateRoute(origin, destination) {
    if (!directionsService || !directionsRenderer) {
        directionsService = new google.maps.DirectionsService();
        directionsRenderer = new google.maps.DirectionsRenderer({
            map: state.map,
            suppressMarkers: false,
            polylineOptions: { strokeColor: '#2563eb', strokeWeight: 5, strokeOpacity: 0.9 }
        });
    }

    directionsService.route({
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING
    }, (response, status) => {
        if (status === 'OK') {
            directionsRenderer.setDirections(response);

            if (state.map && response.routes && response.routes[0]) {
                state.map.fitBounds(response.routes[0].bounds);
            }

            const route = response.routes[0].legs[0];
            const distanceKm = route.distance.value / 1000;
            const durationMins = route.duration.value / 60;

            const pickupInput = document.getElementById('pickupAddress');
            const destInput = document.getElementById('destinationAddress');

            if (route.start_location && pickupInput) {
                pickupInput.dataset.lat = route.start_location.lat();
                pickupInput.dataset.lng = route.start_location.lng();
            }
            if (route.end_location && destInput) {
                destInput.dataset.lat = route.end_location.lat();
                destInput.dataset.lng = route.end_location.lng();
            }

            updateRouteInfo(distanceKm, durationMins);
        } else {
            console.warn('No se pudo calcular la ruta de Google Maps:', status);
        }
    });
}

function updateRouteInfo(distanceKm, durationMins) {
    const baseFare = 3.00;
    const costPerKm = 1.40;
    const costPerMin = 0.30;

    const total = baseFare + (distanceKm * costPerKm) + (durationMins * costPerMin);

    const btn = document.getElementById('btnSubmitJob') || document.querySelector('.btn-create-job');
    if (btn) {
        btn.innerHTML = `
            <span>Crear Carrera ($${total.toFixed(2)} • ${distanceKm.toFixed(1)} km)</span>
            <i data-lucide="arrow-right"></i>
        `;
        btn.dataset.fare = total.toFixed(2);
        btn.dataset.distance = distanceKm.toFixed(1);
        btn.dataset.duration = Math.round(durationMins);
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ============================================
// MARCADORES DE CONDUCTORES EN VIVO (FASE 4A)
// ============================================
const CAR_PATH = "M17.402,0H5.643C2.526,0,0,3.467,0,6.584v34.804c0,3.116,2.526,5.644,5.643,5.644h11.759c3.116,0,5.644-2.527,5.644-5.644 V6.584C23.044,3.467,20.518,0,17.402,0z M22.057,14.188v11.665l-2.729,0.351v-4.806L22.057,14.188z M20.625,10.773 c-1.016,3.9-2.219,8.51-2.219,8.51H4.638l-2.222-8.51C2.417,10.773,11.3,7.755,20.625,10.773z M3.748,21.713v4.492l-2.73-0.349 V14.502L3.748,21.713z M23.044,9.425H0.69l1.206-6.662c0.645-3.324,5.086-2.435,5.086-2.435h9.106 c0,0,4.45-0.9,5.097,2.435L23.044,9.425z";

// Colores según Estado Operativo (Requerimiento 4):
// 🟢 VERDE: ONLINE + AVAILABLE
// 🟡 ÁMBAR: ONLINE + OFFERED / ASSIGNED
// 🔴 ROJO: ONLINE + BUSY / ACTIVE RIDE
// ⚫ GRIS: OFFLINE
const STATUS_COLORS = {
    available: '#10B981', // Verde
    offered: '#F59E0B',   // Ámbar
    busy: '#EF4444',      // Rojo
    offline: '#6B7280'    // Gris
};

const STATUS_LABELS = {
    available: '🟢 DISPONIBLE',
    offered: '🟡 OFERTADO / ASIGNADO',
    busy: '🔴 EN VIAJE ACTIVO',
    offline: '⚫ DESCONECTADO'
};

function getDriverOperationalStatus(driver) {
    if (!driver.isOnline || driver.status === 'offline') return 'offline';
    if (driver.status === 'offered' || driver.status === 'assigned') return 'offered';
    if (driver.status === 'busy' || driver.status === 'in_progress' || driver.status === 'arrived_at_pickup' || driver.currentRide || driver.currentRideId) return 'busy';
    if (driver.available !== false) return 'available';
    return 'busy';
}

function getDriverCarIcon(driver) {
    const opStatus = getDriverOperationalStatus(driver);
    const fillColor = STATUS_COLORS[opStatus] || STATUS_COLORS.available;
    return {
        path: CAR_PATH,
        scale: 0.65,
        fillColor: fillColor,
        fillOpacity: 1.0,
        strokeWeight: 1.5,
        strokeColor: '#FFFFFF',
        rotation: driver.heading || 0,
        anchor: new google.maps.Point(11.5, 23.5)
    };
}

function updateDriverMarker(driver) {
    if (!state.map) return;

    const driverKey = driver.id || driver.driverId;
    let marker = state.markers.drivers.get(driverKey);
    const pos = driver.location || { lat: 0, lng: 0 };
    const hasValidCoords = typeof pos.lat === 'number' && typeof pos.lng === 'number' && (pos.lat !== 0 || pos.lng !== 0);

    if (!hasValidCoords) {
        if (marker) {
            marker.setMap(null);
            state.markers.drivers.delete(driverKey);
        }
        return;
    }

    const icon = getDriverCarIcon(driver);
    const opStatus = getDriverOperationalStatus(driver);

    if (marker) {
        marker.setPosition(pos);
        marker.setIcon(icon);
        marker.setTitle(`${driver.name} (${STATUS_LABELS[opStatus]})`);
        marker.setMap(state.map);
    } else {
        marker = new google.maps.Marker({
            position: pos,
            map: state.map,
            icon: icon,
            title: `${driver.name} (${STATUS_LABELS[opStatus]})`,
            zIndex: opStatus === 'busy' ? 120 : (opStatus === 'offered' ? 110 : 100)
        });

        // Evento click directo en el vehículo del mapa
        marker.addListener('click', () => {
            openDriverInfoWindow(driver, marker);
        });

        state.markers.drivers.set(driverKey, marker);
    }

    if (state.map && (!state.hasPannedToDriver || state.drivers.length === 1)) {
        state.map.panTo(pos);
        if (state.map.getZoom() < 13) state.map.setZoom(14);
        state.hasPannedToDriver = true;
    }

    // Si la InfoWindow está abierta para este conductor, actualizarla de inmediato
    if (state.currentInspectedDriverId === driverKey && state.driverInfoWindow) {
        updateDriverInfoWindowContent(driver);
    }
}

// InfoWindow para click en vehículo
function openDriverInfoWindow(driver, marker) {
    if (!state.map) return;
    if (!state.driverInfoWindow) {
        state.driverInfoWindow = new google.maps.InfoWindow();
        state.driverInfoWindow.addListener('closeclick', () => {
            state.currentInspectedDriverId = null;
        });
    }

    state.currentInspectedDriverId = driver.id || driver.driverId;
    updateDriverInfoWindowContent(driver);
    state.driverInfoWindow.open(state.map, marker);
}

function updateDriverInfoWindowContent(driver) {
    if (!state.driverInfoWindow) return;

    const opStatus = getDriverOperationalStatus(driver);
    const statusColor = STATUS_COLORS[opStatus] || '#10B981';
    const statusLabel = STATUS_LABELS[opStatus] || 'DISPONIBLE';

    // Cálculo de frescura del GPS
    const now = Date.now();
    const lastGps = driver.lastLocationAt || (driver.lastUpdate ? new Date(driver.lastUpdate).getTime() : now);
    const diffSec = Math.max(0, Math.round((now - lastGps) / 1000));

    let gpsText = 'Actualizado ahora';
    let isGpsStale = false;
    if (diffSec > 3) {
        gpsText = `hace ${diffSec} seg`;
    }
    if (diffSec > 30) {
        isGpsStale = true;
        gpsText = `⚠️ GPS SIN ACTUALIZAR (${diffSec}s)`;
    }

    // Vehículo
    let vehicleDesc = 'Taxi';
    if (driver.vehicle && typeof driver.vehicle === 'object') {
        vehicleDesc = `${driver.vehicle.brand || ''} ${driver.vehicle.model || ''} ${driver.vehicle.year || ''}`.trim();
    } else if (typeof driver.vehicle === 'string') {
        vehicleDesc = driver.vehicle;
    }

    // Información del viaje actual si existe
    const activeRideId = driver.currentRide || driver.currentRideId;
    let rideInfoHtml = '';
    if (activeRideId) {
        const currentRide = state.rides.find(r => r.id === activeRideId);
        if (currentRide) {
            rideInfoHtml = `
                <div style="margin-top:8px; padding:8px; background:#F0FDF4; border:1px solid #BBF7D0; border-radius:6px;">
                    <div style="font-weight:bold; color:#166534; font-size:12px;">🚕 VIAJE ACTIVO #${currentRide.id.slice(0, 8)}</div>
                    <div style="font-size:11px; color:#374151; margin-top:2px;">👤 <strong>Pasajero:</strong> ${escapeHtml(currentRide.customerName || 'Cliente')}</div>
                    <div style="font-size:11px; color:#374151; margin-top:2px;">🏁 <strong>Destino:</strong> ${escapeHtml(currentRide.destination?.address || 'Destino')}</div>
                </div>
            `;
        }
    }

    const html = `
        <div style="color:#111827; font-family:system-ui, sans-serif; min-width:240px; padding:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #E5E7EB; padding-bottom:6px; margin-bottom:8px;">
                <h3 style="margin:0; font-size:15px; font-weight:bold; color:#111827;">${escapeHtml(driver.name)}</h3>
                <span style="background:${statusColor}20; color:${statusColor}; border:1px solid ${statusColor}; font-size:10px; font-weight:bold; padding:2px 8px; border-radius:12px;">${statusLabel}</span>
            </div>
            <div style="font-size:12px; line-height:1.6; color:#374151;">
                <div>📞 <strong>Tel:</strong> ${escapeHtml(driver.phone || 'N/A')}</div>
                <div>🚗 <strong>Vehículo:</strong> ${escapeHtml(vehicleDesc)}</div>
                <div>🔢 <strong>Placa:</strong> <span style="background:#F3F4F6; padding:1px 5px; border-radius:4px; font-weight:bold;">${escapeHtml(driver.plate || 'N/A')}</span></div>
                <div style="margin-top:4px; font-weight:600; color:${isGpsStale ? '#D97706' : '#2563EB'};">
                    📡 <strong>GPS:</strong> ${gpsText}
                </div>
                ${rideInfoHtml}
            </div>
            <div style="margin-top:10px; display:flex; justify-content:flex-end;">
                <button type="button" onclick="window.selectDriverForJob('${driver.id}')" style="background:#2563EB; color:#fff; border:none; border-radius:6px; padding:5px 12px; font-size:11px; font-weight:bold; cursor:pointer;">
                    Asignar a Carrera
                </button>
            </div>
        </div>
    `;

    state.driverInfoWindow.setContent(html);
}

function updateGpsFreshnessTimer() {
    if (state.currentInspectedDriverId && state.driverInfoWindow) {
        const driver = state.drivers.find(d => (d.id || d.driverId) === state.currentInspectedDriverId);
        if (driver) {
            updateDriverInfoWindowContent(driver);
        }
    }
    renderAttentionAlerts();
}

// Trazado en mapa de la carrera activa
function trackActiveRideOnMap(ride) {
    if (!state.map || !ride) return;

    if (ride.status === 'completed' || ride.status === 'cancelled') {
        if (state.activeTripRenderer) {
            state.activeTripRenderer.setMap(null);
            state.activeTripRenderer = null;
        }
        return;
    }

    if (!state.activeTripRenderer) {
        state.activeTripRenderer = new google.maps.DirectionsRenderer({
            map: state.map,
            suppressMarkers: false,
            polylineOptions: { strokeColor: '#2563EB', strokeWeight: 5, strokeOpacity: 0.85 }
        });
    } else {
        state.activeTripRenderer.setMap(state.map);
    }

    const driverId = ride.driverId || ride.assignedDriver?.id;
    const driver = state.drivers.find(d => d.id === driverId || d.driverId === driverId);
    const driverPos = (driver && driver.location && typeof driver.location.lat === 'number' && driver.location.lat !== 0) ? driver.location : null;

    let origin = null;
    let destination = null;
    let strokeColor = '#2563EB';

    if (ride.status === 'accepted' || ride.status === 'assigned' || ride.status === 'offered') {
        // Fase 1: Conductor -> Recogida
        origin = driverPos || ride.pickup;
        destination = ride.pickup;
        strokeColor = '#2563EB'; // Azul (hacia la recogida)
    } else if (ride.status === 'arrived_at_pickup') {
        // En recogida esperando al pasajero
        origin = ride.pickup;
        destination = ride.destination;
        strokeColor = '#8B5CF6'; // Púrpura
    } else if (ride.status === 'in_progress') {
        // Fase 2: Conductor -> Destino
        origin = driverPos || ride.pickup;
        destination = ride.destination;
        strokeColor = '#10B981'; // Verde (en viaje al destino)
    }

    if (origin && destination) {
        state.activeTripRenderer.setOptions({
            polylineOptions: { strokeColor, strokeWeight: 5, strokeOpacity: 0.85 }
        });

        if (!directionsService) directionsService = new google.maps.DirectionsService();

        const reqOrigin = (origin.lat && origin.lng) ? { lat: parseFloat(origin.lat), lng: parseFloat(origin.lng) } : (origin.address || origin);
        const reqDest = (destination.lat && destination.lng) ? { lat: parseFloat(destination.lat), lng: parseFloat(destination.lng) } : (destination.address || destination);

        directionsService.route({
            origin: reqOrigin,
            destination: reqDest,
            travelMode: google.maps.TravelMode.DRIVING
        }, (response, status) => {
            if (status === 'OK' && state.activeTripRenderer) {
                state.activeTripRenderer.setDirections(response);
            }
        });
    }
}

window.focusRideOnMap = function(rideId) {
    const ride = state.rides.find(r => r.id === rideId);
    if (!ride || !state.map) return;

    state.selectedRideId = rideId;
    trackActiveRideOnMap(ride);

    const bounds = new google.maps.LatLngBounds();
    const driverId = ride.driverId || ride.assignedDriver?.id;
    const driver = state.drivers.find(d => d.id === driverId || d.driverId === driverId);

    if (driver && driver.location && typeof driver.location.lat === 'number' && driver.location.lat !== 0) {
        bounds.extend(new google.maps.LatLng(driver.location.lat, driver.location.lng));
    }
    if (ride.pickup && typeof ride.pickup.lat === 'number' && ride.pickup.lat !== 0) {
        bounds.extend(new google.maps.LatLng(ride.pickup.lat, ride.pickup.lng));
    }
    if (ride.destination && typeof ride.destination.lat === 'number' && ride.destination.lat !== 0) {
        bounds.extend(new google.maps.LatLng(ride.destination.lat, ride.destination.lng));
    }

    if (!bounds.isEmpty()) {
        state.map.fitBounds(bounds);
    }
};

function renderDriversList() {
    const listEl = document.getElementById('driversList');
    if (!listEl) return;

    const pendingHtml = state.pendingDrivers.map(driver => `
        <div class="driver-item pending" onclick="window.viewPendingDriver('${driver.id}')" style="cursor: pointer; background: #1c1917; border-left: 3px solid #f59e0b; padding: 10px; margin-bottom: 8px; border-radius: 8px;">
            <div class="driver-avatar" style="background: #f59e0b; color: #fff; font-weight: bold;">${getInitials(driver.name)}</div>
            <div class="driver-info" style="flex:1; margin-left: 8px;">
                <h4 style="color: #fff; font-size: 13px; margin: 0;">${escapeHtml(driver.name)}</h4>
                <p style="color: #f59e0b; font-size: 11px; margin: 2px 0 0;">Solicitud de Registro Pendiente</p>
            </div>
            <i data-lucide="chevron-right" style="color: #9ca3af; width: 16px; height: 16px;"></i>
        </div>
    `).join('');

    const now = Date.now();
    const activeHtml = state.drivers.map(driver => {
        let vehicleText = 'Taxi';
        if (driver.vehicle && typeof driver.vehicle === 'object') {
            vehicleText = `${driver.vehicle.brand || ''} ${driver.vehicle.model || ''} ${driver.vehicle.year || ''}`.trim();
        } else if (typeof driver.vehicle === 'string') {
            vehicleText = driver.vehicle;
        }

        const opStatus = getDriverOperationalStatus(driver);
        const dotColor = STATUS_COLORS[opStatus] || '#10B981';
        const label = STATUS_LABELS[opStatus] || '🟢 DISPONIBLE';

        // Frescura de GPS
        const lastGps = driver.lastLocationAt || (driver.lastUpdate ? new Date(driver.lastUpdate).getTime() : now);
        const diffSec = Math.max(0, Math.round((now - lastGps) / 1000));
        let gpsText = 'GPS: hace 1s';
        let isGpsStale = false;
        if (diffSec > 2) gpsText = `GPS: hace ${diffSec}s`;
        if (diffSec > 30) {
            isGpsStale = true;
            gpsText = `⚠️ GPS (${diffSec}s)`;
        }

        // Carrera activa si existe
        const activeRideId = driver.currentRide || driver.currentRideId;
        let rideSnippet = '';
        if (activeRideId) {
            rideSnippet = `<div style="font-size:10px; color:#38bdf8; font-weight:600; margin-top:3px;">🚕 Carrera #${activeRideId.slice(0, 8)}</div>`;
        }

        const driverKey = driver.id || driver.driverId;
        const shortId = (driver.driverId || driver.id || '').slice(0, 8);

        return `
        <div class="driver-item" data-driver-key="${driverKey}" style="cursor: pointer; background: #18181b; border: 1px solid #27272a; padding: 10px; margin-bottom: 8px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; transition: border-color 0.2s;">
            <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
                <div class="driver-avatar" style="width: 36px; height: 36px; border-radius: 50%; background: #27272a; border: 2px solid ${dotColor}; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; flex-shrink: 0;">
                    ${getInitials(driver.name)}
                </div>
                <div class="driver-info" style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <h4 style="color: #f4f4f5; font-size: 13px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(driver.name)}</h4>
                        <span style="font-size: 9px; color: ${dotColor}; background: ${dotColor}20; border: 1px solid ${dotColor}40; padding: 1px 5px; border-radius: 10px; font-weight: 700;">${label}</span>
                    </div>
                    <p style="color: #a1a1aa; font-size: 11px; margin: 2px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(vehicleText)} • <span style="font-weight: 600; color: #e4e4e7;">${escapeHtml(driver.plate || 'N/A')}</span>
                    </p>
                    <div style="display: flex; align-items: center; gap: 8px; font-size: 10px; margin-top: 3px;">
                        <span style="color: ${isGpsStale ? '#f59e0b' : '#38bdf8'}; font-weight: ${isGpsStale ? 'bold' : 'normal'};">${gpsText}</span>
                        <span style="color: #71717a;">ID: #${escapeHtml(shortId)}</span>
                    </div>
                    ${rideSnippet}
                </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; margin-left: 8px; flex-shrink: 0;">
                <button type="button" class="btn-assign-job" data-driver-key="${driverKey}" title="Asignar a nueva carrera" style="background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: bold; cursor: pointer;">
                    Asignar
                </button>
            </div>
        </div>
    `}).join('');

    listEl.innerHTML = pendingHtml + activeHtml;

    listEl.querySelectorAll('.btn-assign-job').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.driverKey;
            if (key) window.selectDriverForJob(key);
        });
    });

    listEl.querySelectorAll('.driver-item').forEach(item => {
        item.addEventListener('click', () => {
            const key = item.dataset.driverKey;
            if (key) window.focusDriver(key);
        });
    });

    if (state.pendingDrivers.length === 0 && state.drivers.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p style="color:#71717a; font-size:12px; text-align:center; padding:12px;">No hay taxistas registrados</p></div>';
    }

    const availableCountEl = document.getElementById('availableCount');
    if (availableCountEl) {
        const availCount = state.drivers.filter(d => getDriverOperationalStatus(d) === 'available').length;
        availableCountEl.textContent = String(availCount);
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateDriverSelectOptions() {
    const select = document.getElementById('assignedDriverSelect');
    if (!select) return;

    const currentVal = select.value;
    let html = '<option value="">⚡ Enviar a todos los taxistas activos (Automático)</option>';

    state.drivers.forEach(driver => {
        let vehicleText = '';
        if (driver.vehicle && typeof driver.vehicle === 'object') {
            vehicleText = ` • ${driver.vehicle.brand || ''} ${driver.vehicle.model || ''}`;
        } else if (typeof driver.vehicle === 'string') {
            vehicleText = ` • ${driver.vehicle}`;
        }
        const opStatus = getDriverOperationalStatus(driver);
        const label = STATUS_LABELS[opStatus] || '🟢 Disponible';
        html += `<option value="${driver.id}">🚕 ${escapeHtml(driver.name)}${escapeHtml(vehicleText)} (${label})</option>`;
    });

    select.innerHTML = html;
    if (currentVal) select.value = currentVal;
}

window.selectDriverForJob = function(driverId) {
    const select = document.getElementById('assignedDriverSelect');
    if (select) {
        select.value = driverId;
        showToast('Taxista Seleccionado', 'Se asignará este taxista al crear la carrera');
    }
};

window.focusDriver = function (driverId) {
    const driver = state.drivers.find(d => d.id === driverId || d.driverId === driverId);
    const marker = state.markers.drivers.get(driverId) || (driver ? state.markers.drivers.get(driver.id) : null);
    if (marker && state.map) {
        state.map.panTo(marker.getPosition());
        state.map.setZoom(17);
        marker.setAnimation(google.maps.Animation.BOUNCE);
        setTimeout(() => marker.setAnimation(null), 1500);
        if (driver) {
            openDriverInfoWindow(driver, marker);
        }
    } else {
        showToast('Info', 'Ubicación del conductor no disponible');
    }
};

// ============================================
// LISTA DE CARRERAS (RIGHT SIDEBAR)
// ============================================
function renderJobsList() {
    const container = document.getElementById('jobsList');
    if (!container) return;

    let filtered = state.rides;

    // 1. Filtrado por Estado (Tabs / Chips)
    if (state.currentFilter !== 'all') {
        if (state.currentFilter === 'assigned') {
            filtered = state.rides.filter(r => r.status === 'assigned' || r.status === 'accepted');
        } else {
            filtered = state.rides.filter(r => r.status === state.currentFilter);
        }
    }

    // 2. Filtrado por Búsqueda Textual (FASE 4C-3)
    if (state.searchQuery) {
        filtered = filtered.filter(r => matchesSearchQuery(r, state.searchQuery));
    }

    if (filtered.length === 0) {
        const isSearching = Boolean(state.searchQuery);
        container.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <p>${isSearching ? 'No se encontraron servicios que coincidan con la búsqueda.' : `No hay carreras ${state.currentFilter === 'all' ? 'activas' : state.currentFilter}`}</p>
            </div>
        `;
        return;
    }

    const statusBadge = {
        scheduled: '<span class="status-badge scheduled" style="background:#0284c7; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">📅 Programada</span>',
        pending: '<span class="status-badge pending" style="background:#f59e0b; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">⏳ Pendiente</span>',
        offered: '<span class="status-badge offered" style="background:#8b5cf6; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">⚡ Ofertando...</span>',
        assigned: '<span class="status-badge assigned" style="background:#3b82f6; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">👤 Asignada</span>',
        accepted: '<span class="status-badge accepted" style="background:#0284c7; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">🚕 En camino a recoger</span>',
        arrived_at_pickup: '<span class="status-badge arrived" style="background:#8b5cf6; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">📍 En recogida</span>',
        in_progress: '<span class="status-badge in-progress" style="background:#16a34a; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">🚖 Pasajero a bordo</span>',
        completed: '<span class="status-badge completed" style="background:#6b7280; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">✅ Completada</span>',
        cancelled: '<span class="status-badge cancelled" style="background:#ef4444; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">❌ Cancelada</span>',
        reassigned: '<span class="status-badge reassigned" style="background:#d97706; color:#fff; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">🔄 Reasignada</span>'
    };

    container.innerHTML = filtered.map(ride => {
        let driverInfoHtml = '';
        const driverName = ride.assignedDriver?.name || ride.driver?.name || '';
        
        if (driverName) {
            driverInfoHtml = `<div style="font-size:12px; color:#60a5fa; margin-top:6px; font-weight:600;">🚕 Taxista: ${escapeHtml(driverName)}</div>`;
        } else if (ride.status === 'pending') {
            driverInfoHtml = `
                <div style="margin-top:8px; display:flex; gap:6px; align-items:center;">
                    <select class="assign-ride-select" data-ride-id="${ride.id}" style="width:100%; padding:4px 8px; background:#1e1e1e; color:#fff; border:1px solid #3b82f6; border-radius:6px; font-size:11px;">
                        <option value="">⚡ Asignar taxista manualmente...</option>
                        ${state.drivers.map(d => `<option value="${d.id}">🚕 ${escapeHtml(d.name)}</option>`).join('')}
                    </select>
                </div>
            `;
        }

        // Tiempos específicos por etapa
        let etaDetailsHtml = '';
        const estPickupMins = Math.max(2, Math.round((ride.distance || 5.0) * 0.25 * 2.5));

        if (ride.status === 'scheduled') {
            const schedDate = ride.scheduledAt ? new Date(ride.scheduledAt).toLocaleString() : 'Pendiente';
            const leadMin = ride.dispatchLeadTime || 15;
            etaDetailsHtml = `
                <div style="background:#082f49; border-left:3px solid #0284c7; border-radius:4px; padding:6px 8px; margin-top:8px; font-size:11px; color:#e0f2fe;">
                    <strong>📅 Reserva Programada:</strong> Recogida: ${escapeHtml(schedDate)}
                    <div style="font-size:10px; color:#7dd3fc; margin-top:2px;">Despacho automático ~${leadMin} min antes</div>
                </div>
            `;
        } else if (ride.status === 'accepted' || ride.status === 'assigned') {
            etaDetailsHtml = `
                <div style="background:#0c4a6e; border-left:3px solid #38bdf8; border-radius:4px; padding:6px 8px; margin-top:8px; font-size:11px; color:#e0f2fe;">
                    <strong>⏱️ 1ª Parada (Recogida):</strong> Llega en ~${estPickupMins} min
                </div>
                <div style="font-size:11px; color:#94a3b8; margin-top:4px;">
                    🏁 Tiempo luego al destino: ~${ride.duration || 15} min (${ride.distance || 5.0} km)
                </div>
            `;
        } else if (ride.status === 'arrived_at_pickup') {
            etaDetailsHtml = `
                <div style="background:#2e1065; border-left:3px solid #c084fc; border-radius:4px; padding:6px 8px; margin-top:8px; font-size:11px; color:#f3e8ff;">
                    <strong>📍 En el punto de encuentro:</strong> Conductor esperando al pasajero
                </div>
                <div style="font-size:11px; color:#94a3b8; margin-top:4px;">
                    🏁 Siguiente parada: Destino final (~${ride.duration || 15} min)
                </div>
            `;
        } else if (ride.status === 'in_progress') {
            etaDetailsHtml = `
                <div style="background:#064e3b; border-left:3px solid #34d399; border-radius:4px; padding:6px 8px; margin-top:8px; font-size:11px; color:#ecfdf5;">
                    <strong>🚖 2ª Parada (En viaje al destino):</strong> Llega en ~${ride.duration || 15} min (${ride.distance || 5.0} km)
                </div>
            `;
        } else {
            etaDetailsHtml = `
                <div style="font-size:11px; color:#94a3b8; margin-top:6px;">
                    ⏱️ Estimado total: ~${ride.duration || 15} min • ${ride.distance || 5.0} km
                </div>
            `;
        }

        return `
        <div class="job-card" data-ride-id="${ride.id}" onclick="window.focusRideOnMap('${ride.id}')" style="background:#18181b; border:1px solid #27272a; border-radius:10px; padding:12px; margin-bottom:10px; cursor:pointer;">
            <div class="job-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span class="job-id" style="font-weight:bold; font-size:12px; color:#a1a1aa;">#${ride.id.slice(0, 8)}</span>
                ${statusBadge[ride.status] || ''}
            </div>
            <div class="job-locations" style="display:flex; flex-direction:column; gap:6px; font-size:13px;">
                <div class="location-row" style="display:flex; align-items:center; gap:6px;">
                    <span style="color:#22c55e;">📍</span>
                    <span class="address" style="color:#f4f4f5; font-weight:500;">${escapeHtml(ride.pickup?.address || 'Origen')}</span>
                </div>
                <div class="location-row" style="display:flex; align-items:center; gap:6px;">
                    <span style="color:#ef4444;">🏁</span>
                    <span class="address" style="color:#f4f4f5; font-weight:500;">${escapeHtml(ride.destination?.address || 'Destino')}</span>
                </div>
            </div>
            ${etaDetailsHtml}
            <div class="job-footer" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid #27272a; padding-top:8px;">
                <div class="customer-info" style="font-size:12px; color:#a1a1aa;">
                    <strong style="color:#fff;">${escapeHtml(ride.customerName || 'Cliente')}</strong>
                    ${ride.customerPhone ? `<span style="margin-left:4px;">(${escapeHtml(ride.customerPhone)})</span>` : ''}
                </div>
                <div class="job-fare" style="font-size:15px; font-weight:bold; color:#facc15;">
                    $${parseFloat(ride.fare || 15.00).toFixed(2)}
                </div>
            </div>
            ${driverInfoHtml}
            <div style="margin-top:8px; display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap;">
                ${['scheduled', 'pending', 'offered', 'assigned', 'accepted', 'arrived_at_pickup'].includes(ride.status) ? `
                    <button type="button" class="btn-edit-ride" data-ride-id="${ride.id}" style="background:#1e293b; color:#93c5fd; border:1px solid #3b82f6; border-radius:6px; padding:4px 9px; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:4px;">
                        <span>✏️ Editar</span>
                    </button>
                ` : ''}
                ${(ride.status === 'scheduled') ? `
                    <button type="button" class="btn-cancel-scheduled" data-ride-id="${ride.id}" style="background:#450a0a; color:#fca5a5; border:1px solid #dc2626; border-radius:6px; padding:4px 9px; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:4px;">
                        <span>❌ Cancelar</span>
                    </button>
                ` : ''}
                ${(ride.status === 'assigned' || ride.status === 'accepted' || ride.status === 'arrived_at_pickup' || ride.status === 'in_progress') ? `
                    <button type="button" class="btn-cancel-assignment" data-ride-id="${ride.id}" style="background:#450a0a; color:#fca5a5; border:1px solid #dc2626; border-radius:6px; padding:4px 9px; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:4px;">
                        <span>⚠️ Cancelar Asignación</span>
                    </button>
                ` : ''}
            </div>
        </div>
    `}).join('');

    // Listener para editar servicio
    container.querySelectorAll('.btn-edit-ride').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rideId = btn.dataset.rideId;
            openEditRideModal(rideId);
        });
    });

    // Listener para asignar manualmente taxista desde la tarjeta
    container.querySelectorAll('.assign-ride-select').forEach(sel => {
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', (e) => {
            e.stopPropagation();
            const rideId = sel.dataset.rideId;
            const driverId = e.target.value;
            if (rideId && driverId) {
                socket.emit('ride:assign', { rideId, driverId });
                showToast('Asignando', 'Asignando carrera al taxista seleccionado...');
            }
        });
    });

    // Listener para botón Cancelar Asignación / Incidencia
    container.querySelectorAll('.btn-cancel-assignment').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rideId = btn.dataset.rideId;
            openCancelAssignmentModal(rideId);
        });
    });

    // Listener para botón Cancelar Reserva Programada
    container.querySelectorAll('.btn-cancel-scheduled').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rideId = btn.dataset.rideId;
            socket.emit('ride:unassign', {
                rideId,
                reason: 'Cancelada por el despachador (reserva programada)',
                reassignMode: 'cancel'
            });
            showToast('Reserva Cancelada', 'La reserva programada fue cancelada exitosamente.');
        });
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

window.openCancelAssignmentModal = function(rideId) {
    const ride = state.rides.find(r => r.id === rideId);
    if (!ride) return;

    const modal = document.getElementById('cancelAssignmentModal');
    const rideInfoEl = document.getElementById('cancelModalRideInfo');
    const driverInfoEl = document.getElementById('cancelModalDriverInfo');
    const rideIdInput = document.getElementById('cancelModalRideId');
    const manualDriverSelect = document.getElementById('cancelReassignDriverSelect');

    if (rideIdInput) rideIdInput.value = ride.id;
    if (rideInfoEl) rideInfoEl.textContent = `Carrera #${ride.id.slice(0, 8)} • De: ${ride.pickup?.address || 'Origen'} -> A: ${ride.destination?.address || 'Destino'}`;
    
    const driverName = ride.assignedDriver?.name || ride.driver?.name || 'Taxista asignado';
    if (driverInfoEl) driverInfoEl.textContent = `Taxista actual: ${driverName}`;

    // Llenar selector de taxistas alternativos disponibles
    if (manualDriverSelect) {
        let html = '<option value="">-- Seleccionar taxista disponible --</option>';
        state.drivers.forEach(d => {
            html += `<option value="${d.id}">🚕 ${escapeHtml(d.name)} (${d.available ? 'Disponible' : 'Ocupado'})</option>`;
        });
        manualDriverSelect.innerHTML = html;
        manualDriverSelect.style.display = 'none';
    }

    // Resetear opciones del modal
    const autoRadio = document.querySelector('input[name="reassignAction"][value="auto"]');
    if (autoRadio) autoRadio.checked = true;

    const reasonSelect = document.getElementById('cancelReasonSelect');
    if (reasonSelect) reasonSelect.value = 'Accidente o falla mecánica del vehículo';

    const reasonOther = document.getElementById('cancelReasonOther');
    if (reasonOther) {
        reasonOther.value = '';
        reasonOther.style.display = 'none';
    }

    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
};

function setupCancelModalListeners() {
    const modal = document.getElementById('cancelAssignmentModal');
    const closeBtn = document.getElementById('btnCloseCancelModal');
    const dismissBtn = document.getElementById('btnDismissCancelModal');
    const confirmBtn = document.getElementById('btnConfirmCancelAssignment');
    const reasonSelect = document.getElementById('cancelReasonSelect');
    const reasonOther = document.getElementById('cancelReasonOther');
    const actionRadios = document.querySelectorAll('input[name="reassignAction"]');
    const manualDriverSelect = document.getElementById('cancelReassignDriverSelect');

    const closeModal = () => {
        if (modal) {
            modal.style.display = 'none';
            modal.classList.add('hidden');
        }
    };

    closeBtn?.addEventListener('click', closeModal);
    dismissBtn?.addEventListener('click', closeModal);

    reasonSelect?.addEventListener('change', () => {
        if (reasonSelect.value === 'otro') {
            if (reasonOther) reasonOther.style.display = 'block';
        } else {
            if (reasonOther) reasonOther.style.display = 'none';
        }
    });

    actionRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.value === 'manual') {
                if (manualDriverSelect) manualDriverSelect.style.display = 'block';
            } else {
                if (manualDriverSelect) manualDriverSelect.style.display = 'none';
            }
        });
    });

    confirmBtn?.addEventListener('click', () => {
        const rideId = document.getElementById('cancelModalRideId')?.value;
        if (!rideId) return;

        let reason = reasonSelect?.value || 'Cancelado por despachador';
        if (reason === 'otro') {
            reason = reasonOther?.value.trim() || 'Incidencia no especificada';
        }

        let reassignMode = 'auto';
        actionRadios.forEach(r => {
            if (r.checked) reassignMode = r.value;
        });

        const newDriverId = manualDriverSelect?.value || null;

        socket.emit('ride:unassign', {
            rideId,
            reason,
            reassignMode,
            newDriverId
        });

        closeModal();

        const actionText = reassignMode === 'auto' ? 
            'Asignación cancelada. Reasignando automáticamente a la flota activa...' :
            (reassignMode === 'manual' ? 'Asignación cancelada y transferida al nuevo taxista.' : 'Carrera cancelada definitivamente.');
        
        showToast('Incidencia Procesada', actionText);
    });
}

// ============================================
// FASE 4C-4 - EDICIÓN SEGURA DE SERVICIOS
// ============================================
let editInitialSnapshot = null;

function getEditFormData() {
    return {
        customerName: document.getElementById('editCustomerName')?.value?.trim() || '',
        customerPhone: document.getElementById('editCustomerPhone')?.value?.trim() || '',
        pickupAddress: document.getElementById('editPickupAddress')?.value?.trim() || '',
        destAddress: document.getElementById('editDestinationAddress')?.value?.trim() || '',
        passengerCount: document.getElementById('editPassengerCount')?.value || '1',
        vehicleCategory: document.getElementById('editVehicleCategory')?.value || 'standard',
        paymentMethod: document.getElementById('editPaymentMethod')?.value || 'cash',
        fare: document.getElementById('editFare')?.value || '15',
        isManualFare: Boolean(document.getElementById('editIsManualFare')?.checked),
        notes: document.getElementById('editNotes')?.value?.trim() || '',
        scheduledDate: document.getElementById('editScheduledDate')?.value || '',
        scheduledTime: document.getElementById('editScheduledTime')?.value || '',
        dispatchLeadTime: document.getElementById('editDispatchLeadTime')?.value || '15'
    };
}

function openEditRideModal(rideId) {
    const ride = state.rides.find(r => r.id === rideId);
    if (!ride) {
        showToast('Error', 'Carrera no encontrada');
        return;
    }

    const BLOCKED_STATES = ['in_progress', 'completed', 'cancelled', 'expired'];
    if (BLOCKED_STATES.includes(ride.status)) {
        showToast('No Editable', `Los servicios en estado "${ride.status}" no pueden ser editados.`);
        return;
    }

    const modal = document.getElementById('editRideModal');
    if (!modal) return;

    // Poblar campos
    const idInput = document.getElementById('editRideId');
    const versionInput = document.getElementById('editRideVersion');
    const badgeEl = document.getElementById('editRideIdBadge');
    const statusTextEl = document.getElementById('editRideStatusText');

    if (idInput) idInput.value = ride.id;
    if (versionInput) versionInput.value = ride.version || 1;
    if (badgeEl) badgeEl.textContent = `#${ride.id.slice(0, 8)}`;
    if (statusTextEl) statusTextEl.textContent = (ride.status || 'PENDING').toUpperCase();

    const nameInput = document.getElementById('editCustomerName');
    const phoneInput = document.getElementById('editCustomerPhone');
    const pickupInput = document.getElementById('editPickupAddress');
    const destInput = document.getElementById('editDestinationAddress');
    const passengersInput = document.getElementById('editPassengerCount');
    const vehicleInput = document.getElementById('editVehicleCategory');
    const paymentInput = document.getElementById('editPaymentMethod');
    const fareInput = document.getElementById('editFare');
    const isManualInput = document.getElementById('editIsManualFare');
    const notesInput = document.getElementById('editNotes');

    const schedSection = document.getElementById('editScheduledSection');
    const schedDateInput = document.getElementById('editScheduledDate');
    const schedTimeInput = document.getElementById('editScheduledTime');
    const leadTimeInput = document.getElementById('editDispatchLeadTime');

    if (nameInput) nameInput.value = ride.customerName || '';
    if (phoneInput) phoneInput.value = ride.customerPhone || '';
    if (pickupInput) pickupInput.value = typeof ride.pickup === 'string' ? ride.pickup : (ride.pickup?.address || '');
    if (destInput) destInput.value = typeof ride.destination === 'string' ? ride.destination : (ride.destination?.address || '');
    if (passengersInput) passengersInput.value = ride.passengerCount || '1';
    if (vehicleInput) vehicleInput.value = ride.vehicleCategory || 'standard';
    if (paymentInput) paymentInput.value = ride.paymentMethod || 'cash';
    if (fareInput) fareInput.value = ride.fare || 15.00;
    if (isManualInput) isManualInput.checked = Boolean(ride.isManualFare);
    if (notesInput) notesInput.value = ride.notes || '';

    // Manejo de estado scheduled
    if (ride.status === 'scheduled' && ride.isScheduled) {
        if (schedSection) schedSection.style.display = 'block';
        if (ride.scheduledAt) {
            const dt = new Date(ride.scheduledAt);
            if (!isNaN(dt.getTime())) {
                const year = dt.getFullYear();
                const month = String(dt.getMonth() + 1).padStart(2, '0');
                const day = String(dt.getDate()).padStart(2, '0');
                const hours = String(dt.getHours()).padStart(2, '0');
                const minutes = String(dt.getMinutes()).padStart(2, '0');
                if (schedDateInput) schedDateInput.value = `${year}-${month}-${day}`;
                if (schedTimeInput) schedTimeInput.value = `${hours}:${minutes}`;
            }
        }
        if (leadTimeInput) leadTimeInput.value = ride.dispatchLeadTime || '15';
    } else {
        if (schedSection) schedSection.style.display = 'none';
    }

    // Permisos por estado en UI
    const isOfferedOrAssigned = ['offered', 'assigned'].includes(ride.status);
    const isAcceptedOrArrived = ['accepted', 'arrived_at_pickup'].includes(ride.status);

    if (pickupInput) pickupInput.disabled = isOfferedOrAssigned || isAcceptedOrArrived;
    if (destInput) destInput.disabled = isOfferedOrAssigned || isAcceptedOrArrived;
    if (vehicleInput) vehicleInput.disabled = isOfferedOrAssigned || isAcceptedOrArrived;
    if (fareInput) fareInput.disabled = isOfferedOrAssigned || isAcceptedOrArrived;
    if (isManualInput) isManualInput.disabled = isOfferedOrAssigned || isAcceptedOrArrived;
    if (schedDateInput) schedDateInput.disabled = ride.status !== 'scheduled';
    if (schedTimeInput) schedTimeInput.disabled = ride.status !== 'scheduled';
    if (leadTimeInput) leadTimeInput.disabled = ride.status !== 'scheduled';

    if (passengersInput) passengersInput.disabled = isAcceptedOrArrived;
    if (paymentInput) paymentInput.disabled = isAcceptedOrArrived;

    // Snapshot para detectar cambios sin guardar
    editInitialSnapshot = JSON.stringify(getEditFormData());

    modal.style.display = 'flex';
}

function closeEditModal(force = false) {
    const modal = document.getElementById('editRideModal');
    if (!modal || modal.style.display === 'none') return;

    if (!force && editInitialSnapshot) {
        const currentData = JSON.stringify(getEditFormData());
        if (currentData !== editInitialSnapshot) {
            if (!confirm('Hay cambios sin guardar. ¿Deseas salir sin guardar?')) {
                return;
            }
        }
    }

    modal.style.display = 'none';
    editInitialSnapshot = null;
}

function setupEditModalListeners() {
    const btnClose = document.getElementById('btnCloseEditModal');
    const btnCancel = document.getElementById('btnCancelEdit');
    const form = document.getElementById('editRideForm');

    btnClose?.addEventListener('click', () => closeEditModal());
    btnCancel?.addEventListener('click', () => closeEditModal());

    form?.addEventListener('submit', (e) => {
        e.preventDefault();
        const saveBtn = document.getElementById('btnSaveEdit');
        if (saveBtn?.disabled) return;

        const rideId = document.getElementById('editRideId')?.value;
        const version = parseInt(document.getElementById('editRideVersion')?.value) || 1;
        const ride = state.rides.find(r => r.id === rideId);
        if (!ride) {
            showToast('Error', 'Carrera no encontrada en estado local');
            return;
        }

        const changes = {};
        const formData = getEditFormData();

        if (formData.customerName !== (ride.customerName || '')) changes.customerName = formData.customerName;
        if (formData.customerPhone !== (ride.customerPhone || '')) changes.customerPhone = formData.customerPhone;
        if (formData.notes !== (ride.notes || '')) changes.notes = formData.notes;
        if (parseInt(formData.passengerCount) !== (ride.passengerCount || 1)) changes.passengerCount = parseInt(formData.passengerCount);
        if (formData.vehicleCategory !== (ride.vehicleCategory || 'standard')) changes.vehicleCategory = formData.vehicleCategory;
        if (formData.paymentMethod !== (ride.paymentMethod || 'cash')) changes.paymentMethod = formData.paymentMethod;

        const currentPickup = typeof ride.pickup === 'string' ? ride.pickup : (ride.pickup?.address || '');
        if (formData.pickupAddress && formData.pickupAddress !== currentPickup) {
            changes.pickup = formData.pickupAddress;
        }

        const currentDest = typeof ride.destination === 'string' ? ride.destination : (ride.destination?.address || '');
        if (formData.destAddress && formData.destAddress !== currentDest) {
            changes.destination = formData.destAddress;
        }

        if (formData.isManualFare !== Boolean(ride.isManualFare)) {
            changes.isManualFare = formData.isManualFare;
            if (formData.isManualFare) {
                changes.manualFare = parseFloat(formData.fare) || 0;
            }
        } else if (formData.isManualFare && parseFloat(formData.fare) !== ride.fare) {
            changes.manualFare = parseFloat(formData.fare) || 0;
        }

        if (ride.status === 'scheduled' && ride.isScheduled) {
            if (formData.scheduledDate && formData.scheduledTime) {
                const localDt = new Date(`${formData.scheduledDate}T${formData.scheduledTime}`);
                if (!isNaN(localDt.getTime())) {
                    const newIso = localDt.toISOString();
                    if (newIso !== ride.scheduledAt) {
                        changes.scheduledAt = newIso;
                    }
                }
            }
            const lt = parseInt(formData.dispatchLeadTime) || 15;
            if (lt !== (ride.dispatchLeadTime || 15)) {
                changes.dispatchLeadTime = lt;
            }
        }

        if (Object.keys(changes).length === 0) {
            showToast('Sin Cambios', 'No se realizaron modificaciones.');
            closeEditModal(true);
            return;
        }

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = `<span>Guardando...</span>`;
        }

        const onEditedHandler = (updatedRide) => {
            if (updatedRide.id === rideId) {
                socket.off('ride:edited', onEditedHandler);
                socket.off('error', onErrorHandler);
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = `<span>💾 Guardar Cambios</span>`;
                }
                showToast('Servicio Actualizado', 'Los cambios fueron guardados exitosamente.');
                closeEditModal(true);
            }
        };

        const onErrorHandler = (err) => {
            socket.off('ride:edited', onEditedHandler);
            socket.off('error', onErrorHandler);
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = `<span>💾 Guardar Cambios</span>`;
            }
            showToast('Error al Guardar', err?.message || 'No se pudo guardar la edición.');
        };

        socket.once('ride:edited', onEditedHandler);
        socket.once('error', onErrorHandler);

        setTimeout(() => {
            if (saveBtn && saveBtn.disabled) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = `<span>💾 Guardar Cambios</span>`;
            }
        }, 6000);

        socket.emit('ride:edit', {
            rideId,
            version,
            changes
        });
    });
}

if (typeof window !== 'undefined') {
    window.openEditRideModal = openEditRideModal;
    window.closeEditModal = closeEditModal;
}

// ============================================
// FASE 4B - DASHBOARD OPERATIVO Y CONTADORES
// ============================================
function updateStats() {
    const rides = state.rides || [];
    const drivers = state.drivers || [];

    // 1. DASHBOARD DE CARRERAS (Estados reales existentes)
    const pendingCount = rides.filter(r => r.status === 'pending').length;
    const offeredCount = rides.filter(r => r.status === 'offered').length;
    const assignedCount = rides.filter(r => r.status === 'assigned' || r.status === 'accepted' || r.status === 'arrived_at_pickup').length;
    const activeCount = rides.filter(r => r.status === 'in_progress').length;
    const completedCount = rides.filter(r => r.status === 'completed').length;
    const cancelledCount = rides.filter(r => r.status === 'cancelled').length;

    // Desglose de contadores para filtros
    const assignedOnlyCount = rides.filter(r => r.status === 'assigned' || r.status === 'accepted').length;
    const arrivedCount = rides.filter(r => r.status === 'arrived_at_pickup').length;

    // 2. DASHBOARD DE CONDUCTORES (Estado local state.drivers)
    const onlineDrivers = drivers.filter(d => getDriverOperationalStatus(d) !== 'offline');
    const onlineCount = onlineDrivers.length;
    const availableCount = drivers.filter(d => getDriverOperationalStatus(d) === 'available').length;
    const offeredDriversCount = drivers.filter(d => getDriverOperationalStatus(d) === 'offered').length;
    const busyCount = drivers.filter(d => getDriverOperationalStatus(d) === 'busy').length;
    const offlineCount = drivers.filter(d => getDriverOperationalStatus(d) === 'offline').length;

    // 3. ACTUALIZACIÓN DOM - DASHBOARD OPERATIVO
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(Math.max(0, val));
    };

    // Strip de Carreras
    setText('statPendingRides', pendingCount);
    setText('statOfferedRides', offeredCount);
    setText('statAssignedRides', assignedCount);
    setText('statActiveRides', activeCount);
    setText('statCompletedRides', completedCount);
    setText('statCancelledRides', cancelledCount);

    // Strip de Conductores
    setText('statOnlineDrivers', onlineCount);
    setText('statAvailableDrivers', availableCount);
    setText('statOfferedDrivers', offeredDriversCount);
    setText('statBusyDrivers', busyCount);
    setText('statOfflineDrivers', offlineCount);

    // Compatibilidad retroactiva
    setText('pendingRides', pendingCount);
    setText('activeRides', activeCount);
    setText('totalDrivers', drivers.length);
    setText('availableCount', availableCount);
    setText('pendingCounter', `${pendingCount} pendientes`);

    // 4. ACTUALIZACIÓN DOM - FILTROS OPERATIVOS
    setText('countAll', rides.length);
    setText('countPending', pendingCount);
    setText('countOffered', offeredCount);
    setText('countAssigned', assignedOnlyCount);
    setText('countArrived', arrivedCount);
    setText('countInProgress', activeCount);
    setText('countCompleted', completedCount);
    setText('countCancelled', cancelledCount);

    // 5. INDICADORES DE ATENCIÓN OPERATIVA
    renderAttentionAlerts();
}

function calculateAttentionAlerts() {
    const alerts = [];
    const now = Date.now();
    const rides = state.rides || [];
    const drivers = state.drivers || [];

    // A. Carreras pendientes sin conductor asignado
    const unassignedPending = rides.filter(r => r.status === 'pending' && !r.assignedDriver && !r.driverId);
    if (unassignedPending.length > 0) {
        alerts.push({
            type: 'warning',
            message: `${unassignedPending.length} carrera${unassignedPending.length > 1 ? 's' : ''} pendiente${unassignedPending.length > 1 ? 's' : ''} sin conductor`,
            filter: 'pending'
        });
    }

    // B. Carreras ofrecidas esperando aceptación
    const offeredAwaiting = rides.filter(r => r.status === 'offered');
    if (offeredAwaiting.length > 0) {
        alerts.push({
            type: 'info',
            message: `${offeredAwaiting.length} carrera${offeredAwaiting.length > 1 ? 's' : ''} en proceso de oferta`,
            filter: 'offered'
        });
    }

    // C. Carreras reasignadas
    const reassignedRides = rides.filter(r => (r.rejectedDrivers && r.rejectedDrivers.length > 0) || r.status === 'reassigned');
    if (reassignedRides.length > 0) {
        alerts.push({
            type: 'warning',
            message: `${reassignedRides.length} carrera${reassignedRides.length > 1 ? 's' : ''} reasignada${reassignedRides.length > 1 ? 's' : ''}`,
            filter: 'all'
        });
    }

    // D. Conductores con GPS obsoleto (>30s sin actualización)
    const staleGpsDrivers = drivers.filter(d => {
        const isOnline = d.isOnline || d.status !== 'offline';
        if (!isOnline) return false;
        const lastLoc = d.lastLocationAt || (d.lastUpdate ? new Date(d.lastUpdate).getTime() : 0);
        return (now - lastLoc) > 30000;
    });
    if (staleGpsDrivers.length > 0) {
        alerts.push({
            type: 'danger',
            message: `${staleGpsDrivers.length} conductor${staleGpsDrivers.length > 1 ? 'es' : ''} con ⚠️ GPS sin actualizar (>30s)`,
            driverId: staleGpsDrivers[0].id || staleGpsDrivers[0].driverId
        });
    }

    // E. Conductores online sin señal GPS válida
    const noGpsDrivers = drivers.filter(d => {
        const isOnline = d.isOnline || d.status !== 'offline';
        if (!isOnline) return false;
        return !d.location || typeof d.location.lat !== 'number' || (d.location.lat === 0 && d.location.lng === 0);
    });
    if (noGpsDrivers.length > 0) {
        alerts.push({
            type: 'warning',
            message: `${noGpsDrivers.length} conductor${noGpsDrivers.length > 1 ? 'es' : ''} online sin señal GPS`,
            driverId: noGpsDrivers[0].id || noGpsDrivers[0].driverId
        });
    }

    return alerts;
}

function renderAttentionAlerts() {
    const banner = document.getElementById('attentionAlertsBar');
    if (!banner) return;

    const alerts = calculateAttentionAlerts();
    if (alerts.length === 0) {
        banner.innerHTML = `
            <div style="display:inline-flex; align-items:center; gap:8px; font-size:11px; color:#10b981; padding:4px 12px; background:rgba(6, 78, 59, 0.6); border:1px solid rgba(5, 150, 105, 0.4); border-radius:20px; backdrop-filter:blur(8px);">
                <span>🟢</span>
                <span>Operación en orden: Red de despacho activa y al día.</span>
            </div>
        `;
        return;
    }

    const alertsHtml = alerts.map(a => {
        const bg = a.type === 'danger' ? 'rgba(127, 29, 29, 0.75)' : (a.type === 'warning' ? 'rgba(120, 53, 15, 0.75)' : 'rgba(30, 58, 138, 0.75)');
        const border = a.type === 'danger' ? '#dc2626' : (a.type === 'warning' ? '#d97706' : '#2563eb');
        const text = a.type === 'danger' ? '#fca5a5' : (a.type === 'warning' ? '#fde68a' : '#bfdbfe');
        const clickHandler = a.filter ? `onclick="window.applyJobFilter('${a.filter}')"` : (a.driverId ? `onclick="window.focusDriver('${a.driverId}')"` : '');

        return `
            <div class="attention-chip" ${clickHandler} style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; color:${text}; background:${bg}; border:1px solid ${border}; padding:4px 10px; border-radius:20px; backdrop-filter:blur(8px); margin-right:6px; margin-bottom:4px; transition:transform 0.15s;" onmouseover="this.style.transform='scale(1.03)'" onmouseout="this.style.transform='scale(1)'">
                <span>⚠️</span>
                <span>${escapeHtml(a.message)}</span>
            </div>
        `;
    }).join('');

    banner.innerHTML = `<div style="display:flex; flex-wrap:wrap; align-items:center;">${alertsHtml}</div>`;
}

window.applyJobFilter = function(filterName) {
    state.currentFilter = filterName;
    document.querySelectorAll('.filter-chip').forEach(btn => {
        if (btn.dataset.filter === filterName) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    renderJobsList();
};

// ============================================
// EVENT LISTENERS DEL DESPACHO
// ============================================
// ============================================
// EVENT LISTENERS DEL DESPACHO & FORMULARIO AVANZADO
// ============================================
function setupEventListeners() {
    // 1. Selector de Modo: Inmediato vs Programado
    const btnModeImmediate = document.getElementById('btnModeImmediate');
    const btnModeScheduled = document.getElementById('btnModeScheduled');
    const serviceModeInput = document.getElementById('serviceMode');
    const scheduledFields = document.getElementById('scheduledFieldsContainer');
    const scheduledDateInput = document.getElementById('scheduledDate');
    const scheduledTimeInput = document.getElementById('scheduledTime');
    const dispatchLeadTimeSelect = document.getElementById('dispatchLeadTime');

    const updateServiceMode = (mode) => {
        if (!serviceModeInput) return;
        serviceModeInput.value = mode;

        if (mode === 'scheduled') {
            btnModeScheduled?.classList.add('active');
            if (btnModeScheduled) {
                btnModeScheduled.style.background = '#0284c7';
                btnModeScheduled.style.color = '#ffffff';
            }
            btnModeImmediate?.classList.remove('active');
            if (btnModeImmediate) {
                btnModeImmediate.style.background = 'transparent';
                btnModeImmediate.style.color = '#a1a1aa';
            }
            if (scheduledFields) scheduledFields.style.display = 'block';

            // Autocompletar fecha de hoy y hora + 30 minutos si están vacíos
            if (scheduledDateInput && !scheduledDateInput.value) {
                const now = new Date();
                scheduledDateInput.value = now.toISOString().split('T')[0];
                scheduledDateInput.min = now.toISOString().split('T')[0];
            }
            if (scheduledTimeInput && !scheduledTimeInput.value) {
                const future = new Date(Date.now() + 30 * 60 * 1000);
                const hh = String(future.getHours()).padStart(2, '0');
                const mm = String(future.getMinutes()).padStart(2, '0');
                scheduledTimeInput.value = `${hh}:${mm}`;
            }
        } else {
            btnModeImmediate?.classList.add('active');
            if (btnModeImmediate) {
                btnModeImmediate.style.background = '#2563eb';
                btnModeImmediate.style.color = '#ffffff';
            }
            btnModeScheduled?.classList.remove('active');
            if (btnModeScheduled) {
                btnModeScheduled.style.background = 'transparent';
                btnModeScheduled.style.color = '#a1a1aa';
            }
            if (scheduledFields) scheduledFields.style.display = 'none';
        }

        updateLiveSummary();
    };

    btnModeImmediate?.addEventListener('click', () => updateServiceMode('immediate'));
    btnModeScheduled?.addEventListener('click', () => updateServiceMode('scheduled'));

    // 2. Control de Tarifa: Calculada vs Manual
    const fareTypeCalculated = document.getElementById('fareTypeCalculated');
    const fareTypeManual = document.getElementById('fareTypeManual');
    const manualFareContainer = document.getElementById('manualFareContainer');
    const manualFareInput = document.getElementById('manualFareInput');

    const updateFareMode = () => {
        const isManual = fareTypeManual?.checked;
        if (manualFareContainer) {
            manualFareContainer.style.display = isManual ? 'block' : 'none';
        }
        updateLiveSummary();
    };

    fareTypeCalculated?.addEventListener('change', updateFareMode);
    fareTypeManual?.addEventListener('change', updateFareMode);
    manualFareInput?.addEventListener('input', updateLiveSummary);

    // 3. Actualizador de Resumen en Vivo
    function updateLiveSummary() {
        const mode = serviceModeInput?.value || 'immediate';
        const isScheduled = mode === 'scheduled';
        const isManual = fareTypeManual?.checked;

        // Tipo
        const typeEl = document.getElementById('summaryServiceType');
        if (typeEl) {
            typeEl.innerHTML = isScheduled ? '📅 SERVICIO PROGRAMADO' : '⚡ SERVICIO INMEDIATO';
            typeEl.style.color = isScheduled ? '#38bdf8' : '#60a5fa';
        }

        // Fila Programación
        const schedRow = document.getElementById('summaryScheduleRow');
        const pickupTimeEl = document.getElementById('summaryPickupTime');
        const dispatchTimeEl = document.getElementById('summaryDispatchTime');

        if (schedRow && pickupTimeEl && dispatchTimeEl) {
            if (isScheduled && scheduledDateInput?.value && scheduledTimeInput?.value) {
                schedRow.style.display = 'block';
                const localStr = `${scheduledDateInput.value}T${scheduledTimeInput.value}`;
                const dt = new Date(localStr);
                const lead = parseInt(dispatchLeadTimeSelect?.value || '15');
                const dispatchDt = new Date(dt.getTime() - lead * 60 * 1000);

                pickupTimeEl.textContent = !isNaN(dt.getTime()) ? `${scheduledDateInput.value} ${scheduledTimeInput.value}` : '--:--';
                dispatchTimeEl.textContent = !isNaN(dispatchDt.getTime()) ? `${String(dispatchDt.getHours()).padStart(2, '0')}:${String(dispatchDt.getMinutes()).padStart(2, '0')} (~${lead} min antes)` : '--:--';
            } else {
                schedRow.style.display = 'none';
            }
        }

        // Tarifa
        const fareEl = document.getElementById('summaryFare');
        const submitBtn = document.getElementById('btnSubmitJob') || document.querySelector('.btn-create-job');
        let currentFare = parseFloat(submitBtn?.dataset?.fare || '15.00');

        if (isManual && manualFareInput?.value && !isNaN(parseFloat(manualFareInput.value))) {
            currentFare = parseFloat(manualFareInput.value);
        }

        if (fareEl) {
            fareEl.textContent = `$${currentFare.toFixed(2)}`;
        }

        // Pasajero
        const passEl = document.getElementById('summaryPassenger');
        const cName = document.getElementById('customerName')?.value?.trim() || 'Cliente en Espera';
        const cPhone = document.getElementById('customerPhone')?.value?.trim();
        if (passEl) {
            passEl.textContent = cPhone ? `${cName} (${cPhone})` : cName;
        }

        // Ruta
        const routeEl = document.getElementById('summaryRoute');
        const pAddr = document.getElementById('pickupAddress')?.value?.trim() || 'Origen';
        const dAddr = document.getElementById('destinationAddress')?.value?.trim() || 'Destino';
        const dist = submitBtn?.dataset?.distance || '5.0';
        const dur = submitBtn?.dataset?.duration || '15';
        if (routeEl) {
            routeEl.textContent = `${pAddr} ➔ ${dAddr} (~${dist} km • ~${dur} min)`;
        }

        // Detalles
        const vehicleEl = document.getElementById('summaryVehicle');
        const passengersEl = document.getElementById('summaryPassengers');
        const paymentEl = document.getElementById('summaryPayment');

        const vSel = document.getElementById('vehicleCategory');
        const pCount = document.getElementById('passengerCount')?.value || '1';
        const paySel = document.getElementById('paymentMethod');

        if (vehicleEl && vSel) vehicleEl.textContent = vSel.options[vSel.selectedIndex]?.text || 'Standard';
        if (passengersEl) passengersEl.textContent = `${pCount} Pasajero${pCount > 1 ? 's' : ''}`;
        if (paymentEl && paySel) paymentEl.textContent = paySel.options[paySel.selectedIndex]?.text || 'Efectivo';
    }

    // Listeners para actualizar resumen en vivo
    ['customerName', 'customerPhone', 'pickupAddress', 'destinationAddress', 'scheduledDate', 'scheduledTime', 'passengerCount'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateLiveSummary);
    });
    ['dispatchLeadTime', 'vehicleCategory', 'paymentMethod'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', updateLiveSummary);
    });

    // Prevenir envío accidental con Enter en campos de cliente
    document.getElementById('customerName')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('customerPhone')?.focus();
        }
    });

    document.getElementById('customerPhone')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('pickupAddress')?.focus();
        }
    });

    // 4. Envío y Validación del Formulario de Creación
    const handleJobSubmit = async (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        const btn = document.getElementById('btnSubmitJob') || document.querySelector('.btn-create-job');
        if (btn?.disabled) return; // Protección contra doble click

        const customerName = document.getElementById('customerName')?.value?.trim() || '';
        const customerPhone = document.getElementById('customerPhone')?.value?.trim() || '';
        const pickupInput = document.getElementById('pickupAddress');
        const destInput = document.getElementById('destinationAddress');
        const pickupAddress = pickupInput?.value?.trim() || '';
        const destAddress = destInput?.value?.trim() || '';
        const notes = document.getElementById('notes')?.value?.trim() || '';
        const assignedDriverId = document.getElementById('assignedDriverSelect')?.value || null;

        const mode = serviceModeInput?.value || 'immediate';
        const isScheduled = mode === 'scheduled';

        // Validar direcciones
        if (!pickupAddress || !destAddress) {
            showToast('Direcciones Requeridas', 'Por favor ingresa punto de recogida y destino');
            return;
        }

        // Validar programación si es modo programado
        let scheduledAtIso = null;
        let leadTimeMinutes = 15;

        if (isScheduled) {
            const sDate = scheduledDateInput?.value;
            const sTime = scheduledTimeInput?.value;

            if (!sDate) {
                showToast('Fecha Requerida', 'Por favor selecciona la fecha de recogida');
                scheduledDateInput?.focus();
                return;
            }

            if (!sTime) {
                showToast('Hora Requerida', 'Por favor selecciona la hora de recogida');
                scheduledTimeInput?.focus();
                return;
            }

            const localDateTime = new Date(`${sDate}T${sTime}`);
            if (isNaN(localDateTime.getTime())) {
                showToast('Fecha Inválida', 'La fecha u hora seleccionada no es válida');
                return;
            }

            const now = Date.now();
            if (localDateTime.getTime() <= now) {
                showToast('Fecha en el Pasado', 'La hora de recogida no puede ser en el pasado');
                return;
            }

            const diffMinutes = (localDateTime.getTime() - now) / (60 * 1000);
            if (diffMinutes < 10) {
                showToast('Anticipación Insuficiente', 'El servicio programado debe tener al menos 10 minutos de anticipación');
                return;
            }

            scheduledAtIso = localDateTime.toISOString();
            leadTimeMinutes = parseInt(dispatchLeadTimeSelect?.value || '15') || 15;
        }

        // Validar pasajeros
        const passengerCount = parseInt(document.getElementById('passengerCount')?.value || '1') || 1;
        if (passengerCount < 1 || passengerCount > 8) {
            showToast('Pasajeros Inválido', 'La cantidad de pasajeros debe estar entre 1 y 8');
            return;
        }

        // Validar categoría y método de pago
        const vehicleCategory = document.getElementById('vehicleCategory')?.value || 'standard';
        const paymentMethod = document.getElementById('paymentMethod')?.value || 'cash';

        // Validar tarifa
        const isManualFare = Boolean(fareTypeManual?.checked);
        let finalFare = parseFloat(btn?.dataset?.fare || '15.00');
        let manualFareVal = null;

        if (isManualFare) {
            const mVal = parseFloat(manualFareInput?.value);
            if (isNaN(mVal) || mVal < 0) {
                showToast('Tarifa Inválida', 'Por favor ingresa un monto válido y no negativo para la tarifa manual');
                manualFareInput?.focus();
                return;
            }
            finalFare = mVal;
            manualFareVal = mVal;
        }

        const distance = parseFloat(btn?.dataset?.distance || '5.0');
        const duration = parseInt(btn?.dataset?.duration || '15');
        const pLat = parseFloat(pickupInput?.dataset?.lat || '0');
        const pLng = parseFloat(pickupInput?.dataset?.lng || '0');
        const dLat = parseFloat(destInput?.dataset?.lat || '0');
        const dLng = parseFloat(destInput?.dataset?.lng || '0');

        const clientNameFinal = customerName || 'Cliente en Espera';
        const clientPhoneFinal = customerPhone || '';

        // Bloquear botón contra doble click
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span>⏳ Procesando servicio...</span>`;
        }

        const payload = {
            customerName: clientNameFinal,
            customerPhone: clientPhoneFinal,
            pickup: { address: pickupAddress, lat: pLat, lng: pLng },
            destination: { address: destAddress, lat: dLat, lng: dLng },
            assignedDriverId: assignedDriverId || null,
            fare: finalFare,
            isManualFare,
            manualFare: manualFareVal,
            passengerCount,
            vehicleCategory,
            paymentMethod,
            distance,
            duration,
            notes,
            isScheduled,
            scheduledAt: scheduledAtIso,
            dispatchLeadTime: isScheduled ? leadTimeMinutes : 0
        };

        // Escuchar confirmación o error del backend
        const onCreatedHandler = (createdRide) => {
            socket.off('ride:created', onCreatedHandler);
            socket.off('error', onErrorHandler);

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<span>✓ ¡Servicio Creado!</span><i data-lucide="check"></i>`;
                setTimeout(() => {
                    btn.innerHTML = `<span>Crear Servicio</span><i data-lucide="arrow-right"></i>`;
                    if (typeof lucide !== 'undefined') lucide.createIcons();
                }, 2500);
            }

            // Limpiar campos principales
            if (pickupInput) pickupInput.value = '';
            if (destInput) destInput.value = '';
            document.getElementById('notes').value = '';
            showToast('Servicio Creado', isScheduled ? '📅 Reserva programada guardada exitosamente.' : '⚡ Servicio creado y emitido.');
            updateLiveSummary();
        };

        const onErrorHandler = (err) => {
            socket.off('ride:created', onCreatedHandler);
            socket.off('error', onErrorHandler);

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<span>Crear Servicio</span><i data-lucide="arrow-right"></i>`;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }

            showToast('Error', err?.message || 'No se pudo crear el servicio.');
        };

        socket.once('ride:created', onCreatedHandler);
        socket.once('error', onErrorHandler);

        // Timeout de seguridad para desbloquear el botón si no responde el servidor en 6s
        setTimeout(() => {
            if (btn && btn.disabled) {
                btn.disabled = false;
                btn.innerHTML = `<span>Crear Servicio</span><i data-lucide="arrow-right"></i>`;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }, 6000);

        // Emitir al servidor
        socket.emit('ride:create', payload);
    };

    const submitBtn = document.getElementById('btnSubmitJob') || document.querySelector('.btn-create-job');
    if (submitBtn) {
        submitBtn.addEventListener('click', handleJobSubmit);
    }

    const jobForm = document.getElementById('newJobForm');
    if (jobForm) {
        jobForm.addEventListener('submit', handleJobSubmit);
    }

    // Inicializar resumen en vivo
    updateLiveSummary();

    // 5. Filtros de carreras
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            window.applyJobFilter(chip.dataset.filter || 'all');
        });
    });

    // 6. Búsqueda de Servicios en Tiempo Real (FASE 4C-3)
    const searchInput = document.getElementById('jobSearchInput');
    const searchClearBtn = document.getElementById('btnSearchClear');

    if (searchInput) {
        let searchDebounce = null;
        searchInput.addEventListener('input', (e) => {
            const val = e.target.value;
            if (searchClearBtn) {
                searchClearBtn.style.display = val.trim() ? 'flex' : 'none';
            }
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                state.searchQuery = val.trim();
                renderJobsList();
            }, 60);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                if (searchClearBtn) searchClearBtn.style.display = 'none';
                state.searchQuery = '';
                renderJobsList();
            }
        });
    }

    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                searchClearBtn.style.display = 'none';
                searchInput.focus();
            }
            state.searchQuery = '';
            renderJobsList();
        });
    }

    // 7. Controles del mapa
    const centerBtn = document.getElementById('centerMap');
    if (centerBtn) {
        centerBtn.addEventListener('click', () => {
            if (state.drivers.length > 0 && state.drivers[0].location) {
                state.map.panTo(state.drivers[0].location);
                state.map.setZoom(14);
            } else if (state.map) {
                state.map.panTo({ lat: 40.7128, lng: -74.0060 });
                state.map.setZoom(12);
            }
        });
    }

    const trafficBtn = document.getElementById('toggleTraffic');
    if (trafficBtn) {
        trafficBtn.addEventListener('click', () => {
            if (!state.trafficLayer) {
                state.trafficLayer = new google.maps.TrafficLayer();
                state.trafficLayer.setMap(state.map);
                trafficBtn.classList.add('active');
            } else {
                state.trafficLayer.setMap(null);
                state.trafficLayer = null;
                trafficBtn.classList.remove('active');
            }
        });
    }
}

// UI & Utils
function startClock() {
    function update() {
        const timeEl = document.getElementById('currentTime');
        if (timeEl) {
            timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    }
    update();
    setInterval(update, 1000);
}

function updateConnectionStatus() {
    const statusEl = document.getElementById('connectionStatus');
    if (!statusEl) return;
    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('span');
    if (dot && text) {
        if (state.connected) {
            dot.style.background = '#10b981';
            text.textContent = 'Sistema Online';
        } else {
            dot.style.background = '#ef4444';
            text.textContent = 'Desconectado';
        }
    }
}

function showToast(title, message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <div class="toast-content">
            <div class="toast-text">
                <div class="toast-title">${escapeHtml(title)}</div>
                <div class="toast-message">${escapeHtml(message)}</div>
            </div>
        </div>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
}

function getInitials(name) { return name ? name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'TX'; }
function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text || ''; return div.innerHTML; }

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
