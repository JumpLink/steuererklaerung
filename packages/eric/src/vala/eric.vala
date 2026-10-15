/*
 * SteuerEric — a thin GObject-Introspection wrapper over the ERiC C API
 * (libericapi.so) so GJS can call ELSTER's ERiC the same way the Node build does
 * through koffi. Buffer lifecycle (create → read → free) is handled here, so GJS
 * callers only ever see plain strings and ints.
 *
 * The ERiC native library is opened at runtime by absolute path (see eric-shim.c) and
 * is never linked or shipped by this package; this file re-declares only the public
 * ABI we use.
 */

using GLib;

namespace SteuerEric {

    [CCode (cheader_filename = "eric-extern.h")]
    namespace Native {
        [CCode (cname = "st_eric_load")]
        public static extern int load (string lib_dir);
        [CCode (cname = "st_eric_load_error")]
        public static extern unowned string load_error ();
        [CCode (cname = "EricInitialisiere")]
        public static extern int initialisiere (string plugin_pfad, string log_pfad);
        [CCode (cname = "EricBeende")]
        public static extern int beende ();
        [CCode (cname = "EricRueckgabepufferErzeugen")]
        public static extern void* puffer_erzeugen ();
        [CCode (cname = "EricRueckgabepufferFreigeben")]
        public static extern int puffer_freigeben (void* handle);
        [CCode (cname = "EricRueckgabepufferInhalt")]
        public static extern unowned string puffer_inhalt (void* handle);
        [CCode (cname = "EricPruefeSteuernummer")]
        public static extern int pruefe_steuernummer (string stnr);
        [CCode (cname = "EricPruefeIBAN")]
        public static extern int pruefe_iban (string iban);
        [CCode (cname = "EricVersion")]
        public static extern int version (void* puffer);
        [CCode (cname = "EricCheckXML")]
        public static extern int check_xml (string xml, string datenart_version, void* fehlertext_puffer);
        [CCode (cname = "EricHoleFehlerText")]
        public static extern int hole_fehler_text (int fehlerkode, void* puffer);
        [CCode (cname = "EricBearbeiteVorgang")]
        public static extern int bearbeite_vorgang (string datenpuffer, string datenart_version, uint flags,
                                                    void* druck, void* crypto,
                                                    void* rueckgabe, void* serverantwort);
        [CCode (cname = "st_eric_sende")]
        public static extern int sende (string datenpuffer, string datenart_version, uint flags,
                                        string keystore_pfad, string pin,
                                        void* rueckgabe, void* serverantwort);
    }

    /**
     * Eric — GObject facade over libericapi.so.
     */
    public class Eric : GLib.Object {

        /**
         * Open the ERiC libraries in @lib_dir (by absolute path). Must succeed before any other
         * call; returns false when a library is missing or does not match this machine, and
         * load_error() then says why.
         */
        public bool load (string lib_dir) {
            return Native.load (lib_dir) != 0;
        }

        /** The loader's message for the last failed load(), empty otherwise. */
        public string load_error () {
            return Native.load_error ();
        }

        /** EricInitialisiere — must run before validation/version. Returns the ERiC code (0 = OK). */
        public int initialisiere (string plugin_pfad, string log_pfad) {
            return Native.initialisiere (plugin_pfad, log_pfad);
        }

        /** EricBeende — shut the library down. */
        public int beende () {
            return Native.beende ();
        }

        /** EricPruefeSteuernummer — returns the ERiC code (0 = formally valid). */
        public int pruefe_steuernummer (string stnr) {
            return Native.pruefe_steuernummer (stnr);
        }

        /** EricPruefeIBAN — returns the ERiC code (0 = formally valid). */
        public int pruefe_iban (string iban) {
            return Native.pruefe_iban (iban);
        }

        /** EricVersion — returns the version info XML (empty string on error). */
        public string version () {
            void* puffer = Native.puffer_erzeugen ();
            int rc = Native.version (puffer);
            string inhalt = (rc == 0) ? Native.puffer_inhalt (puffer) : "";
            Native.puffer_freigeben (puffer);
            return inhalt;
        }

        /**
         * EricCheckXML — schema-validate @xml for @datenart_version. Returns the
         * ERiC code; @errors receives the error text (empty when valid).
         */
        public int check_xml (string xml, string datenart_version, out string errors) {
            void* puffer = Native.puffer_erzeugen ();
            int rc = Native.check_xml (xml, datenart_version, puffer);
            errors = (rc == 0) ? "" : Native.puffer_inhalt (puffer);
            Native.puffer_freigeben (puffer);
            return rc;
        }

        /** EricHoleFehlerText — human-readable message for an ERiC error code. */
        public string fehler_text (int fehlerkode) {
            void* puffer = Native.puffer_erzeugen ();
            int rc = Native.hole_fehler_text (fehlerkode, puffer);
            string text = (rc == 0) ? Native.puffer_inhalt (puffer) : "";
            Native.puffer_freigeben (puffer);
            return text;
        }

        /**
         * EricBearbeiteVorgang in validate-only mode (druck/crypto are
         * NULL — no PDF, no encryption, no submission). @flags is e.g.
         * VALIDIERE (2) | PRUEFE_HINWEISE (128). Returns the ERiC code; the result
         * XML (hints or errors) is written to @rueckgabe_xml and the server answer
         * to @serverantwort_xml.
         */
        public int validate_vorgang (string datenpuffer, string datenart_version, uint flags,
                                     out string rueckgabe_xml, out string serverantwort_xml) {
            void* rb = Native.puffer_erzeugen ();
            void* sb = Native.puffer_erzeugen ();
            int rc = Native.bearbeite_vorgang (datenpuffer, datenart_version, flags, null, null, rb, sb);
            rueckgabe_xml = Native.puffer_inhalt (rb);
            serverantwort_xml = Native.puffer_inhalt (sb);
            Native.puffer_freigeben (rb);
            Native.puffer_freigeben (sb);
            return rc;
        }

        /**
         * EricBearbeiteVorgang in SEND mode. Opens the PKCS#12 keystore at
         * @keystore_pfad with @pin, transmits @datenpuffer to the ELSTER server
         * and releases the certificate handle afterwards. @flags must include
         * VALIDIERE (2) | SENDE (4); whether the submission reaches the live
         * system or is discarded is governed by the <Testmerker> in the XML, NOT
         * by this call. Returns the ERiC code; the server answer (Transferticket
         * on success) lands in @serverantwort_xml, the receipt XML in
         * @rueckgabe_xml. Performs no retry — the caller decides.
         */
        public int send_vorgang (string datenpuffer, string datenart_version, uint flags,
                                 string keystore_pfad, string pin,
                                 out string rueckgabe_xml, out string serverantwort_xml) {
            void* rb = Native.puffer_erzeugen ();
            void* sb = Native.puffer_erzeugen ();
            int rc = Native.sende (datenpuffer, datenart_version, flags, keystore_pfad, pin, rb, sb);
            rueckgabe_xml = Native.puffer_inhalt (rb);
            serverantwort_xml = Native.puffer_inhalt (sb);
            Native.puffer_freigeben (rb);
            Native.puffer_freigeben (sb);
            return rc;
        }
    }
}
