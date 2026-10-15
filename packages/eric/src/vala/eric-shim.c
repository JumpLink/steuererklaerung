/*
 * Runtime loader and forwarding shims for the ERiC C API.
 *
 * The binding is not linked against libericapi.so: ERiC is proprietary and lives where the app
 * finds it at runtime, so a build of this package needs no ERiC and the loader needs no
 * LD_LIBRARY_PATH. st_eric_load() opens the base libraries by absolute path, and every Eric*
 * function declared in eric-extern.h is defined here as a forwarder to the symbol in the opened
 * library. Contains only OUR OWN calls into the public ERiC ABI — no ERiC source or header content.
 */

#include <dlfcn.h>
#include <stdio.h>

#include "eric-extern.h"

/* Dependency order: each library needs the ones before it. The last is the API itself. */
static const char *const BASE_LIBS[] = {
    "libericxerces.so", "libeSigner.so", "libotto.so", "libericapi.so",
};
#define BASE_LIB_COUNT (sizeof BASE_LIBS / sizeof BASE_LIBS[0])

static void *api_handle = NULL;
static char load_error[1024] = "";

int st_eric_load(const char *lib_dir) {
    if (api_handle) return 1;
    void *last = NULL;
    for (unsigned i = 0; i < BASE_LIB_COUNT; i++) {
        char path[4096];
        snprintf(path, sizeof path, "%s/%s", lib_dir, BASE_LIBS[i]);
        last = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
        if (!last) {
            const char *why = dlerror();
            snprintf(load_error, sizeof load_error, "%s", why ? why : path);
            return 0;
        }
    }
    api_handle = last;
    load_error[0] = '\0';
    return 1;
}

const char *st_eric_load_error(void) {
    return load_error;
}

static void *lookup(const char *name) {
    return api_handle ? dlsym(api_handle, name) : NULL;
}

/* Non-zero ERiC-style failure for a call made before st_eric_load() succeeded. */
#define NOT_LOADED (-1)

#define ST_SHIM(RET, FAIL, NAME, PARAMS, ARGS)                  \
    RET NAME PARAMS {                                           \
        static RET (*fn) PARAMS = NULL;                         \
        if (!fn) *(void **) (&fn) = lookup(#NAME);              \
        return fn ? fn ARGS : (FAIL);                           \
    }

ST_SHIM(int, NOT_LOADED, EricInitialisiere, (const char *pluginPfad, const char *logPfad), (pluginPfad, logPfad))
ST_SHIM(int, NOT_LOADED, EricBeende, (void), ())
ST_SHIM(void *, NULL, EricRueckgabepufferErzeugen, (void), ())
ST_SHIM(int, NOT_LOADED, EricRueckgabepufferFreigeben, (void *handle), (handle))
ST_SHIM(const char *, "", EricRueckgabepufferInhalt, (void *handle), (handle))
ST_SHIM(int, NOT_LOADED, EricPruefeSteuernummer, (const char *steuernummer), (steuernummer))
ST_SHIM(int, NOT_LOADED, EricPruefeIBAN, (const char *iban), (iban))
ST_SHIM(int, NOT_LOADED, EricVersion, (void *rueckgabeXmlPuffer), (rueckgabeXmlPuffer))
ST_SHIM(int, NOT_LOADED, EricCheckXML,
        (const char *xml, const char *datenartVersion, void *fehlertextPuffer),
        (xml, datenartVersion, fehlertextPuffer))
ST_SHIM(int, NOT_LOADED, EricHoleFehlerText, (int fehlerkode, void *rueckgabePuffer), (fehlerkode, rueckgabePuffer))
ST_SHIM(int, NOT_LOADED, EricBearbeiteVorgang,
        (const char *datenpuffer, const char *datenartVersion, unsigned int bearbeitungsFlags,
         const void *druckParameter, const void *cryptoParameter,
         void *rueckgabeXmlPuffer, void *serverantwortXmlPuffer),
        (datenpuffer, datenartVersion, bearbeitungsFlags, druckParameter, cryptoParameter,
         rueckgabeXmlPuffer, serverantwortXmlPuffer))
ST_SHIM(int, NOT_LOADED, EricGetHandleToCertificate,
        (unsigned int *hToken, unsigned int *iInfoPinSupport, const char *pathToKeystore),
        (hToken, iInfoPinSupport, pathToKeystore))
ST_SHIM(int, NOT_LOADED, EricCloseHandleToCertificate, (unsigned int hToken), (hToken))
