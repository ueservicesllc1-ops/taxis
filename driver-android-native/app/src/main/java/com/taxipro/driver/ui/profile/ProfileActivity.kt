package com.taxipro.driver.ui.profile

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.taxipro.driver.R
import com.taxipro.driver.databinding.ActivityProfileBinding
import com.taxipro.driver.ui.auth.LoginActivity
import com.taxipro.driver.ui.vehicle.VehiclesActivity

class ProfileActivity : AppCompatActivity() {

    private lateinit var binding: ActivityProfileBinding
    private lateinit var auth: FirebaseAuth

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityProfileBinding.inflate(layoutInflater)
        setContentView(binding.root)

        auth = FirebaseAuth.getInstance()

        loadProfileData()

        binding.btnManageVehicles.setOnClickListener {
            startActivity(Intent(this, VehiclesActivity::class.java))
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

        val fullName = prefs.getString("driver_full_name", null)
            ?: auth.currentUser?.displayName
            ?: "Socio Conductor"

        val phone = prefs.getString("driver_phone", "+1 (555) 019-2831")
        val ssnMasked = prefs.getString("driver_ssn_masked", "***-**-6789")

        val activeVehicle = prefs.getString("active_vehicle_model", "Toyota Prius (2022)")
        val activePlate = prefs.getString("active_vehicle_plate", "Placa: PBX-4829")

        binding.tvProfileDriverName.text = fullName
        binding.tvProfilePhone.text = phone
        binding.tvProfileSsnMasked.text = ssnMasked
        binding.tvProfileVehicleModel.text = activeVehicle
        binding.tvProfileVehiclePlate.text = activePlate

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
}
