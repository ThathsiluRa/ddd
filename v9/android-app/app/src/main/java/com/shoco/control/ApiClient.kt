package com.shoco.control

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

data class ApiResult(
    val statusCode: Int,
    val body: String,
    val successful: Boolean
)

object ApiClient {
    fun request(
        baseUrl: String,
        token: String,
        path: String,
        method: String = "GET",
        body: String? = null
    ): ApiResult {
        val normalizedBase = baseUrl.trim().trimEnd('/')
        val uri = URI(normalizedBase)

        require(uri.scheme.equals("https", ignoreCase = true)) {
            "The server URL must use HTTPS."
        }
        require(!uri.host.isNullOrBlank()) {
            "Enter a complete server URL, for example https://control.example.com"
        }

        val connection = URL(normalizedBase + path).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $token")

            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            } else if (method == "POST") {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(0)
                connection.outputStream.close()
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            ApiResult(status, responseBody, status in 200..299)
        } finally {
            connection.disconnect()
        }
    }
}
