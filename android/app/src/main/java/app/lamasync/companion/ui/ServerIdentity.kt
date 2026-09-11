package app.lamasync.companion.ui

/**
 * LAMA-334 — the human-friendly server identity for the shell header.
 *
 * The stored [app.lamasync.companion.data.Registration.origin] is a canonical
 * `https://host[:port][/path]` — correct for authorization, wrong as a headline
 * (the issue's item 7: "not the raw URL as the primary title", and no
 * "sensitive/verbose endpoint details" in the default chrome).
 *
 * The header shows the HOST, with the port kept only when it is not the
 * scheme's default (a non-default port is how a user tells two servers on one
 * host apart). The full origin stays one tap away on the Connection screen.
 */
internal fun serverIdentity(origin: String?): String {
    val trimmed = origin?.trim().orEmpty()
    if (trimmed.isEmpty()) return "not paired"

    val scheme = trimmed.substringBefore("://", "").lowercase()
    val authority = trimmed
        .substringAfter("://", trimmed)
        .substringBefore('/')
        .substringBefore('?')
        .substringBefore('#')
    if (authority.isEmpty()) return "not paired"

    val defaultPort = when (scheme) {
        "https" -> ":443"
        "http" -> ":80"
        else -> null
    }
    return if (defaultPort != null && authority.endsWith(defaultPort)) {
        authority.dropLast(defaultPort.length)
    } else {
        authority
    }
}
