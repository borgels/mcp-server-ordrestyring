import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface OrdrestyringAuditEvent {
  requestId?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: unknown;
  status?: string;
  retryAfter?: string;
  reason?: string;
  operationHash?: string;
  idempotencyKey?: string;
  error?: unknown;
}

export async function writeAuditEvent(event: OrdrestyringAuditEvent): Promise<void> {
  const auditPath = process.env.ORDRESTYRING_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    tool: event.tool,
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

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
