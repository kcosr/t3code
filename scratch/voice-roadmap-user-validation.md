# Voice Roadmap Deferred User Validation

This log records checks that require Kevin's judgment, physical interaction, unavailable hardware,
or an unavailable platform build environment. Review the complete list after phases 1-5 are
implemented and autonomously tested.

## Environment constraints

- iOS build and device testing are unavailable in the current environment. Review iOS parity and
  perform native build, lifecycle, route, and interruption testing on an iOS-capable host later.

## Pending checks

- On the final Android build, verify that granting or denying the background voice notification
  permission behaves as expected and that the notification Stop action is usable from the locked
  notification shade during both dictation and a Realtime conversation.
- Verify that a Realtime conversation remains connected and a long dictation keeps recording for
  several minutes after backgrounding the app, locking the screen, and allowing the device to
  enter Doze/app standby; confirm the server does not reap the Realtime session for missed native
  heartbeats.
