package com.taxipro.driver.ui.ride

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.android.gms.maps.model.MarkerOptions
import android.widget.Toast
import com.taxipro.driver.R
import com.taxipro.driver.config.AppConfig
import com.taxipro.driver.databinding.ActivityRideAlertBinding
import com.google.firebase.auth.FirebaseAuth
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject

import android.app.KeyguardManager
import android.media.MediaPlayer
import android.view.WindowManager
import com.taxipro.driver.ui.ride.RideAlertManager

class RideAlertActivity : AppCompatActivity(), OnMapReadyCallback {

    private lateinit var binding: ActivityRideAlertBinding
    private var countDownTimer: CountDownTimer? = null
    private var googleMap: GoogleMap? = null
    private var socket: Socket? = null
    private var mediaPlayer: MediaPlayer? = null
    private var currentRideId: String = ""
    private var isAccepting = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureLockScreenFlags()

        binding = ActivityRideAlertBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val rideId = intent.getStringExtra("rideId") ?: ""
        currentRideId = rideId

        // Registrar en RideAlertManager y cancelar notificación de la barra
        RideAlertManager.markShowing(rideId)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.cancel(rideId.hashCode() and 0x7FFFFFFF)

        // Haptic feedback & Sonido profesional continuo en bucle
        vibratePhone()
        startAlertSound()

        setupSocket()

        val fare = intent.getStringExtra("fare") ?: "$16.05"
        val pickup = intent.getStringExtra("pickup") ?: "Punto de Recogida"
        val destination = intent.getStringExtra("destination") ?: "Destino Final"
        val customerName = intent.getStringExtra("customerName") ?: "Pasajero"
        val customerPhone = intent.getStringExtra("customerPhone") ?: ""
        val pLat = intent.getDoubleExtra("pLat", 0.0)
        val pLng = intent.getDoubleExtra("pLng", 0.0)
        val dLat = intent.getDoubleExtra("dLat", 0.0)
        val dLng = intent.getDoubleExtra("dLng", 0.0)
        val pickupDist = intent.getStringExtra("pickupDistance") ?: "3 min (1.1 km) a recoger"
        val tripDist = intent.getStringExtra("tripDistance") ?: "20 min (14.2 km) al destino"

        binding.tvFare.text = fare
        binding.tvPickupAddress.text = pickup
        binding.tvDropoffAddress.text = destination
        binding.tvPickupDistance.text = pickupDist
        binding.tvTripDistance.text = tripDist

        val mapFragment = supportFragmentManager
            .findFragmentById(R.id.alertMapFragment) as? SupportMapFragment
        mapFragment?.getMapAsync(this)

        startTimer()

        binding.btnAccept.setOnClickListener {
            if (isAccepting) return@setOnClickListener
            isAccepting = true
            stopAlertSound()
            countDownTimer?.cancel()
            binding.btnAccept.isEnabled = false
            binding.btnDecline.isEnabled = false
            binding.btnAccept.text = "Confirmando..."

            // Enviar aceptación al backend de forma segura
            socket?.emit("ride:accept", rideId)
        }

