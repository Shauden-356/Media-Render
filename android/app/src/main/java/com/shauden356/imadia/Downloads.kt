package com.shauden356.imadia

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

enum class Status { Queued, Running, Done, Failed, Cancelled }

data class Download(
    val id: String,
    val url: String,
    val format: String,
    val quality: Int?,
    val label: String,
    val status: Status = Status.Queued,
    val progress: Float = -1f,
    val stage: String = "Waiting",
    val fileUri: String? = null,
    val fileName: String? = null,
    val mime: String? = null,
    val size: Long = 0,
    val error: String? = null,
    val log: String? = null,
)

// The list of downloads, shared by the screen and the background service.
object Downloads {
    private val state = MutableStateFlow<List<Download>>(emptyList())
    val items: StateFlow<List<Download>> = state

    fun add(d: Download) = state.update { listOf(d) + it }

    fun update(id: String, change: (Download) -> Download) =
        state.update { list -> list.map { if (it.id == id) change(it) else it } }

    fun remove(id: String) = state.update { list -> list.filterNot { it.id == id } }

    fun get(id: String): Download? = state.value.firstOrNull { it.id == id }

    fun active(): Int = state.value.count { it.status == Status.Queued || it.status == Status.Running }
}
