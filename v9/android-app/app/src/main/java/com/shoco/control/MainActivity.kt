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
    private lateinit var connectionLabel: TextView
    private lateinit var telegramValue: TextView
    private lateinit var usersValue: TextView
    private lateinit var sessionsValue: TextView
    private lateinit var subBotsValue: TextView
    private lateinit var uptimeValue: TextView
    private lateinit var sessionList: TextView
    private lateinit var saveButton: Button
    private lateinit var refreshButton: Button
    private lateinit var reconnectButton: Button

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
        connectionLabel = findViewById(R.id.connectionLabel)
        telegramValue = findViewById(R.id.telegramValue)
        usersValue = findViewById(R.id.usersValue)
        sessionsValue = findViewById(R.id.sessionsValue)
        subBotsValue = findViewById(R.id.subBotsValue)
        uptimeValue = findViewById(R.id.uptimeValue)
        sessionList = findViewById(R.id.sessionList)
        saveButton = findViewById(R.id.saveButton)
        refreshButton = findViewById(R.id.refreshButton)
        reconnectButton = findViewById(R.id.reconnectButton)
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
        val telegram = status.getJSONObject("telegram")
        val whatsapp = status.getJSONObject("whatsapp")
        val username = telegram.optString("username").ifBlank { "unknown" }

        telegramValue.text = if (telegram.optBoolean("connected")) "@$username" else getString(R.string.offline)
        usersValue.text = status.optInt("users").toString()
        sessionsValue.text = getString(
            R.string.session_summary,
            whatsapp.optInt("online"),
            whatsapp.optInt("total")
        )
        subBotsValue.text = status.optInt("deployedBots").toString()
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
