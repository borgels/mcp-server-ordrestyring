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
/** Any piece of a secret this long or longer is redacted, wherever it appears. */
export const FRAGMENT_LENGTH = 6;
/**
 * What a redacted value is replaced by. Its brackets are not ASCII, so it cannot be a piece of a token issued as
 * ASCII; a gateway refuses a token that contains it or shares a FRAGMENT_LENGTH piece with it (overlapsMarker).
 */
export const REDACTION_MARKER = '‹redacted›';

/** Whether a secret could survive its own redaction: it contains the marker, or shares a piece with it. */
export function overlapsMarker(value: string): boolean {
  if (value.includes(REDACTION_MARKER)) {
    return true;
  }
  for (let i = 0; i + FRAGMENT_LENGTH <= REDACTION_MARKER.length; i += 1) {
    if (value.includes(REDACTION_MARKER.slice(i, i + FRAGMENT_LENGTH))) {
      return true;
    }
  }
  return false;
}

/**
 * The secrets of one client, and so of one gateway or server instance: the
 * exact values (raw, URL-encoded and JSON-escaped) and every fragment of
 * FRAGMENT_LENGTH characters or more of them. Each gateway instance owns its
 * redactor, so a host that runs several tenants in one process never mixes
 * their keys, and a tenant's key is released with its instance.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly fragments = new Set<string>();

  /** Redact this value and every piece of it. Values shorter than MIN_SECRET_LENGTH are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) {
      this.secrets.add(form);
      for (let i = 0; i + FRAGMENT_LENGTH <= form.length; i += 1) {
        this.fragments.add(form.slice(i, i + FRAGMENT_LENGTH));
      }
    }
    return this;
  }

  /** Every secret value, and every run of text covered by a piece of one, replaced with ‹redacted›. */
  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('‹redacted›');
    }
    return this.redactFragments(result);
  }

  private redactFragments(text: string): string {
    if (this.fragments.size === 0 || text.length < FRAGMENT_LENGTH) {
      return text;
    }
    let covered: Uint8Array | undefined;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) {
        covered ??= new Uint8Array(text.length);
        covered.fill(1, i, i + FRAGMENT_LENGTH);
      }
    }
    if (!covered) {
      return text;
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (covered[i]) {
        out += '‹redacted›';
        while (i < text.length && covered[i]) i += 1;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
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
 * ‹redacted›: inside a gateway call the instance's own redactor, outside one
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

/** Message for a refused redirect: the status and our own request. The Location is never quoted. */
export function redirectRefusedMessage(
  service: string,
  response: Response,
  method: string,
  url: string,
): string {
  // The Location is the vendor's text and is never quoted; only the status and our own request.
  return redactRegisteredSecrets(
    `${service} responded with a redirect (HTTP ${response.status}) for ${method} ${describeUrl(url)}; ` +
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
