package app.lamasync.companion.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QrPayloadParsingTest {

    private val baseSecret = "s3Cr3T_AbC1234567890aBcD1234567890aBcD1234567890XYZ"
    private val baseOrigin = "https://fleet.example.com"

    private fun validJson(
        origin: String = baseOrigin,
        enrollmentId: String = "enr_aB1",
        secret: String = baseSecret,
        kind: String = "lamasync.android.enroll",
        version: Int = 1,
    ): String {
        // Serialized by hand to make casing/content assertions exact.
        val escapedSecret = secret.replace("\\", "\\\\").replace("\"", "\\\"")
        val escapedOrigin = origin.replace("\\", "\\\\").replace("\"", "\\\"")
        return """{"kind":"$kind","version":$version,"serverOrigin":"$escapedOrigin","enrollmentId":"$enrollmentId","secret":"$escapedSecret"}"""
    }

    @Test
    fun `valid payload parses and preserves case`() {
        val mixedCaseSecret = "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-aBcDeFgHiJkL"
        val result = QrPayloadParser.parse(validJson(secret = mixedCaseSecret))
        assertTrue(result is QrPayloadResult.Valid)
        val payload = (result as QrPayloadResult.Valid).payload
        assertEquals("lamasync.android.enroll", payload.kind)
        assertEquals(1, payload.version)
        assertEquals("https://fleet.example.com", payload.serverOrigin)
        assertEquals("enr_aB1", payload.enrollmentId)
        assertEquals(mixedCaseSecret, payload.secret)
    }

    @Test
    fun `unknown json fields are tolerated`() {
        val raw = validJson().replace(
            "}",
            """"expiresAt":"ignored"}""",
        )
        assertTrue(QrPayloadParser.parse(raw) is QrPayloadResult.Valid)
    }

    @Test
    fun `wrong kind is rejected`() {
        val result = QrPayloadParser.parse(validJson(kind = "lamasync.cli.pair"))
        assertEquals(QrRejection.UNSUPPORTED_KIND, (result as QrPayloadResult.Invalid).reason)
    }

    @Test
    fun `unsupported version is rejected`() {
        for (version in listOf(0, 2, 99)) {
            val result = QrPayloadParser.parse(validJson(version = version))
            assertEquals(QrRejection.UNSUPPORTED_VERSION, (result as QrPayloadResult.Invalid).reason)
        }
    }

    @Test
    fun `version of non-numeric json type is malformed`() {
        // kotlinx-serialization coerces the numeric string "1" into Int 1 (then
        // validated normally), but a non-numeric value must be rejected.
        val rawBool = validJson().replace("\"version\":1", "\"version\":true")
        assertEquals(QrRejection.MALFORMED_JSON, (QrPayloadParser.parse(rawBool) as QrPayloadResult.Invalid).reason)
        val rawText = validJson().replace("\"version\":1", "\"version\":\"one\"")
        assertEquals(QrRejection.MALFORMED_JSON, (QrPayloadParser.parse(rawText) as QrPayloadResult.Invalid).reason)
        val rawObject = validJson().replace("\"version\":1", "\"version\":{}")
        assertEquals(QrRejection.MALFORMED_JSON, (QrPayloadParser.parse(rawObject) as QrPayloadResult.Invalid).reason)
    }

    @Test
    fun `malformed json is rejected`() {
        for (raw in listOf("", "not json", "{", """{"kind":}""")) {
            assertEquals(
                QrRejection.MALFORMED_JSON,
                (QrPayloadParser.parse(raw) as QrPayloadResult.Invalid).reason,
            )
        }
    }

    @Test
    fun `missing fields are rejected`() {
        val json = validJson()
        val variants = listOf(
            json.replace(""""kind":"lamasync.android.enroll",""" , ""),
            json.replace(""""version":1,""", ""),
            json.replace(""""enrollmentId":"enr_aB1",""", ""),
            json.replace(""""secret":"$baseSecret"""", """"secret":""""),
        )
        for (raw in variants) {
            val result = QrPayloadParser.parse(raw)
            assertTrue(
                "expected rejection for $raw but got $result",
                result is QrPayloadResult.Invalid,
            )
        }
    }

    @Test
    fun `plain-http origin is rejected`() {
        val result = QrPayloadParser.parse(validJson(origin = "http://fleet.example.com"))
        assertEquals(QrRejection.BAD_ORIGIN, (result as QrPayloadResult.Invalid).reason)
    }

    @Test
    fun `origin with userinfo query fragment or path is rejected`() {
        val badOrigins = listOf(
            "https://user:pw@fleet.example.com",
            "https://fleet.example.com?x=1",
            "https://fleet.example.com/#frag",
            "https://fleet.example.com/sub",
            "https://fleet.example.com/sub/",
        )
        for (origin in badOrigins) {
            val result = QrPayloadParser.parse(validJson(origin = origin))
            assertEquals("origin $origin", QrRejection.BAD_ORIGIN, (result as QrPayloadResult.Invalid).reason)
        }
    }

    @Test
    fun `oversized qr text is rejected`() {
        val pad = "x".repeat(5000)
        assertEquals(
            QrRejection.QR_TEXT_TOO_LONG,
            (QrPayloadParser.parse(pad) as QrPayloadResult.Invalid).reason,
        )
    }

    @Test
    fun `field bounds are enforced`() {
        val longId = "a".repeat(129)
        assertEquals(
            QrRejection.FIELD_TOO_LONG,
            (QrPayloadParser.parse(validJson(enrollmentId = longId)) as QrPayloadResult.Invalid).reason,
        )
        val shortSecret = "a".repeat(31)
        assertEquals(
            QrRejection.SECRET_OUT_OF_BOUNDS,
            (QrPayloadParser.parse(validJson(secret = shortSecret)) as QrPayloadResult.Invalid).reason,
        )
        val longSecret = "a".repeat(513)
        assertEquals(
            QrRejection.FIELD_TOO_LONG,
            (QrPayloadParser.parse(validJson(secret = longSecret)) as QrPayloadResult.Invalid).reason,
        )
    }

    @Test
    fun `enrollment id charset is enforced`() {
        for (badId in listOf("has space", "contains/slash", "tab\tid", "uni¢ode")) {
            val result = QrPayloadParser.parse(validJson(enrollmentId = badId))
            assertEquals("id $badId", QrRejection.BAD_ENROLLMENT_ID, (result as QrPayloadResult.Invalid).reason)
        }
    }

    @Test
    fun `secret url casing never uppercased`() {
        val mixed = "MiXeD_cAsE_1234567890aBcD1234567890aBcD1234567890xYz"
        val payload = (QrPayloadParser.parse(validJson(secret = mixed)) as QrPayloadResult.Valid).payload
        assertEquals(mixed, payload.secret)
        assertTrue(payload.secret.contains('X'))
    }
}
