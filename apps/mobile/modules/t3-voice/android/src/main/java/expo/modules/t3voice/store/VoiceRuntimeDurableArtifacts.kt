package expo.modules.t3voice.store

import expo.modules.t3voice.kernel.VoiceRuntimeDraftContext
import expo.modules.t3voice.kernel.VoiceRuntimeIdentity
import expo.modules.t3voice.kernel.VoiceRuntimeTarget

import android.content.Context
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

internal class VoiceRuntimeDurableStateCorruptionException(
  message: String,
  cause: Throwable,
) : IllegalStateException(message, cause)

internal data class VoiceRuntimeDraftHandle(
  val artifactId: String,
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
  val turnClientOperationId: String,
  val target: VoiceRuntimeDraftContext,
  val expiresAtEpochMillis: Long,
)

internal data class VoiceRuntimeStoredDraft(
  val handle: VoiceRuntimeDraftHandle,
  val transcript: String,
)

internal interface VoiceRuntimeDraftRepository {
  fun publish(artifact: VoiceRuntimeStoredDraft)
  fun read(artifactId: String): VoiceRuntimeStoredDraft?
  fun remove(artifactId: String): Boolean
  fun handles(nowEpochMillis: Long): List<VoiceRuntimeDraftHandle>
  fun rebind(identity: VoiceRuntimeIdentity, target: VoiceRuntimeTarget.Thread, nowEpochMillis: Long)
  fun checkpoint(): List<VoiceRuntimeStoredDraft>?
  fun restore(checkpoint: List<VoiceRuntimeStoredDraft>): Boolean
}

