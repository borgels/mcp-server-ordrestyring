/**
 * Helpers for calls to the upstream API: redirects are never followed (so
 * credentials are not re-sent to another location), error bodies are read up
 * to a fixed size, and URLs in error messages carry no query string.
 */

import { currentRedactor } from './ordrestyring/scope.js';

/** Error bodies are read up to this many bytes; the rest is discarded. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Maximum length of any single piece of upstream text placed in an error message. */
export const MAX_ERROR_TEXT = 500;

/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;

/**
 * Exact secret values of one client, and so of one gateway or server
 * instance. Each gateway instance owns its redactor, so a host that runs
 * several tenants in one process never mixes their keys, and a tenant's key
 * is released with its instance.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();

  /** Redact this exact value (and its URL-encoded form). Values shorter than MIN_SECRET_LENGTH are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    this.secrets.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      this.secrets.add(encoded);
    }
    return this;
  }

  /** Every secret value replaced with [REDACTED]. */
  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('[REDACTED]');
    }
    return result;
  }
}

/**
 * The MCP server's own secrets (the token it reads from the environment).
 * Gateway instances never add to it: their calls run in a call scope with
 * their own redactor.
 */
const processRedactor = new SecretRedactor();

/** Redact this exact value in the MCP server's error text (not used by gateway instances). */
export function registerSecret(value: string | undefined): void {
  processRedactor.addSecret(value);
}

/**
 * Replaces the secrets of the instance whose call is in progress with
 * [REDACTED]: inside a gateway call the instance's own redactor, outside one
 * (the MCP server) the server's.
 */
export function redactRegisteredSecrets(value: string): string {
  return (currentRedactor() ?? processRedactor).redact(value);
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** Shortens text to `max` characters. Redact before truncating, so a secret is never cut in half. */
export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}... [truncated]` : value;
}

/** Message for a refused redirect; the Location is shown without its query string. */
export function redirectRefusedMessage(
  service: string,
  response: Response,
  method: string,
  url: string,
): string {
  const location = response.headers.get('location');
  let target: string | undefined;
  if (location) {
    try {
      target = describeUrl(new URL(location, url));
    } catch {
      target = undefined;
    }
  }
  const where = target ? ` to ${target}` : '';
  return redactRegisteredSecrets(
    `${service} responded with a redirect (HTTP ${response.status})${where} for ${method} ${describeUrl(url)}; ` +
      'redirects are not followed. Check the configured base URL.',
  );
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Reads at most `limit` bytes of the body as UTF-8 text. */
export async function readTextUpTo(
  response: Response,
  limit: number,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: '', exceeded: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), exceeded };
}

/**
 * Reads an error response body up to MAX_ERROR_BODY_BYTES. JSON is parsed
 * only when the body is complete; otherwise the (partial) text is returned.
 * An empty body gives null.
 */
export async function readErrorBody(response: Response): Promise<unknown> {
  const { text, exceeded } = await readTextUpTo(response, MAX_ERROR_BODY_BYTES);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!exceeded && contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}
