// Conexión Socket.io (usa el host actual automáticamente)
const socket = io();

// Estado de la aplicación
const state = {
    rides: [],
    drivers: [],
    currentFilter: 'all',
    dispatcherId: null,
    connected: false
};

// Elementos del DOM
const elements = {
    form: document.getElementById('newRideForm'),
    customerName: document.getElementById('customerName'),
    customerPhone: document.getElementById('customerPhone'),
    pickupAddress: document.getElementById('pickupAddress'),
    destinationAddress: document.getElementById('destinationAddress'),
    notes: document.getElementById('notes'),
    ridesList: document.getElementById('ridesList'),
    availableDrivers: document.getElementById('availableDrivers'),
    connectionStatus: document.getElementById('connectionStatus'),
    filterBtns: document.querySelectorAll('.filter-btn'),
    notificationSound: document.getElementById('notificationSound')
};

// Inicialización
function init() {
    setupSocketListeners();
    setupEventListeners();
    registerDispatcher();
}

// Registro del despachador
function registerDispatcher() {
    const dispatcherName = prompt('Ingrese su nombre:', 'Operador 1') || 'Operador 1';
    socket.emit('register:dispatcher', { name: dispatcherName });
    document.getElementById('dispatcherName').textContent = dispatcherName;
}

// Event Listeners de Socket.io
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('✅ Conectado al servidor');
        state.connected = true;
        updateConnectionStatus();
    });

    socket.on('disconnect', () => {
        console.log('❌ Desconectado del servidor');
        state.connected = false;
        updateConnectionStatus();
    });

    socket.on('registered', (data) => {
        state.dispatcherId = data.id;
        console.log('Registrado como:', data.type, data.id);
    });

    socket.on('driver:online', (driver) => {
        console.log('Taxista conectado:', driver.name);
        addOrUpdateDriver(driver);
        playNotification();
    });

    socket.on('driver:offline', (data) => {
        console.log('Taxista desconectado:', data.driverId);
        removeDriver(data.driverId);
    });

    socket.on('driver:location_update', (data) => {
        updateDriverLocation(data.driverId, data.location);
    });

    socket.on('ride:created', (ride) => {
        console.log('Carrera creada:', ride.id);
        addRide(ride);
        showNotification('Carrera creada', `Carrera ${ride.id.slice(0, 8)} creada exitosamente`);
    });

    socket.on('ride:update', (ride) => {
        updateRide(ride);
    });

    socket.on('ride:accepted', (ride) => {
        console.log('Carrera aceptada:', ride.id, 'por', ride.driver.name);
        updateRide(ride);
        playNotification();
        showNotification('🎉 Carrera Aceptada', `${ride.driver.name} aceptó la carrera`);
    });

    socket.on('ride:started', (ride) => {
        updateRide(ride);
        showNotification('🚖 Carrera Iniciada', `${ride.driver.name} inició la carrera`);
    });

    socket.on('ride:completed', (ride) => {
        updateRide(ride);
        playNotification();
        showNotification('✅ Carrera Completada', `Carrera finalizada - $${ride.fare}`);
    });

    socket.on('ride:cancelled', (ride) => {
        updateRide(ride);
        showNotification('❌ Carrera Cancelada', 'La carrera fue cancelada');
    });
}

// Event Listeners del DOM
function setupEventListeners() {
    // Submit del formulario
    elements.form.addEventListener('submit', handleFormSubmit);

    // Filtros
    elements.filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.currentFilter = btn.dataset.filter;
            renderRides();
        });
    });

    // Autocompletado de direcciones (simulado)
    elements.pickupAddress.addEventListener('input', debounce(handleAddressInput, 300));
    elements.destinationAddress.addEventListener('input', debounce(handleAddressInput, 300));
}

// Manejar envío del formulario
function handleFormSubmit(e) {
    e.preventDefault();

    const rideData = {
        customerName: elements.customerName.value.trim(),
        customerPhone: elements.customerPhone.value.trim(),
        pickup: {
            address: elements.pickupAddress.value.trim(),
            lat: 0, // Esto se obtendría de un servicio de geocoding
            lng: 0
        },
        destination: {
            address: elements.destinationAddress.value.trim(),
            lat: 0,
            lng: 0
        },
        notes: elements.notes.value.trim()
    };

    // Emitir evento para crear carrera
    socket.emit('ride:create', rideData);

    // Limpiar formulario
    elements.form.reset();

    // Efecto visual
    const submitBtn = elements.form.querySelector('.btn-primary');
    submitBtn.textContent = '✓ Carrera Lanzada';
    setTimeout(() => {
        submitBtn.innerHTML = '<span>Lanzar Carrera</span><svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/></svg>';
    }, 2000);
}

// Manejar autocompletado de direcciones
function handleAddressInput(e) {
    const value = e.target.value;
    if (value.length < 3) return;

    // Aquí se integraría con Google Places API o similar
    // Por ahora, solo un placeholder
    console.log('Buscando direcciones para:', value);
}

// Agregar o actualizar taxista
function addOrUpdateDriver(driver) {
    const index = state.drivers.findIndex(d => d.id === driver.id);
    if (index !== -1) {
        state.drivers[index] = driver;
    } else {
        state.drivers.push(driver);
    }
    renderDrivers();
}

// Eliminar taxista
function removeDriver(driverId) {
    state.drivers = state.drivers.filter(d => d.id !== driverId);
    renderDrivers();
}

