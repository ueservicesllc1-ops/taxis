package com.taxipro.driver.config

import android.content.Context
import com.taxipro.driver.R

object AppConfig {
    const val STAGING_URL = "https://taxis-production-17b1.up.railway.app"
    const val EMULATOR_URL = "http://10.0.2.2:3000"
    const val DEFAULT_URL = STAGING_URL

    /**
     * Retorna la URL del backend de Staging oficial para teléfonos físicos y producción.
     * Prioridad de resolución:
     * 1. custom_server_url definido dinámicamente en SharedPreferences (driver_prefs).
     * 2. Recurso string server_url (Staging: https://taxis-production-17b1.up.railway.app).
     * 3. Constante DEFAULT_URL (Staging HTTPS oficial).
     */
    fun getServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        val customUrl = prefs.getString("custom_server_url", null)
        if (!customUrl.isNullOrEmpty()) {
            return customUrl
        }

        return try {
            val resUrl = context.getString(R.string.server_url)
            if (resUrl.isNotEmpty()) resUrl else DEFAULT_URL
        } catch (e: Exception) {
            DEFAULT_URL
        }
    }

    /**
     * Retorna la URL exclusiva para pruebas en Android Emulator (10.0.2.2).
     */
    fun getEmulatorUrl(context: Context): String {
        return try {
            val resUrl = context.getString(R.string.emulator_server_url)
            if (resUrl.isNotEmpty()) resUrl else EMULATOR_URL
        } catch (e: Exception) {
            EMULATOR_URL
        }
    }

    fun setCustomServerUrl(context: Context, url: String) {
        val prefs = context.getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("custom_server_url", url.trim()).apply()
    }
}

