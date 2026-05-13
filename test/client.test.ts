import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatUnknownError,
  OrdrestyringGraphQLError,
  OrdrestyringHttpError,
  redactSecrets,
} from '../src/errors.js';
import { OrdrestyringClient } from '../src/ordrestyring/client.js';

const originalTimeout = process.env.ORDRESTYRING_TIMEOUT_MS;

describe('OrdrestyringClient', () => {
  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.ORDRESTYRING_TIMEOUT_MS;
    } else {
      process.env.ORDRESTYRING_TIMEOUT_MS = originalTimeout;
    }
  });

  it('sends the Ordrestyring API token as a Bearer header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { __typename: 'Query' } }));
    const client = new OrdrestyringClient({
      apiToken: 'secret-test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.graphql({ query: 'query { __typename }' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-test-token',
    });
  });

  it('returns GraphQL data on successful responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { ok: true } }));
    const client = new OrdrestyringClient({
      apiToken: 'test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.graphql({ query: 'query { ok }' })).resolves.toEqual({ ok: true });
  });

  it('treats GraphQL errors as errors even on HTTP 200', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: { caseById: null },
        errors: [{ message: 'validation', type: 'ValidationError', path: ['caseById'] }],
      }),
    );
    const client = new OrdrestyringClient({
      apiToken: 'test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.graphql({ query: 'query { caseById(id: -1) { id } }' })).rejects.toThrow(
      /ValidationError/,
    );

    try {
      await client.graphql({ query: 'query { caseById(id: -1) { id } }' });
    } catch (error) {
      expect(error).toBeInstanceOf(OrdrestyringGraphQLError);
    }
  });

  it('includes retry-after and rate-limit guidance for HTTP failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { errors: [{ message: 'Too Many Attempts.', type: 'ThrottleRequestsException' }] },
        429,
        { 'retry-after': '17', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' },
      ),
    );
    const client = new OrdrestyringClient({
      apiToken: 'test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.graphql({ query: 'query { __typename }' })).rejects.toThrow(/retry-after=17s/);

    try {
      await client.graphql({ query: 'query { __typename }' });
    } catch (error) {
      expect(error).toBeInstanceOf(OrdrestyringHttpError);
      expect((error as OrdrestyringHttpError).retryAfter).toBe('17');
      expect((error as OrdrestyringHttpError).rateLimitRemaining).toBe('0');
    }
  });

  it('redacts token material from formatted errors', () => {
    expect(redactSecrets('Authorization: Bearer secret-test-token')).toBe('Authorization: [REDACTED]');
    expect(formatUnknownError(new Error('ORDRESTYRING_API_TOKEN=secret-test-token'))).toBe(
      'ORDRESTYRING_API_TOKEN= [REDACTED]',
    );
  });

  it('uses ORDRESTYRING_TIMEOUT_MS when timeout is not passed explicitly', async () => {
    process.env.ORDRESTYRING_TIMEOUT_MS = '1234';
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { ok: true } }));
    const client = new OrdrestyringClient({
      apiToken: 'test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.graphql({ query: 'query { ok }' });

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });

  it('fails clearly when ORDRESTYRING_API_TOKEN is missing', async () => {
    const client = new OrdrestyringClient({
      apiToken: '',
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(client.graphql({ query: 'query { __typename }' })).rejects.toThrow(
      'Missing ORDRESTYRING_API_TOKEN',
    );
  });

  it('refuses non-https base URLs to protect the API token', () => {
    expect(
      () =>
        new OrdrestyringClient({
          apiToken: 'test-token',
          baseUrl: 'http://graphql.ordrestyring.dk',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/https/);
  });

  it('allows http:// for loopback mocks', () => {
    expect(
      () =>
        new OrdrestyringClient({
          apiToken: 'test-token',
          baseUrl: 'http://localhost:8080',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).not.toThrow();
  });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}
