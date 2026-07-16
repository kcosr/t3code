package expo.modules.t3voice.store

import expo.modules.t3voice.kernel.VoiceKernelDriver
import expo.modules.t3voice.kernel.VoiceKernelDriverResultPayload
import expo.modules.t3voice.kernel.VoiceKernelEpoch
import expo.modules.t3voice.kernel.VoiceKernelMessage
import expo.modules.t3voice.net.VoiceKernelDriverResultSink

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

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
    executor.shutdownNow()
  }
}
