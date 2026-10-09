import { imapConnector } from './client.ts';
import { openGioTransport } from './gio-transport.ts';

/** The connector every GJS surface (CLI, MCP, desktop) uses: IMAP over a Gio TLS socket. */
export const gioMailConnector = imapConnector(openGioTransport);
