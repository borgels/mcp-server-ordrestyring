import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/stdio.js'],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    stderr: 'pipe',
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));

  const client = new Client({ name: 'ordrestyring-mcp-smoke', version: '0.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const checkConnection = parseToolJson(
      await client.callTool({ name: 'ordrestyring_check_connection', arguments: {} }),
    );
    const schemaResults = parseToolJson(
      await client.callTool({
        name: 'ordrestyring_search_schema',
        arguments: { query: 'case', limit: 3 },
      }),
    );
    const cases = parseToolJson(
      await client.callTool({
        name: 'ordrestyring_list_cases',
        arguments: { cursor: null, limit: 1, orderByField: 'updatedAt', orderDirection: 'DESC' },
      }),
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          toolCount: tools.tools.length,
          hasDiagnostics: tools.tools.some(tool => tool.name === 'ordrestyring_diagnostics'),
          checkConnection,
          schemaResultCount: Array.isArray(schemaResults) ? schemaResults.length : 0,
          caseCount: Array.isArray(cases?.cases?.items) ? cases.cases.items.length : undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
    const stderr = stderrChunks.join('').trim();
    if (stderr) {
      console.error(stderr);
    }
  }
}

function parseToolJson(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find(item => item.type === 'text')?.text;
  if (!text) {
    throw new Error('Tool result did not contain text content.');
  }

  return JSON.parse(text);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
