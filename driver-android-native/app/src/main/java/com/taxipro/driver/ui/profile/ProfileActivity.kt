package com.taxipro.driver.ui.profile

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.taxipro.driver.R
import com.taxipro.driver.databinding.ActivityProfileBinding
import com.taxipro.driver.ui.auth.DriverRegistrationActivity
import com.taxipro.driver.ui.auth.LoginActivity
import com.taxipro.driver.ui.vehicle.VehiclesActivity

class ProfileActivity : AppCompatActivity() {

    private lateinit var binding: ActivityProfileBinding
    private lateinit var auth: FirebaseAuth
    private lateinit var db: FirebaseFirestore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityProfileBinding.inflate(layoutInflater)
        setContentView(binding.root)

        auth = FirebaseAuth.getInstance()
        db = FirebaseFirestore.getInstance()

        loadProfileData()

        binding.btnManageVehicles.setOnClickListener {
            startActivity(Intent(this, VehiclesActivity::class.java))
        }

        binding.btnUploadMissingDocs.setOnClickListener {
            startActivity(Intent(this, DriverRegistrationActivity::class.java))
        }

        binding.btnSignOut.setOnClickListener {
            auth.signOut()
            val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
            prefs.edit().putBoolean("is_online", false).apply()

            val intent = Intent(this, LoginActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        loadProfileData()
    }

    private fun loadProfileData() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val uid = auth.currentUser?.uid

        val fullName = prefs.getString("driver_full_name", null)
            ?: auth.currentUser?.displayName
            ?: "Socio Conductor"

        val phone = prefs.getString("driver_phone", null)
            ?: auth.currentUser?.phoneNumber
            ?: "No registrado"
        val ssnMasked = prefs.getString("driver_ssn_masked", "No registrado")

        val activeVehicle = prefs.getString("active_vehicle_model", "Sin vehículo asignado")
        val activePlate = prefs.getString("active_vehicle_plate", "Sin placa")

        binding.tvProfileDriverName.text = fullName
        binding.tvProfilePhone.text = phone
        binding.tvProfileSsnMasked.text = ssnMasked
        binding.tvProfileVehicleModel.text = activeVehicle
        binding.tvProfileVehiclePlate.text = activePlate

        // Estado inicial de documentos desde SharedPreferences
        var selfieUrl = prefs.getString("selfie_url", "") ?: ""
        var licenseUrl = prefs.getString("license_url", "") ?: ""
        var insuranceUrl = prefs.getString("insurance_url", "") ?: ""
        var registrationUrl = prefs.getString("registration_url", "") ?: ""

        updateDocUi(selfieUrl, licenseUrl, insuranceUrl, registrationUrl)

        // Sincronizar en vivo desde Firestore
        if (uid != null) {
            db.collection("drivers").document(uid).get()
                .addOnSuccessListener { doc ->
                    if (doc != null && doc.exists()) {
                        val docsMap = doc.get("documents") as? Map<*, *>
                        val fSelfie = docsMap?.get("selfie") as? String ?: doc.getString("selfieUrl") ?: selfieUrl
                        val fLicense = docsMap?.get("license") as? String ?: doc.getString("licenseUrl") ?: licenseUrl
                        val fInsurance = docsMap?.get("insurance") as? String ?: doc.getString("insuranceUrl") ?: insuranceUrl
                        val fReg = docsMap?.get("registration") as? String ?: doc.getString("registrationUrl") ?: registrationUrl

                        val fApprovalStatus = doc.getString("approvalStatus") ?: doc.getString("status") ?: "provisional"
                        prefs.edit()
                            .putString("approval_status", fApprovalStatus)
                            .putString("selfie_url", fSelfie)
                            .putString("license_url", fLicense)
                            .putString("insurance_url", fInsurance)
                            .putString("registration_url", fReg)
                            .apply()

                        updateDocUi(fSelfie, fLicense, fInsurance, fReg)
                    }
                }
        }

        // Calcular estado de aprobación y tiempo restante
        val registeredAt = prefs.getLong("registered_at", System.currentTimeMillis())
        val deadline = prefs.getLong("approval_deadline", registeredAt + (24 * 3600 * 1000L))
        val approvalStatus = prefs.getString("approval_status", "provisional")

        val now = System.currentTimeMillis()
        val diffMillis = deadline - now

        if (approvalStatus == "approved") {
            binding.tvApprovalStatusTitle.text = "Cuenta Aprobada y Verificada"
            binding.tvApprovalStatusTitle.setTextColor(Color.parseColor("#22C55E"))
            binding.tvApprovalRemainingTime.text = "Documentación 100% aprobada por la administración"
            binding.ivApprovalIcon.setImageResource(R.drawable.ic_check_circle)
        } else if (diffMillis > 0) {
            val hours = (diffMillis / (1000 * 60 * 60)).toInt()
            val mins = ((diffMillis / (1000 * 60)) % 60).toInt()
            binding.tvApprovalStatusTitle.text = "Aprobación Provisional Activa (24h)"
            binding.tvApprovalStatusTitle.setTextColor(Color.parseColor("#22C55E"))
            binding.tvApprovalRemainingTime.text = "Puedes trabajar libremente: Quedan ${hours}h ${mins}m de revisión"
            binding.ivApprovalIcon.setImageResource(R.drawable.ic_shield)
        } else {
            binding.tvApprovalStatusTitle.text = "Período Provisional Finalizado"
            binding.tvApprovalStatusTitle.setTextColor(Color.parseColor("#EF4444"))
            binding.tvApprovalRemainingTime.text = "Tiempo cumplido. Tu cuenta está en proceso de validación administrativa."
            binding.ivApprovalIcon.setImageResource(R.drawable.ic_activity)
        }
    }

    private fun updateDocUi(selfie: String, license: String, insurance: String, reg: String) {
        setDocRow(binding.ivStatusSelfie, binding.tvStatusSelfie, selfie.isNotEmpty())
        setDocRow(binding.ivStatusLicense, binding.tvStatusLicense, license.isNotEmpty())
        setDocRow(binding.ivStatusInsurance, binding.tvStatusInsurance, insurance.isNotEmpty())
        setDocRow(binding.ivStatusRegistration, binding.tvStatusRegistration, reg.isNotEmpty())
    }

    private fun setDocRow(iv: android.widget.ImageView, tv: android.widget.TextView, isUploaded: Boolean) {
        if (isUploaded) {
            iv.setImageResource(R.drawable.ic_check_circle)
            iv.setColorFilter(Color.parseColor("#22C55E"))
            tv.text = "Cargada ✓"
            tv.setTextColor(Color.parseColor("#22C55E"))
        } else {
            iv.setImageResource(R.drawable.ic_activity)
            iv.setColorFilter(Color.parseColor("#94A3B8"))
            tv.text = "Pendiente"
            tv.setTextColor(Color.parseColor("#F59E0B"))
        }
    }
}
