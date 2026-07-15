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
- Repeat the Realtime Wi-Fi interruption test on the post-`62aaf72e1` follow-up build. The
  provisional build disconnected correctly but initially left a server lease that caused a
  concurrent-session error on Resume; cleanup reconciliation and watchdog expiry were hardened
  afterward.
- Repeat `activate_thread` from Realtime voice on the final follow-up build. The provisional build
  navigated successfully but emitted no focus-update or client-action acknowledgement request, so
  the server returned `client_action_timeout`; the action handler now performs navigation, focus
  synchronization, and acknowledgement directly.

## Completed checks

- Kevin confirmed that Realtime voice remained connected and usable through foreground,
  background, and screen-lock testing on the Phase 2 build.
