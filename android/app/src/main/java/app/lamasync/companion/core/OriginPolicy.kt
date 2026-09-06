package app.lamasync.companion.core

import java.net.URI

/**
 * Canonical HTTPS origin handling shared by QR validation, the native API
 * client, cookie scoping and the WebView navigation policy.
 *
 * Rules (spec): the enrolled server origin must be HTTPS, must not contain
 * a username or password, must not contain a query or fragment, and its path
 * must be the root (empty or "/"). The canonical form used everywhere is
 * `https://host[:port]` with no trailing slash.
 */
sealed interface OriginCheck {
    data class Valid(val origin: String) : OriginCheck
    data class Invalid(val reason: OriginRejection) : OriginCheck
}

enum class OriginRejection {
    NOT_HTTPS,
    HAS_USERINFO,
    HAS_QUERY_OR_FRAGMENT,
    NON_ROOT_PATH,
    MALFORMED,
    OVER_LENGTH,
}

object OriginPolicy {

    const val MAX_ORIGIN_LENGTH = 253

    /** Parses [input] (an https URL) and returns the canonical origin. */
    fun parseHttpsOrigin(input: String): OriginCheck {
        if (input.length > MAX_ORIGIN_LENGTH) {
            return OriginCheck.Invalid(OriginRejection.OVER_LENGTH)
        }
        val uri = try {
            URI(input.trim())
        } catch (e: Exception) {
            return OriginCheck.Invalid(OriginRejection.MALFORMED)
        }
        if (!uri.isAbsolute || uri.scheme == null) {
            return OriginCheck.Invalid(OriginRejection.MALFORMED)
        }
        val scheme = uri.scheme.lowercase()
        if (scheme != "https") {
            return OriginCheck.Invalid(OriginRejection.NOT_HTTPS)
        }
        if (uri.rawUserInfo != null) {
            return OriginCheck.Invalid(OriginRejection.HAS_USERINFO)
        }
        if (uri.query != null || uri.rawFragment != null) {
            return OriginCheck.Invalid(OriginRejection.HAS_QUERY_OR_FRAGMENT)
        }
        val path = uri.rawPath ?: ""
        if (path.isNotEmpty() && path != "/") {
            return OriginCheck.Invalid(OriginRejection.NON_ROOT_PATH)
        }
        val host = uri.host ?: return OriginCheck.Invalid(OriginRejection.MALFORMED)
        if (host.isBlank() || host.contains('_')) {
            return OriginCheck.Invalid(OriginRejection.MALFORMED)
        }
        val port = when {
            uri.port == -1 -> ""
            uri.port == 443 -> ""
            else -> ":${uri.port}"
        }
        // Lowercase the host: DNS names are case-insensitive and the enrolled
        // server is identified by a canonical origin, never by raw casing.
        val canonical = "https://${host.lowercase()}$port"
        if (canonical.length > MAX_ORIGIN_LENGTH) {
            return OriginCheck.Invalid(OriginRejection.OVER_LENGTH)
        }
        return OriginCheck.Valid(canonical)
    }

    /** Returns true when [candidate] is an https URL on exactly [canonicalOrigin]. */
    fun isSameOrigin(canonicalOrigin: String, candidateUrl: String): Boolean {
        val base = try {
            URI(canonicalOrigin)
        } catch (e: Exception) {
            return false
        }
        val other = try {
            URI(candidateUrl)
        } catch (e: Exception) {
            return false
        }
        if (other.scheme == null || other.host == null) return false
        return base.scheme.equals(other.scheme, ignoreCase = true) &&
            base.host.equals(other.host, ignoreCase = true) &&
            effectivePort(base) == effectivePort(other)
    }

    private fun effectivePort(uri: URI): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> -1
    }
}
