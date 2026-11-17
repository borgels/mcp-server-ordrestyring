import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError, redactDeep } from '../errors.js';
import { withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { currentCallContext, currentInstancePolicy, currentRedactor } from './scope.js';

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
  // Redacted with the shared redactDeep (the call scope's redactor, numbers and depth included), then copied
  // through JSON: plain data, without undefined fields, that the server does not keep. The second pass is the final
  // one, over the assembled record.
  const safe = JSON.parse(JSON.stringify(redactDeep(redactDeep(record)))) as Record<string, unknown>;

  // The sink check (src/key-admission.ts), on the record and the line in their final form: one that holds a piece of
  // the token is replaced by a fixed record.
  const redactor = currentRedactor();
  const leaks = (value: unknown) => redactor !== undefined && leaksSecret(value, redactor);
  if (sink) {
    await sink(leaks(safe) ? withheldAuditRecord() : safe);
  } else if (auditPath) {
    const line = JSON.stringify(safe);
    await appendFile(auditPath, `${leaks(line) ? JSON.stringify(withheldAuditRecord()) : line}\n`, 'utf8');
  }
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
