package net.ridesharemedia.shell

import android.app.admin.DeviceAdminReceiver

/** Device-admin component so an EMM (or `dpm set-device-owner` for a pilot) can make this app the dedicated-device owner. */
class AdminReceiver : DeviceAdminReceiver()
