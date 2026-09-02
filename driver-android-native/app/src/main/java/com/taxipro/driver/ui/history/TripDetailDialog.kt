package com.taxipro.driver.ui.history

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.taxipro.driver.databinding.DialogTripDetailBinding
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class TripDetailDialog : BottomSheetDialogFragment() {

    private var _binding: DialogTripDetailBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = DialogTripDetailBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.btnCloseDetail.setOnClickListener { dismiss() }

        val tripJsonStr = arguments?.getString("trip_json") ?: return
        try {
            val json = JSONObject(tripJsonStr)
            val rideId = json.optString("rideId", "")
            val status = json.optString("status", "completed")
            val fare = json.optDouble("fare", 0.0)
            val platformFee = json.optDouble("platformFee", 0.0)
            val earnings = json.optDouble("driverEarnings", 0.0)
            val passenger = json.optString("passengerName", "Pasajero")
            val pickupObj = json.optJSONObject("pickup")
            val destObj = json.optJSONObject("destination")
            val pickup = pickupObj?.optString("address") ?: json.optString("pickup", "Origen")
            val destination = destObj?.optString("address") ?: json.optString("destination", "Destino")
            val distance = json.optString("distance", "5.0 km")
            val duration = json.optString("duration", "15 min")
            val cancelReason = json.optString("cancelReason", "")
            val completedAt = json.optString("completedAt", json.optString("createdAt", ""))

            binding.tvDetailRideId.text = "ID: $rideId"
            binding.tvDetailPassenger.text = "Pasajero: $passenger"
            binding.tvDetailPickup.text = pickup
            binding.tvDetailDestination.text = destination
            binding.tvDetailDistTime.text = "Distancia: $distance • Tiempo estimado: $duration"

            binding.tvDetailFare.text = String.format(Locale.US, "$%.2f", fare)
            binding.tvDetailPlatformFee.text = String.format(Locale.US, "$%.2f", platformFee)
            binding.tvDetailEarnings.text = String.format(Locale.US, "$%.2f", earnings)

            // Formato de fecha
            if (completedAt.isNotEmpty()) {
                try {
                    val sdfIn = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                    val date = sdfIn.parse(completedAt) ?: Date()
                    val sdfOut = SimpleDateFormat("dd MMM yyyy, HH:mm", Locale.getDefault())
                    binding.tvDetailDateTime.text = sdfOut.format(date)
                } catch (e: Exception) {
                    binding.tvDetailDateTime.text = completedAt.take(19).replace("T", " ")
                }
            }

            if (status.equals("cancelled", ignoreCase = true)) {
                binding.tvDetailStatusBadge.text = "CANCELADO"
                binding.tvDetailStatusBadge.setBackgroundColor(Color.parseColor("#381B1B"))
                binding.tvDetailStatusBadge.setTextColor(Color.parseColor("#EF4444"))
                binding.tvDetailEarnings.setTextColor(Color.parseColor("#AFAFAF"))

                if (cancelReason.isNotEmpty()) {
                    binding.layoutCancellationReason.visibility = View.VISIBLE
                    binding.tvDetailCancelReason.text = cancelReason
                }
            } else {
                binding.tvDetailStatusBadge.text = "COMPLETADO"
                binding.tvDetailStatusBadge.setBackgroundColor(Color.parseColor("#1B382B"))
                binding.tvDetailStatusBadge.setTextColor(Color.parseColor("#06C167"))
                binding.tvDetailEarnings.setTextColor(Color.parseColor("#06C167"))
                binding.layoutCancellationReason.visibility = View.GONE
            }

        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        fun newInstance(tripJson: JSONObject): TripDetailDialog {
            return TripDetailDialog().apply {
                arguments = Bundle().apply {
                    putString("trip_json", tripJson.toString())
                }
            }
        }
    }
}
