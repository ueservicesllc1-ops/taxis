# 🚂 Desplegar en Railway

## Pasos para desplegar TaxiPro en Railway

### 1️⃣ Preparar el Proyecto

Asegúrate de que tu código esté listo:
```bash
# Verificar que todo funciona localmente
npm start
```

### 2️⃣ Crear Proyecto en Railway

1. Ve a [Railway.app](https://railway.app)
2. Clic en "New Project"
3. Selecciona "Deploy from GitHub repo"
4. Conecta tu repositorio de TaxiPro

### 3️⃣ Configurar Variables de Entorno

**Opción A: Importar desde JSON (Recomendado)**

1. En Railway, ve a tu proyecto → Variables
2. Clic en "Raw Editor"
3. Copia el contenido de `railway-env.json`
4. Pégalo en el editor
5. Clic en "Update Variables"

**Opción B: Agregar manualmente**

Copia cada variable del archivo `railway-env.json` una por una.

### 4️⃣ Variables CRÍTICAS a Modificar

⚠️ **ANTES de Deploy, cambia estos valores:**

```json
{
  "NODE_ENV": "production",
  "ALLOWED_ORIGINS": "https://tu-app.railway.app",  // ← Tu dominio de Railway
  "JWT_SECRET": "genera-un-string-random-seguro-aqui",  // ← Genera nuevo
  "SESSION_SECRET": "otro-string-random-diferente-min-32-chars"  // ← Genera nuevo
}
```

**Para generar secrets seguros:**
```bash
# En tu terminal local
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5️⃣ Configurar Build & Start

Railway debería detectar automáticamente tu `package.json`, pero verifica:

**Build Command:**
```bash
npm install
```

**Start Command:**
```bash
npm start
```

### 6️⃣ Configurar Puerto

Railway asigna un puerto dinámico. Tu código ya está configurado:
```javascript
const PORT = process.env.PORT || 3000;
```
✅ No necesitas cambiar nada.

### 7️⃣ Deploy

1. Push tu código a GitHub
2. Railway detectará los cambios y desplegará automáticamente
3. Espera 2-3 minutos
4. Obtén tu URL: `https://tu-app.railway.app`

### 8️⃣ Verificar Deployment

Abre en el navegador:
```
https://tu-app.railway.app/health
```

Deberías ver:
```json
{
  "status": "OK",
  "timestamp": "...",
  "uptime": 123.45,
  "drivers": 0,
  "rides": 0
}
```

### 9️⃣ Actualizar CORS

Después del deploy, actualiza la variable `ALLOWED_ORIGINS`:
```json
{
  "ALLOWED_ORIGINS": "https://tu-app.railway.app,https://www.tu-dominio.com"
}
```

### 🔟 Configurar Dominio Personalizado (Opcional)

1. En Railway → Settings → Domains
2. Agregar dominio personalizado
3. Configurar DNS según instrucciones
4. Actualizar `ALLOWED_ORIGINS`

---

## 🔒 SEGURIDAD POST-DEPLOY

### ⚠️ IMPORTANTE: Rotar API Keys

Tus API keys están expuestas en el código frontend. Debes:

#### 1. Google Maps API
```
1. Ve a Google Cloud Console
2. APIs & Services → Credentials
3. Edita tu API Key
4. Agrega restricciones:
   - Application restrictions: HTTP referrers
   - Website restrictions: 
     * https://tu-app.railway.app/*
     * https://tu-dominio.com/*
5. API restrictions: Solo Maps JavaScript API, Places API
```

#### 2. Firebase
```
1. Firebase Console → Project Settings
2. Revisa las reglas de Firestore (ya optimizadas)
3. Configura App Check para protección adicional
4. Activa reCAPTCHA en Authentication
```

---

## 📊 Monitoreo

### Ver Logs en Railway
```
1. Railway Dashboard → Tu Proyecto
2. Tab "Deployments"
3. Clic en el deployment activo
4. Ver logs en tiempo real
```

### Logs de tu App
Los logs se guardan en archivo con Winston:
- Ver en Railway → Deployments → Logs
- Filtrar por nivel: `error`, `warn`, `info`

---

## 🚨 Troubleshooting

### Error: "Cannot connect to server"
- ✅ Verifica que las variables de entorno estén configuradas
- ✅ Revisa los logs de Railway
- ✅ Asegúrate que el puerto es `process.env.PORT`

### Error: "CORS blocked"
- ✅ Actualiza `ALLOWED_ORIGINS` con tu dominio de Railway
- ✅ Incluye https:// en la URL

### Error: "Firebase authentication failed"
- ✅ Verifica las credenciales de Firebase
- ✅ Revisa que el dominio esté autorizado en Firebase Console

### Socket.io no conecta
- ✅ Asegúrate que usas `const socket = io()` (sin URL hardcoded)
- ✅ Railway debe soportar WebSockets (lo hace por defecto)

---

## 📝 Checklist de Deploy

- [ ] Variables de entorno configuradas en Railway
- [ ] `JWT_SECRET` y `SESSION_SECRET` generados (nuevos, no del ejemplo)
- [ ] `ALLOWED_ORIGINS` actualizado con dominio de Railway
- [ ] `NODE_ENV` = "production"
- [ ] Código pusheado a GitHub
- [ ] Deploy exitoso en Railway
- [ ] `/health` endpoint responde OK
- [ ] Apps frontend cargan correctamente
- [ ] Socket.io conecta
- [ ] Google Maps funciona
- [ ] Firebase auth funciona
- [ ] API Keys restringidas en Google Cloud Console
- [ ] Logs funcionando

---

## 🎯 Comandos Útiles de Railway CLI (Opcional)

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link a tu proyecto
railway link

# Ver logs en tiempo real
railway logs

# Ejecutar comandos en producción
railway run npm run migrate
```

---

## 📞 Soporte

Si encuentras problemas:
1. Revisa los logs de Railway
2. Verifica las variables de entorno
3. Consulta `OPTIMIZATION_REPORT.md` para troubleshooting

---

**¡Tu app está lista para Railway! 🚀**
