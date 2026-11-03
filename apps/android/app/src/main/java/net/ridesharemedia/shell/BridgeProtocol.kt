package net.ridesharemedia.shell

import org.json.JSONObject
import java.util.Base64

/**
 * Message protocol between the player page and the native key, over a WebMessage listener that Android only injects
 * into frames from the configured server origin. Requests: {"id": n, "op": "info"} or {"id": n, "op": "sign", "data": base64}.
 * The bridge signs ONLY canonical device-protocol payloads (METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256HEX for /v1/devices/…),
 * so even a compromised page cannot use the hardware key as a general-purpose signing oracle.
 */
class BridgeProtocol(private val key: KeySigner, private val info: () -> JSONObject) {

    interface KeySigner { fun sign(data: ByteArray): ByteArray }

    fun handle(raw: String): String {
        val req = runCatching { JSONObject(raw) }.getOrNull() ?: return error(null, "malformed request")
        val id = req.opt("id")
        return when (req.optString("op")) {
            "info" -> ok(id, info())
            "sign" -> {
                val data = runCatching { Base64.getDecoder().decode(req.getString("data")) }.getOrNull() ?: return error(id, "data must be base64")
                if (!isDeviceProtocolPayload(String(data, Charsets.UTF_8))) return error(id, "refused: not a device protocol payload")
                ok(id, JSONObject().put("signature", Base64.getEncoder().encodeToString(key.sign(data))))
            }
            else -> error(id, "unknown op")
        }
    }

    companion object {
        private val PAYLOAD = Regex("^(GET|POST)\\n/v1/devices/[A-Za-z0-9/_-]{1,200}\\n\\d{9,12}\\n[A-Za-z0-9_-]{16,64}\\n[0-9a-f]{64}$")
        fun isDeviceProtocolPayload(s: String): Boolean = s.length <= 512 && PAYLOAD.matches(s)
        private fun ok(id: Any?, result: JSONObject) = JSONObject().put("id", id ?: JSONObject.NULL).put("ok", true).put("result", result).toString()
        private fun error(id: Any?, message: String) = JSONObject().put("id", id ?: JSONObject.NULL).put("ok", false).put("error", message).toString()
    }
}
