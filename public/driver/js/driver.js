import { auth, googleProvider, signInWithPopup, db, storage, doc, getDoc, setDoc, updateDoc, ref, uploadBytes, getDownloadURL, onAuthStateChanged } from '../../config/firebase.js';

// Conexión Socket.io (usa el host actual automáticamente)
const socket = io();

// Estado de la aplicación
const state = {
    driver: null,
    currentRide: null,
    availableRides: [],
    stats: {
        todayRides: 0,
        todayEarnings: 0
    },
    available: false,
    connected: false,
    location: null,
    user: null // Firebase Auth User
};

// Datos de Vehículos (USA Comunes)
const vehicleData = {
    "Toyota": ["Camry", "Corolla", "Prius", "RAV4", "Highlander", "Sienna", "Tacoma"],
    "Honda": ["Civic", "Accord", "CR-V", "Pilot", "Odyssey", "HR-V"],
    "Ford": ["F-150", "Escape", "Explorer", "Fusion", "Mustang", "Edge"],
    "Chevrolet": ["Malibu", "Impala", "Equinox", "Traverse", "Tahoe", "Suburban"],
    "Nissan": ["Altima", "Sentra", "Rogue", "Versa", "Pathfinder"],
    "Hyundai": ["Elantra", "Sonata", "Tucson", "Santa Fe"],
    "Kia": ["Optima", "Sorento", "Soul", "Sportage", "Forte"],
    "Tesla": ["Model 3", "Model Y", "Model S", "Model X"],
    "Jeep": ["Grand Cherokee", "Wrangler", "Cherokee", "Compass"],
    "Subaru": ["Outback", "Forester", "Crosstrek", "Impreza"],
    "Volkswagen": ["Jetta", "Passat", "Tiguan", "Atlas"],
    "BMW": ["3 Series", "5 Series", "X3", "X5"],
    "Mercedes-Benz": ["C-Class", "E-Class", "GLC", "GLE"],
    "Ram": ["1500", "2500"],
    "GMC": ["Sierra", "Terrain", "Acadia", "Yukon"]
};

// Elementos del DOM
const elements = {
    loginScreen: document.getElementById('loginScreen'),
    mainScreen: document.getElementById('mainScreen'),
    loginActions: document.getElementById('loginActions'),
    googleLoginBtn: document.getElementById('googleLoginBtn'),
    registrationForm: document.getElementById('registrationForm'),
    pendingView: document.getElementById('pendingView'),
    checkStatusBtn: document.getElementById('checkStatusBtn'),

    // Registration Fields
    regName: document.getElementById('regName'),
    regEmail: document.getElementById('regEmail'),
    regPhone: document.getElementById('regPhone'),
    regAddress: document.getElementById('regAddress'),
    regBrand: document.getElementById('regBrand'),
    regModel: document.getElementById('regModel'),
    regYear: document.getElementById('regYear'),
    regColor: document.getElementById('regColor'),
    regPlate: document.getElementById('regPlate'),
    regLicense: document.getElementById('regLicense'),
    licenseUpload: document.getElementById('licenseUpload'),
    licensePreview: document.getElementById('licensePreview'),

    // Main UI
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    toggleAvailability: document.getElementById('toggleAvailability'),
    availabilityText: document.getElementById('availabilityText'),
    driverAvatarLarge: document.getElementById('driverAvatarLarge'),
    welcomeName: document.getElementById('welcomeName'),
    vehicleInfo: document.getElementById('vehicleInfo'),
    todayRides: document.getElementById('todayRides'),
    todayEarnings: document.getElementById('todayEarnings'),
    availableRides: document.getElementById('availableRides'),
    currentRideSection: document.getElementById('currentRideSection'),
    currentRideCard: document.getElementById('currentRideCard'),
    toast: document.getElementById('toast'),
    rideNotification: document.getElementById('rideNotification'),
    rideAccepted: document.getElementById('rideAccepted')
};

