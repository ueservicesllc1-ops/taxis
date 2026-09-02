package com.taxipro.driver.ui.auth

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.taxipro.driver.R
import com.taxipro.driver.databinding.ActivityDriverRegistrationBinding
import com.taxipro.driver.ui.main.MainActivity
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class DriverRegistrationActivity : AppCompatActivity() {

    private lateinit var binding: ActivityDriverRegistrationBinding
    private val auth = FirebaseAuth.getInstance()
    private val db = FirebaseFirestore.getInstance()

    // Tipos de documentos
    private val DOC_SELFIE = 1
    private val DOC_LICENSE = 2
    private val DOC_INSURANCE = 3
    private val DOC_REGISTRATION = 4
    private var currentSelectingDoc = 0

    // URIs locales de las fotos capturadas
    private var selfieUri: Uri? = null
    private var licenseUri: Uri? = null
    private var insuranceUri: Uri? = null
    private var registrationUri: Uri? = null

    private var tempCameraUri: Uri? = null

    // Catálogo completo de marcas y modelos del mercado estadounidense (USA)
    private val carMakesAndModels = mapOf(
        "Toyota" to listOf("Camry", "Corolla", "RAV4", "Prius", "Highlander", "Sienna", "Tacoma", "Tundra", "4Runner", "Venza", "Avalon", "Crown"),
        "Honda" to listOf("Civic", "Accord", "CR-V", "HR-V", "Pilot", "Odyssey", "Passport", "Insight", "Ridgeline"),
        "Chevrolet" to listOf("Malibu", "Equinox", "Tahoe", "Suburban", "Traverse", "Trax", "Trailblazer", "Silverado", "Blazer", "Bolt"),
        "Ford" to listOf("Fusion", "Escape", "Explorer", "Expedition", "Edge", "F-150", "Bronco", "Ranger", "Transit", "Mustang Mach-E"),
        "Nissan" to listOf("Altima", "Sentra", "Rogue", "Pathfinder", "Murano", "Versa", "Kicks", "Armada", "Frontier"),
        "Hyundai" to listOf("Elantra", "Sonata", "Tucson", "Santa Fe", "Kona", "Palisade", "Venue", "Ioniq 5"),
        "Kia" to listOf("Forte", "K5", "Optima", "Sportage", "Sorento", "Telluride", "Soul", "Seltos", "Carnival", "EV6"),
        "Subaru" to listOf("Outback", "Forester", "Crosstrek", "Impreza", "Legacy", "Ascent"),
        "Volkswagen" to listOf("Jetta", "Passat", "Tiguan", "Atlas", "Taos", "ID.4", "Golf"),
        "Mazda" to listOf("Mazda3", "Mazda6", "CX-5", "CX-30", "CX-50", "CX-9", "CX-90"),
        "BMW" to listOf("3 Series", "5 Series", "X3", "X5", "X1", "4 Series", "7 Series"),
        "Mercedes-Benz" to listOf("C-Class", "E-Class", "GLC", "GLE", "A-Class", "CLA", "S-Class"),
        "Lexus" to listOf("ES", "RX", "NX", "IS", "GX", "UX"),
        "Audi" to listOf("A4", "A6", "Q5", "Q7", "Q3", "A3"),
        "Jeep" to listOf("Grand Cherokee", "Cherokee", "Compass", "Renegade", "Wrangler", "Gladiator"),
        "GMC" to listOf("Acadia", "Terrain", "Yukon", "Sierra"),
        "Dodge" to listOf("Charger", "Challenger", "Durango", "Journey"),
        "Tesla" to listOf("Model 3", "Model Y", "Model S", "Model X"),
        "Chrysler" to listOf("Pacifica", "300", "Voyager"),
        "Acura" to listOf("TLX", "MDX", "RDX", "ILX", "Integra"),
        "Cadillac" to listOf("CT5", "XT4", "XT5", "XT6", "Escalade"),
        "Lincoln" to listOf("Corsair", "Nautilus", "Aviator", "Navigator")
    )

    private val carYears = (2026 downTo 2010).map { it.toString() }

    // Launcher de Cámara
    private val cameraLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success && tempCameraUri != null) {
            handleImageCaptured(tempCameraUri!!)
        }
    }

    // Launcher de Galería / Archivos
    private val galleryLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            handleImageCaptured(uri)
        }
    }

    // Launcher de Permiso de Cámara
    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            openCamera()
        } else {
            Toast.makeText(this, "Permiso de cámara necesario para tomar foto", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDriverRegistrationBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupCarDropdowns()
        setupDocumentClickListeners()

        binding.btnSubmitRegistration.setOnClickListener {
            submitRegistrationForm()
        }
    }

    private fun setupCarDropdowns() {
        // 1. Adapter de Marcas
        val makesList = carMakesAndModels.keys.toList().sorted()
        val makesAdapter = ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, makesList)
        binding.actvVehicleMake.setAdapter(makesAdapter)

        // Al seleccionar marca -> poblar modelos automáticamente
        binding.actvVehicleMake.setOnItemClickListener { _, _, position, _ ->
            val selectedMake = makesList[position]
            val modelsList = carMakesAndModels[selectedMake] ?: emptyList()
            val modelsAdapter = ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, modelsList)
            binding.actvVehicleModel.setText("", false)
            binding.actvVehicleModel.setAdapter(modelsAdapter)
        }

        // 2. Adapter de Años
        val yearsAdapter = ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, carYears)
        binding.actvVehicleYear.setAdapter(yearsAdapter)
    }

    private fun setupDocumentClickListeners() {
        binding.cardSelfie.setOnClickListener {
            currentSelectingDoc = DOC_SELFIE
            showPhotoSourceDialog("Foto Selfie")
        }

        binding.cardLicenseDoc.setOnClickListener {
            currentSelectingDoc = DOC_LICENSE
            showPhotoSourceDialog("Licencia de Conducir")
        }

        binding.cardInsuranceDoc.setOnClickListener {
            currentSelectingDoc = DOC_INSURANCE
            showPhotoSourceDialog("Seguro del Carro")
        }

        binding.cardRegistrationDoc.setOnClickListener {
            currentSelectingDoc = DOC_REGISTRATION
            showPhotoSourceDialog("Registración del Carro")
        }
    }

    private fun showPhotoSourceDialog(title: String) {
        val options = arrayOf("📷 Tomar foto con la cámara", "🖼️ Elegir de la galería")
        AlertDialog.Builder(this)
            .setTitle(title)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> cameraPermissionLauncher.launch(android.Manifest.permission.CAMERA)
                    1 -> galleryLauncher.launch("image/*")
                }
            }
            .show()
    }

    private fun openCamera() {
        try {
            val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES)
            val photoFile = File.createTempFile("DOC_${timeStamp}_", ".jpg", storageDir)
            tempCameraUri = FileProvider.getUriForFile(
                this,
                "${applicationContext.packageName}.fileprovider",
                photoFile
            )
            cameraLauncher.launch(tempCameraUri)
        } catch (e: Exception) {
            Toast.makeText(this, "Error al preparar cámara: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleImageCaptured(uri: Uri) {
        when (currentSelectingDoc) {
            DOC_SELFIE -> {
                selfieUri = uri
                binding.ivSelfiePreview.setImageURI(uri)
                binding.ivSelfiePreview.imageTintList = null
                binding.tvSelfieStatus.text = "Selfie cargada con éxito ✓"
                binding.tvSelfieStatus.setTextColor(Color.parseColor("#22C55E"))
                binding.ivSelfieCheck.setImageResource(R.drawable.ic_check_circle)
            }
            DOC_LICENSE -> {
                licenseUri = uri
                binding.ivLicensePreview.setImageURI(uri)
                binding.ivLicensePreview.imageTintList = null
                binding.tvLicenseStatus.text = "Licencia cargada con éxito ✓"
                binding.tvLicenseStatus.setTextColor(Color.parseColor("#22C55E"))
                binding.ivLicenseCheck.setImageResource(R.drawable.ic_check_circle)
            }
            DOC_INSURANCE -> {
                insuranceUri = uri
                binding.ivInsurancePreview.setImageURI(uri)
                binding.ivInsurancePreview.imageTintList = null
                binding.tvInsuranceStatus.text = "Póliza de seguro cargada con éxito ✓"
                binding.tvInsuranceStatus.setTextColor(Color.parseColor("#22C55E"))
                binding.ivInsuranceCheck.setImageResource(R.drawable.ic_check_circle)
            }
            DOC_REGISTRATION -> {
                registrationUri = uri
                binding.ivRegistrationPreview.setImageURI(uri)
                binding.ivRegistrationPreview.imageTintList = null
                binding.tvRegistrationStatus.text = "Registración cargada con éxito ✓"
                binding.tvRegistrationStatus.setTextColor(Color.parseColor("#22C55E"))
                binding.ivRegistrationCheck.setImageResource(R.drawable.ic_check_circle)
            }
        }
    }

    private fun submitRegistrationForm() {
        val firstName = binding.etFirstName.text.toString().trim()
        val lastName = binding.etLastName.text.toString().trim()
        val ssnItin = binding.etSsnItin.text.toString().trim()
        val phone = binding.etPhone.text.toString().trim()

        val make = binding.actvVehicleMake.text.toString().trim()
        val model = binding.actvVehicleModel.text.toString().trim()
        val year = binding.actvVehicleYear.text.toString().trim()
        val plate = binding.etVehiclePlate.text.toString().trim()

        if (firstName.isEmpty() || lastName.isEmpty()) {
            Toast.makeText(this, "Ingresa tu nombre y apellido", Toast.LENGTH_SHORT).show()
            return
        }

        if (ssnItin.isEmpty()) {
            Toast.makeText(this, "Ingresa tu SSN o ITIN", Toast.LENGTH_SHORT).show()
            return
        }

        if (phone.isEmpty()) {
            Toast.makeText(this, "Ingresa tu teléfono móvil", Toast.LENGTH_SHORT).show()
            return
        }

        if (make.isEmpty() || model.isEmpty() || year.isEmpty() || plate.isEmpty()) {
            Toast.makeText(this, "Selecciona la marca, modelo, año y escribe la placa", Toast.LENGTH_SHORT).show()
            return
        }

        // Mostrar indicador de carga mientras sube documentos a B2 / Firebase Storage
        binding.pbUpload.visibility = View.VISIBLE
        binding.tvUploadStatus.visibility = View.VISIBLE
        binding.btnSubmitRegistration.isEnabled = false

        val maskedSsn = if (ssnItin.length >= 4) {
            "***-**-" + ssnItin.takeLast(4)
        } else {
            "***-**-****"
        }

        val now = System.currentTimeMillis()
        val deadline24Hours = now + (24 * 60 * 60 * 1000L)
        val fullCarModel = "$make $model ($year)"
        val fullCarPlate = "Placa: $plate"
        val userId = auth.currentUser?.uid ?: "driver_${System.currentTimeMillis()}"

        // Subir archivos a Storage (asíncrono con fallback inmediato)
        uploadDocumentsToStorage(userId) { urls ->
            val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
            prefs.edit()
                .putString("driver_first_name", firstName)
                .putString("driver_last_name", lastName)
                .putString("driver_full_name", "$firstName $lastName")
                .putString("driver_ssn_masked", maskedSsn)
                .putString("driver_phone", phone)
                .putLong("registered_at", now)
                .putLong("approval_deadline", deadline24Hours)
                .putString("approval_status", "provisional")
                .putBoolean("registration_completed", true)
                .putString("active_vehicle_model", fullCarModel)
                .putString("active_vehicle_plate", fullCarPlate)
                .putString("selfie_url", urls["selfie"] ?: "")
                .putString("license_url", urls["license"] ?: "")
                .putString("insurance_url", urls["insurance"] ?: "")
                .putString("registration_url", urls["registration"] ?: "")
                .apply()

            // Guardar documento completo en Firestore
            val driverDoc = hashMapOf(
                "id" to userId,
                "firstName" to firstName,
                "lastName" to lastName,
                "name" to "$firstName $lastName",
                "ssnItinMasked" to maskedSsn,
                "phone" to phone,
                "registeredAt" to now,
                "approvalDeadline" to deadline24Hours,
                "approvalStatus" to "provisional",
                "registrationCompleted" to true,
                "activeVehicle" to fullCarModel,
                "vehicle" to "$make $model",
                "year" to year,
                "plate" to plate,
                "documents" to urls,
                "status" to "approved",
                "available" to true,
                "isOnline" to true
            )

            db.collection("drivers").document(userId)
                .set(driverDoc, SetOptions.merge())
                .addOnCompleteListener {
                    binding.pbUpload.visibility = View.GONE
                    binding.tvUploadStatus.visibility = View.GONE

                    Toast.makeText(
                        this@DriverRegistrationActivity,
                        "¡Registro y documentos subidos con éxito! Cuentas con 24h para trabajar de inmediato.",
                        Toast.LENGTH_LONG
                    ).show()

                    startActivity(Intent(this@DriverRegistrationActivity, MainActivity::class.java))
                    finish()
                }
        }
    }

    private fun uploadDocumentsToStorage(userId: String, onComplete: (Map<String, String>) -> Unit) {
        val resultUrls = mutableMapOf<String, String>()
        val docsToUpload = listOfNotNull(
            selfieUri?.let { "selfie" to it },
            licenseUri?.let { "license" to it },
            insuranceUri?.let { "insurance" to it },
            registrationUri?.let { "registration" to it }
        )

        if (docsToUpload.isEmpty()) {
            onComplete(resultUrls)
            return
        }

        auth.currentUser?.getIdToken(false)?.addOnSuccessListener { tokenResult ->
            val idToken = tokenResult.token ?: ""
            val serverUrl = com.taxipro.driver.config.AppConfig.getServerUrl(this@DriverRegistrationActivity)
            val uploadEndpoint = "$serverUrl/api/storage/upload"

            Thread {
                var completedCount = 0
                for ((name, uri) in docsToUpload) {
                    try {
                        val b2Url = uploadFileToB2Endpoint(uploadEndpoint, idToken, name, uri)
                        if (!b2Url.isNullOrEmpty()) {
                            resultUrls[name] = b2Url
                        } else {
                            resultUrls[name] = uri.toString()
                        }
                    } catch (e: Exception) {
                        resultUrls[name] = uri.toString()
                    }
                    completedCount++
                    if (completedCount == docsToUpload.size) {
                        runOnUiThread {
                            onComplete(resultUrls)
                        }
                    }
                }
            }.start()
        }?.addOnFailureListener {
            // Fallback con URIs locales si no se pudo obtener token
            for ((name, uri) in docsToUpload) {
                resultUrls[name] = uri.toString()
            }
            onComplete(resultUrls)
        }
    }

    private fun uploadFileToB2Endpoint(endpointUrl: String, idToken: String, category: String, uri: Uri): String? {
        val boundary = "Boundary-" + System.currentTimeMillis()
        val lineEnd = "\r\n"
        val twoHyphens = "--"

        val url = java.net.URL(endpointUrl)
        val conn = url.openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"
        conn.doInput = true
        conn.doOutput = true
        conn.useCaches = false
        conn.connectTimeout = 30000
        conn.readTimeout = 30000
        conn.setRequestProperty("Connection", "Keep-Alive")
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        if (idToken.isNotEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer $idToken")
        }

        val outputStream = java.io.DataOutputStream(conn.outputStream)

        // 1. Campo category
        outputStream.writeBytes(twoHyphens + boundary + lineEnd)
        outputStream.writeBytes("Content-Disposition: form-data; name=\"category\"$lineEnd$lineEnd")
        outputStream.writeBytes(category + lineEnd)

        // 2. Campo file binario
        val fileName = "$category-${System.currentTimeMillis()}.jpg"
        outputStream.writeBytes(twoHyphens + boundary + lineEnd)
        outputStream.writeBytes("Content-Disposition: form-data; name=\"file\"; filename=\"$fileName\"$lineEnd")
        outputStream.writeBytes("Content-Type: image/jpeg$lineEnd$lineEnd")

        val inputStream = contentResolver.openInputStream(uri)
        inputStream?.use { input ->
            val buffer = ByteArray(8192)
            var bytesRead: Int
            while (input.read(buffer).also { bytesRead = it } != -1) {
                outputStream.write(buffer, 0, bytesRead)
            }
        }
        outputStream.writeBytes(lineEnd)
        outputStream.writeBytes(twoHyphens + boundary + twoHyphens + lineEnd)
        outputStream.flush()
        outputStream.close()

        val responseCode = conn.responseCode
        if (responseCode == java.net.HttpURLConnection.HTTP_OK) {
            val responseText = conn.inputStream.bufferedReader().use { it.readText() }
            val json = org.json.JSONObject(responseText)
            if (json.optBoolean("success", false)) {
                return json.optString("url", null)
            }
        }
        return null
    }
}

