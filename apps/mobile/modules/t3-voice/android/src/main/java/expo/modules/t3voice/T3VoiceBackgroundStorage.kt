package expo.modules.t3voice

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal interface T3VoiceBackgroundKeyValueStore {
  fun getString(key: String): String?

  fun put(values: Map<String, String?>): Boolean

  fun clear(keys: Set<String>): Boolean
}

internal class T3VoiceBackgroundPreferences(context: Context) : T3VoiceBackgroundKeyValueStore {
  private val preferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  override fun getString(key: String): String? = preferences.getString(key, null)

  override fun put(values: Map<String, String?>): Boolean =
    preferences.edit().apply {
      values.forEach { (key, value) ->
        if (value === null) remove(key) else putString(key, value)
      }
    }.commit()

  override fun clear(keys: Set<String>): Boolean =
    preferences.edit().apply { keys.forEach(::remove) }.commit()

  private companion object {
    const val PREFERENCES_NAME = "t3_voice_background_execution"
  }
}

internal data class T3VoiceEncryptedGrant(
  val initializationVector: ByteArray,
  val ciphertext: ByteArray,
)

internal interface T3VoiceRuntimeGrantCipher {
  fun encrypt(plaintext: ByteArray, authenticatedMetadata: ByteArray): T3VoiceEncryptedGrant

  fun decrypt(
    encrypted: T3VoiceEncryptedGrant,
    authenticatedMetadata: ByteArray,
  ): ByteArray

  fun deleteKey()
}

internal class T3VoiceAndroidKeystoreGrantCipher(
  private val keyAlias: String = KEY_ALIAS,
) : T3VoiceRuntimeGrantCipher {
  override fun encrypt(
    plaintext: ByteArray,
    authenticatedMetadata: ByteArray,
  ): T3VoiceEncryptedGrant {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
    cipher.updateAAD(authenticatedMetadata)
    return T3VoiceEncryptedGrant(cipher.iv, cipher.doFinal(plaintext))
  }

  override fun decrypt(
    encrypted: T3VoiceEncryptedGrant,
    authenticatedMetadata: ByteArray,
  ): ByteArray {
    val key = getExistingKey() ?: error("The background voice grant key is unavailable.")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      key,
      GCMParameterSpec(GCM_TAG_LENGTH_BITS, encrypted.initializationVector),
    )
    cipher.updateAAD(authenticatedMetadata)
    return cipher.doFinal(encrypted.ciphertext)
  }

  override fun deleteKey() {
    val keyStore = keyStore()
    if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias)
  }

  private fun getExistingKey(): SecretKey? =
    keyStore().getKey(keyAlias, null) as? SecretKey

  private fun getOrCreateKey(): SecretKey =
    getExistingKey()
      ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
        init(
          KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build(),
        )
        generateKey()
      }

  private fun keyStore(): KeyStore =
    KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

  private companion object {
    const val ANDROID_KEY_STORE = "AndroidKeyStore"
    const val KEY_ALIAS = "t3.voice.background.runtime-grant.v1"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val GCM_TAG_LENGTH_BITS = 128
  }
}

internal enum class T3VoiceRuntimeGrantOperation(val wireValue: String) {
  REALTIME_START("realtime-start"),
  THREAD_TURN_START("thread-turn-start"),
  ;

  companion object {
    fun fromWireValue(value: String): T3VoiceRuntimeGrantOperation =
      entries.singleOrNull { it.wireValue == value }
        ?: throw IllegalArgumentException("Unknown background voice grant operation.")
  }
}

