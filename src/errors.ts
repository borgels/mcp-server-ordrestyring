import { redactRegisteredSecrets, truncate } from './upstream-http.js';

export interface OrdrestyringGraphQLErrorPayload {
  message?: string;
  type?: string;
  locations?: Array<{ line?: number; column?: number }>;
  path?: Array<string | number>;
  validation?: Record<string, string[]>;
  extensions?: Record<string, unknown>;
}

const SECRET_PATTERNS = [
  /Authorization:\s*Bearer\s+[^,\s}]+/gi,
  /(ORDRESTYRING_API_TOKEN|apiToken|token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
];

export class OrdrestyringHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: unknown;
  readonly retryAfter?: string;
  readonly rateLimitLimit?: string;
  readonly rateLimitRemaining?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: unknown;
    retryAfter?: string;
    rateLimitLimit?: string;
    rateLimitRemaining?: string;
    fallbackMessage?: string;
  }) {
    super(formatOrdrestyringHttpError(input));
    this.name = 'OrdrestyringHttpError';
    this.status = input.status;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.rateLimitLimit = input.rateLimitLimit;
    this.rateLimitRemaining = input.rateLimitRemaining;
  }
}

export class OrdrestyringGraphQLError extends Error {
  readonly errors: OrdrestyringGraphQLErrorPayload[];
  readonly data?: unknown;

  constructor(input: { errors: OrdrestyringGraphQLErrorPayload[]; data?: unknown }) {
    super(formatOrdrestyringGraphQLErrors(input.errors));
    this.name = 'OrdrestyringGraphQLError';
    this.errors = input.errors;
    this.data = input.data;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        if (/^Bearer\s/i.test(match)) {
          return 'Bearer [REDACTED]';
        }

        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    redactRegisteredSecrets(value),
  );
}

function formatOrdrestyringHttpError(input: {
  status: number;
  url: string;
  payload?: unknown;
  retryAfter?: string;
  rateLimitLimit?: string;
  rateLimitRemaining?: string;
  fallbackMessage?: string;
}): string {
  const parts = [
    `Ordrestyring GraphQL request failed with HTTP ${input.status}`,
    input.retryAfter ? `retry-after=${truncate(input.retryAfter, 64)}s` : undefined,
    input.rateLimitLimit ? `rate-limit=${truncate(input.rateLimitLimit, 64)}` : undefined,
    input.rateLimitRemaining ? `rate-limit-remaining=${truncate(input.rateLimitRemaining, 64)}` : undefined,
    graphqlErrorsText(input.payload),
    // Redact before truncating, so a secret is never cut in half and left partly visible.
    input.fallbackMessage === undefined ? undefined : truncate(redactSecrets(input.fallbackMessage.trim())),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

const MAX_GRAPHQL_ERRORS = 10;

function formatOrdrestyringGraphQLErrors(errors: OrdrestyringGraphQLErrorPayload[]): string {
  const text = errors
    .slice(0, MAX_GRAPHQL_ERRORS)
    .map(error =>
      [
        error.message ?? 'GraphQL error',
        error.type ? `type=${error.type}` : undefined,
        error.path?.length ? `path=${error.path.join('.')}` : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    )
    .map(entry => truncate(redactSecrets(entry)))
    .join(' | ');

  return redactSecrets(text || 'Ordrestyring GraphQL returned errors.');
}

function graphqlErrorsText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return undefined;
  }

  return formatOrdrestyringGraphQLErrors(errors as OrdrestyringGraphQLErrorPayload[]);
}
