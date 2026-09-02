package com.taxipro.driver.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.taxipro.driver.R
import com.taxipro.driver.ui.ride.RideAlertActivity
import com.taxipro.driver.ui.ride.RideAlertManager

class TaxiFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val TAG = "TaxiFCMService"
        const val CHANNEL_ID = "ride_alerts_channel"
        const val CHANNEL_NAME = "Solicitudes de Viajes"
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "Nuevo FCM Token recibido: $token")

        val prefs = getSharedPreferences("driver_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("fcm_token", token).apply()

        val auth = FirebaseAuth.getInstance()
        val uid = auth.currentUser?.uid
        if (uid != null) {
            val tokenData = mapOf(
                "fcmToken" to token,
                "platform" to "android",
                "updatedAt" to FieldValue.serverTimestamp(),
                "isActive" to true
            )
            FirebaseFirestore.getInstance().collection("drivers").document(uid)
                .set(tokenData, SetOptions.merge())
                .addOnSuccessListener {
                    Log.i(TAG, "FCM Token sincronizado exitosamente en Firestore para $uid")
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "Error guardando FCM Token en Firestore", e)
                }
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.i(TAG, "FCM Mensaje recibido de: ${remoteMessage.from}")

        val data = remoteMessage.data
        if (data.isNotEmpty()) {
            val type = data["type"] ?: ""
            if (type == "NEW_RIDE") {
                val rideId = data["rideId"] ?: ""

                // 6. EVITAR DUPLICADOS: Si la alerta ya está en pantalla vía Socket.io, omitir
                if (RideAlertManager.isShowing(rideId)) {
                    Log.i(TAG, "Alerta para rideId $rideId ya está activa en pantalla. Omitiendo duplicado FCM.")
                    return
                }

                showRideNotification(data)
            }
        }
    }

    private fun showRideNotification(data: Map<String, String>) {
        val rideId = data["rideId"] ?: ""
        val passengerName = data["passengerName"] ?: "Pasajero"
        val pickup = data["pickup"] ?: "Punto de recogida"
        val destination = data["destination"] ?: "Destino final"
        val fare = data["fare"] ?: "$15.00"
        val distance = data["distance"] ?: "3 min (1.1 km)"
        val estimatedTime = data["estimatedTime"] ?: "18 min"
        val pLat = data["pLat"]?.toDoubleOrNull() ?: 0.0
        val pLng = data["pLng"]?.toDoubleOrNull() ?: 0.0
        val dLat = data["dLat"]?.toDoubleOrNull() ?: 0.0
        val dLng = data["dLng"]?.toDoubleOrNull() ?: 0.0

        val intent = Intent(this, RideAlertActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("rideId", rideId)
            putExtra("fare", fare)
            putExtra("pickup", pickup)
            putExtra("destination", destination)
            putExtra("customerName", passengerName)
            putExtra("pLat", pLat)
            putExtra("pLng", pLng)
            putExtra("dLat", dLat)
            putExtra("dLng", dLng)
            putExtra("pickupDistance", distance)
            putExtra("tripDistance", estimatedTime)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            rideId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val soundUri = Uri.parse("android.resource://" + packageName + "/" + R.raw.ride_alert)
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val audioAttributes = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()

            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notificaciones prioritarias para solicitudes de nuevas carreras"
                enableLights(true)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 500, 200, 500)
                setSound(soundUri, audioAttributes)
                lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
            }
            notificationManager.createNotificationChannel(channel)
        }

        val notificationBuilder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("🚕 Nueva carrera • $fare")
            .setContentText("Recogida: $pickup ➔ $destination")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Pasajero: $passengerName\nRecogida: $pickup\nDestino: $destination\nTarifa: $fare"))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setSound(soundUri)
            .setVibrate(longArrayOf(0, 500, 200, 500))
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true) // Despierta la pantalla y muestra Heads-Up sobre Lockscreen

        val notifId = (rideId.hashCode() and 0x7FFFFFFF)
        notificationManager.notify(notifId, notificationBuilder.build())
        Log.i(TAG, "Notificación prioritaria emitida para carrera $rideId (ID: $notifId)")
    }
}
