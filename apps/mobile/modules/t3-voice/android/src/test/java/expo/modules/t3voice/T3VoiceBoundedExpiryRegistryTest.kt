package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBoundedExpiryRegistryTest {
  @Test
  fun `entry expires once and is no longer completable`() {
    val scheduler = Executors.newSingleThreadScheduledExecutor()
    try {
      val expired = CountDownLatch(1)
      val registry =
        T3VoiceBoundedExpiryRegistry(
          maximumEntries = 2,
          scheduler = scheduler,
          nowEpochMillis = { 1_000L },
          onExpired = { if (it == "action-one") expired.countDown() },
        )

      assertTrue(registry.register("action-one", 1_025L))
      assertFalse(registry.register("action-one", 1_025L))
      assertTrue(expired.await(1, TimeUnit.SECONDS))
      assertNull(registry.expiration("action-one"))
      assertFalse(registry.remove("action-one"))
    } finally {
      scheduler.shutdownNow()
    }
  }

  @Test
  fun `overflow and conflicting ID reuse fail closed`() {
    val scheduler = Executors.newSingleThreadScheduledExecutor()
    try {
      val registry =
        T3VoiceBoundedExpiryRegistry(
          maximumEntries = 2,
          scheduler = scheduler,
          nowEpochMillis = { 0L },
          onExpired = {},
        )
      registry.register("one", 60_000L)
      registry.register("two", 60_000L)

      assertThrows(IllegalStateException::class.java) {
        registry.register("three", 60_000L)
      }
      assertThrows(IllegalStateException::class.java) {
        registry.register("one", 61_000L)
      }
      assertEquals(2, registry.sizeForTest())
      registry.clear()
      assertEquals(0, registry.sizeForTest())
    } finally {
      scheduler.shutdownNow()
    }
  }

  @Test
  fun `zero-delay expiry is always published after registration`() {
    val scheduler = Executors.newSingleThreadScheduledExecutor()
    try {
      val resolved = CountDownLatch(1)
      val events = mutableListOf<String>()
      val registry =
        T3VoiceBoundedExpiryRegistry(
          maximumEntries = 1,
          scheduler = scheduler,
          nowEpochMillis = { 10L },
          onExpired = {
            synchronized(events) { events += "resolved:$it" }
            resolved.countDown()
          },
        )

      registry.register("action", 10L) {
        synchronized(events) { events += "received:action" }
      }

      assertTrue(resolved.await(1, TimeUnit.SECONDS))
      assertEquals(
        listOf("received:action", "resolved:action"),
        synchronized(events) { events.toList() },
      )
    } finally {
      scheduler.shutdownNow()
    }
  }

  @Test
  fun `completion removes the deadline and suppresses later expiry`() {
    val scheduler = Executors.newSingleThreadScheduledExecutor()
    try {
      val resolved = CountDownLatch(1)
      val registry =
        T3VoiceBoundedExpiryRegistry(
          maximumEntries = 1,
          scheduler = scheduler,
          nowEpochMillis = { 0L },
          onExpired = { resolved.countDown() },
        )
      registry.register("confirmation", 100L)

      assertTrue(registry.remove("confirmation"))
      assertFalse(resolved.await(200, TimeUnit.MILLISECONDS))
      assertNull(registry.expiration("confirmation"))
    } finally {
      scheduler.shutdownNow()
    }
  }
}
