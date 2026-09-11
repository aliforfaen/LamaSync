package app.lamasync.companion.media

/**
 * LAMA-296 stage 2 — truthful coverage derivation.
 *
 * "Protected through" is computed from a CONTIGUOUS discovery/completion
 * model, never from the latest upload timestamp: order the durable registry
 * by capture time (DATE_TAKEN, falling back to DATE_ADDED) and advance the
 * boundary while every item in order is satisfied. A satisfied item is
 * PROTECTED (verified receipt) or LOCALLY_DELETED (the local source
 * disappeared — nothing remains to protect; the server copy is untouched).
 *
 * Any DISCOVERED/STAGED/FAILED/UNREADABLE item breaks the chain honestly:
 * coverage stops before it and the UI reports pending items instead of a
 * fake "everything up to now" derived from the newest upload.
 */
object MediaCoverage {

    data class Snapshot(
        /** Newest capture-time (epoch millis) where coverage is contiguous,
         *  or null when nothing is protected yet. */
        val protectedThroughEpochMillis: Long?,
        /** Number of contiguous satisfied items up to the boundary. */
        val contiguousProtectedCount: Long = 0L,
        /** Total registry size. */
        val totalCount: Long = 0L,
        /** Satisfied items (protected + locally deleted). */
        val satisfiedCount: Long = 0L,
        /** Unsatisfied items awaiting transfer/recovery. */
        val pendingCount: Long = 0L,
        /** Bytes of pending (unsatisfied, non-deleted) items. */
        val pendingBytes: Long = 0L,
        /** Actionable failures (unreadable sources). */
        val unreadableCount: Long = 0L,
    )

    /** Capture-time ordering key (epoch millis; DATE_ADDED is seconds). */
    fun captureKey(record: MediaRecord): Long =
        record.dateTakenMillis ?: (record.dateAddedSeconds * 1000L)

    fun of(records: Collection<MediaRecord>): Snapshot {
        if (records.isEmpty()) return Snapshot(protectedThroughEpochMillis = null)
        val ordered = records.sortedWith(
            compareBy<MediaRecord> { captureKey(it) }
                .thenBy { it.mediaId },
        )
        var boundary: Long? = null
        var contiguous = 0L
        var chainBroken = false
        var satisfied = 0L
        var pending = 0L
        var pendingBytes = 0L
        var unreadable = 0L

        for (record in ordered) {
            when (record.status) {
                MediaRecordStatus.PROTECTED,
                MediaRecordStatus.LOCALLY_DELETED,
                -> {
                    satisfied++
                    if (!chainBroken) {
                        // Chain still contiguous: the boundary advances.
                        boundary = captureKey(record)
                        contiguous++
                    }
                }
                MediaRecordStatus.UNREADABLE -> {
                    unreadable++
                    pending++
                    record.sizeBytes?.let { pendingBytes += it }
                    chainBroken = true
                }
                else -> {
                    pending++
                    record.sizeBytes?.let { pendingBytes += it }
                    chainBroken = true
                }
            }
        }
        return Snapshot(
            protectedThroughEpochMillis = boundary,
            contiguousProtectedCount = contiguous,
            totalCount = records.size.toLong(),
            satisfiedCount = satisfied,
            pendingCount = pending,
            pendingBytes = pendingBytes,
            unreadableCount = unreadable,
        )
    }

    /** Human "protected through" label in the device's local time zone. */
    fun protectedThroughLabel(epochMillis: Long?): String? {
        if (epochMillis == null) return null
        val instant = java.time.Instant.ofEpochMilli(epochMillis)
        return java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
            .withZone(java.time.ZoneId.systemDefault())
            .format(instant)
    }
}