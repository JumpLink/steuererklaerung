#ifndef STEUER_ERIC_EXTERN_H
#define STEUER_ERIC_EXTERN_H

/*
 * Hand-written prototypes for the subset of the ERiC C API this binding wraps.
 *
 * These are OUR OWN re-declarations of the public ERiC ABI (the same role the
 * koffi signature strings play on the Node side) — they contain no ERiC source
 * or header content. The ERiC shared library (libericapi.so) is NOT linked: it
 * is opened by absolute path at runtime (st_eric_load) from wherever the app
 * resolved it — the copy bundled by an official build, ERIC_HOME, or the user's
 * data directory. This package never contains ERiC itself.
 *
 * The Eric* functions below are defined in eric-shim.c and forward to the
 * opened library, so this file stays the single list of what the binding uses.
 */

/* Open the ERiC base libraries from @lib_dir by absolute path, dependencies
 * first. Returns 1 on success, 0 on failure (st_eric_load_error says why).
 * Definition in eric-shim.c. */
int st_eric_load(const char *lib_dir);
const char *st_eric_load_error(void);

int EricInitialisiere(const char *pluginPfad, const char *logPfad);
int EricBeende(void);

void *EricRueckgabepufferErzeugen(void);
int EricRueckgabepufferFreigeben(void *handle);
const char *EricRueckgabepufferInhalt(void *handle);

int EricPruefeSteuernummer(const char *steuernummer);
int EricPruefeIBAN(const char *iban);
int EricVersion(void *rueckgabeXmlPuffer);
int EricCheckXML(const char *xml, const char *datenartVersion, void *fehlertextPuffer);
int EricHoleFehlerText(int fehlerkode, void *rueckgabePuffer);

/* Validation path of EricBearbeiteVorgang: druck/crypto parameters are passed as
 * NULL (no PDF, no encryption, no submission), so they are declared as opaque
 * pointers here. ERiC 44 dropped the transfer handle of earlier versions. */
int EricBearbeiteVorgang(const char *datenpuffer, const char *datenartVersion,
                         unsigned int bearbeitungsFlags,
                         const void *druckParameter, const void *cryptoParameter,
                         void *rueckgabeXmlPuffer, void *serverantwortXmlPuffer);

/* --- Submission path (EricBearbeiteVorgang with the SENDE flag) --------------
 * Sending additionally needs a certificate handle (obtained from a PKCS#12
 * keystore) and an eric_verschluesselungs_parameter_t. We keep the handle
 * lifecycle and the crypto struct entirely inside this header — our own
 * re-declaration of the public ERiC ABI, no ERiC source — so the Vala facade
 * only ever sees one plain function and never models the C struct itself. */
int EricGetHandleToCertificate(unsigned int *hToken, unsigned int *iInfoPinSupport,
                               const char *pathToKeystore);
int EricCloseHandleToCertificate(unsigned int hToken);

/* Our re-declaration of eric_verschluesselungs_parameter_t (version must be 3). */
typedef struct {
    unsigned int version;
    unsigned int zertifikatHandle;
    const char *pin;
} st_eric_verschluesselung_t;

/*
 * Open the keystore at @keystore_pfad, run EricBearbeiteVorgang with the
 * caller-supplied @flags (the caller sets VALIDIERE|SENDE), then always release
 * the certificate handle. @rueckgabe and @serverantwort are ERiC
 * Rueckgabepuffer handles; on success @serverantwort carries the Transferticket.
 * Returns the ERiC return code (a non-zero handle-acquisition error short-
 * circuits before anything is transmitted). Never retries on its own.
 * Definition in eric-send.c.
 */
int st_eric_sende(const char *datenpuffer, const char *datenart_version,
                  unsigned int flags, const char *keystore_pfad,
                  const char *pin, void *rueckgabe, void *serverantwort);

#endif /* STEUER_ERIC_EXTERN_H */
