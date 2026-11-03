package net.ridesharemedia.shell

import android.content.Context
import android.content.RestrictionsManager

/** Settings pushed by the EMM as managed configuration (see res/xml/app_restrictions.xml), with safe defaults. */
data class ShellConfig(val serverOrigin: String, val kioskEnabled: Boolean) {
    companion object {
        fun load(context: Context): ShellConfig {
            val r = (context.getSystemService(Context.RESTRICTIONS_SERVICE) as RestrictionsManager).applicationRestrictions
            val origin = UrlPolicy.validateServerUrl(r.getString("server_url"), BuildConfig.ALLOW_CLEARTEXT_SERVER)
                ?: UrlPolicy.validateServerUrl(BuildConfig.DEFAULT_SERVER_URL, BuildConfig.ALLOW_CLEARTEXT_SERVER)!!
            return ShellConfig(origin, r.getBoolean("kiosk_enabled", true))
        }
    }
}
