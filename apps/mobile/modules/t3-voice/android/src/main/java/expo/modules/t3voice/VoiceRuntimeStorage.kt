package expo.modules.t3voice

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal interface VoiceRuntimeKeyValueStore {
  fun getString(key: String): String?

  fun put(values: Map<String, String?>): Boolean

  fun clear(keys: Set<String>): Boolean
}

internal class VoiceRuntimePreferences(context: Context) : VoiceRuntimeKeyValueStore {
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
    const val PREFERENCES_NAME = "t3_voice_runtime_execution"
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
    val key = getExistingKey() ?: error("The runtime voice grant key is unavailable.")
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
    const val KEY_ALIAS = "t3.voice.runtime.runtime-grant.v1"
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
        ?: throw IllegalArgumentException("Unknown runtime voice grant operation.")
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
    VoiceRuntimeOriginPolicy.normalize(environmentOrigin)
    require(targetIdentityDigest.matches(SHA256_HEX_PATTERN)) {
      "Invalid runtime voice target identity digest."
    }
    require(expiresAtEpochMillis > 0) { "Invalid runtime grant expiry." }
  }

  fun authenticatedBytes(): ByteArray =
    listOf(
      STORAGE_VERSION,
      runtimeId,
      readinessGeneration.toString(),
      VoiceRuntimeOriginPolicy.normalize(environmentOrigin),
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
    ) { "Invalid runtime voice target identity." }
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

internal sealed interface T3VoiceRuntimeGrantLoadResult {
  data object Missing : T3VoiceRuntimeGrantLoadResult

  data class Available(val grant: T3VoiceRuntimeGrant) : T3VoiceRuntimeGrantLoadResult

  data class Expired(val metadata: T3VoiceRuntimeGrantMetadata) : T3VoiceRuntimeGrantLoadResult

  data class TargetReplaced(val grant: T3VoiceRuntimeGrant) : T3VoiceRuntimeGrantLoadResult

  data object Locked : T3VoiceRuntimeGrantLoadResult
}

internal data class VoiceRuntimeStoredSessionCredential(
  val environmentOrigin: String,
  val credential: VoiceRuntimeSessionCredential,
)

internal sealed interface VoiceRuntimeSessionCredentialLoadResult {
  data object Missing : VoiceRuntimeSessionCredentialLoadResult
  data object Locked : VoiceRuntimeSessionCredentialLoadResult
  data class Available(val value: VoiceRuntimeStoredSessionCredential) :
    VoiceRuntimeSessionCredentialLoadResult
}

internal class VoiceRuntimeSessionCredentialStore(
  private val storage: VoiceRuntimeKeyValueStore,
  private val cipher: T3VoiceRuntimeGrantCipher,
) {
  constructor(context: Context) : this(
    VoiceRuntimePreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.runtime.session-credential.v1"),
  )

  @Synchronized
  fun set(environmentOrigin: String, credential: String) {
    val normalizedOrigin = VoiceRuntimeOriginPolicy.normalize(environmentOrigin)
    val validated = VoiceRuntimeSessionCredential(credential)
    val encrypted = cipher.encrypt(
      validated.value.toByteArray(StandardCharsets.UTF_8),
      metadata(normalizedOrigin),
    )
    check(storage.put(mapOf(
      KEY_VERSION to VERSION,
      KEY_ORIGIN to normalizedOrigin,
      KEY_IV to Base64.getEncoder().encodeToString(encrypted.initializationVector),
      KEY_CIPHERTEXT to Base64.getEncoder().encodeToString(encrypted.ciphertext),
    ))) { "Could not persist the runtime session credential." }
  }

  @Synchronized
  fun load(): VoiceRuntimeSessionCredentialLoadResult {
    val values = KEYS.associateWith(storage::getString)
    if (values.values.all { it == null }) return VoiceRuntimeSessionCredentialLoadResult.Missing
    if (values.values.any { it == null }) return VoiceRuntimeSessionCredentialLoadResult.Locked
    return try {
      require(values.getValue(KEY_VERSION) == VERSION)
      val origin = VoiceRuntimeOriginPolicy.normalize(values.getValue(KEY_ORIGIN)!!)
      val plaintext = cipher.decrypt(
        T3VoiceEncryptedGrant(
          Base64.getDecoder().decode(values.getValue(KEY_IV)),
          Base64.getDecoder().decode(values.getValue(KEY_CIPHERTEXT)),
        ),
        metadata(origin),
      )
      try {
        VoiceRuntimeSessionCredentialLoadResult.Available(
          VoiceRuntimeStoredSessionCredential(
            origin,
            VoiceRuntimeSessionCredential(String(plaintext, StandardCharsets.UTF_8)),
          ),
        )
      } finally {
        plaintext.fill(0)
      }
    } catch (_: Throwable) {
      VoiceRuntimeSessionCredentialLoadResult.Locked
    }
  }

  @Synchronized
  fun clear() {
    check(storage.clear(KEYS)) { "Could not clear the runtime session credential." }
    cipher.deleteKey()
  }

  private fun metadata(environmentOrigin: String): ByteArray =
    "$VERSION\n$environmentOrigin".toByteArray(StandardCharsets.UTF_8)

  private companion object {
    const val VERSION = "t3-voice-runtime-session-credential-v1"
    const val KEY_VERSION = "runtime_session_credential_version"
    const val KEY_ORIGIN = "runtime_session_credential_origin"
    const val KEY_IV = "runtime_session_credential_iv"
    const val KEY_CIPHERTEXT = "runtime_session_credential_ciphertext"
    val KEYS = setOf(KEY_VERSION, KEY_ORIGIN, KEY_IV, KEY_CIPHERTEXT)
  }
}
