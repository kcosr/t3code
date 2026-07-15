package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceBinderOperationDispatcherTest {
  @Test
  fun ordinaryOperationsRemainOrdered() {
    val orderedExecutor = Executors.newSingleThreadExecutor()
    val dispatcher =
      T3VoiceBinderOperationDispatcher(
        orderedPost = {
          orderedExecutor.submit(it)
          true
        },
      )
    val completed = CountDownLatch(2)
    val results = mutableListOf<String>()

    try {
      dispatcher.post { admission ->
        assertTrue(admission.tryAdmit())
        results += "start"
        completed.countDown()
      }
      dispatcher.post { admission ->
        assertTrue(admission.tryAdmit())
        results += "answer"
        completed.countDown()
      }

      assertTrue(completed.await(1, TimeUnit.SECONDS))
      assertEquals(listOf("start", "answer"), results)
    } finally {
      orderedExecutor.shutdownNow()
    }
  }
}
