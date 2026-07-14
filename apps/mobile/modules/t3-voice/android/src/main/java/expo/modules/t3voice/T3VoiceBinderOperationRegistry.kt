package expo.modules.t3voice

internal class T3VoiceBinderOperationRegistry<T> {
  data class Ticket(
    val operationId: Long,
    val registrationGeneration: Long,
  )

  data class Dispatch<T>(
    val ticket: Ticket,
    val binderGeneration: Long,
    val value: T,
  )

  data class Entry<T>(
    val ticket: Ticket,
    val value: T,
  )

  private data class Pending<T>(
    val ticket: Ticket,
    val value: T,
    var binderGeneration: Long?,
  )

  private var nextOperationId = 0L
  private var binderGeneration = 0L
  private var connected = false
  private val pending = linkedMapOf<Long, Pending<T>>()

  fun register(value: T): Pair<Ticket, Dispatch<T>?> {
    nextOperationId += 1
    val ticket = Ticket(nextOperationId, binderGeneration)
    val operation =
      Pending(
        ticket = ticket,
        value = value,
        binderGeneration = binderGeneration.takeIf { connected },
      )
    pending[ticket.operationId] = operation
    val dispatch =
      operation.binderGeneration?.let { Dispatch(ticket, it, value) }
    return ticket to dispatch
  }

  fun connected(): List<Dispatch<T>> {
    binderGeneration += 1
    connected = true
    return pending.values
      .filter { it.binderGeneration == null }
      .map { operation ->
        operation.binderGeneration = binderGeneration
        Dispatch(operation.ticket, binderGeneration, operation.value)
      }
  }

  fun disconnected(): List<Entry<T>> {
    binderGeneration += 1
    connected = false
    return drain()
  }

  fun timeout(ticket: Ticket): Entry<T>? {
    val operation = pending[ticket.operationId] ?: return null
    if (operation.ticket != ticket || operation.binderGeneration != null) return null
    pending.remove(ticket.operationId)
    return Entry(ticket, operation.value)
  }

  fun complete(ticket: Ticket, binderGeneration: Long): Entry<T>? {
    val operation = pending[ticket.operationId] ?: return null
    if (operation.ticket != ticket || operation.binderGeneration != binderGeneration) return null
    pending.remove(ticket.operationId)
    return Entry(ticket, operation.value)
  }

  fun isActive(ticket: Ticket, binderGeneration: Long): Boolean {
    val operation = pending[ticket.operationId] ?: return false
    return operation.ticket == ticket && operation.binderGeneration == binderGeneration
  }

  fun destroy(): List<Entry<T>> {
    connected = false
    binderGeneration += 1
    return drain()
  }

  private fun drain(): List<Entry<T>> =
    pending.values
      .map { Entry(it.ticket, it.value) }
      .also { pending.clear() }
}
