package net.ridesharemedia.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    @Test fun serverUrlMustBeHttpsUnlessDebug() {
        assertEquals("https://rides.example.com", UrlPolicy.validateServerUrl("https://rides.example.com/anything", false))
        assertEquals("https://rides.example.com:8443", UrlPolicy.validateServerUrl(" https://rides.example.com:8443 ", false))
        assertNull(UrlPolicy.validateServerUrl("http://rides.example.com", false))
        assertEquals("http://10.0.2.2:8080", UrlPolicy.validateServerUrl("http://10.0.2.2:8080", true))
        assertNull(UrlPolicy.validateServerUrl("javascript:alert(1)", true))
        assertNull(UrlPolicy.validateServerUrl("https://user:pw@rides.example.com", false))
        assertNull(UrlPolicy.validateServerUrl("", false))
        assertNull(UrlPolicy.validateServerUrl(null, false))
    }

    @Test fun mainFrameNeverLeavesTheServerOrigin() {
        val o = "https://rides.example.com"
        assertTrue(UrlPolicy.isAllowedMainFrame("https://rides.example.com/player/index.html?x=1", o))
        assertFalse(UrlPolicy.isAllowedMainFrame("https://advertiser.example/offer", o))
        assertFalse(UrlPolicy.isAllowedMainFrame("https://rides.example.com.evil.example/", o))
        assertFalse(UrlPolicy.isAllowedMainFrame("http://rides.example.com/", o))
        assertFalse(UrlPolicy.isAllowedMainFrame("intent://scan/#Intent;scheme=zxing;end", o))
        assertEquals("https://rides.example.com/player/index.html", UrlPolicy.playerUrl(o))
    }
}
