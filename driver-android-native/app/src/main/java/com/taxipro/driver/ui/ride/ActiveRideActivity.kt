package com.taxipro.driver.ui.ride

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.location.Location
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.android.gms.maps.model.Marker
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.gms.maps.model.Polyline
import com.google.android.gms.maps.model.PolylineOptions
import com.taxipro.driver.R
import com.taxipro.driver.config.AppConfig
import com.taxipro.driver.databinding.ActivityActiveRideBinding
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.concurrent.thread
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

class ActiveRideActivity : AppCompatActivity(), OnMapReadyCallback, TextToSpeech.OnInitListener {

    private lateinit var binding: ActivityActiveRideBinding
    private var googleMap: GoogleMap? = null
    private var socket: Socket? = null
    private var tts: TextToSpeech? = null
    private var isVoiceEnabled = true

    // 0: 3D Conducción, 1: 2D Cenital, 2: Vista General de Ruta
    private var cameraMode = 0
    private var isAutoFollowing = true

    // 0: En camino a recoger, 1: En punto de encuentro, 2: En ruta al destino
    private var rideStage = 0

    private var rideId = ""
    private var pickupAddress = ""
    private var destinationAddress = ""
    private var fareAmount = ""
    private var passengerName = "Pasajero"
    private var customerPhone = ""

    private var pLat = 0.0
    private var pLng = 0.0
    private var dLat = 0.0
    private var dLng = 0.0

    private var pickupDistStr = ""
    private var tripDistStr = ""

    private var driverMarker: Marker? = null
    private var targetMarker: Marker? = null
    private var currentRoutePolyline: Polyline? = null
    private var decodedRoutePoints: List<LatLng> = emptyList()

    private val navHandler = Handler(Looper.getMainLooper())
    private var lastSpokenInstruction = ""

    // ALGORITMO DE DETECCIÓN DE DESVÍO DE RUTA (SEGURIDAD)
    private var offRouteWarningLevel = 0 // 0: Normal, 1: Desvío inicial (>300m), 2: Desvío crítico (>500m), 3: Cancelado (>750m)
    private var lastOffRouteWarningTimestamp = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityActiveRideBinding.inflate(layoutInflater)
        setContentView(binding.root)

        tts = TextToSpeech(this, this)

        rideId = intent.getStringExtra("rideId") ?: ""
        pickupAddress = intent.getStringExtra("pickup") ?: "Punto de Recogida"
        destinationAddress = intent.getStringExtra("destination") ?: "Destino Final"
        fareAmount = intent.getStringExtra("fare") ?: "$15.00"
        passengerName = intent.getStringExtra("passengerName") ?: "Pasajero"
        customerPhone = intent.getStringExtra("customerPhone") ?: ""
        pLat = intent.getDoubleExtra("pLat", 0.0)
        pLng = intent.getDoubleExtra("pLng", 0.0)
        dLat = intent.getDoubleExtra("dLat", 0.0)
        dLng = intent.getDoubleExtra("dLng", 0.0)

        pickupDistStr = intent.getStringExtra("pickupDistance") ?: "3 min (1.1 km) a recoger"
        tripDistStr = intent.getStringExtra("tripDistance") ?: "18 min (8.5 km) al destino"

        binding.tvPassengerName.text = passengerName

        persistActiveRideState()
        setupSocket()

        val mapFragment = supportFragmentManager
            .findFragmentById(R.id.activeRideMapFragment) as? SupportMapFragment
        mapFragment?.getMapAsync(this)

        updateUiStage()

        // Controles de Cámara y Navegación
        binding.btnCameraMode.setOnClickListener {
            toggleCameraMode()
        }

        binding.btnRecenter.setOnClickListener {
            isAutoFollowing = true
            binding.btnRecenter.visibility = View.GONE
            applyCameraForCurrentMode(isSmooth = true)
        }