// Inicialización
function init() {
    setupAuthListener();
    setupSocketListeners();
    setupEventListeners();
    startLocationTracking();
    initVehicleSelects();

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function initVehicleSelects() {
    // Llenar Marcas
    const brands = Object.keys(vehicleData).sort();
    brands.forEach(brand => {
        const option = document.createElement('option');
        option.value = brand;
        option.textContent = brand;
        elements.regBrand.appendChild(option);
    });

    // Llenar Años (2015 - 2026)
    const currentYear = 2026;
    for (let year = currentYear; year >= 2015; year--) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        elements.regYear.appendChild(option);
    }

    // Listener para cambio de Marca
    elements.regBrand.addEventListener('change', (e) => {
        const brand = e.target.value;
        elements.regModel.innerHTML = '<option value="">Selecciona Modelo</option>';

        if (brand && vehicleData[brand]) {
            elements.regModel.disabled = false;
            vehicleData[brand].sort().forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                elements.regModel.appendChild(option);
            });
        } else {
            elements.regModel.disabled = true;
            elements.regModel.innerHTML = '<option value="">Selecciona Marca primero</option>';
        }
    });
}

// Auth Listener
function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            console.log('Usuario autenticado:', user.email);
            state.user = user;
            await checkDriverStatus(user);
        } else {
            console.log('No hay usuario autenticado');
            showLoginView();
        }
    });
}

// Check Driver Status in Firestore
async function checkDriverStatus(user) {
    try {
        const driverRef = doc(db, "drivers", user.uid);
        const driverSnap = await getDoc(driverRef);

        if (driverSnap.exists()) {
            const driverData = driverSnap.data();
            console.log('Driver data found:', driverData);

            if (driverData.status === 'approved') {
                proceedToMainApp(driverData);
            } else if (driverData.status === 'pending') {
                showPendingView();
            } else if (driverData.status === 'rejected') {
                alert('Tu solicitud ha sido rechazada. Contacta a administración.');
                auth.signOut();
            }
        } else {
            console.log('Nuevo conductor, mostrar registro');
            showRegistrationForm(user);
        }
    } catch (error) {
        console.error("Error checking driver status:", error);
        if (error.code === 'permission-denied') {
            alert("Error de permisos: No se pudo acceder a la base de datos. Por favor, asegúrate de que las reglas de Firebase permitan lectura/escritura a usuarios autenticados.");
        } else {
            alert("Error verificando estado: " + error.message);
        }
    }
}

// UI Transtions
function showLoginView() {
    elements.loginScreen.classList.remove('hidden');
    elements.mainScreen.classList.add('hidden');
    elements.loginActions.classList.remove('hidden');
    elements.registrationForm.classList.add('hidden');
    elements.pendingView.classList.add('hidden');
}

function showRegistrationForm(user) {
    elements.loginActions.classList.add('hidden');
    elements.registrationForm.classList.remove('hidden');

    elements.regName.value = user.displayName || '';
    elements.regEmail.value = user.email || '';

    // Init Autocomplete
    setTimeout(initAddressAutocomplete, 500);
}

function initAddressAutocomplete() {
    if (typeof google === 'undefined' || !elements.regAddress) return;

    const autocomplete = new google.maps.places.Autocomplete(elements.regAddress, {
        fields: ["formatted_address", "geometry"],
        strictBounds: false,
    });

    autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        if (place.formatted_address) {
            elements.regAddress.value = place.formatted_address;
        }
    });
}

function showPendingView() {
    elements.loginActions.classList.add('hidden');
    elements.registrationForm.classList.add('hidden');
    elements.pendingView.classList.remove('hidden');
}

function proceedToMainApp(driverData) {
    state.driver = driverData;

    socket.emit('register:driver', {
        id: auth.currentUser.uid,
        ...driverData,
        location: state.location || { lat: 0, lng: 0 }
    });

    elements.driverAvatarLarge.textContent = getInitials(driverData.name);
    elements.welcomeName.textContent = driverData.name;
    elements.vehicleInfo.textContent = `${driverData.vehicle.brand} ${driverData.vehicle.model} - ${driverData.vehicle.plate}`;

    elements.loginScreen.classList.add('hidden');
    elements.mainScreen.classList.remove('hidden');
}