        binding.btnDecline.setOnClickListener {
            stopAlertSound()
            countDownTimer?.cancel()
            val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
            val driverName = prefs.getString("driver_full_name", "Conductor")
            
            val rejectObj = JSONObject().apply {
                put("rideId", rideId)
                put("driverId", driverName)
                put("reason", "Rechazado voluntariamente por el conductor")
                put("timestamp", System.currentTimeMillis())
            }
            socket?.emit("ride:rejected", rejectObj)
            finish()
        }
    }

    private fun proceedToActiveRide(rideObj: JSONObject?) {
        val pickup = intent.getStringExtra("pickup") ?: "Punto de Recogida"
        val destination = intent.getStringExtra("destination") ?: "Destino Final"
        val customerName = intent.getStringExtra("customerName") ?: "Pasajero"
        val customerPhone = intent.getStringExtra("customerPhone") ?: ""
        val fare = intent.getStringExtra("fare") ?: "$16.05"
        val pLat = intent.getDoubleExtra("pLat", 0.0)
        val pLng = intent.getDoubleExtra("pLng", 0.0)
        val dLat = intent.getDoubleExtra("dLat", 0.0)
        val dLng = intent.getDoubleExtra("dLng", 0.0)
        val pickupDist = intent.getStringExtra("pickupDistance") ?: "3 min (1.1 km) a recoger"
        val tripDist = intent.getStringExtra("tripDistance") ?: "20 min (14.2 km) al destino"

        val intent = Intent(this, ActiveRideActivity::class.java).apply {
            putExtra("rideId", currentRideId)
            putExtra("pickup", pickup)
            putExtra("destination", destination)
            putExtra("pLat", pLat)
            putExtra("pLng", pLng)
            putExtra("dLat", dLat)
            putExtra("dLng", dLng)
            putExtra("fare", fare)
            putExtra("passengerName", customerName)
            putExtra("customerPhone", customerPhone)
            putExtra("pickupDistance", pickupDist)
            putExtra("tripDistance", tripDist)
        }
        startActivity(intent)
        finish()
    }

    private fun configureLockScreenFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
    }

    private fun vibratePhone() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                val vibrator = vm.defaultVibrator
                val pattern = longArrayOf(0, 500, 200, 500, 200, 500)
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            } else {
                @Suppress("DEPRECATION")
                val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                val pattern = longArrayOf(0, 500, 200, 500, 200, 500)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(pattern, -1)
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun startAlertSound() {
        try {
            mediaPlayer = MediaPlayer.create(this, R.raw.ride_alert)
            mediaPlayer?.isLooping = true
            mediaPlayer?.start()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun stopAlertSound() {
        try {
            if (mediaPlayer?.isPlaying == true) {
                mediaPlayer?.stop()
            }
            mediaPlayer?.release()
            mediaPlayer = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun setupSocket() {
        val user = FirebaseAuth.getInstance().currentUser ?: return
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

                // Confirmación autoritativa del servidor para aceptación segura
                socket?.on("ride:assigned") { args ->
                    runOnUiThread {
                        if (isAccepting) {
                            val rideObj = if (args.isNotEmpty()) args[0] as? JSONObject else null
                            proceedToActiveRide(rideObj)
                        }
                    }
                }

                socket?.on("ride:update") { args ->
                    runOnUiThread {
                        if (isAccepting && args.isNotEmpty()) {
                            val rideObj = args[0] as? JSONObject
                            val status = rideObj?.optString("status", "")
                            val rId = rideObj?.optString("id", "")
                            if (rId == currentRideId && (status == "accepted" || status == "assigned")) {
                                proceedToActiveRide(rideObj)
                            }
                        }
                    }
                }
                
                socket?.on("ride:accept_error") { args ->
                    runOnUiThread {
                        isAccepting = false
                        stopAlertSound()
                        val msg = if (args.isNotEmpty() && args[0] is JSONObject) {
                            (args[0] as JSONObject).optString("message", "El viaje ya fue asignado a otro conductor.")
                        } else {
                            "El viaje ya fue asignado a otro conductor."
                        }
                        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                        finish()
                    }
                }

                socket?.on("ride:cancelled") {
                    runOnUiThread {
                        stopAlertSound()
                        Toast.makeText(this, "La carrera fue cancelada por la central.", Toast.LENGTH_SHORT).show()
                        finish()
                    }
                }

                socket?.connect()
            } catch (e: Exception) {
                e.printStackTrace()
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

        val pLat = intent.getDoubleExtra("pLat", 0.0)
        val pLng = intent.getDoubleExtra("pLng", 0.0)

        val targetLatLng: LatLng = if (pLat != 0.0 && pLng != 0.0) {
            LatLng(pLat, pLng)
        } else {
            val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
            val driverLat = prefs.getFloat("last_driver_lat", 0f).toDouble()
            val driverLng = prefs.getFloat("last_driver_lng", 0f).toDouble()
            if (driverLat != 0.0 && driverLng != 0.0) {
                LatLng(driverLat, driverLng)
            } else {
                LatLng(40.7128, -74.0060) // New York fallback en vez de Ecuador
            }
        }

        googleMap?.addMarker(MarkerOptions().position(targetLatLng).title("Punto de Recogida"))
        googleMap?.moveCamera(CameraUpdateFactory.newLatLngZoom(targetLatLng, 15f))
    }

    private fun startTimer() {
        countDownTimer = object : CountDownTimer(15000, 1000) {
            override fun onTick(millisUntilFinished: Long) {
                val sec = (millisUntilFinished / 1000).toInt()
                binding.tvTimer.text = "$sec"
                binding.timerProgress.progress = sec
            }

            override fun onFinish() {
                stopAlertSound()
                val rideId = intent.getStringExtra("rideId") ?: ""
                val expireObj = JSONObject().apply {
                    put("rideId", rideId)
                    put("timestamp", System.currentTimeMillis())
                }
                socket?.emit("ride:expired", expireObj)
                finish()
            }
        }.start()
    }

    private fun vibratePhone() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vibratorManager.defaultVibrator.vibrate(
                    VibrationEffect.createWaveform(longArrayOf(0, 400, 200, 400), -1)
                )
            } else {
                @Suppress("DEPRECATION")
                val vibrator = getSystemService(VIBRATOR_SERVICE) as Vibrator
                @Suppress("DEPRECATION")
                vibrator.vibrate(longArrayOf(0, 400, 200, 400), -1)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopAlertSound()
        countDownTimer?.cancel()
        socket?.disconnect()
        RideAlertManager.clear(currentRideId)
    }
}
