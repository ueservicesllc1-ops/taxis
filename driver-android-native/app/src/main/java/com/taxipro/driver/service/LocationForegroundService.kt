package com.taxipro.driver.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.*
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.taxipro.driver.R
import com.taxipro.driver.TaxiDriverApplication
import com.taxipro.driver.ui.main.MainActivity
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject

class LocationForegroundService : Service() {

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private val db = FirebaseFirestore.getInstance()
    private val auth = FirebaseAuth.getInstance()
    private var socket: Socket? = null

    companion object {
        const val TAG = "LocationService"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "ACTION_START_LOCATION_SERVICE"
        const val ACTION_STOP = "ACTION_STOP_LOCATION_SERVICE"
    }

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        setupSocket()
        setupLocationCallback()
    }

    private fun setupSocket() {
        val user = auth.currentUser ?: return
        user.getIdToken(false).addOnSuccessListener { tokenResult ->
            val idToken = tokenResult.token ?: return@addOnSuccessListener
            try {
                if (socket != null && socket?.connected() == true) {
                    return@addOnSuccessListener
                }

                val serverUrl = com.taxipro.driver.config.AppConfig.getServerUrl(this)
                val opts = IO.Options().apply {
                    auth = mapOf("token" to idToken)
                    extraHeaders = mapOf("Authorization" to listOf("Bearer $idToken"))
                    transports = arrayOf("websocket", "polling")
                    reconnection = true
                    reconnectionAttempts = 50
                    reconnectionDelay = 1000
                }
                socket = IO.socket(serverUrl, opts)

                socket?.on(Socket.EVENT_CONNECT_ERROR) { args ->
                    val errDesc = if (args.isNotEmpty()) args[0].toString() else "Unknown"
                    Log.w(TAG, "Socket connect error: $errDesc, refrescando token...")
                    auth.currentUser?.getIdToken(true)?.addOnSuccessListener { refreshed ->
                        refreshed.token?.let { freshToken ->
                            try {
                                opts.auth = mapOf("token" to freshToken)
                                opts.extraHeaders = mapOf("Authorization" to listOf("Bearer $freshToken"))
                                socket?.connect()
                            } catch (e: Exception) {
                                Log.e(TAG, "Error updating socket auth after refresh", e)
                            }
                        }
                    }
                }

                socket?.on(Socket.EVENT_CONNECT) {
                    val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
                    val name = prefs.getString("driver_full_name", auth.currentUser?.displayName ?: "Socio Conductor")
                    val vehicle = prefs.getString("active_vehicle_model", "Vehículo Taxi")
                    val plate = prefs.getString("active_vehicle_plate", "Placa Taxi")
                    val uid = auth.currentUser?.uid ?: "driver_local"
                    val fcmToken = prefs.getString("fcm_token", "")

                    val regObj = JSONObject().apply {
                        put("driverId", uid)
                        put("userId", uid)
                        put("name", name)
                        put("vehicle", vehicle)
                        put("plate", plate)
                        if (!fcmToken.isNullOrEmpty()) {
                            put("fcmToken", fcmToken)
                        }
                    }
                    socket?.emit("register:driver", regObj)
                    Log.i(TAG, "Socket autenticado conectado y registrado a $serverUrl (UID: $uid)")

                    // Emitir de inmediato la última ubicación conocida para aparecer en el mapa de despacho
                    val lastLat = prefs.getFloat("last_driver_lat", 0f).toDouble()
                    val lastLng = prefs.getFloat("last_driver_lng", 0f).toDouble()
                    if (lastLat != 0.0 && lastLng != 0.0) {
                        val initLoc = JSONObject().apply {
                            put("lat", lastLat)
                            put("lng", lastLng)
                            put("heading", 0.0)
                        }
                        socket?.emit("driver:location", initLoc)
                    }
                }

                socket?.on("ride:new") { args ->
                    if (args.isNotEmpty()) {
                        try {
                            val data = args[0] as? JSONObject ?: return@on
                        val rideId = data.optString("id", "")
                        val pickupObj = data.optJSONObject("pickup")
                        val destObj = data.optJSONObject("destination")

                        val pickup = pickupObj?.optString("address") ?: "Punto de Recogida"
                        val destination = destObj?.optString("address") ?: "Destino Final"
                        val pLat = pickupObj?.optDouble("lat", 0.0) ?: 0.0
                        val pLng = pickupObj?.optDouble("lng", 0.0) ?: 0.0
                        val dLat = destObj?.optDouble("lat", 0.0) ?: 0.0
                        val dLng = destObj?.optDouble("lng", 0.0) ?: 0.0

                        val fareVal = data.optDouble("fare", 16.0)
                        val fare = String.format(java.util.Locale.US, "$%.2f", fareVal)
                        val distanceVal = data.optDouble("distance", 5.0)
                        val durationVal = data.optInt("duration", 15)
                        val customerName = data.optString("customerName", "Pasajero")
                        val customerPhone = data.optString("customerPhone", "")

                        // Calcular distancia real de recogida según GPS actual del conductor
                        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
                        val driverLat = prefs.getFloat("last_driver_lat", 0f).toDouble()
                        val driverLng = prefs.getFloat("last_driver_lng", 0f).toDouble()

                        var pickupDistKm = 1.2
                        var pickupMins = 3
                        if (driverLat != 0.0 && driverLng != 0.0 && pLat != 0.0 && pLng != 0.0) {
                            val results = FloatArray(1)
                            Location.distanceBetween(driverLat, driverLng, pLat, pLng, results)
                            pickupDistKm = (results[0] / 1000.0)
                            pickupMins = Math.max(1, (pickupDistKm * 2.5).toInt())
                        }

                        val pickupDistStr = String.format(java.util.Locale.US, "%d min (%.1f km) a recoger", pickupMins, pickupDistKm)
                        val tripDistStr = String.format(java.util.Locale.US, "%d min (%.1f km) al destino", durationVal, distanceVal)

                        val alertIntent = Intent(this, com.taxipro.driver.ui.ride.RideAlertActivity::class.java).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            putExtra("rideId", rideId)
                            putExtra("pickup", pickup)
                            putExtra("destination", destination)
                            putExtra("pLat", pLat)
                            putExtra("pLng", pLng)
                            putExtra("dLat", dLat)
                            putExtra("dLng", dLng)
                            putExtra("fare", fare)
                            putExtra("customerName", customerName)
                            putExtra("customerPhone", customerPhone)
                            putExtra("pickupDistance", pickupDistStr)
                            putExtra("tripDistance", tripDistStr)
                            putExtra("pickupMins", pickupMins)
                            putExtra("pickupKm", pickupDistKm)
                            putExtra("tripMins", durationVal)
                            putExtra("tripKm", distanceVal)
                        }

                        // Coordinar deduplicación
                        com.taxipro.driver.ui.ride.RideAlertManager.markShowing(rideId)
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                        nm.cancel(rideId.hashCode() and 0x7FFFFFFF)

                        startActivity(alertIntent)
                    } catch (ex: Exception) {
                        Log.e(TAG, "Error handling ride:new", ex)
                    }
                }
            }
            socket?.connect()
        } catch (e: Exception) {
            Log.e(TAG, "Socket connection error", e)
        }
    }
}

    private fun setupLocationCallback() {
        locationCallback = object : LocationCallback() {
            override fun onLocationResult(locationResult: LocationResult) {
                for (location in locationResult.locations) {
                    updateLocationInFirestore(location)
                    updateLocationInSocket(location)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startForeground(NOTIFICATION_ID, createNotification())
                if (socket == null || socket?.connected() != true) {
                    setupSocket()
                }
                requestLocationUpdates()
            }
            ACTION_STOP -> {
                stopLocationUpdates()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun requestLocationUpdates() {
        val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 4000)
            .setMinUpdateIntervalMillis(2000)
            .build()

        try {
            fusedLocationClient.requestLocationUpdates(
                locationRequest,
                locationCallback,
                Looper.getMainLooper()
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "Location permission missing", e)
        }
    }

    private fun updateLocationInFirestore(location: Location) {
        val currentUser = auth.currentUser ?: return
        val userId = currentUser.uid
        val locationData = mapOf(
            "lat" to location.latitude,
            "lng" to location.longitude,
            "heading" to location.bearing
        )

        val driverData = mapOf(
            "id" to userId,
            "name" to (currentUser.displayName ?: "Conductor Uber"),
            "email" to (currentUser.email ?: ""),
            "status" to "approved",
            "available" to true,
            "isOnline" to true,
            "location" to locationData,
            "lastUpdate" to System.currentTimeMillis()
        )

        db.collection("drivers").document(userId)
            .set(driverData, com.google.firebase.firestore.SetOptions.merge())
            .addOnFailureListener { e ->
                Log.w(TAG, "Error updating location in Firestore", e)
            }
    }

    private fun updateLocationInSocket(location: Location) {
        try {
            val json = JSONObject().apply {
                put("lat", location.latitude)
                put("lng", location.longitude)
                put("heading", location.bearing)
            }
            socket?.emit("driver:location", json)
        } catch (e: Exception) {
            Log.e(TAG, "Error sending location over socket", e)
        }
    }

    private fun stopLocationUpdates() {
        fusedLocationClient.removeLocationUpdates(locationCallback)
        val userId = auth.currentUser?.uid ?: return
        db.collection("drivers").document(userId).update(
            mapOf(
                "available" to false,
                "isOnline" to false
            )
        )
        socket?.disconnect()
    }

    private fun createNotification(): Notification {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            notificationIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, TaxiDriverApplication.LOCATION_CHANNEL_ID)
            .setContentTitle("TaxiPro Driver en Servicio")
            .setContentText("Transmitiendo ubicación GPS en tiempo real a la central")
            .setSmallIcon(R.drawable.shape_status_online)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