// Actualizar ubicación del taxista
function updateDriverLocation(driverId, location) {
    const driver = state.drivers.find(d => d.id === driverId);
    if (driver) {
        driver.location = location;
        // Actualizar en el mapa si está visible
    }
}

// Agregar carrera
function addRide(ride) {
    state.rides.unshift(ride); // Agregar al inicio
    renderRides();
}

// Actualizar carrera
function updateRide(ride) {
    const index = state.rides.findIndex(r => r.id === ride.id);
    if (index !== -1) {
        state.rides[index] = ride;
    } else {
        state.rides.unshift(ride);
    }
    renderRides();
}

// Renderizar taxistas
function renderDrivers() {
    const availableDrivers = state.drivers.filter(d => d.available);

    if (availableDrivers.length === 0) {
        elements.availableDrivers.innerHTML = '<p class="empty-state">No hay taxistas disponibles</p>';
        return;
    }

    elements.availableDrivers.innerHTML = availableDrivers.map(driver => `
        <div class="driver-item">
            <div class="driver-avatar">${getInitials(driver.name)}</div>
            <div class="driver-info">
                <h4>${escapeHtml(driver.name)}</h4>
                <p>${escapeHtml(driver.vehicle)} - ${escapeHtml(driver.plate)}</p>
            </div>
        </div>
    `).join('');
}

// Renderizar carreras
function renderRides() {
    let filteredRides = state.rides;

    // Aplicar filtro
    if (state.currentFilter !== 'all') {
        filteredRides = state.rides.filter(r => r.status === state.currentFilter);
    }

    // Filtrar solo carreras activas (no completadas ni canceladas)
    filteredRides = filteredRides.filter(r =>
        r.status !== 'completed' && r.status !== 'cancelled'
    );

    if (filteredRides.length === 0) {
        elements.ridesList.innerHTML = `
            <div class="empty-state-large">
                <svg width="80" height="80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
                <p>No hay carreras ${state.currentFilter === 'all' ? 'activas' : state.currentFilter}</p>
            </div>
        `;
        return;
    }

    elements.ridesList.innerHTML = filteredRides.map(ride => createRideCard(ride)).join('');

    // Agregar event listeners a botones de cancelar
    document.querySelectorAll('[data-cancel-ride]').forEach(btn => {
        btn.addEventListener('click', () => {
            const rideId = btn.dataset.cancelRide;
            if (confirm('¿Está seguro de cancelar esta carrera?')) {
                socket.emit('ride:cancel', rideId);
            }
        });
    });
}

// Crear tarjeta de carrera
function createRideCard(ride) {
    const statusText = {
        pending: 'Pendiente',
        accepted: 'Aceptada',
        in_progress: 'En Curso',
        completed: 'Completada',
        cancelled: 'Cancelada'
    };

    const statusEmoji = {
        pending: '⏳',
        accepted: '✓',
        in_progress: '🚖',
        completed: '✅',
        cancelled: '❌'
    };

    return `
        <div class="ride-card">
            <div class="ride-header">
                <span class="ride-id">#${ride.id.slice(0, 8)}</span>
                <span class="ride-status ${ride.status}">
                    ${statusEmoji[ride.status]} ${statusText[ride.status]}
                </span>
            </div>

            <div class="ride-details">
                <div class="ride-location">
                    <span class="ride-location-icon">📍</span>
                    <div class="ride-location-text">
                        <div class="ride-location-label">Origen</div>
                        <div class="ride-location-address">${escapeHtml(ride.pickup.address)}</div>
                    </div>
                </div>

                <div class="ride-location">
                    <span class="ride-location-icon">🎯</span>
                    <div class="ride-location-text">
                        <div class="ride-location-label">Destino</div>
                        <div class="ride-location-address">${escapeHtml(ride.destination.address)}</div>
                    </div>
                </div>
            </div>

            <div class="ride-customer">
                <span>👤</span>
                <strong>${escapeHtml(ride.customerName)}</strong>
                <span>•</span>
                <span>${escapeHtml(ride.customerPhone)}</span>
            </div>

            ${ride.driver ? `
                <div class="ride-driver">
                    <span>🚖</span>
                    <div>
                        <strong>${escapeHtml(ride.driver.name)}</strong>
                        <div style="font-size: 0.875rem; color: var(--text-secondary);">
                            ${escapeHtml(ride.driver.vehicle)} - ${escapeHtml(ride.driver.plate)}
                        </div>
                    </div>
                </div>
            ` : ''}

            ${ride.status === 'pending' || ride.status === 'accepted' ? `
                <div class="ride-actions">
                    <button class="btn-cancel" data-cancel-ride="${ride.id}">
                        Cancelar Carrera
                    </button>
                </div>
            ` : ''}
        </div>
    `;
}

// Actualizar estado de conexión
function updateConnectionStatus() {
    if (state.connected) {
        elements.connectionStatus.textContent = 'Conectado';
        elements.connectionStatus.classList.add('connected');
    } else {
        elements.connectionStatus.textContent = 'Desconectado';
        elements.connectionStatus.classList.remove('connected');
    }
}

// Utilidades
function getInitials(name) {
    return name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function playNotification() {
    elements.notificationSound.play().catch(e => console.log('No se pudo reproducir sonido'));
}

function showNotification(title, message) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
            body: message,
            icon: '/favicon.ico'
        });
    }
}

// Solicitar permisos de notificación
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

// Iniciar aplicación
init();
