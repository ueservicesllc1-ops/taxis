# 🗺️ Configuración de Google Maps

Para que el mapa funcione correctamente en la interfaz de despacho, necesitas obtener una **API Key de Google Maps**.

## Pasos para obtener tu API Key:

1. Ve a [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un nuevo proyecto o selecciona uno existente
3. Ve a **APIs & Services** > **Credentials**
4. Haz clic en **Create Credentials** > **API Key**
5. Habilita las siguientes APIs:
   - Maps JavaScript API
   - Places API
   - Geocoding API
   - Directions API

## Configuración:

1. Abre el archivo `public/dispatch/index-v2.html`
2. Busca la línea que dice:
```html
<script src="https://maps.googleapis.com/maps/api/js?key=YOUR_GOOGLE_MAPS_API_KEY&libraries=places" async defer></script>
```
3. Reemplaza `YOUR_GOOGLE_MAPS_API_KEY` con tu API Key real

## Restricciones Recomendadas:

Para proteger tu API Key:
1. En Google Cloud Console, ve a tu API Key
2. Agrega restricción de sitio web (HTTP referrers)
3. Agrega: `localhost:*` y tu dominio de producción

## Alternativa Gratuita:

Si no quieres usar Google Maps inmediatamente, puedes usar:
- **Mapbox** (50,000 vistas gratis/mes)
- **Leaflet + OpenStreetMap** (completamente gratis)

La aplicación funcionará sin problemas sin el mapa, solo no mostrará la visualización geográfica.
