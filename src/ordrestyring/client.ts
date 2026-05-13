import { OrdrestyringGraphQLError, OrdrestyringHttpError } from '../errors.js';

export interface OrdrestyringClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: unknown[];
}

export class OrdrestyringClient {
  private readonly apiToken?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OrdrestyringClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.ORDRESTYRING_API_TOKEN;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.ORDRESTYRING_BASE_URL ?? 'https://graphql.ordrestyring.dk',
    );
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.ORDRESTYRING_TIMEOUT_MS ?? 30_000);
  }

  async graphql<T>(request: GraphQLRequest): Promise<T> {
    const response = await this.rawGraphql<T>(request);

    if (response.errors?.length) {
      throw new OrdrestyringGraphQLError({
        errors: response.errors as never,
        data: response.data,
      });
    }

    return response.data as T;
  }

  async rawGraphql<T>(request: GraphQLRequest): Promise<GraphQLResponse<T>> {
    if (!this.apiToken) {
      throw new Error('Missing ORDRESTYRING_API_TOKEN. Set it in the MCP server environment.');
    }

    const url = `${this.baseUrl}/graphql`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Include-Input-Deprecation': 'true',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({
        query: request.query,
        variables: request.variables ?? {},
        operationName: request.operationName,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new OrdrestyringHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        rateLimitLimit: response.headers.get('x-ratelimit-limit') ?? undefined,
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return responseBody as GraphQLResponse<T>;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`ORDRESTYRING_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send the Ordrestyring API token over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
