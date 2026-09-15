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

data class MenuAction(
    val id: String,
    val action: String,
    val title: String,
    val description: String,
    val needsInput: Boolean,
    val inputType: String,
    val multiline: Boolean,
    val hint: String,
    val confirmation: String
)

class MainActivity : Activity() {
    companion object {
        private const val DEFAULT_API_URL = "https://bot.srilankangrill.online"
    }

    private lateinit var preferences: SecurePreferences
    private lateinit var apiUrlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var connectionText: TextView
    private lateinit var summaryText: TextView
    private lateinit var titleText: TextView
    private lateinit var subtitleText: TextView
    private lateinit var menuContainer: LinearLayout
    private lateinit var progressBar: ProgressBar
    private var menuData: JSONObject? = null
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
        titleText = findViewById(R.id.titleText)
        subtitleText = findViewById(R.id.subtitleText)
        menuContainer = findViewById(R.id.menuContainer)
        progressBar = findViewById(R.id.progressBar)

        apiUrlInput.setText(preferences.apiUrl().ifBlank { DEFAULT_API_URL })
        tokenInput.hint = if (preferences.token().isBlank()) {
            getString(R.string.token_hint)
        } else {
            getString(R.string.token_saved)
        }

        findViewById<Button>(R.id.connectButton).setOnClickListener { saveAndConnect() }
        if (preferences.token().isNotBlank()) loadDashboard()
    }

    private fun credentials(): Pair<String, String>? {
        val url = apiUrlInput.text.toString().trim().trimEnd('/')
        val entered = tokenInput.text.toString().trim()
        val token = entered.ifBlank { preferences.token() }
        if (!url.startsWith("https://", true)) {
            showError(getString(R.string.https_required))
            return null
        }
        if (token.length < 32) {
            showError(getString(R.string.token_required))
            return null
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
                mainHandler.post {
                    setBusy(false)
                    showError(error.message ?: getString(R.string.connection_failed))
                }
            }
        }
    }

    private fun renderStatus(data: JSONObject) {
        val wa = data.getJSONObject("whatsapp")
        summaryText.text = getString(
            R.string.status_summary,
            wa.optInt("online"),
            wa.optInt("total"),
            formatUptime(data.optLong("uptimeSeconds"))
        )
    }

    private fun renderMenu(data: JSONObject) {
        menuData = data
        data.optJSONObject("app")?.let { app ->
            titleText.text = app.optString("title", getString(R.string.app_name))
            subtitleText.text = app.optString("subtitle", getString(R.string.subtitle))
        }
        renderCategoryList()
    }

    private fun renderCategoryList() {
        val categories = menuData?.optJSONArray("categories") ?: return
        menuContainer.removeAllViews()
        addSectionLabel(getString(R.string.select_menu))

        for (index in 0 until categories.length()) {
            val category = categories.getJSONObject(index)
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                background = getDrawable(R.drawable.panel)
                setPadding(dp(14), dp(12), dp(14), dp(12))
            }
            val button = Button(this).apply {
                text = category.optString("title", "Menu")
                isAllCaps = false
                textSize = 16f
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setTextColor(getColor(R.color.accent))
                background = getDrawable(R.drawable.button_secondary)
                setOnClickListener { openCategory(index) }
            }
            card.addView(button, LinearLayout.LayoutParams(-1, dp(54)))
            val description = category.optString("description")
            if (description.isNotBlank()) {
                card.addView(TextView(this).apply {
                    text = description
                    setTextColor(getColor(R.color.text_secondary))
                    textSize = 12f
                    setPadding(dp(4), dp(8), dp(4), 0)
                })
            }
            val count = category.optJSONArray("items")?.length() ?: 0
            card.addView(TextView(this).apply {
                text = resources.getQuantityString(R.plurals.control_count, count, count)
                setTextColor(getColor(R.color.text_secondary))
                textSize = 11f
                setPadding(dp(4), dp(6), dp(4), 0)
            })
            menuContainer.addView(card, LinearLayout.LayoutParams(-1, -2).apply {
                setMargins(0, dp(6), 0, dp(6))
            })
        }
    }

    private fun openCategory(categoryIndex: Int) {
        val category = menuData?.optJSONArray("categories")?.optJSONObject(categoryIndex) ?: return
        menuContainer.removeAllViews()

        menuContainer.addView(Button(this).apply {
            text = getString(R.string.back_to_menus)
            isAllCaps = false
            setTextColor(getColor(R.color.accent))
            background = getDrawable(R.drawable.button_secondary)
            setOnClickListener { renderCategoryList() }
        }, LinearLayout.LayoutParams(-1, dp(48)).apply {
            setMargins(0, dp(14), 0, dp(8))
        })

        addSectionLabel(category.optString("title", "Menu"))
        val description = category.optString("description")
        if (description.isNotBlank()) {
            menuContainer.addView(TextView(this).apply {
                text = description
                setTextColor(getColor(R.color.text_secondary))
                textSize = 13f
                setPadding(0, 0, 0, dp(8))
            })
        }

        val items = category.optJSONArray("items") ?: return
        var row: LinearLayout? = null
        for (index in 0 until items.length()) {
            if (index % 2 == 0) {
                row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                }
                menuContainer.addView(row)
            }
            val action = parseAction(items.getJSONObject(index))
            val button = Button(this).apply {
                text = action.title
                isAllCaps = false
                textSize = 13f
                setTextColor(getColor(R.color.accent))
                background = getDrawable(R.drawable.button_secondary)
                contentDescription = action.description.ifBlank { action.title }
                setOnClickListener { selectAction(action) }
            }
            row?.addView(button, LinearLayout.LayoutParams(0, dp(58), 1f).apply {
                val gap = dp(5)
                setMargins(gap, gap, gap, gap)
            })
        }
    }

    private fun addSectionLabel(label: String) {
        menuContainer.addView(TextView(this).apply {
            text = label.uppercase()
            setTextColor(getColor(R.color.text_secondary))
            textSize = 12f
            letterSpacing = 0.12f
            setPadding(0, dp(20), 0, dp(9))
        })
    }

    private fun parseAction(item: JSONObject): MenuAction {
        return MenuAction(
            id = item.optString("id"),
            action = item.optString("action", item.optString("id")),
            title = item.optString("title", item.optString("id")),
            description = item.optString("description"),
            needsInput = item.optBoolean("input"),
            inputType = item.optString("inputType", "text"),
            multiline = item.optBoolean("multiline"),
            hint = item.optString("hint"),
            confirmation = item.optString("confirmation")
        )
    }

    private fun selectAction(action: MenuAction) {
        if (action.action == "refresh") {
            loadDashboard()
            return
        }
        if (action.needsInput) {
            showInputDialog(action)
        } else {
            confirmAndRun(action, "")
        }
    }

    private fun showInputDialog(action: MenuAction) {
        val input = EditText(this).apply {
            hint = action.hint
            setTextColor(getColor(R.color.text_primary))
            setHintTextColor(getColor(R.color.text_secondary))
            setPadding(dp(16), dp(12), dp(16), dp(12))
            inputType = when (action.inputType) {
                "phone" -> InputType.TYPE_CLASS_PHONE
                "url" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                else -> InputType.TYPE_CLASS_TEXT or
                    (if (action.multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0)
            }
            minLines = if (action.multiline) 8 else 1
            maxLines = if (action.multiline) 16 else 1
        }
        val wrapper = LinearLayout(this).apply {
            setPadding(dp(18), dp(4), dp(18), 0)
            addView(input, LinearLayout.LayoutParams(-1, -2))
        }
        AlertDialog.Builder(this)
            .setTitle(action.title)
            .setMessage(action.description.ifBlank { null })
            .setView(wrapper)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.run) { _, _ ->
                confirmAndRun(action, input.text.toString())
            }
            .show()
    }

    private fun confirmAndRun(action: MenuAction, input: String) {
        if (action.confirmation.isBlank()) {
            executeAction(action, input)
            return
        }
        AlertDialog.Builder(this)
            .setTitle(action.title)
            .setMessage(action.confirmation)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.continue_action) { _, _ -> executeAction(action, input) }
            .show()
    }

    private fun executeAction(action: MenuAction, input: String) {
        val (url, token) = credentials() ?: return
        val body = JSONObject()
            .put("action", action.action)
            .put("input", input)
            .toString()
        setBusy(true)
        executor.execute {
            try {
                val result = ApiClient.request(url, token, "/api/v1/actions/run", "POST", body)
                mainHandler.post {
                    setBusy(false)
                    if (!result.successful) return@post showApiError(result)
                    val json = JSONObject(result.body)
                    val output = json.optString("output").ifBlank { getString(R.string.done) }
                    showResult(action.title, output)
                    if (json.optBoolean("refreshStatus")) loadDashboard()
                }
            } catch (error: Exception) {
                mainHandler.post {
                    setBusy(false)
                    showError(error.message ?: getString(R.string.connection_failed))
                }
            }
        }
    }

    private fun showResult(title: String, output: String) {
        val textView = TextView(this).apply {
            text = output
            setTextColor(getColor(R.color.text_primary))
            textSize = 14f
            setTextIsSelectable(true)
            setPadding(dp(20), dp(12), dp(20), dp(12))
        }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(ScrollView(this).apply { addView(textView) })
            .setPositiveButton(R.string.close, null)
            .show()
    }

    private fun showApiError(result: ApiResult) {
        val message = try {
            JSONObject(result.body).optString("error")
        } catch (_: Exception) {
            ""
        }
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

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }
}
