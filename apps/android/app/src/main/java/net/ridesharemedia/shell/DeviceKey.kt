package net.ridesharemedia.shell

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.UUID

/**
 * Tablet identity key in the Android Keystore: ECDSA P-256, non-exportable, StrongBox-backed when the device has a secure
 * element (falls back to the TEE). The private key never enters app memory or the WebView; only signatures leave.
 */
class DeviceKey(private val context: Context) : BridgeProtocol.KeySigner {
    private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private val prefs = context.getSharedPreferences("shell", Context.MODE_PRIVATE)

    init { if (!ks.containsAlias(ALIAS)) generate(null) }

    /** With a challenge, the secure hardware also issues an attestation certificate chain for the new key (R-028). */
    private fun generate(challenge: ByteArray?) {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .apply { if (challenge != null) setAttestationChallenge(challenge) }
            .build()
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try { gen.initialize(spec(strongBox = true)); gen.generateKeyPair() }
        catch (e: StrongBoxUnavailableException) { gen.initialize(spec(strongBox = false)); gen.generateKeyPair() }
    }

    /** X.509 SubjectPublicKeyInfo, base64 — the format the server's enrollment endpoint expects. */
    fun publicKeySpkiB64(): String = Base64.getEncoder().encodeToString(ks.getCertificate(ALIAS).publicKey.encoded)

    override fun everSigned(): Boolean = prefs.getBoolean("keyUsed", false)

    /**
     * Replaces the (never used) key with a fresh one bound to the server's enrollment challenge and returns the public key
     * plus the attestation chain (leaf first, ending in a Google root). BridgeProtocol refuses this once the key has signed.
     */
    override fun attest(challenge: ByteArray): BridgeProtocol.Attestation {
        ks.deleteEntry(ALIAS)
        generate(challenge)
        val chain = ks.getCertificateChain(ALIAS)?.map { it.encoded } ?: emptyList()
        return BridgeProtocol.Attestation(publicKeySpkiB64(), chain)
    }

    override fun sign(data: ByteArray): ByteArray {
        if (!everSigned()) prefs.edit().putBoolean("keyUsed", true).commit() // durable before the first signature leaves
        val key = ks.getKey(ALIAS, null) as PrivateKey
        return Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() } // DER-encoded
    }

    fun hardwareBacked(): Boolean = runCatching {
        val key = ks.getKey(ALIAS, null) as PrivateKey
        val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= 31) info.securityLevel != KeyProperties.SECURITY_LEVEL_SOFTWARE else @Suppress("DEPRECATION") info.isInsideSecureHardware
    }.getOrDefault(false)

    /** Random per-install serial (no hardware identifiers, for privacy). */
    fun serial(): String {
        return prefs.getString("serial", null) ?: ("AND-" + UUID.randomUUID().toString().replace("-", "").take(12)).also { prefs.edit().putString("serial", it).apply() }
    }

    companion object { const val ALIAS = "rmn-device-key" }
}
