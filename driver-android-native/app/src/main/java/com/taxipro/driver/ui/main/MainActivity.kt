package com.taxipro.driver.ui.main

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.taxipro.driver.R
import com.taxipro.driver.config.AppConfig
import com.taxipro.driver.databinding.ActivityMainBinding
import com.taxipro.driver.service.LocationForegroundService
import com.taxipro.driver.ui.auth.LoginActivity
import com.taxipro.driver.ui.history.TripHistoryActivity
import com.taxipro.driver.ui.profile.ProfileActivity
import com.taxipro.driver.ui.ride.RideAlertActivity
import com.taxipro.driver.ui.wallet.WalletActivity

class MainActivity : AppCompatActivity(), OnMapReadyCallback {

    private lateinit var binding: ActivityMainBinding
    private lateinit var auth: FirebaseAuth
    private lateinit var db: FirebaseFirestore
    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private var googleMap: GoogleMap? = null
    private var isOnline = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val locationGranted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] ?: false
        if (locationGranted) {
            setupMapAndLocation()
        } else {
            Toast.makeText(this, "Se requiere permiso de ubicación para recibir carreras", Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        auth = FirebaseAuth.getInstance()
        db = FirebaseFirestore.getInstance()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)

        if (auth.currentUser == null) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        setupNavHeader()

        val mapFragment = supportFragmentManager
            .findFragmentById(R.id.mapFragment) as SupportMapFragment
        mapFragment.getMapAsync(this)

        setupListeners()
        checkPermissions()
        restoreOnlineState()
        syncFcmToken()
        setupDriverFirestoreListener()
    }

    private var driverDocListener: com.google.firebase.firestore.ListenerRegistration? = null

    private fun setupDriverFirestoreListener() {
        val uid = auth.currentUser?.uid ?: return
        driverDocListener?.remove()
        driverDocListener = db.collection("drivers").document(uid)
            .addSnapshotListener { snapshot, error ->
                if (error != null || snapshot == null || !snapshot.exists()) return@addSnapshotListener
                val appStatus = snapshot.getString("approvalStatus")
                    ?: snapshot.getString("status")
                    ?: "provisional"

                val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
                prefs.edit().putString("approval_status", appStatus).apply()

                runOnUiThread {
                    checkApprovalState()
                }
            }
    }

    private fun syncFcmToken() {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    val token = task.result
                    val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
                    prefs.edit().putString("fcm_token", token).apply()

                    val uid = auth.currentUser?.uid
                    if (uid != null && token != null) {
                        val tokenData = mapOf(
                            "fcmToken" to token,
                            "platform" to "android",
                            "updatedAt" to com.google.firebase.firestore.FieldValue.serverTimestamp(),
                            "isActive" to true
                        )
                        db.collection("drivers").document(uid)
                            .set(tokenData, com.google.firebase.firestore.SetOptions.merge())
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onResume() {
        super.onResume()
        restoreOnlineState()
        checkApprovalState()
        updateTodayEarningsPill()
    }

    override fun onDestroy() {
        super.onDestroy()
        driverDocListener?.remove()
    }

    private fun updateTodayEarningsPill() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val driverId = auth.currentUser?.uid 
            ?: prefs.getString("driver_full_name", "Socio Conductor") 
            ?: "driver_local"
        val serverUrl = AppConfig.getServerUrl(this)
        val endpoint = "$serverUrl/api/drivers/$driverId/earnings"

        kotlin.concurrent.thread {
            try {
                val url = java.net.URL(endpoint)
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("x-driver-id", driverId)
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                if (conn.responseCode == 200) {
                    val reader = java.io.BufferedReader(java.io.InputStreamReader(conn.inputStream))
                    val json = org.json.JSONObject(reader.use { it.readText() })
                    val todayTotal = json.optJSONObject("today")?.optDouble("total", 0.0) ?: 0.0
                    runOnUiThread {
                        binding.tvTodayEarnings.text = String.format(java.util.Locale.US, "%.2f", todayTotal)
                    }
                }
            } catch (e: Exception) {
                // Silencioso
            }
        }
    }

    private fun checkApprovalState(): Boolean {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val approvalStatus = prefs.getString("approval_status", "provisional")
        val registeredAt = prefs.getLong("registered_at", System.currentTimeMillis())
        val deadline = prefs.getLong("approval_deadline", registeredAt + (24 * 3600 * 1000L))
        val now = System.currentTimeMillis()

        if (approvalStatus == "approved") {
            binding.tvStatusText.text = if (isOnline) "Tienes conexión" else "Estás desconectado"
            binding.tvStatusSubtext.text = if (isOnline) "Buscando carreras cercanas..." else "Cuenta Aprobada y Verificada. Presiona IR para comenzar."
            binding.btnGoOnline.isEnabled = true
            if (!isOnline) {
                binding.btnGoOnline.setCardBackgroundColor(Color.parseColor("#276EF1"))
                binding.tvGoOnlineText.text = "IR"
            }
            return true
        }

        if (now > deadline) {
            // Pasaron las 24 horas sin aprobación formal -> Cuenta en pausa / suspendida
            binding.tvStatusText.text = "Revisión requerida"
            binding.tvStatusSubtext.text = "Período provisional de 24h concluido. Esperando validación de documentos por el administrador."
            binding.btnGoOnline.isEnabled = false
            binding.btnGoOnline.setCardBackgroundColor(Color.parseColor("#475569"))
            return false
        } else {
            // Dentro de las 24 horas -> PUEDE TRABAJAR
            val hours = Math.max(0, ((deadline - now) / (1000 * 60 * 60)).toInt())
            binding.tvStatusSubtext.text = "Aprobación provisional activa: Puedes trabajar (${hours}h restantes)"
            binding.btnGoOnline.isEnabled = true
            if (!isOnline) {
                binding.btnGoOnline.setCardBackgroundColor(Color.parseColor("#276EF1"))
                binding.tvGoOnlineText.text = "IR"
            }
            return true
        }
    }

    private fun setupNavHeader() {
        val headerView = binding.navView.getHeaderView(0)
        val tvName = headerView.findViewById<TextView>(R.id.navHeaderName)
        val tvRating = headerView.findViewById<TextView>(R.id.navHeaderRating)
        val tvViewProfile = headerView.findViewById<TextView>(R.id.navHeaderViewProfile)
        val ivPhoto = headerView.findViewById<View>(R.id.navHeaderPhotoCard)

        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val driverName = prefs.getString("driver_full_name", null)
            ?: auth.currentUser?.displayName
            ?: "Socio Conductor"

        tvName.text = driverName
        tvRating.text = "4.98"

        val openProfile = {
            binding.drawerLayout.closeDrawer(GravityCompat.START)
            startActivity(Intent(this, ProfileActivity::class.java))
        }

        tvViewProfile.setOnClickListener { openProfile() }
        ivPhoto?.setOnClickListener { openProfile() }
        tvName.setOnClickListener { openProfile() }
    }

    private fun restoreOnlineState() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val savedOnline = prefs.getBoolean("is_online", false)
        if (savedOnline && !isOnline) {
            toggleAvailability(true, silent = true)
        }
    }

    private fun checkPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        permissionLauncher.launch(permissions.toTypedArray())
    }

    override fun onMapReady(map: GoogleMap) {
        googleMap = map
        
        // Aplicar tema Uber Driver Dark Night
        try {
            googleMap?.setMapStyle(MapStyleOptions.loadRawResourceStyle(this, R.raw.uber_map_style))
        } catch (e: Exception) {
            e.printStackTrace()
        }

        googleMap?.uiSettings?.isZoomControlsEnabled = false
        googleMap?.uiSettings?.isCompassEnabled = false
        googleMap?.uiSettings?.isMyLocationButtonEnabled = true

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            googleMap?.isMyLocationEnabled = true
        }

        setupMapAndLocation()
    }

    private var hasInitialCameraPanned = false

    private fun setupMapAndLocation() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val savedLat = prefs.getFloat("last_driver_lat", 0f).toDouble()
        val savedLng = prefs.getFloat("last_driver_lng", 0f).toDouble()

        if (savedLat != 0.0 && savedLng != 0.0) {
            val savedLatLng = LatLng(savedLat, savedLng)
            googleMap?.moveCamera(CameraUpdateFactory.newLatLngZoom(savedLatLng, 16.5f))
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            googleMap?.isMyLocationEnabled = true

            // Obtener última ubicación
            fusedLocationClient.lastLocation.addOnSuccessListener { location ->
                if (location != null) {
                    val currentLatLng = LatLng(location.latitude, location.longitude)
                    googleMap?.animateCamera(CameraUpdateFactory.newLatLngZoom(currentLatLng, 16.5f))
                    hasInitialCameraPanned = true
                    prefs.edit()
                        .putFloat("last_driver_lat", location.latitude.toFloat())
                        .putFloat("last_driver_lng", location.longitude.toFloat())
                        .apply()
                }
            }

            // Actualizaciones continuas para centrar mapa en el conductor real
            val locationRequest = com.google.android.gms.location.LocationRequest.Builder(
                com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY, 3000
            ).setMinUpdateIntervalMillis(1500).build()

            fusedLocationClient.requestLocationUpdates(locationRequest, object : com.google.android.gms.location.LocationCallback() {
                override fun onLocationResult(locationResult: com.google.android.gms.location.LocationResult) {
                    val loc = locationResult.lastLocation ?: return
                    val currentLatLng = LatLng(loc.latitude, loc.longitude)

                    prefs.edit()
                        .putFloat("last_driver_lat", loc.latitude.toFloat())
                        .putFloat("last_driver_lng", loc.longitude.toFloat())
                        .apply()

                    if (!hasInitialCameraPanned) {
                        googleMap?.animateCamera(CameraUpdateFactory.newLatLngZoom(currentLatLng, 16.5f))
                        hasInitialCameraPanned = true
                    }
                }
            }, android.os.Looper.getMainLooper())
        }
    }

    private fun setupListeners() {
        // Abrir Drawer Lateral de Uber (☰)
        binding.btnOpenMenu.setOnClickListener {
            binding.drawerLayout.openDrawer(GravityCompat.START)
        }

        // Abrir Billetera ($0.00 / Ganancias)
        binding.btnEarningsPill.setOnClickListener {
            startActivity(Intent(this, WalletActivity::class.java))
        }

        // Abrir Perfil desde botón superior
        binding.btnProfilePhoto.setOnClickListener {
            startActivity(Intent(this, ProfileActivity::class.java))
        }

        // Botón Circular Azul Uber "IR" / "PARAR"
        binding.btnGoOnline.setOnClickListener {
            if (!isOnline && !checkApprovalState()) {
                Toast.makeText(this, "Tu cuenta está en revisión tras cumplir las 24h provisionales.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            toggleAvailability(!isOnline)
        }

        // Simulación de prueba de oferta al hacer clic prolongado en el botón
        binding.btnGoOnline.setOnLongClickListener {
            val alertIntent = Intent(this, RideAlertActivity::class.java).apply {
                putExtra("fare", "$16.05")
                putExtra("pickup", "Av. Amazonas y Naciones Unidas")
                putExtra("destination", "Aeropuerto Internacional Mariscal Sucre")
                putExtra("pickupDistance", "3 min (1.1 km) de distancia")
                putExtra("tripDistance", "20 min (14.2 km) de viaje")
            }
            startActivity(alertIntent)
            true
        }

        // Drawer Navigation Items (Uber Side Menu)
        binding.navView.setNavigationItemSelectedListener { menuItem ->
            binding.drawerLayout.closeDrawer(GravityCompat.START)
            when (menuItem.itemId) {
                R.id.menu_earnings -> {
                    startActivity(Intent(this, WalletActivity::class.java))
                    true
                }
                R.id.menu_trips -> {
                    startActivity(Intent(this, TripHistoryActivity::class.java))
                    true
                }
                R.id.menu_profile -> {
                    startActivity(Intent(this, ProfileActivity::class.java))
                    true
                }
                R.id.menu_vehicles -> {
                    startActivity(Intent(this, com.taxipro.driver.ui.vehicle.VehiclesActivity::class.java))
                    true
                }
                R.id.menu_documents -> {
                    startActivity(Intent(this, com.taxipro.driver.ui.auth.DriverRegistrationActivity::class.java))
                    true
                }
                R.id.menu_safety -> {
                    Toast.makeText(this, "🛡️ Centro de Seguridad Uber: Activo 24/7", Toast.LENGTH_LONG).show()
                    true
                }
                R.id.menu_messages -> {
                    Toast.makeText(this, "💬 Bandeja de Mensajes y Notificaciones al día", Toast.LENGTH_SHORT).show()
                    true
                }
                R.id.menu_help -> {
                    Toast.makeText(this, "❓ Soporte y Ayuda para Conductores", Toast.LENGTH_SHORT).show()
                    true
                }
                R.id.menu_settings -> {
                    Toast.makeText(this, "⚙️ Preferencias de viaje y navegación", Toast.LENGTH_SHORT).show()
                    true
                }
                R.id.menu_signout -> {
                    val uid = auth.currentUser?.uid
                    if (uid != null) {
                        db.collection("drivers").document(uid).update("isActive", false)
                    }
                    auth.signOut()
                    toggleAvailability(false, silent = true)
                    startActivity(Intent(this, LoginActivity::class.java))
                    finish()
                    true
                }
                else -> false
            }
        }
    }

    private fun toggleAvailability(enable: Boolean, silent: Boolean = false) {
        isOnline = enable

        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("is_online", enable).apply()

        val intent = Intent(this, LocationForegroundService::class.java).apply {
            action = if (enable) LocationForegroundService.ACTION_START else LocationForegroundService.ACTION_STOP
        }

        if (enable) {
            ContextCompat.startForegroundService(this, intent)
            binding.tvStatusText.text = "Tienes conexión"
            binding.tvStatusSubtext.text = "Buscando carreras cercanas..."
            binding.tvGoOnlineText.text = "PARAR"
            binding.tvGoOnlineText.textSize = 17f
            binding.btnGoOnline.setCardBackgroundColor(Color.parseColor("#EF4444")) // Rojo cuando conectado
            if (!silent) Toast.makeText(this, "Conectado. Transmitiendo GPS a la central.", Toast.LENGTH_SHORT).show()
        } else {
            startService(intent)
            binding.tvStatusText.text = "Estás desconectado"
            binding.tvStatusSubtext.text = "Presiona IR para comenzar a recibir carreras"
            binding.tvGoOnlineText.text = "IR"
            binding.tvGoOnlineText.textSize = 24f
            binding.btnGoOnline.setCardBackgroundColor(Color.parseColor("#276EF1")) // Azul Uber para IR
            if (!silent) Toast.makeText(this, "Desconectado", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onBackPressed() {
        if (binding.drawerLayout.isDrawerOpen(GravityCompat.START)) {
            binding.drawerLayout.closeDrawer(GravityCompat.START)
        } else {
            super.onBackPressed()
        }
    }
}
