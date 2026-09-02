package com.taxipro.driver.ui.ride

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.location.Location
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
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
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

class ActiveRideActivity : AppCompatActivity(), OnMapReadyCallback {

    private lateinit var binding: ActivityActiveRideBinding
    private var googleMap: GoogleMap? = null
    private var socket: Socket? = null

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

    private val navHandler = Handler(Looper.getMainLooper())
    private var isTracking = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityActiveRideBinding.inflate(layoutInflater)
        setContentView(binding.root)

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

        binding.btnRideAction.setOnClickListener {
            handleStageAdvance()
        }

        binding.btnCancelActiveRide.setOnClickListener {
            showCancelRideDialog()
        }

        binding.btnNavigateExternal.setOnClickListener {
            launchExternalNavigation()
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

        drawPhaseMap(isInitial = true)
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

    private fun calculateDistanceInMeters(targetLat: Double, targetLng: Double): Float {
        val driver = getDriverLatLng()
        val results = FloatArray(1)
        Location.distanceBetween(driver.latitude, driver.longitude, targetLat, targetLng, results)
        return results[0]
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

    private fun drawPhaseMap(isInitial: Boolean = false) {
        if (googleMap == null) return

        currentRoutePolyline?.remove()
        targetMarker?.remove()

        val driverPos = getDriverLatLng()

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

        val targetPos = if (rideStage < 2) {
            if (pLat != 0.0 && pLng != 0.0) LatLng(pLat, pLng) else driverPos
        } else {
            if (dLat != 0.0 && dLng != 0.0) LatLng(dLat, dLng) else LatLng(driverPos.latitude + 0.015, driverPos.longitude + 0.015)
        }

        val markerTitle = if (rideStage < 2) "Punto de Recogida ($passengerName)" else "Destino ($destinationAddress)"
        val markerColor = if (rideStage < 2) BitmapDescriptorFactory.HUE_GREEN else BitmapDescriptorFactory.HUE_RED

        targetMarker = googleMap?.addMarker(
            MarkerOptions()
                .position(targetPos)
                .title(markerTitle)
                .icon(BitmapDescriptorFactory.defaultMarker(markerColor))
        )

        // Trazar línea de ruta
        val routeColor = if (rideStage < 2) Color.parseColor("#2563EB") else Color.parseColor("#10B981")
        currentRoutePolyline = googleMap?.addPolyline(
            PolylineOptions()
                .add(driverPos, targetPos)
                .width(14f)
                .color(routeColor)
                .geodesic(true)
        )

        // CÁMARA 3D EN PERSPECTIVA VEHICULAR (Uber / Google Maps Mode)
        val bearing = calculateBearing(driverPos, targetPos)
        val cameraPosition = CameraPosition.Builder()
            .target(driverPos)
            .zoom(17.8f)
            .tilt(55f) // Perspectiva 3D hacia adelante
            .bearing(bearing) // Girar mapa hacia el destino
            .build()

        if (isInitial) {
            googleMap?.moveCamera(CameraUpdateFactory.newCameraPosition(cameraPosition))
        } else {
            googleMap?.animateCamera(CameraUpdateFactory.newCameraPosition(cameraPosition), 1200, null)
        }
    }

    private fun startNavigationUpdates() {
        navHandler.postDelayed(object : Runnable {
            override fun run() {
                if (!isTracking || isFinishing) return

                val targetLat = if (rideStage < 2) pLat else dLat
                val targetLng = if (rideStage < 2) pLng else dLng

                if (targetLat != 0.0 && targetLng != 0.0) {
                    val dist = calculateDistanceInMeters(targetLat, targetLng)
                    val distFormatted = if (dist >= 1000) {
                        String.format(java.util.Locale.US, "%.1f km", dist / 1000f)
                    } else {
                        "${dist.toInt()} m"
                    }

                    if (rideStage == 0) {
                        binding.tvGpsProximity.text = "📍 GPS: A $distFormatted del punto de recogida (Requiere < 250m)"
                        binding.tvGpsProximity.setTextColor(if (dist <= 250f) Color.parseColor("#22C55E") else Color.parseColor("#EF4444"))
                        binding.tvNavNextInstruction.text = "En $distFormatted avanza hacia la recogida"
                        binding.tvNavETA.text = "${maxOf(1, (dist / 400).toInt())} min"
                    } else if (rideStage == 1) {
                        binding.tvGpsProximity.text = "📍 GPS: En punto de encuentro. Esperando al pasajero."
                        binding.tvGpsProximity.setTextColor(Color.parseColor("#22C55E"))
                    } else if (rideStage == 2) {
                        binding.tvGpsProximity.text = "📍 GPS: A $distFormatted del destino final"
                        binding.tvGpsProximity.setTextColor(if (dist <= 350f) Color.parseColor("#22C55E") else Color.parseColor("#2563EB"))
                        binding.tvNavNextInstruction.text = "En $distFormatted avanza hacia el destino"
                        binding.tvNavETA.text = "${maxOf(1, (dist / 500).toInt())} min"
                    }
                }

                drawPhaseMap(isInitial = false)
                navHandler.postDelayed(this, 3000)
            }
        }, 3000)
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
            // Pasajero a bordo
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
            drawPhaseMap()
            Toast.makeText(this, "¡Llegada notificada al pasajero!", Toast.LENGTH_SHORT).show()
        } else if (rideStage == 2) {
            notifyServerStage("ride:picked_up")
            Toast.makeText(this, "¡Pasajero a bordo! Rumbo al destino", Toast.LENGTH_SHORT).show()
            updateUiStage()
            drawPhaseMap()
        } else if (rideStage > 2) {
            completeRide()
        }
    }

    private fun launchExternalNavigation() {
        val targetLat = if (rideStage < 2) pLat else dLat
        val targetLng = if (rideStage < 2) pLng else dLng
        val label = if (rideStage < 2) pickupAddress else destinationAddress

        if (targetLat == 0.0 || targetLng == 0.0) {
            Toast.makeText(this, "Coordenadas no disponibles para navegación", Toast.LENGTH_SHORT).show()
            return
        }

        try {
            val navUri = Uri.parse("google.navigation:q=$targetLat,$targetLng&mode=d")
            val mapIntent = Intent(Intent.ACTION_VIEW, navUri).apply {
                setPackage("com.google.android.apps.maps")
            }
            startActivity(mapIntent)
        } catch (e: Exception) {
            val fallbackUri = Uri.parse("geo:$targetLat,$targetLng?q=$targetLat,$targetLng($label)")
            startActivity(Intent(Intent.ACTION_VIEW, fallbackUri))
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
        isTracking = false
        navHandler.removeCallbacksAndMessages(null)
        socket?.disconnect()
    }
}
