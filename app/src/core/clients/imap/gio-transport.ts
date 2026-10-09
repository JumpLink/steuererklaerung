/**
 * The TLS socket under the IMAP client, over Gio (GJS only).
 *
 * `SocketClient.set_tls(true)` validates the server certificate against the system trust store — there
 * is no switch to turn that off, on purpose: a mailbox password must not go to an impostor. A plain
 * connection exists for loopback only; `pruefeMailEingang` refuses it for any other host.
 */

import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import { ImapError, type RawTransport } from './client.ts';

/** Give up on a silent server instead of hanging the app. */
const IO_TIMEOUT_SECONDS = 30;
const READ_CHUNK = 65536;

type Promisified = {
    _promisify(proto: object, name: string, finish: string): void;
};
const gio = Gio as unknown as Promisified;
gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async', 'connect_to_host_finish');
gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

interface AsyncSocketClient {
    connect_to_host_async(host: string, port: number, cancellable: null): Promise<Gio.SocketConnection>;
}
interface AsyncInput {
    read_bytes_async(count: number, priority: number, cancellable: null): Promise<GLib.Bytes>;
}
interface AsyncOutput {
    write_all_async(bytes: Uint8Array, priority: number, cancellable: null): Promise<[boolean, number]>;
}

export async function openGioTransport(target: { host: string; port: number; tls: boolean }): Promise<RawTransport> {
    const client = new Gio.SocketClient();
    client.set_tls(target.tls);
    client.set_timeout(IO_TIMEOUT_SECONDS);
    let connection: Gio.SocketConnection;
    try {
        connection = await (client as unknown as AsyncSocketClient).connect_to_host_async(
            target.host,
            target.port,
            null,
        );
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new ImapError(`Keine Verbindung zu ${target.host}:${target.port} (${why})`, 'connection');
    }
    const input = connection.get_input_stream() as unknown as AsyncInput;
    const output = connection.get_output_stream() as unknown as AsyncOutput;
    return {
        async read() {
            try {
                const bytes = await input.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, null);
                const arr = bytes.toArray();
                return arr.length === 0 ? null : arr;
            } catch (err) {
                throw new ImapError(
                    `Lesen vom Server schlug fehl (${err instanceof Error ? err.message : err})`,
                    'connection',
                );
            }
        },
        async write(bytes) {
            try {
                await output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null);
            } catch (err) {
                throw new ImapError(
                    `Schreiben zum Server schlug fehl (${err instanceof Error ? err.message : err})`,
                    'connection',
                );
            }
        },
        close() {
            try {
                connection.close(null);
            } catch {
                // already closed
            }
        },
    };
}
