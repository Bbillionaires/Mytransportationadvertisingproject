package net.ridesharemedia.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class BridgeProtocolTest {
    private val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val signer = object : BridgeProtocol.KeySigner {
        override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(data); sign() }
    }
    private val bridge = BridgeProtocol(signer) { JSONObject().put("algorithm", "ECDSA_P256").put("serial", "AND-test") }
    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray())
    private val validPayload = "POST\n/v1/devices/heartbeat\n1762200000\nAbCdEfGhIjKlMnOpQrStUvWx\n" + "a".repeat(64)

    @Test fun infoReturnsKeyMetadata() {
        val r = JSONObject(bridge.handle("""{"id":1,"op":"info"}"""))
        assertTrue(r.getBoolean("ok"))
        assertEquals("ECDSA_P256", r.getJSONObject("result").getString("algorithm"))
        assertEquals(1, r.getInt("id"))
    }

    @Test fun signsOnlyDeviceProtocolPayloadsWithAVerifiableSignature() {
        val r = JSONObject(bridge.handle(JSONObject().put("id", 2).put("op", "sign").put("data", b64(validPayload)).toString()))
        assertTrue(r.getBoolean("ok"))
        val sig = Base64.getDecoder().decode(r.getJSONObject("result").getString("signature"))
        val ok = Signature.getInstance("SHA256withECDSA").run { initVerify(kp.public); update(validPayload.toByteArray()); verify(sig) }
        assertTrue("signature verifies with the public key", ok)
    }

    @Test fun refusesToBeAGeneralSigningOracle() {
        for (bad in listOf(
            "hello world",
            "POST\n/v1/finance/journal-requests\n1762200000\nAbCdEfGhIjKlMnOpQrStUvWx\n" + "a".repeat(64), // not a device path
            "DELETE\n/v1/devices/heartbeat\n1762200000\nAbCdEfGhIjKlMnOpQrStUvWx\n" + "a".repeat(64),
            validPayload + "\nextra",
            "POST\n/v1/devices/../auth/login\n1762200000\nAbCdEfGhIjKlMnOpQrStUvWx\n" + "a".repeat(64),
        )) {
            val r = JSONObject(bridge.handle(JSONObject().put("id", 3).put("op", "sign").put("data", b64(bad)).toString()))
            assertFalse("must refuse: $bad", r.getBoolean("ok"))
        }
        assertFalse(JSONObject(bridge.handle("not json")).getBoolean("ok"))
        assertFalse(JSONObject(bridge.handle("""{"id":4,"op":"export_private_key"}""")).getBoolean("ok"))
    }

    @Test fun payloadPatternMatchesEveryPlayerEndpoint() {
        for (p in listOf("/v1/devices/playlist", "/v1/devices/events", "/v1/devices/commands/0b6f6f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/ack",
            "/v1/devices/rider-pairings/0b6f6f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "/v1/devices/games/city-trivia/sessions", "/v1/devices/proximity/alerts/0b6f6f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/outcome")) {
            assertTrue(p, BridgeProtocol.isDeviceProtocolPayload("GET\n$p\n1762200000\nAbCdEfGhIjKlMnOpQrStUvWx\n" + "0".repeat(64)))
        }
    }
}