        binding.btnVoiceToggle.setOnClickListener {
            isVoiceEnabled = !isVoiceEnabled
            if (isVoiceEnabled) {
                binding.ivVoiceIcon.setColorFilter(Color.parseColor("#22C55E"))
                speakVoiceInstruction("Guía por voz activada")
                Toast.makeText(this, "Guía por voz activada", Toast.LENGTH_SHORT).show()
            } else {
                binding.ivVoiceIcon.setColorFilter(Color.parseColor("#94A3B8"))
                tts?.stop()
                Toast.makeText(this, "Guía por voz silenciada", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnRideAction.setOnClickListener {
            handleStageAdvance()
        }

        binding.btnCancelActiveRide.setOnClickListener {
            showCancelRideDialog()
        }

        binding.btnCallPassenger.setOnClickListener {
            if (customerPhone.isNotEmpty()) {
                val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$customerPhone"))
                startActivity(intent)
            } else {
                Toast.makeText(this, "Llamando a $passengerName...", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnChatPassenger.setOnClickListener {
            Toast.makeText(this, "Chat con $passengerName disponible", Toast.LENGTH_SHORT).show()
        }

        startNavigationUpdates()
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale("es", "US"))
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts?.setLanguage(Locale("es", "ES"))
            }
            speakVoiceInstruction("Navegación iniciada. Conduzca con precaución.")
        }
    }

    private fun speakVoiceInstruction(text: String) {
        if (!isVoiceEnabled || text == lastSpokenInstruction) return
        lastSpokenInstruction = text
        try {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "NAV_INSTRUCTION")
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun toggleCameraMode() {
        cameraMode = (cameraMode + 1) % 3
        when (cameraMode) {
            0 -> {
                binding.tvCameraModeText.text = "3D CONDUCCIÓN"
                binding.ivCameraIcon.setColorFilter(Color.parseColor("#22C55E"))
            }
            1 -> {
                binding.tvCameraModeText.text = "2D CENITAL"
                binding.ivCameraIcon.setColorFilter(Color.parseColor("#3B82F6"))
            }
            2 -> {
                binding.tvCameraModeText.text = "RUTA COMPLETA"
                binding.ivCameraIcon.setColorFilter(Color.parseColor("#F59E0B"))
            }
        }
        isAutoFollowing = true
        binding.btnRecenter.visibility = View.GONE
        applyCameraForCurrentMode(isSmooth = true)
    }

    private fun persistActiveRideState() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("active_ride_id", rideId)
            .putInt("active_ride_stage", rideStage)
            .putString("active_pickup", pickupAddress)
            .putString("active_destination", destinationAddress)
            .putString("active_fare", fareAmount)
            .putString("active_passenger_name", passengerName)
            .putString("active_passenger_phone", customerPhone)
            .apply()
    }

    private fun clearActiveRideState() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        prefs.edit()
            .remove("active_ride_id")
            .remove("active_ride_stage")
            .apply()
    }

    private fun setupSocket() {
        val user = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser ?: return
        user.getIdToken(false).addOnSuccessListener { tokenResult ->
            val idToken = tokenResult.token ?: return@addOnSuccessListener
            try {
                val serverUrl = AppConfig.getServerUrl(this)
                val opts = IO.Options().apply {
                    auth = mapOf("token" to idToken)
                    reconnection = true
                    reconnectionAttempts = 10
                    reconnectionDelay = 1000
                }
                socket = IO.socket(serverUrl, opts)

                socket?.on("ride:cancelled") {
                    runOnUiThread {
                        speakVoiceInstruction("La carrera fue cancelada por la central.")
                        Toast.makeText(this, "Este viaje fue cancelado por la central.", Toast.LENGTH_LONG).show()
                        clearActiveRideState()
                        finish()
                    }
                }

                socket?.connect()
            } catch (e: Exception) {
                Log.e("ActiveRide", "Error connecting socket", e)
            }
        }
    }

    override fun onMapReady(map: GoogleMap) {
        googleMap = map
        try {
            googleMap?.setMapStyle(MapStyleOptions.loadRawResourceStyle(this, R.raw.uber_map_style))
        } catch (e: Exception) {
            e.printStackTrace()
        }
        googleMap?.uiSettings?.isCompassEnabled = true
        googleMap?.uiSettings?.isZoomControlsEnabled = false
        googleMap?.uiSettings?.isTiltGesturesEnabled = true
        googleMap?.uiSettings?.isRotateGesturesEnabled = true

        // Detectar si el usuario arrastra el mapa manualmente
        googleMap?.setOnCameraMoveStartedListener { reason ->
            if (reason == GoogleMap.OnCameraMoveStartedListener.REASON_GESTURE) {
                isAutoFollowing = false
                binding.btnRecenter.visibility = View.VISIBLE
            }
        }

        fetchRealRoutePolyline()
    }

    private fun getDriverLatLng(): LatLng {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val lat = prefs.getFloat("last_driver_lat", 0f).toDouble()
        val lng = prefs.getFloat("last_driver_lng", 0f).toDouble()
        return if (lat != 0.0 && lng != 0.0) {
            LatLng(lat, lng)
        } else if (pLat != 0.0 && pLng != 0.0) {
            LatLng(pLat - 0.003, pLng - 0.003)
        } else {
            LatLng(40.7128, -74.0060)
        }
    }

    private fun getTargetLatLng(): LatLng {
        return if (rideStage < 2) {
            if (pLat != 0.0 && pLng != 0.0) LatLng(pLat, pLng) else getDriverLatLng()
        } else {
            if (dLat != 0.0 && dLng != 0.0) LatLng(dLat, dLng) else LatLng(getDriverLatLng().latitude + 0.015, getDriverLatLng().longitude + 0.015)
        }
    }

    private fun calculateDistanceInMeters(targetLat: Double, targetLng: Double): Float {
        val driver = getDriverLatLng()
        val results = FloatArray(1)
        Location.distanceBetween(driver.latitude, driver.longitude, targetLat, targetLng, results)
        return results[0]
    }

    private fun getMinDistanceToRouteInMeters(driverPos: LatLng): Float {
        if (decodedRoutePoints.isEmpty()) {
            val target = getTargetLatLng()
            val res = FloatArray(1)
            Location.distanceBetween(driverPos.latitude, driverPos.longitude, target.latitude, target.longitude, res)
            return 0f
        }

        var minDistance = Float.MAX_VALUE
        val results = FloatArray(1)
        for (pt in decodedRoutePoints) {
            Location.distanceBetween(driverPos.latitude, driverPos.longitude, pt.latitude, pt.longitude, results)
            if (results[0] < minDistance) {
                minDistance = results[0]
            }
        }
        return minDistance
    }

    private fun calculateBearing(start: LatLng, end: LatLng): Float {
        val startLat = Math.toRadians(start.latitude)
        val startLng = Math.toRadians(start.longitude)
        val endLat = Math.toRadians(end.latitude)
        val endLng = Math.toRadians(end.longitude)

        val dLng = endLng - startLng
        val y = sin(dLng) * cos(endLat)
        val x = cos(startLat) * sin(endLat) - sin(startLat) * cos(endLat) * cos(dLng)
        val bearing = Math.toDegrees(atan2(y, x))
        return ((bearing + 360) % 360).toFloat()
    }

    private fun fetchRealRoutePolyline() {
        val driver = getDriverLatLng()
        val target = getTargetLatLng()

        thread {
            try {
                val urlStr = "https://router.project-osrm.org/route/v1/driving/${driver.longitude},${driver.latitude};${target.longitude},${target.latitude}?overview=full&geometries=polyline&steps=true"
                val url = URL(urlStr)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                conn.requestMethod = "GET"

                if (conn.responseCode == 200) {
                    val reader = BufferedReader(InputStreamReader(conn.inputStream))
                    val response = StringBuilder()
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        response.append(line)
                    }
                    reader.close()

                    val json = JSONObject(response.toString())
                    val routes = json.optJSONArray("routes")
                    if (routes != null && routes.length() > 0) {
                        val route = routes.getJSONObject(0)
                        val geometry = route.getString("geometry")
                        val points = decodePolyline(geometry)
                        runOnUiThread {
                            decodedRoutePoints = points
                            drawPhaseMap(isInitial = true)
                        }
                        return@thread
                    }
                }
            } catch (e: Exception) {
                Log.e("ActiveRide", "Error fetching OSRM route: ${e.message}")
            }

            // Fallback si no hay conexión OSRM
            runOnUiThread {
                decodedRoutePoints = listOf(driver, target)
                drawPhaseMap(isInitial = true)
            }
        }
    }

