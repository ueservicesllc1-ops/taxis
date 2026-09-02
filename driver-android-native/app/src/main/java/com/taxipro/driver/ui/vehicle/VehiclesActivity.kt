package com.taxipro.driver.ui.vehicle

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.taxipro.driver.R
import com.taxipro.driver.databinding.ActivityVehiclesBinding

class VehiclesActivity : AppCompatActivity() {

    private lateinit var binding: ActivityVehiclesBinding
    private val auth = FirebaseAuth.getInstance()
    private val db = FirebaseFirestore.getInstance()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityVehiclesBinding.inflate(layoutInflater)
        setContentView(binding.root)

        loadVehiclesFromPreferences()

        binding.btnBackVehicles.setOnClickListener {
            finish()
        }

        binding.btnSelectSecondaryCar.setOnClickListener {
            switchActiveVehicle()
        }

        binding.btnAddVehicle.setOnClickListener {
            showAddVehicleDialog()
        }
    }

    private fun loadVehiclesFromPreferences() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val activeModel = prefs.getString("active_vehicle_model", "Toyota Prius (2022)")
        val activePlate = prefs.getString("active_vehicle_plate", "Placa: PBX-4829")

        val secondaryModel = prefs.getString("secondary_vehicle_model", "Chevrolet Tahoe (2021)")
        val secondaryPlate = prefs.getString("secondary_vehicle_plate", "Placa: 4BCF82")

        binding.tvActiveCarModel.text = activeModel
        binding.tvActiveCarPlate.text = activePlate

        binding.tvSecondaryCarModel.text = secondaryModel
        binding.tvSecondaryCarPlate.text = secondaryPlate
    }

    private fun switchActiveVehicle() {
        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val oldActiveModel = binding.tvActiveCarModel.text.toString()
        val oldActivePlate = binding.tvActiveCarPlate.text.toString()

        val newActiveModel = binding.tvSecondaryCarModel.text.toString()
        val newActivePlate = binding.tvSecondaryCarPlate.text.toString()

        prefs.edit()
            .putString("active_vehicle_model", newActiveModel)
            .putString("active_vehicle_plate", newActivePlate)
            .putString("secondary_vehicle_model", oldActiveModel)
            .putString("secondary_vehicle_plate", oldActivePlate)
            .apply()

        binding.tvActiveCarModel.text = newActiveModel
        binding.tvActiveCarPlate.text = newActivePlate

        binding.tvSecondaryCarModel.text = oldActiveModel
        binding.tvSecondaryCarPlate.text = oldActivePlate

        val userId = auth.currentUser?.uid
        if (userId != null) {
            db.collection("drivers").document(userId).update(
                mapOf(
                    "activeVehicle" to newActiveModel,
                    "plate" to newActivePlate
                )
            )
        }

        Toast.makeText(this, "Auto activo cambiado a: $newActiveModel", Toast.LENGTH_SHORT).show()
    }

    private val carMakesAndModels = mapOf(
        "Toyota" to listOf("Camry", "Corolla", "RAV4", "Prius", "Highlander", "Sienna", "Tacoma", "Tundra", "4Runner", "Venza"),
        "Honda" to listOf("Civic", "Accord", "CR-V", "HR-V", "Pilot", "Odyssey", "Passport"),
        "Chevrolet" to listOf("Malibu", "Equinox", "Tahoe", "Suburban", "Traverse", "Trax", "Silverado"),
        "Ford" to listOf("Fusion", "Escape", "Explorer", "Expedition", "F-150", "Bronco", "Edge"),
        "Nissan" to listOf("Altima", "Sentra", "Rogue", "Pathfinder", "Murano", "Versa"),
        "Hyundai" to listOf("Elantra", "Sonata", "Tucson", "Santa Fe", "Kona", "Palisade"),
        "Kia" to listOf("Forte", "K5", "Sportage", "Sorento", "Telluride", "Soul")
    )
    private val carYears = (2026 downTo 2010).map { it.toString() }

    private fun showAddVehicleDialog() {
        val dialog = Dialog(this)
        dialog.setContentView(R.layout.dialog_add_vehicle)
        dialog.window?.setLayout(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val actvMake = dialog.findViewById<android.widget.AutoCompleteTextView>(R.id.actvNewMake)
        val actvModel = dialog.findViewById<android.widget.AutoCompleteTextView>(R.id.actvNewModel)
        val actvYear = dialog.findViewById<android.widget.AutoCompleteTextView>(R.id.actvNewYear)
        val etPlate = dialog.findViewById<EditText>(R.id.etNewPlate)
        val btnSave = dialog.findViewById<Button>(R.id.btnSaveNewVehicle)

        val makesList = carMakesAndModels.keys.toList().sorted()
        val makesAdapter = android.widget.ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, makesList)
        actvMake?.setAdapter(makesAdapter)

        actvMake?.setOnItemClickListener { _, _, position, _ ->
            val selectedMake = makesList[position]
            val modelsList = carMakesAndModels[selectedMake] ?: emptyList()
            val modelsAdapter = android.widget.ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, modelsList)
            actvModel?.setText("", false)
            actvModel?.setAdapter(modelsAdapter)
        }

        val yearsAdapter = android.widget.ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, carYears)
        actvYear?.setAdapter(yearsAdapter)

        btnSave?.setOnClickListener {
            val make = actvMake?.text?.toString()?.trim() ?: ""
            val model = actvModel?.text?.toString()?.trim() ?: ""
            val year = actvYear?.text?.toString()?.trim() ?: ""
            val plate = etPlate?.text?.toString()?.trim() ?: ""

            if (make.isEmpty() || model.isEmpty() || year.isEmpty() || plate.isEmpty()) {
                Toast.makeText(this, "Completa marca, modelo, año y placa", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val fullModel = "$make $model ($year)"
            val fullPlate = "Placa: $plate"

            val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
            prefs.edit()
                .putString("secondary_vehicle_model", fullModel)
                .putString("secondary_vehicle_plate", fullPlate)
                .apply()

            binding.tvSecondaryCarModel.text = fullModel
            binding.tvSecondaryCarPlate.text = fullPlate

            dialog.dismiss()
            Toast.makeText(this, "Vehículo $fullModel agregado exitosamente", Toast.LENGTH_SHORT).show()
        }

        dialog.show()
    }
}
