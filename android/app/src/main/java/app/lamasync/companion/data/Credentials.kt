package app.lamasync.companion.data

/**
 * Opaque credential wrappers enforcing role separation at the type level.
 *
 * [NativeToken] may be used only by the native API client; [WebGrant] only by
 * the web-session broker. Neither type is interchangeable, and neither can be
 * constructed from the other — this is what makes "the native client cannot
 * access the grant" a compiler-checked property, not a convention.
 *
 * [toString] is redacted so accidental logging never leaks a secret.
 */
class NativeToken private constructor(val value: String) {
    override fun toString(): String = "NativeToken[redacted]"

    override fun equals(other: Any?): Boolean = other is NativeToken && other.value == value
    override fun hashCode(): Int = value.hashCode()

    companion object {
        fun of(raw: String): NativeToken = NativeToken(raw)
    }
}

class WebGrant private constructor(val value: String) {
    override fun toString(): String = "WebGrant[redacted]"

    override fun equals(other: Any?): Boolean = other is WebGrant && other.value == value
    override fun hashCode(): Int = value.hashCode()

    companion object {
        fun of(raw: String): WebGrant = WebGrant(raw)
    }
}
