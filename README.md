# 🚕 TaxiPro - Plataforma de Despacho de Taxis

Una plataforma completa para gestión de taxis similar a Uber, con web app de despacho para la base y app móvil para taxistas.

## 📋 Características

### 🆕 Versión 2.0 - Interfaz Mejorada

#### Web App de Despacho (Base) - **CON MAPA INTEGRADO**
- ✅ **Interfaz de 3 columnas** con mapa central (inspirada en sistemas profesionales)
- ✅ **Google Maps integrado** con visualización de taxistas y rutas en tiempo real
- ✅ Recepción de llamadas y creación de carreras
- ✅ Visualización de taxistas disponibles con geolocalización
- ✅ Lanzamiento de carreras a taxistas cercanos
- ✅ Seguimiento de carreras activas en el mapa
- ✅ Filtros por estado (pendiente, aceptada, en curso)
- ✅ Notificaciones en tiempo real con toasts
- ✅ Panel de estadísticas en vivo
- ✅ **Firebase Firestore** para persistencia de datos
- ✅ Diseño moderno estilo dashboard administrativo
- ✅ Reloj en tiempo real

### Web App para Taxistas (Mobile-First)
- ✅ Login de taxistas con información de vehículo
- ✅ Toggle de disponibilidad
- ✅ Recepción de notificaciones de nuevas carreras
- ✅ Aceptar/rechazar carreras
- ✅ Información del cliente y destino
- ✅ Estados de carrera (aceptada, en curso, completada)
- ✅ Estadísticas diarias (carreras y ganancias)
- ✅ Geolocalización en tiempo real
- ✅ Diseño optimizado para móvil

### Backend
- ✅ Servidor Node.js + Express
- ✅ WebSockets con Socket.io para tiempo real
- ✅ Cálculo de distancia entre taxista y recogida
- ✅ Gestión de carreras y taxistas
- ✅ API REST para consultas

## 🚀 Instalación

### Prerequisitos
- Node.js (v14 o superior)
- npm o yarn
- Cuenta de Firebase (para autenticación y base de datos)
- Google Maps API Key

### Pasos

1. **Clonar el repositorio**
```bash
git clone <tu-repositorio>
cd Taxis
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar variables de entorno**

Copia el archivo `.env.example` a `.env`:
```bash
cp .env.example .env
```

Edita el archivo `.env` y configura tus credenciales:
```env
NODE_ENV=development
PORT=3000

# Firebase
FIREBASE_API_KEY=tu_api_key_aqui
FIREBASE_AUTH_DOMAIN=tu_proyecto.firebaseapp.com
# ... (completa todas las variables)

# Google Maps
GOOGLE_MAPS_API_KEY=tu_google_maps_api_key
```

**⚠️ IMPORTANTE:** 
- Nunca compartas tu archivo `.env`
- Rota tus API keys si fueron expuestas
- Configura restricciones en Google Cloud Console

4. **Iniciar el servidor**
```bash
npm start
```

Para desarrollo con auto-reload:
```bash
npm run dev
```

5. **Acceder a las aplicaciones**
- **App de Despacho**: http://localhost:3000
- **App de Taxistas**: http://localhost:3000/driver
- **Health Check**: http://localhost:3000/health

## 📱 Uso

### Para Despachadores

1. Abre http://localhost:3000 en tu navegador
2. Ingresa tu nombre cuando se te solicite
3. Espera a que se conecten taxistas
4. Cuando un cliente llame:
   - Ingresa nombre y teléfono del cliente
   - Ingresa dirección de origen
   - Ingresa dirección de destino
   - Haz clic en "Lanzar Carrera"
5. Los taxistas cercanos recibirán la notificación
6. Verás cuando un taxista acepte la carrera

### Para Taxistas

1. Abre http://localhost:3000/driver en tu teléfono o navegador
2. Ingresa tus datos:
   - Nombre completo
   - Vehículo (marca y modelo)
   - Placa
3. Haz clic en "Iniciar Sesión"
4. Activa tu disponibilidad con el botón superior derecho
5. Recibirás notificaciones de carreras disponibles
6. Revisa la información y acepta/rechaza
7. Si aceptas, sigue los pasos:
   - **Iniciar Carrera**: Al llegar al punto de recogida
   - **Completar Carrera**: Al llegar al destino

## 🛠️ Tecnologías Utilizadas

- **Frontend**: HTML5, CSS3 (Vanilla), JavaScript (ES6+)
- **Backend**: Node.js, Express
- **Tiempo Real**: Socket.io
- **Geolocalización**: Geolocation API
- **Notificaciones**: Web Notifications API
- **PWA Ready**: Wake Lock API, Vibration API

## 📂 Estructura del Proyecto

```
Taxis/
├── server/
│   └── index.js              # Servidor backend
├── public/
│   ├── dispatch/             # App de Despacho
│   │   ├── index.html
│   │   ├── css/
│   │   │   └── dispatch.css
│   │   └── js/
│   │       └── dispatch.js
│   └── driver/               # App de Taxistas
│       ├── index.html
│       ├── css/
│       │   └── driver.css
│       └── js/
│           └── driver.js
├── package.json
└── README.md
```

## 🔧 Configuración Avanzada

### Puerto del Servidor
Por defecto el servidor corre en el puerto 3000. Para cambiarlo:

```bash
PORT=8080 npm start
```

### Integración con Google Maps (Próximamente)
Para agregar funcionalidad de mapas y geocoding:

1. Obtén una API Key de Google Maps
2. Agrega el script en index.html:
```html
<script src="https://maps.googleapis.com/maps/api/js?key=TU_API_KEY&libraries=places"></script>
```
3. Implementa la geocodificación en dispatch.js y driver.js

## 📊 Próximas Características

- [ ] Base de datos persistente (MongoDB/Firebase)
- [ ] Integración con Google Maps
- [ ] Historial de carreras
- [ ] Sistema de calificaciones
- [ ] Chat entre despachador y taxista
- [ ] Reportes y estadísticas
- [ ] Panel de administración
- [ ] Autenticación de usuarios
- [ ] Cálculo automático de tarifas
- [ ] Múltiples bases/centrales

## 🔐 Notas de Seguridad

⚠️ **IMPORTANTE**: Este es un MVP para desarrollo. Para producción, debes:

- Implementar autenticación segura
- Usar HTTPS
- Validar y sanitizar todas las entradas
- Implementar rate limiting
- Usar una base de datos segura
- Proteger las API keys
- Implementar logs de auditoría

## 📱 Empaquetar como App Móvil

Para convertir la web app de taxistas en una app nativa:

### Con Capacitor (Recomendado)
```bash
npm install @capacitor/core @capacitor/cli
npx cap init
npx cap add android
npx cap add ios
npx cap sync
```

### Con Cordova
```bash
npm install -g cordova
cordova create taxidriver com.taxipro.driver TaxiProDriver
# Copiar archivos de public/driver a www/
cordova platform add android
cordova platform add ios
cordova build
```

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Por favor:

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## 📄 Licencia

MIT License - siéntete libre de usar este proyecto para tus necesidades.

## 📞 Soporte

Para preguntas o soporte, abre un issue en el repositorio.

---

**Desarrollado con ❤️ para revolucionar el transporte de taxis**
