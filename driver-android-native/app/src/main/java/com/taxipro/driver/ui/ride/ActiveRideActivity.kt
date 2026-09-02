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
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.android.gms.maps.model.Marker
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.gms.maps.model.Polyline
import com.google.android.gms.maps.model.PolylineOptions
import com.taxipro.driver.R
import com.taxipro.driver.databinding.ActivityActiveRideBinding
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.util.Locale

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
    private var pickupMarker: Marker? = null
    private var destMarker: Marker? = null
    private var currentRoutePolyline: Polyline? = null

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

        // Persistir viaje activo localmente para recuperación de sesión
        persistActiveRideState()

        setupSocket()

        val mapFragment = supportFragmentManager
            .findFragmentById(R.id.activeRideMapFragment) as? SupportMapFragment
        mapFragment?.getMapAsync(this)

        updateUiStage()

        binding.btnRideAction.setOnClickListener {
            advanceStage()
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
                val serverUrl = com.taxipro.driver.config.AppConfig.getServerUrl(this)
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
        googleMap?.uiSettings?.isCompassEnabled = false
        googleMap?.uiSettings?.isZoomControlsEnabled = false

        drawPhaseMap()
    }

    private fun getDriverLatLng(): LatLng {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val lat = prefs.getFloat("last_driver_lat", 0f).toDouble()
        val lng = prefs.getFloat("last_driver_lng", 0f).toDouble()
        return if (lat != 0.0 && lng != 0.0) {
            LatLng(lat, lng)
        } else if (pLat != 0.0 && pLng != 0.0) {
            // Ligeramente desviado del punto de recogida si no hay GPS
            LatLng(pLat - 0.005, pLng - 0.005)
        } else {
            LatLng(40.7128, -74.0060)
        }
    }

    private fun drawPhaseMap() {
        if (googleMap == null) return

        currentRoutePolyline?.remove()
        pickupMarker?.remove()
        destMarker?.remove()

        val driverPos = getDriverLatLng()

        // Colocar marcador del conductor
        if (driverMarker == null) {
            driverMarker = googleMap?.addMarker(
                MarkerOptions()
                    .position(driverPos)
                    .title("Tu ubicación")
                    .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_AZURE))
            )
        } else {
            driverMarker?.position = driverPos
        }

        if (rideStage < 2) {
            // FASE 1: RUTA HACIA EL PUNTO DE RECOGIDA
            val pickupPos = if (pLat != 0.0 && pLng != 0.0) LatLng(pLat, pLng) else driverPos

            pickupMarker = googleMap?.addMarker(
                MarkerOptions()
                    .position(pickupPos)
                    .title("Recoger a $passengerName")
                    .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN))
            )

            // Trazar línea de ruta de recogida (Azul Uber)
            currentRoutePolyline = googleMap?.addPolyline(
                PolylineOptions()
                    .add(driverPos, pickupPos)
                    .width(12f)
                    .color(Color.parseColor("#2563eb"))
                    .geodesic(true)
            )

            focusBounds(listOf(driverPos, pickupPos))

        } else {
            // FASE 2: RUTA HACIA EL DESTINO FINAL
            val pickupPos = if (pLat != 0.0 && pLng != 0.0) LatLng(pLat, pLng) else driverPos
            val destPos = if (dLat != 0.0 && dLng != 0.0) LatLng(dLat, dLng) else LatLng(pLat + 0.02, pLng + 0.02)

            destMarker = googleMap?.addMarker(
                MarkerOptions()
                    .position(destPos)
                    .title("Destino: $destinationAddress")
                    .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED))
            )

            // Trazar línea de ruta final
            currentRoutePolyline = googleMap?.addPolyline(
                PolylineOptions()
                    .add(driverPos, destPos)
                    .width(12f)
                    .color(Color.parseColor("#10b981"))
                    .geodesic(true)
            )

            focusBounds(listOf(driverPos, destPos))
        }
    }

    private fun focusBounds(points: List<LatLng>) {
        if (points.isEmpty() || googleMap == null) return
        val builder = LatLngBounds.Builder()
        var validPoints = 0
        for (pt in points) {
            if (pt.latitude != 0.0 || pt.longitude != 0.0) {
                builder.include(pt)
                validPoints++
            }
        }
        if (validPoints > 0) {
            try {
                val bounds = builder.build()
                googleMap?.animateCamera(CameraUpdateFactory.newLatLngBounds(bounds, 140))
            } catch (e: Exception) {
                googleMap?.animateCamera(CameraUpdateFactory.newLatLngZoom(points[0], 15f))
            }
        }
    }

    private fun advanceStage() {
        rideStage++

        if (rideStage == 1) {
            // Llegó al punto de recogida
            notifyServerStage("ride:arrived_at_pickup")
            updateUiStage()
        } else if (rideStage == 2) {
            // Pasajero a bordo -> Inicia viaje hacia destino
            notifyServerStage("ride:picked_up")
            Toast.makeText(this, "¡Pasajero a bordo! Rumbo al destino", Toast.LENGTH_SHORT).show()
            updateUiStage()
            drawPhaseMap()
        } else if (rideStage > 2) {
            // Finalizar viaje
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

        android.app.AlertDialog.Builder(this)
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
        android.app.AlertDialog.Builder(this)
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
                // En camino a recoger al pasajero
                binding.tvNavNextInstruction.text = "Dirígete al punto de recogida"
                binding.tvNavStreetName.text = pickupAddress
                binding.tvNavETA.text = pickupDistStr.split(" ")[0] + " min"
                binding.tvCurrentStageTitle.text = "1ª PARADA: RECOGER AL PASAJERO"
                binding.tvCurrentStageAddress.text = pickupAddress
                binding.tvRideActionText.text = "LLEGUÉ AL PUNTO DE ENCUENTRO"
                binding.btnRideAction.setCardBackgroundColor(Color.parseColor("#276EF1")) // Azul
            }
            1 -> {
                // En el punto de encuentro esperando al pasajero
                binding.tvNavNextInstruction.text = "En punto de encuentro"
                binding.tvNavStreetName.text = "Esperando que aborde $passengerName"
                binding.tvNavETA.text = "0 min"
                binding.tvCurrentStageTitle.text = "PASAJERO NOTIFICADO"
                binding.tvCurrentStageAddress.text = pickupAddress
                binding.tvRideActionText.text = "CONFIRMAR PASAJERO A BORDO"
                binding.btnRideAction.setCardBackgroundColor(Color.parseColor("#16A34A")) // Verde
            }
            2 -> {
                // Pasajero a bordo -> En camino al destino final
                binding.tvNavNextInstruction.text = "Rumbo al destino final"
                binding.tvNavStreetName.text = destinationAddress
                binding.tvNavETA.text = tripDistStr.split(" ")[0] + " min"
                binding.tvCurrentStageTitle.text = "2ª PARADA: DESTINO FINAL"
                binding.tvCurrentStageAddress.text = destinationAddress
                binding.tvRideActionText.text = "FINALIZAR VIAJE ($fareAmount)"
                binding.btnRideAction.setCardBackgroundColor(Color.parseColor("#0F172A")) // Negro Uber
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        socket?.disconnect()
    }
}
