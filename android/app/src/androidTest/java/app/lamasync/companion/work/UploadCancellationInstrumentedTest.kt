package app.lamasync.companion.work

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.data.WebGrant
import app.lamasync.companion.network.MobileBrowseRefDto
import app.lamasync.companion.network.MobileUploadDestinationDto
import app.lamasync.companion.network.MobileUploadDto
import app.lamasync.companion.network.MobileUploadReceiptDto
import app.lamasync.companion.network.MobileUploadService
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage-1 correction R2 — cancellation races across remote cancel,
 * worker writes, offline and restart. On real Android state:
 *   - a CANCELLED item survives store-recreation (process restart) and is
 *     immune to stale worker-style writes from ANY store instance;
 *   - an offline cancellation is reconciled on the next worker pass: while
 *     the network is down the item stays CANCELLED; once reachable, the
 *     AUTHORITATIVE server result (already finalized) reconciles it to DONE
 *     with a receipt instead of claiming a cancellation of a protected file.
 */
@RunWith(AndroidJUnit4::class)
class UploadCancellationInstrumentedTest {

    private lateinit var app: Application
    private val origin = "https://fleet.example.com"
    private val hostId = "mob-cancel-1"

    private fun item(status: UploadStatus, id: String = "cancel-1", serverId: String? = "mupcancel1"): UploadQueueItem =
        UploadQueueItem(
            id = id,
            origin = origin,
            hostId = hostId,
            sourceUri = "content://authority/doc.pdf",
            displayName = "doc.pdf",
            destinationId = "mdst-1",
            destinationRelPath = "Mobile/$hostId/Inbox",
            idempotencyKey = "up-00000001",
            staged = true,
            stagedFileName = "stage-cancel",
            serverUploadId = serverId,
            status = status,
            createdAtEpochMillis = 1L,
            updatedAtEpochMillis = 1L,
        )

    private val finalizedDto = MobileUploadDto(
        id = "mupcancel1",
        destinationId = "mdst-1",
        fileName = "doc.pdf",
        finalRelPath = "Mobile/$hostId/Inbox/doc.pdf",
        sizeBytes = 10,
        bytesReceived = 10,
        status = "finalized",
        error = null,
        createdAt = 1L,
        updatedAt = 2L,
        finalizedAt = 42L,
        receipt = MobileUploadReceiptDto(
            uploadId = "mupcancel1",
            fileName = "doc.pdf",
            finalRelPath = "Mobile/$hostId/Inbox/doc.pdf",
            browseRef = MobileBrowseRefDto(kind = "local", path = "Mobile/$hostId/Inbox/doc.pdf"),
            sizeBytes = 10,
            sha256 = "a".repeat(64),
            finalizedAt = 42L,
        ),
    )

    /** Scripted service: cancel throws (offline) or returns a canned row. */
    private class FakeUploadService(private val behavior: () -> MobileUploadDto) : MobileUploadService {
        override suspend fun listDestinations(
            origin: String,
            native: NativeToken,
        ): List<MobileUploadDestinationDto> = error("unused")
        override suspend fun createUpload(
            origin: String,
            native: NativeToken,
            destinationId: String,
            fileName: String,
            sizeBytes: Long?,
            sha256: String?,
            idempotencyKey: String,
        ): MobileUploadDto = error("unused")
        override suspend fun sendChunk(
            origin: String,
            native: NativeToken,
            uploadId: String,
            offset: Long,
            data: ByteArray,
        ): MobileUploadDto = error("unused")
        override suspend fun uploadState(
            origin: String,
            native: NativeToken,
            uploadId: String,
        ): MobileUploadDto = error("unused")
        override suspend fun listUploads(
            origin: String,
            native: NativeToken,
        ): List<MobileUploadDto> = error("unused")
        override suspend fun finalize(
            origin: String,
            native: NativeToken,
            uploadId: String,
        ): MobileUploadReceiptDto = error("unused")
        override suspend fun cancel(
            origin: String,
            native: NativeToken,
            uploadId: String,
        ): MobileUploadDto = behavior()
    }

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        RegistrationStoreImpl(app).clear()
        KeystoreCredentialVault(app).clear()
        UploadQueueStore.getInstance(app).clear()
    }

    @After
    fun tearDown() {
        RegistrationStoreImpl(app).clear()
        KeystoreCredentialVault(app).clear()
        UploadQueueStore.getInstance(app).clear()
    }

    @Test
    fun cancelledItemSurvivesRestartAndStaleWorkerWrites() {
        val canonical = UploadQueueStore.getInstance(app)
        canonical.add(item(UploadStatus.PENDING))
        // The UI actor cancels through the canonical store.
        canonical.update(item(UploadStatus.CANCELLED))

        // A stale worker write (pre-cancel object) through a SEPARATE store
        // instance shares the process-wide lock + terminal guard: refused.
        UploadQueueStore(app).update(item(UploadStatus.UPLOADING, id = "cancel-1").copy(uploadedBytes = 5))
        UploadQueueStore(app).update(item(UploadStatus.FAILED, id = "cancel-1", serverId = "mupcancel1").copy(error = "lost source"))
        assertEquals(UploadStatus.CANCELLED, canonical.load().items.single().status)

        // Process-restart analog: a fresh store instance reads the durable
        // cancel straight back (real SharedPreferences behind it).
        assertEquals(UploadStatus.CANCELLED, UploadQueueStore(app).load().items.single().status)
    }

    @Test
    fun offlineCancellationStaysCancelledThenReconcilesToAuthoritativeResult() = runBlocking {
        val vault = KeystoreCredentialVault(app)
        vault.saveCredentials(NativeToken.of("native-token"), WebGrant.of("web-grant"))
        RegistrationStoreImpl(app).save(
            Registration(origin = origin, hostId = hostId, displayName = "Cancel Test", enrolledAtEpochMillis = 1L),
        )
        val canonical = UploadQueueStore.getInstance(app)
        canonical.add(item(UploadStatus.CANCELLED))

        // Worker pass 1: still offline — remote cancel fails, item STAYS
        // CANCELLED (the durable requested state wins).
        val offline = FakeUploadService {
            throw ApiFailure.Network(ApiFailure.Network.CauseKind.IO, IOException("tailnet down"))
        }
        val first = syncServerCancellations(canonical, offline, vault.nativeToken(), RegistrationStoreImpl(app).load())
        assertEquals("no item reconciled while offline", 0, first)
        assertEquals(UploadStatus.CANCELLED, canonical.load().items.single().status)

        // Worker pass 2: reachable; the server reports the upload already
        // finalized (the cancel lost the race) — the AUTHORITATIVE result is
        // applied, never a lie about a cancelled protected file.
        val online = FakeUploadService { finalizedDto }
        val second = syncServerCancellations(canonical, online, vault.nativeToken(), RegistrationStoreImpl(app).load())
        assertEquals(1, second)
        val after = canonical.load().items.single()
        assertEquals(UploadStatus.DONE, after.status)
        assertEquals("finalized", after.serverStatus)
        assertNotNull("receipt from the server response", after.receipt)
        assertEquals("mupcancel1", after.receipt!!.uploadId)
    }
}