// Event Listeners
function setupEventListeners() {
    elements.googleLoginBtn.addEventListener('click', async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error) {
            console.error("Error login:", error);
            alert("Error iniciando sesión con Google");
        }
    });

    elements.regLicense.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function (e) {
                elements.licensePreview.querySelector('img').src = e.target.result;
                elements.licensePreview.classList.remove('hidden');
                elements.licenseUpload.classList.add('hidden');
            }
            reader.readAsDataURL(file);
        }
    });

    elements.licensePreview.querySelector('.btn-remove-file').addEventListener('click', () => {
        elements.regLicense.value = '';
        elements.licensePreview.classList.add('hidden');
        elements.licenseUpload.classList.remove('hidden');
    });

    elements.registrationForm.addEventListener('submit', handleRegistration);

    elements.checkStatusBtn.addEventListener('click', () => {
        if (state.user) checkDriverStatus(state.user);
    });

    elements.toggleAvailability.addEventListener('click', toggleAvailability);
}

// Handle Registration
async function handleRegistration(e) {
    e.preventDefault();

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    try {
        const user = auth.currentUser;
        if (!user) throw new Error("No usuario autenticado");

        const licenseFile = elements.regLicense.files[0];
        let licenseUrl = '';

        if (licenseFile) {
            try {
                const storageRef = ref(storage, `licenses/${user.uid}/${licenseFile.name}`);
                await uploadBytes(storageRef, licenseFile);
                licenseUrl = await getDownloadURL(storageRef);
            } catch (storageError) {
                console.error("Error subiendo imagen (probablemente CORS o Permisos):", storageError);
                // No bloqueamos el registro, solo avisamos
                alert("Nota: La imagen no se pudo guardar por restricciones del navegador (CORS), pero tu registro continuará.");
            }
        }

        const driverData = {
            id: user.uid,
            name: elements.regName.value,
            email: elements.regEmail.value,
            phone: elements.regPhone.value,
            address: elements.regAddress.value,
            vehicle: {
                brand: elements.regBrand.value,
                model: elements.regModel.value,
                year: elements.regYear.value,
                color: elements.regColor.value,
                plate: elements.regPlate.value
            },
            documents: {
                licenseUrl: licenseUrl
            },
            status: 'pending',
            createdAt: new Date().toISOString(),
            rating: 5.0,
            ridesCompleted: 0
        };

        await setDoc(doc(db, "drivers", user.uid), driverData);
        showPendingView();

    } catch (error) {
        console.error("Error registering:", error);
        alert("Error al registrar: " + error.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Enviar Solicitud';
    }
}

// Socket.io Event Listeners
function setupSocketListeners() {
    socket.on('connect', () => {
        state.connected = true;
        updateConnectionStatus();

        // Force sync: Always start as Unavailable on connect/refresh
        state.available = false;
        updateAvailabilityUI(); // Update button UI

        // Inform server we are unavailable freshly connected
        socket.emit('driver:availability', {
            driverId: state.user?.uid || auth.currentUser?.uid,
            available: false,
            location: state.location
        });
    });

    socket.on('disconnect', () => {
        state.connected = false;
        updateConnectionStatus();
    });

    socket.on('ride:new', (ride) => {
        addAvailableRide(ride);
        playNotificationSound();
        showToast('Nueva Carrera', `${ride.pickup.address}`);
        vibratePhone();
    });

    socket.on('ride:assigned', (ride) => {
        state.currentRide = ride;
        state.availableRides = state.availableRides.filter(r => r.id !== ride.id);
        renderAvailableRides();
        renderCurrentRide();
        playAcceptedSound();
        showToast('Carrera Asignada', 'Dirígete al punto de recogida');
    });

    socket.on('ride:cancelled', (ride) => {
        if (state.currentRide && state.currentRide.id === ride.id) {
            state.currentRide = null;
            renderCurrentRide();
        }
        state.availableRides = state.availableRides.filter(r => r.id !== ride.id);
        renderAvailableRides();
        showToast('Carrera Cancelada', 'La carrera fue cancelada');
    });

    socket.on('ride:error', (data) => {
        showToast('Error', data.message);
    });
}

// Update Firestore Availability
async function toggleAvailability() {
    if (!state.user || state.driver?.status !== 'approved') return;

    // Toggle state
    const newStatus = !state.available;

    try {
        // Optimistic UI Update first
        state.available = newStatus;
        updateAvailabilityUI();

        // Update Persistence in Firestore
        const userRef = doc(db, "drivers", state.user.uid);
        await updateDoc(userRef, {
            available: newStatus,
            location: state.location,
            lastSeen: new Date().toISOString()
        });

        // Also emit via socket (optional but good for server logic)
        socket.emit('driver:availability', {
            driverId: state.user.uid,
            available: newStatus,
            location: state.location
        });

    } catch (error) {
        console.error("Error updating availability:", error);
        // Rollback UI if failed
        state.available = !newStatus;
        updateAvailabilityUI();
        showToast('Error', 'No se pudo conectar con el servidor');
    }
}

function updateAvailabilityUI() {
    if (state.available) {
        elements.toggleAvailability.classList.add('available');
        elements.toggleAvailability.innerHTML = '<i data-lucide="check"></i><span>Disponible</span>';
        elements.toggleAvailability.style.backgroundColor = '#22c55e'; // Green explicit
        elements.toggleAvailability.style.borderColor = '#22c55e';
        showToast('Disponible', 'Ahora estás disponible para carreras');
    } else {
        elements.toggleAvailability.classList.remove('available');
        elements.toggleAvailability.innerHTML = '<i data-lucide="power"></i><span>Desconectado</span>';
        elements.toggleAvailability.style.backgroundColor = 'transparent'; // Reset
        elements.toggleAvailability.style.borderColor = '#374151';
        showToast('No Disponible', 'No recibirás nuevas carreras');
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function startLocationTracking() {
    if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                state.location = { lat: position.coords.latitude, lng: position.coords.longitude };
            },
            (error) => { console.error('Error location:', error); state.location = { lat: 0, lng: 0 }; }
        );

        setInterval(() => {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    state.location = { lat: position.coords.latitude, lng: position.coords.longitude };
                    if (state.connected && state.driver?.status === 'approved') {
                        socket.emit('driver:location', state.location);
                    }
                },
                (error) => console.error('Error updating location:', error)
            );
        }, 10000);
    } else {
        state.location = { lat: 0, lng: 0 };
    }
}