internal class VoiceRuntimeDurableDraftRepository(
  private val storage: VoiceRuntimeKeyValueStore,
  private val cipher: T3VoiceRuntimeGrantCipher =
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.runtime.drafts.v1"),
  private val now: () -> Long = System::currentTimeMillis,
) : VoiceRuntimeDraftRepository {
  constructor(context: Context) : this(
    VoiceRuntimePreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.runtime.drafts.v1"),
    System::currentTimeMillis,
  )

  @Synchronized
  override fun publish(artifact: VoiceRuntimeStoredDraft) {
    require(artifact.transcript.length <= 128 * 1024)
    val entries = loadEntries()
      .filter { it.handle.expiresAtEpochMillis > now() && it.handle.artifactId != artifact.handle.artifactId }
      .plus(encrypt(artifact))
      .sortedWith(compareBy<EncryptedEntry>({ it.handle.expiresAtEpochMillis }, { it.handle.artifactId }))
      .takeLast(MAXIMUM_ARTIFACTS)
    write(entries)
  }

  @Synchronized
  override fun read(artifactId: String): VoiceRuntimeStoredDraft? {
    val current = loadEntries()
    val live = current.filter { it.handle.expiresAtEpochMillis > now() }
    if (live.size != current.size) write(live)
    return live.firstOrNull { it.handle.artifactId == artifactId }?.let(::decrypt)
  }

  @Synchronized
  override fun remove(artifactId: String): Boolean {
    val current = loadEntries()
    val next = current.filterNot { it.handle.artifactId == artifactId }
    if (next.size == current.size) return false
    write(next)
    return true
  }

  @Synchronized
  override fun handles(nowEpochMillis: Long): List<VoiceRuntimeDraftHandle> {
    val current = loadEntries()
    val live = current.filter { it.handle.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) write(live)
    return live.map(EncryptedEntry::handle)
  }

  @Synchronized
  override fun rebind(
    identity: VoiceRuntimeIdentity,
    target: VoiceRuntimeTarget.Thread,
    nowEpochMillis: Long,
  ) {
    val rebound = loadEntries().mapNotNull { entry ->
      if (entry.handle.expiresAtEpochMillis <= nowEpochMillis) return@mapNotNull null
      val handle = entry.handle
      val matches = handle.identity.runtimeId == identity.runtimeId &&
        handle.identity.generation == identity.generation &&
        handle.target.environmentId == target.environmentId &&
        handle.target.projectId == target.projectId && handle.target.threadId == target.threadId
      if (!matches || handle.identity == identity) entry else encrypt(
        decrypt(entry).copy(handle = handle.copy(identity = identity)),
      )
    }
    write(rebound)
  }

  @Synchronized
  override fun checkpoint(): List<VoiceRuntimeStoredDraft>? = runCatching {
    loadEntries().map(::decrypt)
  }.getOrNull()

  @Synchronized
  override fun restore(checkpoint: List<VoiceRuntimeStoredDraft>): Boolean = runCatching {
    require(checkpoint.size <= MAXIMUM_ARTIFACTS)
    write(checkpoint.map(::encrypt))
  }.isSuccess

  private data class EncryptedEntry(
    val handle: VoiceRuntimeDraftHandle,
    val initializationVector: ByteArray,
    val ciphertext: ByteArray,
  )

  private fun encrypt(artifact: VoiceRuntimeStoredDraft): EncryptedEntry {
    val encrypted = cipher.encrypt(
      artifact.transcript.toByteArray(StandardCharsets.UTF_8),
      aad(artifact.handle),
    )
    return EncryptedEntry(artifact.handle, encrypted.initializationVector, encrypted.ciphertext)
  }

  private fun decrypt(entry: EncryptedEntry): VoiceRuntimeStoredDraft = VoiceRuntimeStoredDraft(
    entry.handle,
    cipher.decrypt(
      T3VoiceEncryptedGrant(entry.initializationVector, entry.ciphertext),
      aad(entry.handle),
    ).toString(StandardCharsets.UTF_8),
  )

  private fun aad(handle: VoiceRuntimeDraftHandle): ByteArray = listOf(
    "t3-voice-runtime-draft-v1",
    handle.artifactId,
    handle.identity.runtimeId,
    handle.identity.runtimeInstanceId,
    handle.identity.generation.toString(),
    handle.modeSessionId,
    handle.turnClientOperationId,
    handle.target.environmentId,
    handle.target.projectId,
    handle.target.threadId,
    handle.target.composerRevision,
    handle.expiresAtEpochMillis.toString(),
  ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  private fun loadEntries(): List<EncryptedEntry> {
    val raw = storage.getString(KEY_ENTRIES) ?: return emptyList()
    return try {
      val values = JSONArray(raw)
      buildList(values.length()) {
        for (index in 0 until values.length()) add(decode(values.getJSONObject(index)))
      }
    } catch (cause: Throwable) {
      throw VoiceRuntimeDurableStateCorruptionException(
        "Voice draft artifact state is unreadable.",
        cause,
      )
    }
  }

  private fun write(entries: List<EncryptedEntry>) {
    val values = JSONArray()
    entries.forEach { values.put(encode(it)) }
    check(storage.put(mapOf(KEY_ENTRIES to values.toString()))) {
      "Could not persist voice draft artifacts."
    }
  }

  private fun encode(entry: EncryptedEntry): JSONObject = JSONObject()
    .put("artifactId", entry.handle.artifactId)
    .put("runtimeId", entry.handle.identity.runtimeId)
    .put("runtimeInstanceId", entry.handle.identity.runtimeInstanceId)
    .put("generation", entry.handle.identity.generation)
    .put("modeSessionId", entry.handle.modeSessionId)
    .put("turnClientOperationId", entry.handle.turnClientOperationId)
    .put("environmentId", entry.handle.target.environmentId)
    .put("projectId", entry.handle.target.projectId)
    .put("threadId", entry.handle.target.threadId)
    .put("composerRevision", entry.handle.target.composerRevision)
    .put("expiresAt", entry.handle.expiresAtEpochMillis)
    .put("iv", Base64.getEncoder().encodeToString(entry.initializationVector))
    .put("ciphertext", Base64.getEncoder().encodeToString(entry.ciphertext))

  private fun decode(value: JSONObject): EncryptedEntry {
    require(value.keys().asSequence().toSet() == FIELDS)
    val handle = VoiceRuntimeDraftHandle(
      value.getString("artifactId"),
      VoiceRuntimeIdentity(
        value.getString("runtimeId"),
        value.getString("runtimeInstanceId"),
        value.getLong("generation"),
      ),
      value.getString("modeSessionId"),
      value.getString("turnClientOperationId"),
      VoiceRuntimeDraftContext(
        value.getString("environmentId"),
        value.getString("projectId"),
        value.getString("threadId"),
        value.getString("composerRevision"),
      ),
      value.getLong("expiresAt"),
    )
    return EncryptedEntry(
      handle,
      Base64.getDecoder().decode(value.getString("iv")),
      Base64.getDecoder().decode(value.getString("ciphertext")),
    )
  }

  private companion object {
    const val KEY_ENTRIES = "entries"
    const val MAXIMUM_ARTIFACTS = 32
    val FIELDS = setOf(
      "artifactId", "runtimeId", "runtimeInstanceId", "generation", "modeSessionId",
      "turnClientOperationId", "environmentId", "projectId", "threadId", "composerRevision",
      "expiresAt", "iv", "ciphertext",
    )
  }
}

internal class VoiceRuntimeMemoryDraftRepository : VoiceRuntimeDraftRepository {
  private val entries = linkedMapOf<String, VoiceRuntimeStoredDraft>()
  override fun publish(artifact: VoiceRuntimeStoredDraft) { entries[artifact.handle.artifactId] = artifact }
  override fun read(artifactId: String) = entries[artifactId]
  override fun remove(artifactId: String) = entries.remove(artifactId) != null
  override fun handles(nowEpochMillis: Long): List<VoiceRuntimeDraftHandle> {
    entries.entries.removeAll { it.value.handle.expiresAtEpochMillis <= nowEpochMillis }
    return entries.values.map { it.handle }
  }
  override fun rebind(identity: VoiceRuntimeIdentity, target: VoiceRuntimeTarget.Thread, nowEpochMillis: Long) {
    entries.replaceAll { _, artifact ->
      val handle = artifact.handle
      if (handle.expiresAtEpochMillis > nowEpochMillis &&
        handle.identity.runtimeId == identity.runtimeId &&
        handle.identity.generation == identity.generation &&
        handle.target.environmentId == target.environmentId &&
        handle.target.projectId == target.projectId && handle.target.threadId == target.threadId) {
        artifact.copy(handle = handle.copy(identity = identity))
      } else artifact
    }
  }
  override fun checkpoint(): List<VoiceRuntimeStoredDraft> = entries.values.toList()
  override fun restore(checkpoint: List<VoiceRuntimeStoredDraft>): Boolean {
    entries.clear()
    checkpoint.forEach { entries[it.handle.artifactId] = it }
    return true
  }
}
