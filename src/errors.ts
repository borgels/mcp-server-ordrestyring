/**
 * Errors and redaction.
 *
 * The rule: no text Ordrestyring controls ever reaches a host, a result or an
 * audit record through an error. An HTTP error carries the status, our own
 * hint and the parsed Retry-After and rate-limit numbers; a GraphQL error
 * carries the number of errors; never a response body, an error message or
 * path from Ordrestyring, or a redirect's Location. Ordrestyring's text can
 * quote the request or part of the token, and no redactor recognises every
 * fragment.
 *
 * Redaction is the second line: the token of the instance in scope (its
 * exact value, URL- and JSON-encoded forms, and any fragment of
 * FRAGMENT_LENGTH characters or more) is redacted from everything returned,
 * on structured values before they are serialised.
 */
import { redactRegisteredSecrets } from './upstream-http.js';

export { FRAGMENT_LENGTH, MIN_SECRET_LENGTH } from './upstream-http.js';

/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;

/** A GraphQL error as Ordrestyring sends it; read only to count. */
export interface OrdrestyringGraphQLErrorPayload {
  message?: string;
  type?: string;
  path?: Array<string | number>;
}

const SECRET_PATTERNS = [
  /Authorization:\s*Bearer\s+[^,\s}]+/gi,
  /(ORDRESTYRING_API_TOKEN|apiToken|token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
];

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  401: 'The API token was rejected (invalid or expired).',
  403: 'The API token has no access to this. Retrying will not help.',
  429: 'Ordrestyring is throttling requests. Wait and retry later.',
};

/** An HTTP error from Ordrestyring: the status and the numbers from its headers. Nothing of the body is kept. */
export class OrdrestyringHttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or not a number of seconds. */
  readonly retryAfter?: string;
  readonly rateLimitLimit?: string;
  readonly rateLimitRemaining?: string;

  constructor(input: {
    status: number;
    url: string;
    retryAfter?: string;
    rateLimitLimit?: string;
    rateLimitRemaining?: string;
  }) {
    const retryAfter = wholeNumber(input.retryAfter);
    const rateLimitLimit = wholeNumber(input.rateLimitLimit);
    const rateLimitRemaining = wholeNumber(input.rateLimitRemaining);
    super(
      [
        `Ordrestyring GraphQL request failed with HTTP ${input.status}`,
        Object.hasOwn(STATUS_HINTS, input.status) ? STATUS_HINTS[input.status] : undefined,
        retryAfter === undefined ? undefined : `retry-after=${retryAfter}s`,
        rateLimitLimit === undefined ? undefined : `rate-limit=${rateLimitLimit}`,
        rateLimitRemaining === undefined ? undefined : `rate-limit-remaining=${rateLimitRemaining}`,
      ]
        .filter(Boolean)
        .join(' | '),
    );
    this.name = 'OrdrestyringHttpError';
    this.status = input.status;
    this.url = input.url;
    this.retryAfter = retryAfter;
    this.rateLimitLimit = rateLimitLimit;
    this.rateLimitRemaining = rateLimitRemaining;
  }
}

/** GraphQL errors from Ordrestyring: how many. Their messages and paths are not kept. */
export class OrdrestyringGraphQLError extends Error {
  readonly count: number;

  constructor(input: { errors: OrdrestyringGraphQLErrorPayload[] }) {
    const count = Array.isArray(input.errors) ? input.errors.length : 0;
    super(
      `Ordrestyring GraphQL returned ${count} error${count === 1 ? '' : 's'}. ` +
        'The query or its arguments were not accepted; check the ids and filters.',
    );
    this.name = 'OrdrestyringGraphQLError';
    this.count = count;
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
          return 'Bearer ‹redacted›';
        }

        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} ‹redacted›`;
      }),
    redactRegisteredSecrets(value),
  );
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets. Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactSecrets(text) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
}

/** Copy of parsed JSON with anything nested deeper than MAX_REDACT_DEPTH replaced, so it can be serialised safely. */
export function limitDepth(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => limitDepth(entry, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, limitDepth(entry, depth + 1)]));
}

/**
 * Text for a failure kept inside a result that is otherwise returned (one
 * section of a combined read): the HTTP status, the GraphQL error count, or
 * this server's own message, redacted. This server's error messages carry no
 * Ordrestyring text (see the top of this file).
 */
export function nestedFailureText(error: unknown): string {
  if (error instanceof OrdrestyringHttpError) {
    return `Ordrestyring GraphQL request failed with HTTP ${error.status}`;
  }
  if (error instanceof OrdrestyringGraphQLError) {
    return error.message;
  }
  return formatUnknownError(error);
}

/** A header value that is a whole number of at most 9 digits, as text; anything else is dropped. */
function wholeNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{1,9}$/.test(trimmed) ? String(Number(trimmed)) : undefined;
}
