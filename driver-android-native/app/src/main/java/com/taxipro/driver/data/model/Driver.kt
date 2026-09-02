package com.taxipro.driver.data.model

data class LocationData(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val heading: Float = 0f
)

data class VehicleData(
    val brand: String = "",
    val model: String = "",
    val year: String = "",
    val color: String = "Blanco",
    val plate: String = ""
)

data class Driver(
    val id: String = "",
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val status: String = "pending", // pending, approved, rejected
    val available: Boolean = false,
    val isOnline: Boolean = false,
    val location: LocationData = LocationData(),
    val vehicle: VehicleData = VehicleData()
)
