package com.shoco.control

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executors

data class MenuAction(val id: String, val title: String, val needsInput: Boolean, val multiline: Boolean, val hint: String)

class MainActivity : Activity() {
    private lateinit var preferences: SecurePreferences
    private lateinit var apiUrlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var connectionText: TextView
    private lateinit var summaryText: TextView
    private lateinit var menuContainer: LinearLayout
    private lateinit var progressBar: ProgressBar
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        preferences = SecurePreferences(this)
        apiUrlInput = findViewById(R.id.apiUrlInput)
        tokenInput = findViewById(R.id.tokenInput)
        connectionText = findViewById(R.id.connectionText)
        summaryText = findViewById(R.id.summaryText)
        menuContainer = findViewById(R.id.menuContainer)
        progressBar = findViewById(R.id.progressBar)
        apiUrlInput.setText(preferences.apiUrl())
        tokenInput.hint = if (preferences.token().isBlank()) getString(R.string.token_hint) else getString(R.string.token_saved)
        findViewById<Button>(R.id.connectButton).setOnClickListener { saveAndConnect() }
        if (preferences.apiUrl().isNotBlank() && preferences.token().isNotBlank()) loadDashboard()
    }

    private fun credentials(): Pair<String, String>? {
        val url = apiUrlInput.text.toString().trim().trimEnd('/')
        val entered = tokenInput.text.toString().trim()
        val token = entered.ifBlank { preferences.token() }
        if (!url.startsWith("https://", true)) {
            showError(getString(R.string.https_required)); return null
        }
        if (token.length < 32) {
            showError(getString(R.string.token_required)); return null
        }
        return url to token
    }

    private fun saveAndConnect() {
        val pair = credentials() ?: return
        preferences.saveApiUrl(pair.first)
        val entered = tokenInput.text.toString().trim()
        if (entered.isNotBlank()) {
            preferences.saveToken(entered)
            tokenInput.text.clear()
            tokenInput.hint = getString(R.string.token_saved)
        }
        loadDashboard()
    }

    private fun loadDashboard() {
        val (url, token) = credentials() ?: return
        setBusy(true)
        executor.execute {
            try {
                val status = ApiClient.request(url, token, "/api/v1/status")
                val menu = ApiClient.request(url, token, "/api/v1/menu")
                mainHandler.post {
                    setBusy(false)
                    if (!status.successful) return@post showApiError(status)
                    if (!menu.successful) return@post showApiError(menu)
                    renderStatus(JSONObject(status.body))
                    renderMenu(JSONObject(menu.body))
                    connectionText.text = getString(R.string.connected)
                    connectionText.setTextColor(getColor(R.color.success))
                }
            } catch (error: Exception) {
                mainHandler.post { setBusy(false); showError(error.message ?: getString(R.string.connection_failed)) }
            }
        }
    }

    private fun renderStatus(data: JSONObject) {
        val wa = data.getJSONObject("whatsapp")
        summaryText.text = getString(R.string.status_summary, wa.optInt("online"), wa.optInt("total"), formatUptime(data.optLong("uptimeSeconds")))
    }

    private fun renderMenu(data: JSONObject) {
        menuContainer.removeAllViews()
        val categories = data.getJSONArray("categories")
        for (categoryIndex in 0 until categories.length()) {
            val category = categories.getJSONObject(categoryIndex)
            menuContainer.addView(TextView(this).apply {
                text = category.getString("title").uppercase()
                setTextColor(getColor(R.color.text_secondary))
                textSize = 12f
                letterSpacing = 0.12f
                setPadding(0, dp(22), 0, dp(9))
            })
            val items = category.getJSONArray("items")
            var row: LinearLayout? = null
            for (index in 0 until items.length()) {
                if (index % 2 == 0) {
                    row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
                    menuContainer.addView(row)
                }
                val item = items.getJSONObject(index)
                val action = MenuAction(item.getString("id"), item.getString("title"), item.optBoolean("input"), item.optBoolean("multiline"), item.optString("hint"))
                val button = Button(this).apply {
                    text = action.title
                    isAllCaps = false
                    textSize = 13f
                    setTextColor(getColor(R.color.accent))
                    background = getDrawable(R.drawable.button_secondary)
                    setOnClickListener { selectAction(action) }
                }
                row?.addView(button, LinearLayout.LayoutParams(0, dp(52), 1f).apply {
                    val gap = dp(5); setMargins(gap, gap, gap, gap)
                })
            }
        }
    }

    private fun selectAction(action: MenuAction) {
        when (action.id) {
            "refresh" -> loadDashboard()
            "reconnect" -> executePost(action.title, "/api/v1/actions/reconnect-disconnected", null, false)
            else -> if (action.needsInput) showInputDialog(action) else runTool(action, "")
        }
    }

    private fun showInputDialog(action: MenuAction) {
        val input = EditText(this).apply {
            hint = action.hint
            setTextColor(getColor(R.color.text_primary))
            setHintTextColor(getColor(R.color.text_secondary))
            setPadding(dp(16), dp(12), dp(16), dp(12))
            inputType = if (action.id == "pair") InputType.TYPE_CLASS_PHONE else
                InputType.TYPE_CLASS_TEXT or (if (action.multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0)
            minLines = if (action.multiline) 8 else 1
            maxLines = if (action.multiline) 16 else 1
        }
        val wrapper = LinearLayout(this).apply {
            setPadding(dp(18), dp(4), dp(18), 0)
            addView(input, LinearLayout.LayoutParams(-1, -2))
        }
        AlertDialog.Builder(this).setTitle(action.title).setView(wrapper)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.run) { _, _ ->
                if (action.id == "pair") requestPair(input.text.toString()) else runTool(action, input.text.toString())
            }.show()
    }

    private fun requestPair(number: String) {
        executePost(getString(R.string.pairing_code), "/api/v1/sessions/pair", JSONObject().put("number", number).toString(), true)
    }

    private fun runTool(action: MenuAction, input: String) {
        val body = JSONObject().put("action", action.id).put("input", input).toString()
        executePost(action.title, "/api/v1/tools/run", body, false)
    }

    private fun executePost(title: String, path: String, body: String?, pairing: Boolean) {
        val (url, token) = credentials() ?: return
        setBusy(true)
        executor.execute {
            try {
                val result = ApiClient.request(url, token, path, "POST", body)
                mainHandler.post {
                    setBusy(false)
                    if (!result.successful) return@post showApiError(result)
                    val json = JSONObject(result.body)
                    val output = if (pairing) {
                        getString(R.string.pair_result, json.getJSONObject("result").getString("code"))
                    } else json.optString("output").ifBlank { json.optString("message", getString(R.string.done)) }
                    showResult(title, output)
                    loadDashboard()
                }
            } catch (error: Exception) {
                mainHandler.post { setBusy(false); showError(error.message ?: getString(R.string.connection_failed)) }
            }
        }
    }

    private fun showResult(title: String, output: String) {
        val textView = TextView(this).apply {
            text = output; setTextColor(getColor(R.color.text_primary)); textSize = 14f
            setTextIsSelectable(true); setPadding(dp(20), dp(12), dp(20), dp(12))
        }
        AlertDialog.Builder(this).setTitle(title).setView(ScrollView(this).apply { addView(textView) })
            .setPositiveButton(R.string.close, null).show()
    }

    private fun showApiError(result: ApiResult) {
        val message = try { JSONObject(result.body).optString("error") } catch (_: Exception) { "" }
        showError(message.ifBlank { "Server returned HTTP ${result.statusCode}." })
    }

    private fun setBusy(busy: Boolean) {
        progressBar.visibility = if (busy) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.connectButton).isEnabled = !busy
    }

    private fun showError(message: String) {
        connectionText.text = message
        connectionText.setTextColor(getColor(R.color.danger))
    }

    private fun formatUptime(seconds: Long): String {
        val hours = seconds / 3600
        val minutes = (seconds % 3600) / 60
        return if (hours > 0) "${hours}h ${minutes}m" else "${minutes}m"
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
    override fun onDestroy() { executor.shutdownNow(); super.onDestroy() }
}
