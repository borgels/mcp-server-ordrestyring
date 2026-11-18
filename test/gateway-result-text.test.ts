// A successful gateway result carries its data in the text block too, as the MCP spec asks of a tool that returns
// structured content: many clients (Claude among them) read only the text.
import { describe, expect, it, vi } from 'vitest';

// One handler answers with a plain object instead of an MCP result, so the gateway's own summary path is used.
vi.mock('../src/tools/ordrestyring.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/ordrestyring.js')>();
  return {
    ...actual,
    registerOrdrestyringTools(server: { registerTool: (...args: unknown[]) => void }, client: unknown) {
      const wrapped = {
        registerTool(name: string, config: unknown, handler: unknown) {
          if (name === 'ordrestyring_check_connection') {
            server.registerTool(name, config, async () => ({ ok: true, company: 'Testfirma ApS' }));
            return;
          }
          server.registerTool(name, config, handler);
        },
      };
      return actual.registerOrdrestyringTools(wrapped as never, client as never);
    },
  };
});

const { createOrdrestyringGateway } = await import('../src/gateway.js');

const TOKEN = 'tenant-a-token-0123456789abcdef';

describe('the data in the text block', () => {
  it('follows the summary as compact JSON, exactly the structured content', async () => {
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, fetchImpl: vi.fn<typeof fetch>() });
    const result = await gateway.callTool('check_connection');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, company: 'Testfirma ApS' });
    expect(result.content).toHaveLength(1);
    const [summary, data, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).toBe('Ordrestyring gateway result.');
    expect(rest).toEqual([]);
    expect(data).toBe(JSON.stringify(result.structuredContent));
    expect(result.content[0]!.text).toContain('"company":"Testfirma ApS"');
  });
});
