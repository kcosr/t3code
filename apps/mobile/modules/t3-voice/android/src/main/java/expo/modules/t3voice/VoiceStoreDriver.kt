package expo.modules.t3voice

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal class VoiceStoreDriver(
  private val resultSink: VoiceKernelDriverResultSink,
  private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
) {
  fun persist(
    label: String,
    epoch: VoiceKernelEpoch,
    body: () -> Unit,
    continuation: (Result<Unit>) -> Unit = { _ -> },
  ) {
    executor.execute {
      val result = runCatching(body)
      resultSink.post(
        VoiceKernelMessage.DriverResult(
          epoch = epoch,
          driver = VoiceKernelDriver.STORE,
          resultKind = "persisted",
          payload = VoiceKernelDriverResultPayload.StorePersisted(label, result, continuation),
        ),
      )
    }
  }

  fun release() {
    executor.shutdown()
    try {
      if (!executor.awaitTermination(5, TimeUnit.SECONDS)) executor.shutdownNow()
    } catch (interrupted: InterruptedException) {
      executor.shutdownNow()
      Thread.currentThread().interrupt()
    }
  }
}