function addAvailableRide(ride) {
    if (state.availableRides.find(r => r.id === ride.id)) return;
    ride.receivedAt = Date.now();
    state.availableRides.unshift(ride);
    renderAvailableRides();
}

function renderAvailableRides() {
    if (state.availableRides.length === 0) {
        elements.availableRides.innerHTML = `
            <div class="empty-state">
                <i data-lucide="inbox" style="width: 48px; height: 48px; color: #9ca3af; margin-bottom: 0.5rem;"></i>
                <p>Esperando carreras...</p>
            </div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
    }

    elements.availableRides.innerHTML = state.availableRides
        .map(ride => createRideCard(ride, false))
        .join('');

    document.querySelectorAll('[data-accept-ride]').forEach(btn => {
        btn.addEventListener('click', () => {
            const rideId = btn.dataset.acceptRide;
            socket.emit('ride:accept', { rideId, driverId: state.user.uid });
        });
    });

    document.querySelectorAll('[data-reject-ride]').forEach(btn => {
        btn.addEventListener('click', () => {
            const rideId = btn.dataset.rejectRide;
            state.availableRides = state.availableRides.filter(r => r.id !== rideId);
            renderAvailableRides();
            showToast('Rechazada', 'Carrera rechazada');
        });
    });

    startRideTimers();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderCurrentRide() {
    if (!state.currentRide) {
        elements.currentRideSection.classList.add('hidden');
        return;
    }
    elements.currentRideSection.classList.remove('hidden');
    elements.currentRideCard.innerHTML = createRideCard(state.currentRide, true);

    const startBtn = document.querySelector('[data-start-ride]');
    const completeBtn = document.querySelector('[data-complete-ride]');

    if (startBtn) {
        startBtn.addEventListener('click', () => {
            socket.emit('ride:start', state.currentRide.id);
            state.currentRide.status = 'in_progress';
            renderCurrentRide();
            showToast('En Camino', 'Carrera iniciada');
        });
    }

    if (completeBtn) {
        completeBtn.addEventListener('click', () => {
            const fare = prompt('Ingrese el monto de la carrera:', '10');
            if (fare) {
                socket.emit('ride:complete', { rideId: state.currentRide.id, fare: parseFloat(fare) });
                state.stats.todayRides++;
                state.stats.todayEarnings += parseFloat(fare);
                updateStats();
                state.currentRide = null;
                renderCurrentRide();
                showToast('Completada', `Carrera completada - $${fare}`);
            }
        });
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function createRideCard(ride, isCurrent) {
    const isAccepted = ride.status === 'accepted';
    const isInProgress = ride.status === 'in_progress';
    return `
        <div class="ride-card ${isCurrent ? 'current-ride' : 'new'}">
            <div class="ride-header">
                <span class="ride-id">#${ride.id.slice(0, 8)}</span>
                ${!isCurrent ? '<span class="ride-timer" id="timer-' + ride.id + '">--:--</span>' : ''}
            </div>
            ${isCurrent && isAccepted ? `
                <div class="ride-progress">
                    <div class="progress-steps">
                        <div class="progress-step ${isAccepted ? 'active' : ''}">Aceptada</div>
                        <div class="progress-step ${isInProgress ? 'active' : ''}">En Camino</div>
                        <div class="progress-step">Completada</div>
                    </div>
                </div>
            ` : ''}
            <div class="ride-locations">
                <div class="ride-location">
                    <div class="location-icon"><i data-lucide="map-pin"></i></div>
                    <div class="location-info">
                        <div class="location-label">Punto de Recogida</div>
                        <div class="location-address">${escapeHtml(ride.pickup.address)}</div>
                    </div>
                </div>
                <div class="ride-location">
                    <div class="location-icon"><i data-lucide="flag"></i></div>
                    <div class="location-info">
                        <div class="location-label">Destino</div>
                        <div class="location-address">${escapeHtml(ride.destination.address)}</div>
                    </div>
                </div>
            </div>
            <div class="ride-customer">
                <i data-lucide="user"></i>
                <strong>${escapeHtml(ride.customerName)}</strong>
                <span>•</span>
                <a href="tel:${ride.customerPhone}" style="color: var(--primary); text-decoration: none;">${escapeHtml(ride.customerPhone)}</a>
            </div>
            ${!isCurrent ? `
                <div class="ride-actions">
                    <button class="btn-primary btn-outline" data-reject-ride="${ride.id}">Rechazar</button>
                    <button class="btn-primary btn-success" data-accept-ride="${ride.id}">Aceptar Carrera</button>
                </div>
            ` : ''}
            ${isCurrent && isAccepted && !isInProgress ? `
                <div class="ride-actions single">
                    <button class="btn-primary btn-success" data-start-ride="${ride.id}">Iniciar Carrera</button>
                </div>
            ` : ''}
            ${isCurrent && isInProgress ? `
                <div class="ride-actions single">
                    <button class="btn-primary btn-success" data-complete-ride="${ride.id}">Completar Carrera</button>
                </div>
            ` : ''}
        </div>
    `;
}

function startRideTimers() {
    state.availableRides.forEach(ride => {
        const timerElement = document.getElementById(`timer-${ride.id}`);
        if (timerElement) {
            const elapsed = Math.floor((Date.now() - ride.receivedAt) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    });
    setTimeout(startRideTimers, 1000);
}

function updateStats() {
    elements.todayRides.textContent = state.stats.todayRides;
    elements.todayEarnings.textContent = `$${state.stats.todayEarnings.toFixed(2)}`;
}

function updateConnectionStatus() {
    const dot = elements.statusIndicator.querySelector('.status-dot');
    if (state.connected) {
        elements.statusText.textContent = 'Conectado';
        dot.classList.add('connected');
    } else {
        elements.statusText.textContent = 'Desconectado';
        dot.classList.remove('connected');
    }
}

function showToast(title, message) {
    const toastTitle = elements.toast.querySelector('.toast-title');
    const toastMessage = elements.toast.querySelector('.toast-message');
    toastTitle.textContent = title;
    toastMessage.textContent = message;
    elements.toast.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(() => elements.toast.classList.add('hidden'), 4000);
}

function playNotificationSound() { elements.rideNotification.play().catch(e => console.log('No sound')); }
function playAcceptedSound() { elements.rideAccepted.play().catch(e => console.log('No sound')); }
function vibratePhone() { if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]); }
function getInitials(name) { return name ? name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'D'; }
function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text || ''; return div.innerHTML; }

init();
