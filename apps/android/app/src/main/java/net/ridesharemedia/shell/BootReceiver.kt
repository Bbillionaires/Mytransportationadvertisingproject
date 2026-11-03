package net.ridesharemedia.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Start the player after boot (dedicated devices also launch it as the HOME activity). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_LOCKED_BOOT_COMPLETED) {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
