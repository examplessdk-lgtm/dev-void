import { once } from 'node:events';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import mysql from 'mysql2';

/** The parts of mysql2's server-side connection that the fake server uses. */
type ServerConnection = {
  sequenceId: number;
  serverHandshake(options: Record<string, unknown>): void;
  on(event: 'query', listener: (sql: string) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  writeColumns(columns: Array<Record<string, unknown>>): void;
  writeTextRow(values: Array<unknown>): void;
  writeEof(): void;
  writeOk(): void;
};

const { Connection, ConnectionConfig } = mysql as unknown as {
  Connection: new (options: { config: unknown }) => ServerConnection;
  ConnectionConfig: new (options: { stream: Socket; isServer: true }) => unknown;
};

const CHARSET = mysql.Charsets.UTF8_GENERAL_CI;
// Every basic capability except CLIENT_SSL (0x0800), so clients never ask for TLS.
const CAPABILITY_FLAGS = 0xffff & ~0x0800;

export type FakeMySqlRow = Record<string, number | string>;

export type FakeMySqlServer = {
  port: number;
  close(): Promise<void>;
};

/**
 * A MySQL wire-protocol server built on mysql2's own server API. It accepts any user, answers
 * every SELECT with `rows` (columns in key order of the first row) and every other statement
 * with OK. It speaks the text protocol only, which is what drizzle's mysql2 driver uses.
 */
export async function startFakeMySqlServer(rows: Array<FakeMySqlRow>): Promise<FakeMySqlServer> {
  const columnNames = Object.keys(rows[0] ?? {});
  const columns = columnNames.map((name) => ({
    catalog: 'def',
    schema: 'app',
    table: 'fake',
    orgTable: 'fake',
    name,
    orgName: name,
    characterSet: CHARSET,
    columnLength: 255,
    columnType: typeof rows[0]?.[name] === 'number' ? mysql.Types.LONG : mysql.Types.VAR_STRING,
    flags: 0,
    decimals: 0,
  }));
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const connection = new Connection({
      config: new ConnectionConfig({ stream: socket, isServer: true }),
    });
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.4.0-void-test',
      connectionId: 1,
      statusFlags: 2,
      characterSet: CHARSET,
      capabilityFlags: CAPABILITY_FLAGS,
      authCallback(_params: unknown, done: (error: null) => void) {
        done(null);
        // Each command starts a new packet sequence; the server API leaves the reset to us.
        connection.sequenceId = 0;
      },
    });
    connection.on('query', (sql) => {
      if (/^\s*select\b/i.test(sql)) {
        connection.writeColumns(columns);
        for (const row of rows) {
          connection.writeTextRow(columnNames.map((name) => row[name]));
        }
        connection.writeEof();
      } else {
        connection.writeOk();
      }
      connection.sequenceId = 0;
    });
    // A client that drops its socket emits an error here; unhandled, it would end the test run.
    connection.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, 'close');
    },
  };
}
