import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OrdrestyringClient, type OrdrestyringClientOptions } from './ordrestyring/client.js';
import { registerOrdrestyringTools } from './tools/ordrestyring.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: OrdrestyringClient;
  clientOptions?: OrdrestyringClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'ordrestyring',
    version: PACKAGE_VERSION,
  });

  const client = options.client ?? new OrdrestyringClient(options.clientOptions);
  registerOrdrestyringTools(server, client);

  return server;
}
