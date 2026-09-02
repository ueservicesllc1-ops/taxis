package com.taxipro.driver.ui.wallet

import android.content.Context
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.taxipro.driver.config.AppConfig
import com.taxipro.driver.databinding.ActivityWalletBinding
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.concurrent.thread

class WalletActivity : AppCompatActivity() {

    private lateinit var binding: ActivityWalletBinding
    private var socket: Socket? = null
    private val auth by lazy { FirebaseAuth.getInstance() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityWalletBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnBackWallet.setOnClickListener { finish() }

        binding.btnCashOut.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Retiro de Fondos")
                .setMessage("La integración de dispersión de transferencias bancarias directas (ACH / SPEI) está programada para la siguiente fase operativa.\n\nTus ganancias reales permanecen seguras y registradas en el balance.")
                .setPositiveButton("Entendido", null)
                .show()
        }

        setupSocket()
        loadWalletData()
    }

    private fun setupSocket() {
        try {
            val serverUrl = AppConfig.getServerUrl(this)
            auth.currentUser?.getIdToken(false)?.addOnSuccessListener { tokenResult ->
                val token = tokenResult.token ?: ""
                val opts = IO.Options().apply {
                    auth = mapOf("token" to token)
                }
                socket = IO.socket(serverUrl, opts)

                socket?.on("driver:earning_updated") {
                    runOnUiThread {
                        Toast.makeText(this, "💰 ¡Nueva ganancia acreditada a tu billetera!", Toast.LENGTH_SHORT).show()
                        loadWalletData()
                    }
                }

                socket?.connect()
            }
        } catch (e: Exception) {
            Log.e("WalletActivity", "Error setting up socket", e)
        }
    }

    private fun loadWalletData() {
        binding.walletProgressBar.visibility = View.VISIBLE

        val driverId = auth.currentUser?.uid ?: return

        val serverUrl = AppConfig.getServerUrl(this)
        val endpoint = "$serverUrl/api/drivers/$driverId/earnings"

        auth.currentUser?.getIdToken(false)?.addOnSuccessListener { tokenResult ->
            val token = tokenResult.token ?: ""
            thread {
                try {
                    val url = URL(endpoint)
                    val conn = url.openConnection() as HttpURLConnection
                    conn.requestMethod = "GET"
                    conn.setRequestProperty("Authorization", "Bearer $token")
                    conn.connectTimeout = 5000
                    conn.readTimeout = 5000

                    val responseCode = conn.responseCode
                    if (responseCode == HttpURLConnection.HTTP_OK) {
                        val reader = BufferedReader(InputStreamReader(conn.inputStream))
                        val responseStr = reader.use { it.readText() }
                        val json = JSONObject(responseStr)

                        runOnUiThread {
                            updateUi(json)
                            binding.walletProgressBar.visibility = View.GONE
                        }
                    } else {
                        runOnUiThread {
                            binding.walletProgressBar.visibility = View.GONE
                        }
                    }
                } catch (e: Exception) {
                    Log.e("WalletActivity", "Error loading earnings", e)
                    runOnUiThread {
                        binding.walletProgressBar.visibility = View.GONE
                    }
                }
            }
        }?.addOnFailureListener {
            binding.walletProgressBar.visibility = View.GONE
        }
    }

    private fun updateUi(json: JSONObject) {
        try {
            val todayObj = json.optJSONObject("today")
            val weekObj = json.optJSONObject("week")
            val monthObj = json.optJSONObject("month")
            val allTimeObj = json.optJSONObject("allTime")

            val allTimeTotal = allTimeObj?.optDouble("total", 0.0) ?: 0.0
            val allTimeTrips = allTimeObj?.optInt("tripCount", 0) ?: 0
            val todayTotal = todayObj?.optDouble("total", 0.0) ?: 0.0
            val todayTrips = todayObj?.optInt("tripCount", 0) ?: 0
            val weekTotal = weekObj?.optDouble("total", 0.0) ?: 0.0
            val weekTrips = weekObj?.optInt("tripCount", 0) ?: 0
            val monthTotal = monthObj?.optDouble("total", 0.0) ?: 0.0
            val monthTrips = monthObj?.optInt("tripCount", 0) ?: 0

            val avgEarnings = if (allTimeTrips > 0) allTimeTotal / allTimeTrips else 0.0

            binding.tvWalletBalance.text = String.format(Locale.US, "$%.2f", allTimeTotal)
            binding.tvTotalTripsCount.text = "$allTimeTrips viajes completados"

            binding.tvEarningsToday.text = String.format(Locale.US, "$%.2f", todayTotal)
            binding.tvTripsToday.text = "$todayTrips ${if (todayTrips == 1) "viaje" else "viajes"}"

            binding.tvEarningsWeek.text = String.format(Locale.US, "$%.2f", weekTotal)
            binding.tvTripsWeek.text = "$weekTrips ${if (weekTrips == 1) "viaje" else "viajes"}"

            binding.tvEarningsMonth.text = String.format(Locale.US, "$%.2f", monthTotal)
            binding.tvTripsMonth.text = "$monthTrips ${if (monthTrips == 1) "viaje" else "viajes"}"

            binding.tvAveragePerTrip.text = String.format(Locale.US, "$%.2f", avgEarnings)
        } catch (e: Exception) {
            Log.e("WalletActivity", "Error parsing earnings UI", e)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        socket?.disconnect()
    }
}
