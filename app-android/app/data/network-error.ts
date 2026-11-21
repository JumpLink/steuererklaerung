/**
 * Turns a failed `fetch` into a sentence that names the cause. Runtimes disagree about what a
 * failure looks like: Node says `ENOTFOUND` / `ECONNREFUSED` in `error.cause`, the JVM behind
 * NativeScript says `java.net.UnknownHostException`, and some fetch layers keep only a generic
 * "Network request failed". Classify what the error (and its cause chain) says; if nothing
 * specific survives, say so honestly instead of guessing.
 */

export type NetworkFailure = 'host-not-found' | 'refused' | 'tls' | 'unreachable' | 'unknown';

/** Every message in the error's `cause` chain, joined; bounded so a cyclic chain cannot loop. */
function causeText(error: unknown): string {
    const parts: string[] = [];
    let cur: unknown = error;
    for (let i = 0; i < 6 && cur != null; i++) {
        if (cur instanceof Error) {
            parts.push(cur.name, cur.message, String((cur as { code?: unknown }).code ?? ''));
            cur = (cur as { cause?: unknown }).cause;
        } else {
            parts.push(String(cur));
            break;
        }
    }
    return parts.join(' ');
}

export function classifyNetworkError(error: unknown): NetworkFailure {
    const t = causeText(error);
    if (/UnknownHost|ENOTFOUND|EAI_AGAIN|getaddrinfo|Unable to resolve host|Name or service not known|No address associated/i.test(t)) return 'host-not-found';
    if (/SSLHandshake|SSLPeerUnverified|CertPath|CertificateException|ERR_CERT|CERT_|certificate|\bTLS\b|\bSSL\b/i.test(t)) return 'tls';
    if (/ConnectException|ECONNREFUSED|Connection refused|failed to connect/i.test(t)) return 'refused';
    if (/NoRouteToHost|ENETUNREACH|EHOSTUNREACH|Network is unreachable|SocketTimeout|ETIMEDOUT/i.test(t)) return 'unreachable';
    return 'unknown';
}

/** The user-visible text; `host` is the `host[:port]` of the request. */
export function describeNetworkError(error: unknown, host: string, label: string, offline = false): string {
    const kind = classifyNetworkError(error);
    // NativeScript's fetch rejects with a bare "Network request failed" and drops the JVM cause, so the
    // only honest signal left is whether the device has any connection at all.
    if (offline && (kind === 'unknown' || kind === 'unreachable')) {
        return `${label}: the device is offline. Check your internet connection.`;
    }
    switch (kind) {
        case 'host-not-found':
            return `${label}: host ${host} was not found. Check the address and your internet connection.`;
        case 'refused':
            return `${label}: ${host} refused the connection. Check the port and that the server is running.`;
        case 'tls':
            return `${label}: could not establish a secure connection to ${host} (certificate or TLS error).`;
        case 'unreachable':
            return `${label}: ${host} is not reachable from this network.`;
        default: {
            const raw = error instanceof Error ? error.message : String(error);
            return `${label}: request to ${host} failed (${raw}).`;
        }
    }
}