internal data class T3VoiceRuntimeGrantMetadata(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val operation: T3VoiceRuntimeGrantOperation,
  val targetIdentityDigest: String,
  val expiresAtEpochMillis: Long,
) {
  init {
    require(runtimeId.isNotBlank() && runtimeId.length <= 128) { "Invalid native runtime ID." }
    require(readinessGeneration > 0) { "Invalid readiness generation." }
    T3VoiceBackgroundOriginPolicy.normalize(environmentOrigin)
    require(targetIdentityDigest.matches(SHA256_HEX_PATTERN)) {
      "Invalid background voice target identity digest."
    }
    require(expiresAtEpochMillis > 0) { "Invalid runtime grant expiry." }
  }

  fun authenticatedBytes(): ByteArray =
    listOf(
      STORAGE_VERSION,
      runtimeId,
      readinessGeneration.toString(),
      T3VoiceBackgroundOriginPolicy.normalize(environmentOrigin),
      operation.wireValue,
      targetIdentityDigest,
      expiresAtEpochMillis.toString(),
    ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  private companion object {
    const val STORAGE_VERSION = "t3-voice-runtime-grant-v2"
    val SHA256_HEX_PATTERN = Regex("^[0-9a-f]{64}$")
  }
}

internal object T3VoiceRuntimeTargetIdentity {
  fun digest(targetIdentity: String): String {
    require(
      targetIdentity.isNotBlank() &&
        targetIdentity.length <= MAXIMUM_TARGET_IDENTITY_LENGTH &&
        targetIdentity.none { it == '\u0000' },
    ) { "Invalid background voice target identity." }
    return MessageDigest.getInstance("SHA-256")
      .digest(targetIdentity.toByteArray(StandardCharsets.UTF_8))
      .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
  }

  private const val MAXIMUM_TARGET_IDENTITY_LENGTH = 4_096
}

internal data class T3VoiceRuntimeGrant(
  val metadata: T3VoiceRuntimeGrantMetadata,
  val token: String,
)

internal data class T3VoiceRuntimeGrantActivation(
  val grant: T3VoiceRuntimeGrant,
  val target: VoiceRuntimeTarget.Thread?,
  val provisioningOperationId: String,
  val issuedAtEpochMillis: Long,
)

internal sealed interface T3VoiceRuntimeGrantLoadResult {
  data object Missing : T3VoiceRuntimeGrantLoadResult

  data class Available(val grant: T3VoiceRuntimeGrant) : T3VoiceRuntimeGrantLoadResult

  data class Expired(val metadata: T3VoiceRuntimeGrantMetadata) : T3VoiceRuntimeGrantLoadResult

  data class TargetReplaced(val grant: T3VoiceRuntimeGrant) : T3VoiceRuntimeGrantLoadResult

  data object Locked : T3VoiceRuntimeGrantLoadResult
}

internal class T3VoiceRuntimeGrantStore(
  private val storage: T3VoiceBackgroundKeyValueStore,
  private val cipher: T3VoiceRuntimeGrantCipher,
  private val clockMillis: () -> Long = System::currentTimeMillis,
) {
  constructor(context: Context) : this(
    T3VoiceBackgroundPreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher(),
  )

  @Synchronized
  fun provision(grant: T3VoiceRuntimeGrant) {
    validateToken(grant.token)
    val existing = loadIgnoringExpiry()
    if (existing is T3VoiceRuntimeGrantLoadResult.Available) {
      val previous = existing.grant
      val sameAuthority =
        grant.metadata.readinessGeneration == previous.metadata.readinessGeneration &&
          grant.metadata.runtimeId == previous.metadata.runtimeId &&
          T3VoiceBackgroundOriginPolicy.normalize(grant.metadata.environmentOrigin) ==
          T3VoiceBackgroundOriginPolicy.normalize(previous.metadata.environmentOrigin) &&
          grant.metadata.operation == previous.metadata.operation &&
          grant.metadata.targetIdentityDigest == previous.metadata.targetIdentityDigest
      require(
        grant.metadata.readinessGeneration > previous.metadata.readinessGeneration ||
          sameAuthority,
      ) { "Background voice grant generation or authority is stale." }
      if (grant.metadata == previous.metadata && grant.token == previous.token) return
    }
    val encrypted =
      cipher.encrypt(
        grant.token.toByteArray(StandardCharsets.UTF_8),
        grant.metadata.authenticatedBytes(),
      )
    check(encrypted.initializationVector.size in 12..32) { "Invalid grant initialization vector." }
    check(encrypted.ciphertext.isNotEmpty()) { "Invalid encrypted grant." }
    check(
      storage.put(
        mapOf(
          KEY_RUNTIME_ID to grant.metadata.runtimeId,
          KEY_READINESS_GENERATION to grant.metadata.readinessGeneration.toString(),
          KEY_ENVIRONMENT_ORIGIN to
            T3VoiceBackgroundOriginPolicy.normalize(grant.metadata.environmentOrigin),
          KEY_OPERATION to grant.metadata.operation.wireValue,
          KEY_TARGET_IDENTITY_DIGEST to grant.metadata.targetIdentityDigest,
          KEY_EXPIRES_AT to grant.metadata.expiresAtEpochMillis.toString(),
          KEY_INITIALIZATION_VECTOR to encode(encrypted.initializationVector),
          KEY_CIPHERTEXT to encode(encrypted.ciphertext),
          KEY_REFRESH_PENDING to null,
        ),
      ),
    ) { "Could not persist the background voice grant." }
  }

  @Synchronized
  fun load(): T3VoiceRuntimeGrantLoadResult {
    val loaded = loadIgnoringExpiry()
    if (loaded !is T3VoiceRuntimeGrantLoadResult.Available) return loaded
    return if (clockMillis() >= loaded.grant.metadata.expiresAtEpochMillis) {
      T3VoiceRuntimeGrantLoadResult.Expired(loaded.grant.metadata)
    } else {
      loaded
    }
  }

  @Synchronized
  fun loadForTarget(targetIdentity: String): T3VoiceRuntimeGrantLoadResult {
    val loaded = load()
    if (loaded !is T3VoiceRuntimeGrantLoadResult.Available) return loaded
    return if (
      loaded.grant.metadata.targetIdentityDigest ==
        T3VoiceRuntimeTargetIdentity.digest(targetIdentity)
    ) {
      loaded
    } else {
      T3VoiceRuntimeGrantLoadResult.TargetReplaced(loaded.grant)
    }
  }

  @Synchronized
  fun validatedRuntimeId(): String? =
    when (val loaded = load()) {
      is T3VoiceRuntimeGrantLoadResult.Available -> loaded.grant.metadata.runtimeId
      is T3VoiceRuntimeGrantLoadResult.Expired -> loaded.metadata.runtimeId
      T3VoiceRuntimeGrantLoadResult.Locked,
      T3VoiceRuntimeGrantLoadResult.Missing,
      is T3VoiceRuntimeGrantLoadResult.TargetReplaced,
      -> null
    }

  @Synchronized
  fun metadataIgnoringExpiry(): T3VoiceRuntimeGrantMetadata? =
    when (val loaded = loadIgnoringExpiry()) {
      is T3VoiceRuntimeGrantLoadResult.Available -> loaded.grant.metadata
      else -> null
    }

  @Synchronized
  fun storedMetadata(): T3VoiceRuntimeGrantMetadata? {
    val present = GRANT_METADATA_KEYS.associateWith(storage::getString)
    if (present.values.all { it === null }) return null
    if (present.values.any { it === null }) return null
    return runCatching {
      T3VoiceRuntimeGrantMetadata(
        runtimeId = present.getValue(KEY_RUNTIME_ID)!!,
        readinessGeneration = present.getValue(KEY_READINESS_GENERATION)!!.toLong(),
        environmentOrigin = present.getValue(KEY_ENVIRONMENT_ORIGIN)!!,
        operation = T3VoiceRuntimeGrantOperation.fromWireValue(present.getValue(KEY_OPERATION)!!),
        targetIdentityDigest = present.getValue(KEY_TARGET_IDENTITY_DIGEST)!!,
        expiresAtEpochMillis = present.getValue(KEY_EXPIRES_AT)!!.toLong(),
      )
    }.getOrNull()
  }

  @Synchronized
  fun beginRefresh(expected: T3VoiceRuntimeGrantMetadata): T3VoiceRuntimeGrantMetadata {
    val current =
      (loadIgnoringExpiry() as? T3VoiceRuntimeGrantLoadResult.Available)?.grant?.metadata
        ?: error("An installed background voice grant is required for refresh.")
    require(current.sameAuthority(expected)) { "Background voice grant refresh authority is stale." }
    check(storage.put(mapOf(KEY_REFRESH_PENDING to "1"))) {
      "Could not persist background voice grant refresh state."
    }
    return current
  }

  @Synchronized
  fun isRefreshPending(metadata: T3VoiceRuntimeGrantMetadata): Boolean {
    val value = storage.getString(KEY_REFRESH_PENDING) ?: return false
    check(value == "1") { "Invalid background voice grant refresh state." }
    val current =
      (loadIgnoringExpiry() as? T3VoiceRuntimeGrantLoadResult.Available)?.grant?.metadata
        ?: return false
    return current.sameAuthority(metadata)
  }

  @Synchronized
  fun clear(deleteKey: Boolean = false) {
    check(storage.clear(ALL_KEYS)) { "Could not clear the background voice grant." }
    if (deleteKey) cipher.deleteKey()
  }

  private fun loadIgnoringExpiry(): T3VoiceRuntimeGrantLoadResult {
    val present = GRANT_KEYS.associateWith(storage::getString)
    if (present.values.all { it === null }) return T3VoiceRuntimeGrantLoadResult.Missing
    if (present.values.any { it === null }) return T3VoiceRuntimeGrantLoadResult.Locked
    return try {
      val metadata =
        T3VoiceRuntimeGrantMetadata(
          runtimeId = present.getValue(KEY_RUNTIME_ID)!!,
          readinessGeneration = present.getValue(KEY_READINESS_GENERATION)!!.toLong(),
          environmentOrigin = present.getValue(KEY_ENVIRONMENT_ORIGIN)!!,
          operation =
            T3VoiceRuntimeGrantOperation.fromWireValue(present.getValue(KEY_OPERATION)!!),
          targetIdentityDigest = present.getValue(KEY_TARGET_IDENTITY_DIGEST)!!,
          expiresAtEpochMillis = present.getValue(KEY_EXPIRES_AT)!!.toLong(),
        )
      val plaintext =
        cipher.decrypt(
          T3VoiceEncryptedGrant(
            decode(present.getValue(KEY_INITIALIZATION_VECTOR)!!),
            decode(present.getValue(KEY_CIPHERTEXT)!!),
          ),
          metadata.authenticatedBytes(),
        )
      val token = plaintext.toString(StandardCharsets.UTF_8)
      plaintext.fill(0)
      validateToken(token)
      T3VoiceRuntimeGrantLoadResult.Available(T3VoiceRuntimeGrant(metadata, token))
    } catch (_: Exception) {
      T3VoiceRuntimeGrantLoadResult.Locked
    }
  }

  private fun validateToken(token: String) {
    require(token.isNotBlank() && token.length <= MAXIMUM_TOKEN_LENGTH) {
      "Invalid background voice grant token."
    }
    require(token.none(Char::isWhitespace)) { "Invalid background voice grant token." }
  }

  private fun encode(bytes: ByteArray): String =
    bytes.joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

  private fun decode(value: String): ByteArray {
    require(value.length % 2 == 0 && value.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' })
    return ByteArray(value.length / 2) { index ->
      value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }

  private companion object {
    const val MAXIMUM_TOKEN_LENGTH = 128
    const val KEY_RUNTIME_ID = "runtime_grant_runtime_id"
    const val KEY_READINESS_GENERATION = "runtime_grant_readiness_generation"
    const val KEY_ENVIRONMENT_ORIGIN = "runtime_grant_environment_origin"
    const val KEY_OPERATION = "runtime_grant_operation"
    const val KEY_TARGET_IDENTITY_DIGEST = "runtime_grant_target_identity_sha256"
    const val KEY_EXPIRES_AT = "runtime_grant_expires_at"
    const val KEY_INITIALIZATION_VECTOR = "runtime_grant_iv"
    const val KEY_CIPHERTEXT = "runtime_grant_ciphertext"
    const val KEY_REFRESH_PENDING = "runtime_grant_refresh_pending"
    val GRANT_METADATA_KEYS =
      setOf(
        KEY_RUNTIME_ID,
        KEY_READINESS_GENERATION,
        KEY_ENVIRONMENT_ORIGIN,
        KEY_OPERATION,
        KEY_TARGET_IDENTITY_DIGEST,
        KEY_EXPIRES_AT,
      )
    val GRANT_KEYS =
      GRANT_METADATA_KEYS +
      setOf(
        KEY_INITIALIZATION_VECTOR,
        KEY_CIPHERTEXT,
      )
    val ALL_KEYS = GRANT_KEYS + KEY_REFRESH_PENDING
  }
}

private fun T3VoiceRuntimeGrantMetadata.sameAuthority(
  other: T3VoiceRuntimeGrantMetadata,
): Boolean =
  runtimeId == other.runtimeId &&
    readinessGeneration == other.readinessGeneration &&
    T3VoiceBackgroundOriginPolicy.normalize(environmentOrigin) ==
    T3VoiceBackgroundOriginPolicy.normalize(other.environmentOrigin) &&
    operation == other.operation &&
    targetIdentityDigest == other.targetIdentityDigest
