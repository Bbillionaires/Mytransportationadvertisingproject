package net.ridesharemedia.shell

import java.net.URI

/** Pure navigation/configuration rules (unit-tested on the JVM). */
object UrlPolicy {
    /** The configured server must be https (cleartext only in debug builds, for the emulator). */
    fun validateServerUrl(raw: String?, allowCleartext: Boolean): String? {
        if (raw.isNullOrBlank()) return null
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https" && !(allowCleartext && scheme == "http")) return null
        if (uri.host.isNullOrBlank() || uri.userInfo != null) return null
        return "$scheme://${uri.host}${if (uri.port != -1) ":${uri.port}" else ""}"
    }

    fun origin(url: String): String? = runCatching {
        val u = URI(url)
        "${u.scheme.lowercase()}://${u.host.lowercase()}${if (u.port != -1) ":${u.port}" else ""}"
    }.getOrNull()

    /** The top-level page may never leave the server origin. (Advertiser pages only ever load inside the player's sandboxed frame.) */
    fun isAllowedMainFrame(url: String, serverOrigin: String): Boolean = origin(url) == serverOrigin

    fun playerUrl(serverOrigin: String) = "$serverOrigin/player/index.html"
}