    private fun decodePolyline(encoded: String): List<LatLng> {
        val poly = ArrayList<LatLng>()
        var index = 0
        val len = encoded.length
        var lat = 0
        var lng = 0

        while (index < len) {
            var b: Int
            var shift = 0
            var result = 0
            do {
                b = encoded[index++].code - 63
                result = result or (b and 0x1f shl shift)
                shift += 5
            } while (b >= 0x20)
            val dlat = if (result and 1 != 0) (result shr 1).inv() else result shr 1
            lat += dlat

            shift = 0
            result = 0
            do {
                b = encoded[index++].code - 63
                result = result or (b and 0x1f shl shift)
                shift += 5
            } while (b >= 0x20)
            val dlng = if (result and 1 != 0) (result shr 1).inv() else result shr 1
            lng += dlng

            val p = LatLng(lat.toDouble() / 1E5, lng.toDouble() / 1E5)
            poly.add(p)
        }
        return poly
    }

    private fun drawPhaseMap(isInitial: Boolean = false) {
        if (googleMap == null) return

        currentRoutePolyline?.remove()
        targetMarker?.remove()

        val driverPos = getDriverLatLng()
        val targetPos = getTargetLatLng()

        // Marcador del auto del conductor
        if (driverMarker == null) {
            driverMarker = googleMap?.addMarker(
                MarkerOptions()
                    .position(driverPos)
                    .title("Tu Taxi")
                    .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_AZURE))
            )
        } else {
            driverMarker?.position = driverPos
        }

        val markerTitle = if (rideStage < 2) "Punto de Recogida ($passengerName)" else "Destino ($destinationAddress)"
        val markerColor = if (rideStage < 2) BitmapDescriptorFactory.HUE_GREEN else BitmapDescriptorFactory.HUE_RED

        targetMarker = googleMap?.addMarker(
            MarkerOptions()
                .position(targetPos)
                .title(markerTitle)
                .icon(BitmapDescriptorFactory.defaultMarker(markerColor))
        )

        // Dibujar trazado real por calles
        val routeColor = if (rideStage < 2) Color.parseColor("#2563EB") else Color.parseColor("#10B981")
        val polyOptions = PolylineOptions()
            .width(16f)
            .color(routeColor)
            .geodesic(true)

        if (decodedRoutePoints.isNotEmpty()) {
            polyOptions.addAll(decodedRoutePoints)
        } else {
            polyOptions.add(driverPos, targetPos)
        }
        currentRoutePolyline = googleMap?.addPolyline(polyOptions)

        applyCameraForCurrentMode(isSmooth = !isInitial)
    }

    private fun applyCameraForCurrentMode(isSmooth: Boolean) {
        if (googleMap == null || !isAutoFollowing) return

        val driverPos = getDriverLatLng()
        val targetPos = getTargetLatLng()
        val bearing = calculateBearing(driverPos, targetPos)

        when (cameraMode) {
            0 -> {
                // 3D CONDUCCIÓN VEHICULAR (Uber Heading-Up)
                val cameraPosition = CameraPosition.Builder()
                    .target(driverPos)
                    .zoom(18.2f)
                    .tilt(58f) // Perspectiva 3D hacia adelante
                    .bearing(bearing)
                    .build()

                if (isSmooth) {
                    googleMap?.animateCamera(CameraUpdateFactory.newCameraPosition(cameraPosition), 1000, null)
                } else {
                    googleMap?.moveCamera(CameraUpdateFactory.newCameraPosition(cameraPosition))
                }
            }
            1 -> {
                // 2D CENITAL CON RUMBO
                val cameraPosition = CameraPosition.Builder()
                    .target(driverPos)
                    .zoom(17.5f)
                    .tilt(0f)
                    .bearing(bearing)
                    .build()

                if (isSmooth) {
                    googleMap?.animateCamera(CameraUpdateFactory.newCameraPosition(cameraPosition), 1000, null)
                } else {
                    googleMap?.moveCamera(CameraUpdateFactory.newCameraPosition(cameraPosition))
                }
            }
            2 -> {
                // VISTA GENERAL DE RUTA (Abarca origen y destino)
                val builder = LatLngBounds.Builder()
                builder.include(driverPos)
                builder.include(targetPos)
                if (decodedRoutePoints.isNotEmpty()) {
                    decodedRoutePoints.forEach { builder.include(it) }
                }
                try {
                    val bounds = builder.build()
                    val cu = CameraUpdateFactory.newLatLngBounds(bounds, 180)
                    if (isSmooth) googleMap?.animateCamera(cu, 1000, null) else googleMap?.moveCamera(cu)
                } catch (e: Exception) {
                    googleMap?.animateCamera(CameraUpdateFactory.newLatLngZoom(driverPos, 15f))
                }
            }
        }
    }

    private fun startNavigationUpdates() {
        navHandler.postDelayed(object : Runnable {
            override fun run() {
                if (isFinishing) return

                val targetLat = if (rideStage < 2) pLat else dLat
                val targetLng = if (rideStage < 2) pLng else dLng

                val driverPos = getDriverLatLng()

                if (targetLat != 0.0 && targetLng != 0.0) {
                    val dist = calculateDistanceInMeters(targetLat, targetLng)
                    val distFormatted = if (dist >= 1000) {
                        String.format(Locale.US, "%.1f km", dist / 1000f)
                    } else {
                        "${dist.toInt()} m"
                    }

                    if (rideStage == 0) {
                        binding.tvGpsProximity.text = "📍 GPS: A $distFormatted del punto de recogida (Requiere < 250m)"
                        binding.tvGpsProximity.setTextColor(if (dist <= 250f) Color.parseColor("#22C55E") else Color.parseColor("#EF4444"))
                        binding.tvNavNextInstruction.text = "En $distFormatted dirígete a la recogida"
                        binding.tvNavETA.text = "${maxOf(1, (dist / 400).toInt())} min"

                        if (dist <= 120f) {
                            speakVoiceInstruction("Aproximándose al punto de recogida. Pasajero cerca.")
                        }
                    } else if (rideStage == 1) {
                        binding.tvGpsProximity.text = "📍 GPS: En punto de encuentro. Esperando al pasajero."
                        binding.tvGpsProximity.setTextColor(Color.parseColor("#22C55E"))
                        binding.tvNavNextInstruction.text = "Punto de encuentro alcanzado"
                        binding.tvNavETA.text = "0 min"
                    } else if (rideStage == 2) {
                        binding.tvGpsProximity.text = "📍 GPS: A $distFormatted del destino final"
                        binding.tvGpsProximity.setTextColor(if (dist <= 350f) Color.parseColor("#22C55E") else Color.parseColor("#2563EB"))
                        binding.tvNavNextInstruction.text = "En $distFormatted continúe hacia el destino"
                        binding.tvNavETA.text = "${maxOf(1, (dist / 500).toInt())} min"

                        if (dist <= 150f) {
                            speakVoiceInstruction("Aproximándose al destino final. Prepárese para finalizar el viaje.")
                        }
                    }

                    // EJECUTAR AUDITORÍA DE DESVÍO DE RUTA (ALGORITMO DE SEGURIDAD)
                    checkRouteDeviation(driverPos)
                }

                if (isAutoFollowing) {
                    drawPhaseMap(isInitial = false)
                }

                navHandler.postDelayed(this, 3000)
            }
        }, 3000)
    }

    private fun checkRouteDeviation(driverPos: LatLng) {
        if (rideStage == 1 || decodedRoutePoints.isEmpty()) return

        val offRouteDistance = getMinDistanceToRouteInMeters(driverPos)
        val now = System.currentTimeMillis()

        if (offRouteDistance > 300f) {
            // Se está alejando de la ruta
            if (offRouteDistance > 750f && offRouteWarningLevel >= 2) {
                // NIVEL 3: DESVÍO EXTREMO -> CANCELAR AUTOMÁTICAMENTE
                offRouteWarningLevel = 3
                triggerAutoCancelDueToDeviation(offRouteDistance)
            } else if (offRouteDistance > 500f && (offRouteWarningLevel < 2 || (now - lastOffRouteWarningTimestamp > 20000L))) {
                // NIVEL 2: SEGUNDA ADVERTENCIA
                offRouteWarningLevel = 2
                lastOffRouteWarningTimestamp = now
                emitOffRouteWarning(2, offRouteDistance)

                binding.bannerNavigation.setCardBackgroundColor(Color.parseColor("#DC2626")) // Rojo
                binding.tvNavNextInstruction.text = "🚨 Advertencia 2/3: Desvío Crítico (${offRouteDistance.toInt()}m)"
                binding.tvNavStreetName.text = "Regresa a la ruta o el viaje se cancelará"
                speakVoiceInstruction("Segunda advertencia. Continúas fuera de la ruta. Si te alejas más, el viaje se cancelará automáticamente.")
            } else if (offRouteWarningLevel < 1 || (now - lastOffRouteWarningTimestamp > 25000L)) {
                // NIVEL 1: PRIMERA ADVERTENCIA
                offRouteWarningLevel = 1
                lastOffRouteWarningTimestamp = now
                emitOffRouteWarning(1, offRouteDistance)

                binding.bannerNavigation.setCardBackgroundColor(Color.parseColor("#D97706")) // Ámbar
                binding.tvNavNextInstruction.text = "⚠️ Advertencia 1/3: Fuera de Ruta (${offRouteDistance.toInt()}m)"
                binding.tvNavStreetName.text = "Por favor regresa al trayecto sugerido"
                speakVoiceInstruction("Atención: Te estás desviando de la ruta asignada. Por favor regresa a la ruta.")
            }
        } else if (offRouteDistance < 150f && offRouteWarningLevel > 0) {
            // El conductor regresó a la ruta
            offRouteWarningLevel = 0
            binding.bannerNavigation.setCardBackgroundColor(Color.parseColor("#000000")) // Negro normal
            speakVoiceInstruction("Has regresado a la ruta correcta.")
        }
    }

    private fun emitOffRouteWarning(level: Int, distance: Float) {
        try {
            val json = JSONObject().apply {
                put("rideId", rideId)
                put("warningLevel", level)
                put("distanceOffRoute", distance)
                put("timestamp", System.currentTimeMillis())
            }
            socket?.emit("ride:off_route_warning", json)
        } catch (e: Exception) {
            Log.e("ActiveRide", "Error emitting off-route warning", e)
        }
    }

    private fun triggerAutoCancelDueToDeviation(offDistance: Float) {
        val reason = "Cancelación automática por desvío excesivo de ruta (${offDistance.toInt()}m fuera de ruta tras 3 advertencias)"
        speakVoiceInstruction("Viaje cancelado automáticamente por desvío excesivo de la ruta. Central notificada.")

        try {
            val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
            val driverName = prefs.getString("driver_full_name", "Conductor")
            val json = JSONObject().apply {
                put("rideId", rideId)
                put("driverId", driverName)
                put("reason", reason)
                put("autoCancelled", true)
                put("offRouteDistance", offDistance)
                put("timestamp", System.currentTimeMillis())
            }
            socket?.emit("ride:cancel", json)
            clearActiveRideState()
        } catch (e: Exception) {
            Log.e("ActiveRide", "Error in auto-cancel", e)
        }

        AlertDialog.Builder(this)
            .setTitle("🚫 Viaje Cancelado por Seguridad")
            .setMessage("Te has alejado más de ${offDistance.toInt()}m de la ruta establecida tras recibir 3 advertencias de desvío.\n\nPor protocolo de seguridad, el viaje ha sido cancelado y la central de despacho ha sido notificada.")
            .setCancelable(false)
            .setPositiveButton("Aceptar") { _, _ ->
                finish()
            }
            .show()
    }

    private fun handleStageAdvance() {
        if (rideStage == 0) {
            // VALIDACIÓN GEOFENCE DE LLEGADA
            if (pLat != 0.0 && pLng != 0.0) {
                val dist = calculateDistanceInMeters(pLat, pLng)
                if (dist > 250f) {
                    AlertDialog.Builder(this)
                        .setTitle("📍 Fuera de zona de recogida")
                        .setMessage("Aún te encuentras a ${dist.toInt()} metros del punto de recogida.\n\nPor seguridad y fidelidad del servicio, debes aproximarte a menos de 250m para notificar al pasajero.")
                        .setPositiveButton("Entendido", null)
                        .setNeutralButton("Simular Llegada (Prueba)") { _, _ ->
                            advanceStage()
                        }
                        .show()
                    return
                }
            }
            advanceStage()
        } else if (rideStage == 1) {
            advanceStage()
        } else if (rideStage == 2) {
            // VALIDACIÓN GEOFENCE DE FINALIZACIÓN
            if (dLat != 0.0 && dLng != 0.0) {
                val dist = calculateDistanceInMeters(dLat, dLng)
                if (dist > 400f) {
                    AlertDialog.Builder(this)
                        .setTitle("⚠️ Destino no alcanzado")
                        .setMessage("Aún estás a ${dist.toInt()} metros del destino acordado.\n\n¿Deseas finalizar y cobrar la carrera de todas formas o continuar el viaje?")
                        .setPositiveButton("Finalizar y Cobrar") { _, _ ->
                            advanceStage()
                        }
                        .setNegativeButton("Continuar Viaje", null)
                        .show()
                    return
                }
            }
            advanceStage()
        }
    }

    private fun advanceStage() {
        rideStage++

        if (rideStage == 1) {
            notifyServerStage("ride:arrived_at_pickup")
            updateUiStage()
            speakVoiceInstruction("Ha llegado al punto de encuentro. Notificando al pasajero.")
            fetchRealRoutePolyline()
            Toast.makeText(this, "¡Llegada notificada al pasajero!", Toast.LENGTH_SHORT).show()
        } else if (rideStage == 2) {
            notifyServerStage("ride:picked_up")
            speakVoiceInstruction("Pasajero a bordo. Iniciando ruta al destino.")
            Toast.makeText(this, "¡Pasajero a bordo! Rumbo al destino", Toast.LENGTH_SHORT).show()
            updateUiStage()
            fetchRealRoutePolyline()
        } else if (rideStage > 2) {
            speakVoiceInstruction("Viaje finalizado con éxito. Tarifa registrada.")
            completeRide()
        }
    }

    private fun notifyServerStage(event: String) {
        try {
            val json = JSONObject().apply {
                put("rideId", rideId)
                put("stage", rideStage)
            }
            socket?.emit(event, json)
        } catch (e: Exception) {
            Log.e("ActiveRide", "Error emitting stage event", e)
        }
    }

    private fun completeRide() {
        try {
            val json = JSONObject().apply {
                put("rideId", rideId)
                put("fare", fareAmount)
            }
            socket?.emit("ride:complete", json)
            clearActiveRideState()
        } catch (e: Exception) {
            Log.e("ActiveRide", "Error completing ride", e)
        }

        Toast.makeText(this, "¡Viaje completado exitosamente! Cobrado: $fareAmount", Toast.LENGTH_LONG).show()
        finish()
    }

    private fun showCancelRideDialog() {
        val reasons = arrayOf(
            "Problema mecánico / Avería",
            "Emergencia personal",
            "No puedo continuar",
            "No encuentro al pasajero",
            "Otro motivo"
        )
        var selectedReasonIndex = 0

        AlertDialog.Builder(this)
            .setTitle("¿Por qué necesitas cancelar este viaje?")
            .setSingleChoiceItems(reasons, 0) { _, which ->
                selectedReasonIndex = which
            }
            .setPositiveButton("Continuar") { _, _ ->
                val chosenReason = reasons[selectedReasonIndex]
                confirmCancelRide(chosenReason)
            }
            .setNegativeButton("Volver al viaje", null)
            .show()
    }

    private fun confirmCancelRide(reason: String) {
        AlertDialog.Builder(this)
            .setTitle("⚠️ Confirmar cancelación")
            .setMessage("¿Estás seguro de que deseas cancelar este viaje? Esta acción liberará la carrera e informará a la central de despacho.")
            .setPositiveButton("Sí, Cancelar Viaje") { _, _ ->
                try {
                    val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
                    val driverName = prefs.getString("driver_full_name", "Conductor")
                    val json = JSONObject().apply {
                        put("rideId", rideId)
                        put("driverId", driverName)
                        put("reason", reason)
                        put("timestamp", System.currentTimeMillis())
                    }
                    socket?.emit("ride:cancel", json)
                    clearActiveRideState()
                } catch (e: Exception) {
                    Log.e("ActiveRide", "Error cancelling ride", e)
                }
                speakVoiceInstruction("Viaje cancelado.")
                Toast.makeText(this, "Viaje cancelado. La central ha sido notificada.", Toast.LENGTH_LONG).show()
                finish()
            }
            .setNegativeButton("No cancelar", null)
            .show()
    }

    private fun updateUiStage() {
        when (rideStage) {
            0 -> {
                binding.tvNavNextInstruction.text = "Dirígete al punto de recogida"
                binding.tvNavStreetName.text = pickupAddress
                binding.tvNavETA.text = pickupDistStr.split(" ")[0] + " min"
                binding.tvCurrentStageTitle.text = "1ª PARADA: RECOGER AL PASAJERO"
                binding.tvCurrentStageAddress.text = pickupAddress
                binding.tvRideActionText.text = "LLEGUÉ AL PUNTO DE ENCUENTRO"
                binding.btnRideAction.setCardBackgroundColor(Color.parseColor("#276EF1"))
            }
            1 -> {
                binding.tvNavNextInstruction.text = "En punto de encuentro"
                binding.tvNavStreetName.text = "Esperando que aborde $passengerName"
                binding.tvNavETA.text = "0 min"
                binding.tvCurrentStageTitle.text = "PASAJERO NOTIFICADO"
                binding.tvCurrentStageAddress.text = pickupAddress
                binding.tvRideActionText.text = "CONFIRMAR PASAJERO A BORDO"
                binding.btnRideAction.setCardBackgroundColor(Color.parseColor("#16A34A"))
            }
            2 -> {
                binding.tvNavNextInstruction.text = "Rumbo al destino final"
                binding.tvNavStreetName.text = destinationAddress
                binding.tvNavETA.text = tripDistStr.split(" ")[0] + " min"
                binding.tvCurrentStageTitle.text = "2ª PARADA: DESTINO FINAL"
                binding.tvCurrentStageAddress.text = destinationAddress
                binding.tvRideActionText.text = "FINALIZAR VIAJE ($fareAmount)"
                binding.btnRideAction.setCardBackgroundColor(Color.parseColor("#0F172A"))
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        navHandler.removeCallbacksAndMessages(null)
        tts?.stop()
        tts?.shutdown()
        socket?.disconnect()
    }
}
