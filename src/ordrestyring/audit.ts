import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError, redactSecrets } from '../errors.js';
import { currentCallContext, currentInstancePolicy } from './scope.js';

export interface OrdrestyringAuditEvent {
  requestId?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: unknown;
  status?: string;
  retryAfter?: string;
  reason?: string;
  operationHash?: string;
  idempotencyKey?: string;
  error?: unknown;
}

/**
 * Append one JSON line to ORDRESTYRING_AUDIT_LOG (no-op when unset). Inside
 * a gateway call under a host's InstancePolicy the record goes to the
 * policy's `audit` sink instead (no-op without one), and
 * ORDRESTYRING_AUDIT_LOG is not read. Caller and request id come from the
 * gateway call's context when there is one.
 *
 * Every string in the record, keys included, has the instance's secrets
 * redacted before it reaches the sink or the file: a key can reach a record
 * through a tool name, the caller or a reason, not only through an error.
 *
 * A failing sink or file throws, so a tool whose start record cannot be
 * written does not run.
 */
export async function writeAuditEvent(event: OrdrestyringAuditEvent): Promise<void> {
  const hosted = currentInstancePolicy();
  const sink = hosted?.audit;
  const auditPath = hosted ? undefined : process.env.ORDRESTYRING_AUDIT_LOG;
  if (!sink && !auditPath) {
    return;
  }

  const context = currentCallContext();
  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? context.requestId ?? randomUUID(),
    tool: event.tool,
    caller: context.caller,
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    operationHash: event.operationHash,
    idempotencyKeyHash:
      event.idempotencyKey === undefined ? undefined : hashValue(event.idempotencyKey),
    status: event.status,
    retryAfter: event.retryAfter,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };
  // A copy through JSON: plain data, without undefined fields, that the server does not keep.
  const safe = JSON.parse(JSON.stringify(redactDeep(record))) as Record<string, unknown>;

  if (sink) {
    await sink(safe);
  } else if (auditPath) {
    await appendFile(auditPath, `${JSON.stringify(safe)}\n`, 'utf8');
  }
}

/** A copy of a JSON value with every string, object keys included, redacted with the current instance's secrets. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value !== 'object' || value === null || depth > 20) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
