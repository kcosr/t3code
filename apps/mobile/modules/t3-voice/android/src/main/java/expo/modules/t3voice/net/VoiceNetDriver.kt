package expo.modules.t3voice.net

import expo.modules.t3voice.kernel.VoiceKernelDriver
import expo.modules.t3voice.kernel.VoiceKernelDriverResultPayload
import expo.modules.t3voice.kernel.VoiceKernelEpoch
import expo.modules.t3voice.kernel.VoiceKernelMessage

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal enum class VoiceNetLane {
  THREAD_TURN,
  REALTIME,
  CONTROL,
}

internal fun interface VoiceKernelDriverResultSink {
  fun post(result: VoiceKernelMessage.DriverResult)
}

internal fun interface VoiceNetExecutorFactory {
  fun create(lane: VoiceNetLane): ExecutorService
}

/**
 * Owns all blocking network execution.
 *
 * Lane -> consumers:
 * - THREAD_TURN (1): thread-turn calls and thread cancellation.
 * - REALTIME (4): heartbeat, action long-poll, start, offer, cleanup, and start binder posts.
 * - CONTROL (1): mute, stop, peer termination, drain deadline, cue completion, and control posts.
 */
internal class VoiceNetDriver(
  private val resultSink: VoiceKernelDriverResultSink,
  executorFactory: VoiceNetExecutorFactory = VoiceNetExecutorFactory { lane ->
    when (lane) {
      VoiceNetLane.THREAD_TURN,
      VoiceNetLane.CONTROL,
      -> Executors.newSingleThreadExecutor()
      VoiceNetLane.REALTIME -> Executors.newFixedThreadPool(4)
    }
  },
) {
  private val executors = VoiceNetLane.entries.associateWith(executorFactory::create)

  fun execute(
    label: String,
    lane: VoiceNetLane,
    epoch: VoiceKernelEpoch,
    blockingBody: () -> (() -> Unit),
  ) {
    executors.getValue(lane).execute {
      android.util.Log.i("T3VoiceDbg", "net.exec:" + label)
      val continuation = try {
        blockingBody()
      } catch (t: Throwable) {
        android.util.Log.e("T3VoiceDbg", "net.THREW:" + label, t)
        throw t
      }
      android.util.Log.i("T3VoiceDbg", "net.done:" + label)
      resultSink.post(
        VoiceKernelMessage.DriverResult(
          epoch = epoch,
          driver = VoiceKernelDriver.NET,
          resultKind = label,
          payload = VoiceKernelDriverResultPayload.NetCompleted(label, continuation),
        ),
      )
    }
  }

  fun execute(
    label: String,
    lane: VoiceNetLane,
    epoch: VoiceKernelEpoch,
    blockingBody: Runnable,
  ) = execute(
    label,
    lane,
    epoch,
    blockingBody = {
      blockingBody.run()
      ({})
    },
  )

  fun executeDetached(
    label: String,
    lane: VoiceNetLane,
    epoch: VoiceKernelEpoch,
    blockingBody: () -> Unit,
  ) = execute(
    label,
    lane,
    epoch,
    blockingBody = {
      blockingBody()
      ({})
    },
  )

  fun release() {
    executors.values.forEach(ExecutorService::shutdownNow)
  }
}
