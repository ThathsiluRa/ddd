package com.shoco.control

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.max

class MainActivity : Activity() {
    private lateinit var preferences: SecurePreferences
    private lateinit var apiUrlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var phoneInput: EditText
    private lateinit var pairingCode: TextView
    private lateinit var connectionLabel: TextView
    private lateinit var serverValue: TextView
    private lateinit var modeValue: TextView
    private lateinit var sessionsValue: TextView
    private lateinit var apiValue: TextView
    private lateinit var uptimeValue: TextView
    private lateinit var sessionList: TextView
    private lateinit var saveButton: Button
    private lateinit var refreshButton: Button
    private lateinit var reconnectButton: Button
    private lateinit var pairButton: Button

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        preferences = SecurePreferences(this)
        bindViews()

        apiUrlInput.setText(preferences.apiUrl())
        tokenInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        tokenInput.hint = if (preferences.token().isBlank()) {
            getString(R.string.token_hint)
        } else {
            getString(R.string.token_saved_hint)
        }

        saveButton.setOnClickListener { saveAndConnect() }
        refreshButton.setOnClickListener { refreshStatus() }
        reconnectButton.setOnClickListener { reconnectDisconnected() }
        pairButton.setOnClickListener { requestPairingCode() }

        if (preferences.apiUrl().isNotBlank() && preferences.token().isNotBlank()) {
            refreshStatus()
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun bindViews() {
        apiUrlInput = findViewById(R.id.apiUrlInput)
        tokenInput = findViewById(R.id.tokenInput)
        phoneInput = findViewById(R.id.phoneInput)
        pairingCode = findViewById(R.id.pairingCode)
        connectionLabel = findViewById(R.id.connectionLabel)
        serverValue = findViewById(R.id.serverValue)
        modeValue = findViewById(R.id.modeValue)
        sessionsValue = findViewById(R.id.sessionsValue)
        apiValue = findViewById(R.id.apiValue)
        uptimeValue = findViewById(R.id.uptimeValue)
        sessionList = findViewById(R.id.sessionList)
        saveButton = findViewById(R.id.saveButton)
        refreshButton = findViewById(R.id.refreshButton)
        reconnectButton = findViewById(R.id.reconnectButton)
        pairButton = findViewById(R.id.pairButton)
    }

    private fun saveAndConnect() {
        val url = apiUrlInput.text.toString().trim().trimEnd('/')
        val enteredToken = tokenInput.text.toString().trim()
        val token = enteredToken.ifBlank { preferences.token() }

        if (!url.startsWith("https://", ignoreCase = true)) {
            showError(getString(R.string.https_required))
            return
        }
        if (token.length < 32) {
            showError(getString(R.string.token_too_short))
            return
        }

        preferences.saveApiUrl(url)
        if (enteredToken.isNotBlank()) {
            preferences.saveToken(enteredToken)
            tokenInput.text.clear()
            tokenInput.hint = getString(R.string.token_saved_hint)
        }
        refreshStatus()
    }

    private fun currentCredentials(): Pair<String, String>? {
        val url = apiUrlInput.text.toString().trim().trimEnd('/').ifBlank { preferences.apiUrl() }
        val enteredToken = tokenInput.text.toString().trim()
        val token = enteredToken.ifBlank { preferences.token() }

        if (url.isBlank() || token.isBlank()) {
            showError(getString(R.string.configure_first))
            return null
        }
        return url to token
    }

    private fun refreshStatus() {
        val (url, token) = currentCredentials() ?: return
        runRequest(
            busyMessage = getString(R.string.connecting),
            call = { ApiClient.request(url, token, "/api/v1/status") },
            onSuccess = success@{ result ->
                if (!result.successful) {
                    showApiFailure(result)
                    return@success
                }
                renderStatus(JSONObject(result.body))
            }
        )
    }

    private fun reconnectDisconnected() {
        val (url, token) = currentCredentials() ?: return
        runRequest(
            busyMessage = getString(R.string.reconnecting),
            call = {
                ApiClient.request(
                    url,
                    token,
                    "/api/v1/actions/reconnect-disconnected",
                    "POST"
                )
            },
            onSuccess = success@{ result ->
                if (!result.successful) {
                    showApiFailure(result)
                    return@success
                }
                val message = JSONObject(result.body)
                    .optString("message", getString(R.string.reconnect_started))
                connectionLabel.text = message
                connectionLabel.setTextColor(getColor(R.color.success))
                mainHandler.postDelayed({ refreshStatus() }, 1_500)
            }
        )
    }

    private fun requestPairingCode() {
        val (url, token) = currentCredentials() ?: return
        val number = phoneInput.text.toString().replace(Regex("[^0-9]"), "")
        if (number.length !in 8..15) {
            showError(getString(R.string.phone_invalid))
            return
        }

        val requestBody = JSONObject().put("number", number).toString()
        runRequest(
            busyMessage = getString(R.string.requesting_pair_code),
            call = {
                ApiClient.request(
                    url,
                    token,
                    "/api/v1/sessions/pair",
                    "POST",
                    requestBody
                )
            },
            onSuccess = success@{ result ->
                if (!result.successful) {
                    showApiFailure(result)
                    return@success
                }

                val payload = JSONObject(result.body).getJSONObject("result")
                pairingCode.text = payload.getString("code")
                pairingCode.visibility = View.VISIBLE
                connectionLabel.text = getString(R.string.pair_code_ready)
                connectionLabel.setTextColor(getColor(R.color.success))
                mainHandler.postDelayed({ refreshStatus() }, 2_000)
            }
        )
    }

    private fun runRequest(
        busyMessage: String,
        call: () -> ApiResult,
        onSuccess: (ApiResult) -> Unit
    ) {
        setBusy(true, busyMessage)
        executor.execute {
            try {
                val result = call()
                mainHandler.post {
                    setBusy(false, null)
                    onSuccess(result)
                }
            } catch (error: Exception) {
                mainHandler.post {
                    setBusy(false, null)
                    showError(error.message ?: getString(R.string.connection_failed))
                }
            }
        }
    }

    private fun renderStatus(status: JSONObject) {
        val server = status.getJSONObject("server")
        val whatsapp = status.getJSONObject("whatsapp")

        serverValue.text = if (server.optBoolean("online")) getString(R.string.online) else getString(R.string.offline)
        modeValue.text = status.optString("mode", "private")
        sessionsValue.text = getString(
            R.string.session_summary,
            whatsapp.optInt("online"),
            whatsapp.optInt("total")
        )
        apiValue.text = "v${status.optInt("apiVersion")}"
        uptimeValue.text = formatUptime(status.optLong("uptimeSeconds"))

        val sessions = whatsapp.optJSONArray("sessions")
        val lines = mutableListOf<String>()
        if (sessions != null) {
            for (index in 0 until sessions.length()) {
                val session = sessions.getJSONObject(index)
                val state = session.optString("status", "offline")
                val indicator = when (state) {
                    "open" -> "●"
                    "connecting" -> "◐"
                    else -> "○"
                }
                lines += "$indicator  ${session.optString("number")}  ·  $state"
            }
        }
        sessionList.text = if (lines.isEmpty()) getString(R.string.no_sessions) else lines.joinToString("\n")

        connectionLabel.text = getString(
            R.string.connected_at,
            status.optString("serverTime").replace("T", " ").take(19)
        )
        connectionLabel.setTextColor(getColor(R.color.success))
    }

    private fun setBusy(busy: Boolean, message: String?) {
        saveButton.isEnabled = !busy
        refreshButton.isEnabled = !busy
        reconnectButton.isEnabled = !busy
        pairButton.isEnabled = !busy
        findViewById<View>(R.id.progressBar).visibility = if (busy) View.VISIBLE else View.GONE
        if (message != null) {
            connectionLabel.text = message
            connectionLabel.setTextColor(getColor(R.color.text_secondary))
        }
    }

    private fun showApiFailure(result: ApiResult) {
        val detail = try {
            JSONObject(result.body).optString("error")
        } catch (_: Exception) {
            ""
        }
        showError(if (detail.isBlank()) "Server returned HTTP ${result.statusCode}." else detail)
    }

    private fun showError(message: String) {
        connectionLabel.text = message
        connectionLabel.setTextColor(getColor(R.color.danger))
    }

    private fun formatUptime(totalSeconds: Long): String {
        var seconds = max(0L, totalSeconds)
        val days = seconds / 86_400
        seconds %= 86_400
        val hours = seconds / 3_600
        val minutes = (seconds % 3_600) / 60
        return when {
            days > 0 -> "${days}d ${hours}h"
            hours > 0 -> "${hours}h ${minutes}m"
            else -> "${minutes}m"
        }
    }
}
