package com.taxipro.driver

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.google.firebase.FirebaseApp

class TaxiDriverApplication : Application() {

    companion object {
        const val LOCATION_CHANNEL_ID = "location_foreground_channel"
        const val RIDE_CHANNEL_ID = "ride_alert_channel"
    }

    override fun onCreate() {
        super.onCreate()
        FirebaseApp.initializeApp(this)
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val locationChannel = NotificationChannel(
                LOCATION_CHANNEL_ID,
                "Servicio de Ubicación GPS 24/7",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Transmisión continua de GPS para despacho de taxis"
            }

            val rideChannel = NotificationChannel(
                RIDE_CHANNEL_ID,
                "Alertas de Carreras Nuevas",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notificaciones de carreras asignadas en tiempo real"
                enableVibration(true)
            }

            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(locationChannel)
            manager?.createNotificationChannel(rideChannel)
        }
    }
}
