package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceKernelReschedulePolicyTest {
  @Test
  fun ownershipRequiresTheExactScheduledToken() {
    val scheduled = VoiceKernelCancellationToken { true }
    val replacement = VoiceKernelCancellationToken { true }

    assertTrue(VoiceKernelReschedulePolicy.owns(scheduled, scheduled))
    assertFalse(VoiceKernelReschedulePolicy.owns(replacement, scheduled))
    assertFalse(VoiceKernelReschedulePolicy.owns(null, scheduled))
  }
}
