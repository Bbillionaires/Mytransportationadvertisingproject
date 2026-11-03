package net.ridesharemedia.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Kiosk shell: one full-screen WebView showing the web player from the configured server. The native key is reachable
 * only through a WebMessage listener restricted to the server origin (never exposed to advertiser frames).
 */
class MainActivity : ComponentActivity() {
    private lateinit var config: ShellConfig
    private lateinit var key: DeviceKey
    private var webView: WebView? = null
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = ShellConfig.load(this)
        key = DeviceKey(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        // Passengers cannot leave the player with the back button.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() {} })
        if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), 1) // EMM can pre-grant
        }
        createWebView()
        // Managed configuration changes (e.g. a new server_url) take effect without reinstalling.
        registerReceiver(object : android.content.BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { recreate() }
        }, IntentFilter(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED))
    }

    override fun onResume() {
        super.onResume()
        enterKioskIfPermitted()
    }

    /** Lock task mode when the EMM (device owner) has allow-listed this app; otherwise run as a normal full-screen app. */
    private fun enterKioskIfPermitted() {
        if (!config.kioskEnabled) return
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (dpm.isDeviceOwnerApp(packageName)) {
            val admin = ComponentName(this, AdminReceiver::class.java)
            dpm.setLockTaskPackages(admin, arrayOf(packageName))
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            dpm.setKeyguardDisabled(admin, true)
            dpm.setStatusBarDisabled(admin, true)
            dpm.addPersistentPreferredActivity(admin, IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT)
            }, ComponentName(this, MainActivity::class.java))
        }
        if (dpm.isLockTaskPermitted(packageName)) runCatching { startLockTask() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val wv = WebView(this)
        webView = wv
        setContentView(wv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true                       // IndexedDB event queue
            mediaPlaybackRequiresUserGesture = false       // kiosk autoplay with sound
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(true)
            userAgentString = "$userAgentString RMNShell/${BuildConfig.VERSION_NAME}"
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) androidx.webkit.WebSettingsCompat.setSafeBrowsingEnabled(wv.settings, true)

        val bridge = BridgeProtocol(key) {
            JSONObject().put("algorithm", "ECDSA_P256").put("publicKey", key.publicKeySpkiB64()).put("serial", key.serial())
                .put("hardwareBacked", key.hardwareBacked()).put("shellVersion", BuildConfig.VERSION_NAME)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(wv, "RMNDevice", setOf(config.serverOrigin)) { _, message, sourceOrigin, isMainFrame, reply ->
                // Defense in depth: Android already restricts injection to the allowed origin; also require the top frame.
                if (isMainFrame && sourceOrigin.toString() == config.serverOrigin) reply.postMessage(bridge.handle(message.data ?: ""))
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.isForMainFrame && !UrlPolicy.isAllowedMainFrame(request.url.toString(), config.serverOrigin)

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) handler.postDelayed({ view.loadUrl(UrlPolicy.playerUrl(config.serverOrigin)) }, 10_000) // offline at boot: retry
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Renderer crashed or was killed for memory: rebuild the WebView instead of crashing the app.
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                webView = null
                handler.post { createWebView() }
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, UrlPolicy.origin(origin) == config.serverOrigin, false)
            }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() } // no camera/microphone on the passenger screen
        }
        wv.loadUrl(UrlPolicy.playerUrl(config.serverOrigin))
    }

    override fun onDestroy() {
        webView?.destroy()
        super.onDestroy()
    }
}
