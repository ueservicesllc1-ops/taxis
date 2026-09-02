package com.taxipro.driver.ui.history

import android.content.Context
import android.os.Bundle
import android.util.Log
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.firebase.auth.FirebaseAuth
import com.taxipro.driver.R
import com.taxipro.driver.config.AppConfig
import com.taxipro.driver.databinding.ActivityTripHistoryBinding
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class TripHistoryActivity : AppCompatActivity() {

    private lateinit var binding: ActivityTripHistoryBinding
    private lateinit var adapter: TripHistoryAdapter
    private val tripsList = mutableListOf<JSONObject>()
    private val auth by lazy { FirebaseAuth.getInstance() }

    private var currentFilter = "all"
    private var currentOffset = 0
    private val limit = 20
    private var hasMore = false
    private var isLoading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityTripHistoryBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnBackHistory.setOnClickListener { finish() }
        binding.btnRefreshHistory.setOnClickListener {
            loadTrips(reset = true)
        }

        setupRecyclerView()
        setupFilters()

        loadTrips(reset = true)
    }

    private fun setupRecyclerView() {
        adapter = TripHistoryAdapter(mutableListOf()) { tripJson ->
            val dialog = TripDetailDialog.newInstance(tripJson)
            dialog.show(supportFragmentManager, "TripDetailDialog")
        }

        val layoutManager = LinearLayoutManager(this)
        binding.rvTripHistory.layoutManager = layoutManager
        binding.rvTripHistory.adapter = adapter

        // Paginación infinita: detectar cuando se llega al final de la lista
        binding.rvTripHistory.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                super.onScrolled(recyclerView, dx, dy)
                if (dy > 0 && hasMore && !isLoading) {
                    val totalItemCount = layoutManager.itemCount
                    val lastVisibleItem = layoutManager.findLastVisibleItemPosition()
                    if (lastVisibleItem >= totalItemCount - 3) {
                        loadTrips(reset = false)
                    }
                }
            }
        })
    }

    private fun setupFilters() {
        binding.chipGroupFilters.setOnCheckedStateChangeListener { _, checkedIds ->
            if (checkedIds.isEmpty()) return@setOnCheckedStateChangeListener
            val selectedFilter = when (checkedIds.first()) {
                R.id.chipCompleted -> "completed"
                R.id.chipCancelled -> "cancelled"
                else -> "all"
            }

            if (selectedFilter != currentFilter) {
                currentFilter = selectedFilter
                loadTrips(reset = true)
            }
        }
    }

    private fun loadTrips(reset: Boolean) {
        if (isLoading) return
        isLoading = true

        if (reset) {
            currentOffset = 0
            binding.historyProgressBar.visibility = View.VISIBLE
        } else {
            binding.paginationProgressBar.visibility = View.VISIBLE
        }

        val driverId = auth.currentUser?.uid ?: run {
            isLoading = false
            binding.historyProgressBar.visibility = View.GONE
            binding.paginationProgressBar.visibility = View.GONE
            return
        }

        val serverUrl = AppConfig.getServerUrl(this)
        val endpoint = "$serverUrl/api/drivers/$driverId/trips?status=$currentFilter&limit=$limit&offset=$currentOffset"

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

                        val tripsArray = json.optJSONArray("trips")
                        hasMore = json.optBoolean("hasMore", false)
                        val nextOffset = json.optInt("nextOffset", currentOffset + limit)

                        val newTrips = mutableListOf<JSONObject>()
                        if (tripsArray != null) {
                            for (i in 0 until tripsArray.length()) {
                                newTrips.add(tripsArray.getJSONObject(i))
                            }
                        }

                        runOnUiThread {
                            if (reset) {
                                tripsList.clear()
                            }
                            tripsList.addAll(newTrips)
                            adapter.notifyDataSetChanged()
                            currentOffset = nextOffset
                            updateEmptyState()

                            binding.historyProgressBar.visibility = View.GONE
                            binding.paginationProgressBar.visibility = View.GONE
                            isLoading = false
                        }
                    } else {
                        runOnUiThread {
                            binding.historyProgressBar.visibility = View.GONE
                            binding.paginationProgressBar.visibility = View.GONE
                            isLoading = false
                        }
                    }
                } catch (e: Exception) {
                    Log.e("TripHistoryActivity", "Error loading trips", e)
                    runOnUiThread {
                        binding.historyProgressBar.visibility = View.GONE
                        binding.paginationProgressBar.visibility = View.GONE
                        isLoading = false
                    }
                }
            }
        }?.addOnFailureListener {
            binding.historyProgressBar.visibility = View.GONE
            binding.paginationProgressBar.visibility = View.GONE
            isLoading = false
        }
    }

    private fun updateEmptyState() {
        if (tripsList.isEmpty()) {
            binding.layoutEmptyState.visibility = View.VISIBLE
            binding.rvTripHistory.visibility = View.GONE
        } else {
            binding.layoutEmptyState.visibility = View.GONE
            binding.rvTripHistory.visibility = View.VISIBLE
        }
    }
}
