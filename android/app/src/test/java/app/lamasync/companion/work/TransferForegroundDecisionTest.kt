package app.lamasync.companion.work

import android.os.Build
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P1: the long-running (foreground-service) worker decision must NOT depend
 * on POST_NOTIFICATIONS. A denied notification permission does not prevent a
 * foreground service from starting — Android still runs the service and
 * surfaces it in Task Manager — so transfers must keep the long-run
 * guarantee regardless of the notification grant.
 */
class TransferForegroundDecisionTest {

    @Test
    fun foregroundIsAllowedOnEverySupportedApiTier() {
        for (sdk in Build.VERSION_CODES.O..Build.VERSION_CODES.CUR_DEVELOPMENT) {
            assertTrue("API $sdk must allow the dataSync FGS worker", TransferForeground.foregroundAllowed(sdk))
        }
    }

    @Test
    fun foregroundIsNotAllowedBeforeO() {
        assertFalse(TransferForeground.foregroundAllowed(Build.VERSION_CODES.N))
        assertFalse(TransferForeground.foregroundAllowed(23))
    }

    @Test
    fun canShowForegroundDelegatesToThePureDecision() {
        // canShowForeground(context, sdkInt) is a thin delegation; on JVM the
        // decision itself is what we verify (context-free).
        assertTrue(TransferForeground.foregroundAllowed(35))
        assertTrue(TransferForeground.foregroundAllowed(33))
        assertFalse(TransferForeground.foregroundAllowed(25))
    }
}
