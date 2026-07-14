package expo.modules.t3voice

internal class MemoryRuntimeStorage : VoiceRuntimeKeyValueStore {
  val values = mutableMapOf<String, String?>()

  override fun getString(key: String): String? = values[key]

  override fun put(values: Map<String, String?>): Boolean {
    values.forEach { (key, value) ->
      if (value == null) this.values.remove(key) else this.values[key] = value
    }
    return true
  }

  override fun clear(keys: Set<String>): Boolean {
    keys.forEach(values::remove)
    return true
  }
}
