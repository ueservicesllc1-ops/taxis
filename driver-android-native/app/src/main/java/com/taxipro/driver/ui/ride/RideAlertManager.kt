package com.taxipro.driver.ui.ride

object RideAlertManager {
    @Volatile
    private var currentActiveRideId: String? = null

    fun markShowing(rideId: String) {
        currentActiveRideId = rideId
    }

    fun clear(rideId: String?) {
        if (rideId == null || currentActiveRideId == rideId) {
            currentActiveRideId = null
        }
    }

    fun isShowing(rideId: String): Boolean {
        return currentActiveRideId != null && currentActiveRideId == rideId
    }

    fun getActiveRideId(): String? = currentActiveRideId
}
