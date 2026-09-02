package com.taxipro.driver.config

import android.content.Context
import com.taxipro.driver.R

object AppConfig {
    private const val DEFAULT_URL = "http://10.0.2.2:3000"

    fun getServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val customUrl = prefs.getString("custom_server_url", null)
        if (!customUrl.isNullOrEmpty()) {
            return customUrl
        }

        return try {
            context.getString(R.string.server_url)
        } catch (e: Exception) {
            DEFAULT_URL
        }
    }

    fun setCustomServerUrl(context: Context, url: String) {
        val prefs = context.getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("custom_server_url", url.trim()).apply()
    }
}
