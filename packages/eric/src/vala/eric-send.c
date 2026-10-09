/*
 * st_eric_sende — the SEND path of EricBearbeiteVorgang.
 *
 * Kept out-of-line (rather than a static inline in the header) so it is emitted
 * as a real symbol in libsteuereric.so regardless of the C optimisation
 * level the Vala/meson build uses. It contains only OUR OWN calls into the
 * public ERiC ABI (declared in eric-extern.h) — no ERiC source or header
 * content — and the ERiC shared library itself is user-provided (ERIC_HOME) and
 * never shipped with this package.
 */

#include "eric-extern.h"

int st_eric_sende(const char *datenpuffer, const char *datenart_version,
                  unsigned int flags, const char *keystore_pfad,
                  const char *pin, void *rueckgabe, void *serverantwort) {
    unsigned int htoken = 0u;
    unsigned int pin_support = 0u;
    int rc = EricGetHandleToCertificate(&htoken, &pin_support, keystore_pfad);
    if (rc != 0) {
        /* Handle acquisition failed (wrong PIN, unreadable/locked keystore):
         * short-circuit before anything is transmitted. */
        return rc;
    }

    st_eric_verschluesselung_t crypto = { 3u, htoken, pin };
    unsigned int transfer_handle = 0u;
    rc = EricBearbeiteVorgang(datenpuffer, datenart_version, flags,
                              (const void *) 0, (const void *) &crypto,
                              (void *) &transfer_handle, rueckgabe, serverantwort);

    EricCloseHandleToCertificate(htoken);
    return rc;
}
