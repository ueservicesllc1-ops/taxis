package com.taxipro.driver.ui.history

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.taxipro.driver.databinding.ItemTripHistoryBinding
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class TripHistoryAdapter(
    private val trips: MutableList<JSONObject>,
    private val onTripClick: (JSONObject) -> Unit
) : RecyclerView.Adapter<TripHistoryAdapter.TripViewHolder>() {

    fun setTrips(newTrips: List<JSONObject>) {
        trips.clear()
        trips.addAll(newTrips)
        notifyDataSetChanged()
    }

    fun appendTrips(moreTrips: List<JSONObject>) {
        val startPos = trips.size
        trips.addAll(moreTrips)
        notifyItemRangeInserted(startPos, moreTrips.size)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): TripViewHolder {
        val binding = ItemTripHistoryBinding.inflate(
            LayoutInflater.from(parent.context), parent, false
        )
        return TripViewHolder(binding)
    }

    override fun onBindViewHolder(holder: TripViewHolder, position: Int) {
        holder.bind(trips[position])
    }

    override fun getItemCount(): Int = trips.size

    inner class TripViewHolder(private val binding: ItemTripHistoryBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(trip: JSONObject) {
            val status = trip.optString("status", "completed")
            val earnings = trip.optDouble("driverEarnings", 0.0)
            val passenger = trip.optString("passengerName", "Pasajero")
            val pickupObj = trip.optJSONObject("pickup")
            val destObj = trip.optJSONObject("destination")
            val pickup = pickupObj?.optString("address") ?: trip.optString("pickup", "Origen")
            val destination = destObj?.optString("address") ?: trip.optString("destination", "Destino")
            val distance = trip.optString("distance", "5.0 km")
            val duration = trip.optString("duration", "15 min")
            val completedAt = trip.optString("completedAt", trip.optString("createdAt", ""))

            binding.tvTripPassenger.text = "Pasajero: $passenger"
            binding.tvTripPickup.text = pickup
            binding.tvTripDestination.text = destination
            binding.tvTripDistanceDuration.text = "$distance • $duration"

            // Formato de fecha
            if (completedAt.isNotEmpty()) {
                try {
                    val sdfIn = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                    val date = sdfIn.parse(completedAt) ?: Date()
                    val sdfOut = SimpleDateFormat("dd MMM, HH:mm", Locale.getDefault())
                    binding.tvTripDate.text = sdfOut.format(date)
                } catch (e: Exception) {
                    binding.tvTripDate.text = completedAt.take(16).replace("T", " ")
                }
            } else {
                binding.tvTripDate.text = "Reciente"
            }

            if (status.equals("cancelled", ignoreCase = true)) {
                binding.tvTripStatusBadge.text = "CANCELADO"
                binding.tvTripStatusBadge.setBackgroundColor(Color.parseColor("#381B1B"))
                binding.tvTripStatusBadge.setTextColor(Color.parseColor("#EF4444"))
                binding.tvTripEarningsBadge.text = "$0.00"
                binding.tvTripEarningsBadge.setTextColor(Color.parseColor("#888888"))
            } else {
                binding.tvTripStatusBadge.text = "COMPLETADO"
                binding.tvTripStatusBadge.setBackgroundColor(Color.parseColor("#1B382B"))
                binding.tvTripStatusBadge.setTextColor(Color.parseColor("#06C167"))
                binding.tvTripEarningsBadge.text = String.format(Locale.US, "+$%.2f", earnings)
                binding.tvTripEarningsBadge.setTextColor(Color.parseColor("#06C167"))
            }

            binding.cardTripItem.setOnClickListener {
                onTripClick(trip)
            }
        }
    }
}
