package expo.modules.t3voice

import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Bounded process-local expiry ownership for server-issued actions and confirmations. */
internal class T3VoiceBoundedExpiryRegistry(
  private val maximumEntries: Int,
  private val scheduler: ScheduledExecutorService,
  private val nowEpochMillis: () -> Long,
  private val onExpired: (String) -> Unit,
) {
  private data class Entry(
    val expiresAtEpochMillis: Long,
    val future: ScheduledFuture<*>,
  )

  private val lock = Any()
  private val entries = mutableMapOf<String, Entry>()

  init {
    require(maximumEntries > 0) { "Expiry registry limit must be positive." }
  }

  /** Returns false for an exact duplicate and throws for conflicting IDs or bounded overflow. */
  fun register(
    id: String,
    expiresAtEpochMillis: Long,
    onRegistered: () -> Unit = {},
  ): Boolean =
    synchronized(lock) {
      val existing = entries[id]
      if (existing != null) {
        check(existing.expiresAtEpochMillis == expiresAtEpochMillis) {
          "An expiring voice ID was reused with another expiration."
        }
        return false
      }
      check(entries.size < maximumEntries) { "The expiring voice ID limit was exceeded." }
      val delayMs = (expiresAtEpochMillis - nowEpochMillis()).coerceAtLeast(0)
      val future =
        scheduler.schedule(
          { expire(id, expiresAtEpochMillis) },
          delayMs,
          TimeUnit.MILLISECONDS,
        )
      entries[id] = Entry(expiresAtEpochMillis, future)
      // The expiry task must acquire this lock, so initial publication is ordered before expiry.
      onRegistered()
      true
    }

  fun expiration(id: String): Long? = synchronized(lock) { entries[id]?.expiresAtEpochMillis }

  fun remove(id: String): Boolean {
    val removed = synchronized(lock) { entries.remove(id) } ?: return false
    removed.future.cancel(false)
    return true
  }

  fun clear() {
    val removed =
      synchronized(lock) {
        entries.values.toList().also { entries.clear() }
      }
    removed.forEach { it.future.cancel(false) }
  }

  internal fun sizeForTest(): Int = synchronized(lock) { entries.size }

  private fun expire(id: String, expectedExpiration: Long) {
    val expired =
      synchronized(lock) {
        val current = entries[id]
        if (current?.expiresAtEpochMillis != expectedExpiration) return
        entries.remove(id)
        true
      }
    if (expired) onExpired(id)
  }
}
