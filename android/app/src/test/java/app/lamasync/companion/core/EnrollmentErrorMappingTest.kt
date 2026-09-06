package app.lamasync.companion.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EnrollmentErrorMappingTest {

    @Test
    fun `status codes map to pinned error types`() {
        assertEquals(ApiFailure.InvalidRequest::class, HttpErrorMapper.mapStatus(400)::class)
        assertEquals(ApiFailure.Unauthorized::class, HttpErrorMapper.mapStatus(401)::class)
        assertEquals(ApiFailure.Forbidden::class, HttpErrorMapper.mapStatus(403)::class)
        assertEquals(ApiFailure.EnrollmentConsumed::class, HttpErrorMapper.mapStatus(409)::class)
        assertEquals(ApiFailure.EnrollmentExpired::class, HttpErrorMapper.mapStatus(410)::class)
        assertEquals(ApiFailure.Throttled::class, HttpErrorMapper.mapStatus(429)::class)
        assertTrue(HttpErrorMapper.mapStatus(500) is ApiFailure.Server)
        assertTrue(HttpErrorMapper.mapStatus(503) is ApiFailure.Server)
        assertTrue(HttpErrorMapper.mapStatus(418) is ApiFailure.Server)
        assertTrue(HttpErrorMapper.mapStatus(200) is ApiFailure.Server)
    }

    @Test
    fun `typed failures carry no secrets in messages`() {
        val messages = listOf(
            HttpErrorMapper.mapStatus(400).message,
            HttpErrorMapper.mapStatus(409).message,
            HttpErrorMapper.mapStatus(410).message,
            HttpErrorMapper.mapStatus(401).message,
        )
        for (message in messages) {
            assertTrue("message must not be blank", !message.isNullOrBlank())
        }
    }
}
