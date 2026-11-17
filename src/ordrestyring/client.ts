import { readEnvInteger } from '../config-env.js';
import { limitDepth, nestedFailuresAsStatus, OrdrestyringGraphQLError, OrdrestyringHttpError } from '../errors.js';
import {
  describeUrl,
  discardBody,
  isRedirect,
  redirectRefusedMessage,
  registerSecret,
  SecretRedactor,
} from '../upstream-http.js';

/** The Ordrestyring GraphQL API. */
export const DEFAULT_BASE_URL = 'https://graphql.ordrestyring.dk';

export interface OrdrestyringClientOptions {
  apiToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Where a missing apiToken or baseUrl is read from. Default process.env
   * (the MCP server). The gateway passes {}: an embedded instance never reads
   * credentials from the environment.
   */
  credentialEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * The instance's own redactor (the gateway). Without one the token is
   * redacted by the MCP server's process-wide redactor.
   */
  redactor?: SecretRedactor;
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

  /** Redacts this client's token; the gateway runs every call with it in scope. */
  readonly redactor: SecretRedactor;

  constructor(options: OrdrestyringClientOptions = {}) {
    const env = options.credentialEnv ?? process.env;
    this.apiToken = options.apiToken ?? env.ORDRESTYRING_API_TOKEN;
    this.redactor = options.redactor ?? new SecretRedactor();
    this.redactor.addSecret(this.apiToken);
    if (!options.redactor) {
      // The MCP server: its errors are redacted outside any call scope.
      registerSecret(this.apiToken);
    }
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? env.ORDRESTYRING_BASE_URL ?? DEFAULT_BASE_URL);
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs =
      options.timeoutMs ?? readEnvInteger('ORDRESTYRING_TIMEOUT_MS', 30_000, { min: 1, max: 600_000 });
  }

  async graphql<T>(request: GraphQLRequest): Promise<T> {
    const response = await this.rawGraphql<T>(request);

    if (response.errors?.length) {
      throw new OrdrestyringGraphQLError({ errors: response.errors as never });
    }

    // A failure reported inside the data keeps only its status and our own text.
    return nestedFailuresAsStatus(response.data) as T;
  }

  async rawGraphql<T>(request: GraphQLRequest): Promise<GraphQLResponse<T>> {
    if (!this.apiToken) {
      throw new Error('Missing ORDRESTYRING_API_TOKEN. Set it in the MCP server environment.');
    }

    const url = `${this.baseUrl}/graphql`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
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
      // Never follow redirects: the token and the request body would be re-sent to the new location.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    } catch (error) {
      throw transportError(url, error, this.timeoutMs);
    }

    if (isRedirect(response.status)) {
      await discardBody(response);
      throw new Error(redirectRefusedMessage('Ordrestyring GraphQL', response, 'POST', url));
    }

    if (!response.ok) {
      // The body is Ordrestyring's text: it is never read into an error, a result or an audit record.
      await discardBody(response);
      throw new OrdrestyringHttpError({
        status: response.status,
        url: describeUrl(url),
        retryAfter: response.headers.get('retry-after') ?? undefined,
        rateLimitLimit: response.headers.get('x-ratelimit-limit') ?? undefined,
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
      });
    }

    return (await readResponseBody(response)) as GraphQLResponse<T>;
  }
}

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A network failure in our own words: only a system error code from a fixed list, never a message. */
function transportError(_url: string, error: unknown, timeoutMs: number): Error {
  // The address is configuration and is not quoted.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new Error(`Ordrestyring GraphQL request timed out after ${timeoutMs} ms (POST).`);
  }
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
  return new Error(`Network error calling Ordrestyring GraphQL (POST)${shown}.`);
}

async function readResponseBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Anything thrown while reading the body is replaced by our own text: its message is not ours.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('Ordrestyring GraphQL response timed out while it was being read.');
    }
    throw new Error('The Ordrestyring GraphQL response could not be read.');
  }

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    // Depth-limited at once, so nothing downstream (a handler's JSON text, the gateway) can exhaust the stack.
    return limitDepth(JSON.parse(text) as unknown);
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  // Linear scan instead of /\/+$/, which backtracks polynomially on long runs of '/'.
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Redacted before it is cut short: the value is configuration and could hold the token.
    // The value is not quoted: configuration is never echoed, not even shortened.
    throw new Error('The Ordrestyring base URL is not a valid URL.');
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    'Refusing to send the Ordrestyring API token over a connection that is not https. Use https:// (loopback http:// is allowed for local mocks).',
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
