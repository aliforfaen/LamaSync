package app.lamasync.companion.media

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.ui.AutoProtectScreen
import app.lamasync.companion.ui.AutoProtectViewModel
import app.lamasync.companion.ui.theme.LamaSyncTheme
import java.io.File
import java.io.FileOutputStream
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * One-off evidence capture (not part of the normal gate): renders the
 * automatic-protection setup/status surface and writes a PNG to the app's
 * files dir so `adb pull` can export it for the report. No secrets are
 * rendered (default disabled state — the honest first-run surface).
 */
@RunWith(AndroidJUnit4::class)
class AutoProtectScreenshotCaptureTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var app: Application

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        MediaProtectionStore.getInstance(app).clear()
        UploadQueueStore.getInstance(app).clear()
    }

    @Test
    fun captureAutoProtectSetupSurface() {
        val viewModel = AutoProtectViewModel(app)
        viewModel.initialize()
        composeRule.setContent {
            LamaSyncTheme {
                AutoProtectScreen(viewModel = viewModel)
            }
        }
        composeRule.waitForIdle()
        val image: ImageBitmap = composeRule.onRoot().captureToImage()
        val bitmap: Bitmap = image.asAndroidBitmap()
        val output = File(app.filesDir, "screenshot-auto-protect.png")
        FileOutputStream(output).use { out ->
            val scaled = Bitmap.createScaledBitmap(
                bitmap,
                bitmap.width * 2 / 3,
                bitmap.height * 2 / 3,
                true,
            )
            scaled.compress(Bitmap.CompressFormat.PNG, 90, out)
        }
        // Sunshine box: verify the file landed.
        check(output.length() > 10_000) { "screenshot too small: ${output.length()}" }
    }
}