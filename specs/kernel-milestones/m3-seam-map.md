# M3 Seam Map (reference — post-M2 tree @ 1fa98135a)

Authoritative inventory for the M3 packets; produced by orchestrator audit. Key facts:

- Service 5840 lines; zero mainHandler/operationLock/serviceDestroyed/synchronized; 19
  assertKernelThread sites; 53 mailbox.submit / 2 submitAndAwait / 2 submitDelayed.
- Mailbox API: submit (silent-drop post-drain), submitAndAwait (throws post-drain,
  forbids self-await), submitDelayed -> VoiceKernelCancellationToken, isKernelThread,
  assertKernelThread, drainAndQuit; VoiceKernelReschedulePolicy.owns for token loops;
  service helpers callbackMessage/submitCallback(Delayed)/runOnKernelThreadOrAwait.
- Ports -> drivers: VoiceRuntimeThreadExecution obj (:1821-1896, pure kernel glue, stays);
  recorder cb :1937-1995, player cbs :2013-2069, focus :2071-2099, WebRTC cbs :1261-1363,
  peer port :4195-4253, cue port :4263-4292 -> MediaDriver; handoff port :4302-4347 ->
  StoreDriver+kernel await; sinks presentation :4003-4029 (submitAndAwait, B9),
  state :4031-4053 / terminal :4054-4063 (submit), finalization :4064-4074 (always
  submit); remoteDispatcher :4075-4081 -> NetDriver.
- Executors (fields :1205-1230, shutdown :2343-2350): heartbeatIo :4851, actionIo :4896,
  offerIo :4257, startIo :5093 + startPost :1212, cleanupIo :4077/:4160/:4634,
  controlIo :1276/:1328/:4296/:4924/:5145/:5162 + controlPost :1213 -> NetDriver realtime
  lane (bounded); runtimeRealtimeIo 8 sites :2683-:3517 + cancellationIo :3851 ->
  NetDriver thread-turn lane (sequential). ELIMINATE (become direct messages, no hop):
  controlIo notification re-entries :1276/:1328/:4924/:4296; offerIo peer-callback half.
- Engine 1657 lines, 36 monitor sites; already admit(pure) -> IO(off-monitor) ->
  complete(pure). B9 holds: presentation publish :1196 / retract :1209/:1212 and handoff
  prepare :1259 / rollback :1288/:1294 all off-monitor (plan :1239 pure under monitor).
  REAL conversion work: update() :1515-1519 does repository.save + stateSink.publish
  INSIDE the monitor (callers :574/:1182/:1205/:1275); terminal path :1506-1518 store
  writes under monitor. Engine state -> RealtimeState: checkpoint :469, serverSession
  :470, pendingStart :471, finalizationInFlight :472, commands ledger :473 (retained).
- Stores: all internally @Synchronized, shared with WorkManager (stay non-exclusive).
  Keystore ciphers (authority + session credential) are tens-of-ms TEE ops — never in a
  reducer step; commit-point sites (CORRECTED): clear() at TEN sites
  (:258,:906,:1692,:2184,:3739,:4721,:4810,:5036,:5068,:5523); prepareTransition :4326;
  discardPreparedTransition :4092/:4341/:4686. The 'configure' cipher write lives inside
  VoiceRuntimeActiveThreadController (:260/:342) reached via voiceRuntimeController.
  configure\* (:809-812, :5059-5062) — NOT a VoiceRuntimeAuthorityStore method; realtimeRepository.save (engine update()); threadOperation/
  readiness/cueSettings are cheap SharedPreferences.
- Host effects: startForeground :2359-2373 (kernel) + promoteForegroundOnMainThread
  :2375-2384 (main thread, proto-HostDriver template); wake :5542-5556; MediaSession
  :5560+; keepServiceStarted :2386-2393 (callers :680/:1504/:4218/:5321); stopSelf
  :2293/:2404/:5417/:5436; stickiness cache :1223-1226/:2298.
- Historical note: the spec's "three lock-free mutations" are resolved (M2 captured all).
