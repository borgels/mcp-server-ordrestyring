import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  failureMetadata,
  formatUnknownError,
  MAX_REDACT_DEPTH,
  vendorRequestId,
  type FailureMetadata,
} from './errors.js';
import { writeAuditEvent } from './ordrestyring/audit.js';
import { DEFAULT_BASE_URL, OrdrestyringClient, type OrdrestyringClientOptions } from './ordrestyring/client.js';
import {
  canonicalToolName,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './ordrestyring/scope.js';
import { registerOrdrestyringTools } from './tools/ordrestyring.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import { SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Handlers, input schemas, policy checks and
 * audit are shared with the MCP server in src/tools/ordrestyring.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the token passed to
 * createOrdrestyringGateway (never ORDRESTYRING_API_TOKEN or
 * ORDRESTYRING_BASE_URL from the environment) and redacts errors and audit
 * records with its own token only.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`: that instance then reads none of
 * ORDRESTYRING_ENABLE_WRITES, ORDRESTYRING_POLICY_PATH or
 * ORDRESTYRING_AUDIT_LOG, so two tenants in one process can have different
 * settings. Without `policy` the instance uses the environment, as the MCP
 * server does. Limits (ORDRESTYRING_TIMEOUT_MS) are still read from the
 * environment when `timeoutMs` is not given.
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), with or
 * without a policy, so a call made from inside another instance's call (from
 * its audit sink or its fetch) never inherits that instance's policy, sink,
 * redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './ordrestyring/scope.js';
export { GatewayConfigError } from './ordrestyring/scope.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Ordrestyring answered with
 * (for GraphQL errors, the status of the answer that carried them, usually 200), and its own request id when a
 * response header gives one as a UUID or hex id. For a host that counts failures without reading their text. Never
 * the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Ordrestyring only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/**
 * One upstream request a tool may make. Ordrestyring has one GraphQL
 * endpoint: `operation` says whether the tool sends queries (reads, schema
 * introspection included) or mutations.
 */
export interface GatewayUpstreamOperation {
  readonly method: 'POST';
  readonly path: '/graphql';
  readonly operation: 'query' | 'mutation';
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. No gateway tool is
   * broad: the free GraphQL read (`graphql_read`) and the schema tools are
   * not in the gateway.
   */
  readonly broad: boolean;
}

export interface OrdrestyringGatewayOptions
  extends Omit<OrdrestyringClientOptions, 'apiToken' | 'baseUrl' | 'credentialEnv' | 'redactor'> {
  /** Ordrestyring API token of this instance. Required; never read from the environment. */
  apiToken: string;
  /** GraphQL base URL. Default https://graphql.ordrestyring.dk; never read from the environment. */
  baseUrl?: string;
  /**
   * Instance policy from the host. When given, the instance reads no policy
   * or audit variables from the environment (see InstancePolicy). A host
   * serving several tenants should always pass it.
   */
  policy?: InstancePolicy;
}

const QUERY: GatewayUpstreamOperation = { method: 'POST', path: '/graphql', operation: 'query' };
const MUTATION: GatewayUpstreamOperation = { method: 'POST', path: '/graphql', operation: 'mutation' };

/** The gateway's tools: a curated subset of the MCP server's tools, with their own titles. */
const GATEWAY_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  upstream: readonly GatewayUpstreamOperation[];
  broad?: boolean;
}> = [
  {
    name: 'check_connection',
    title: 'Check Ordrestyring connection',
    description: 'Verify that the configured Ordrestyring token can access the GraphQL API.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'search_cases',
    title: 'Search Ordrestyring cases',
    description: 'Search or filter cases using schema-supported arguments from the live Ordrestyring schema.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'get_case_health',
    title: 'Get Ordrestyring case health',
    description: 'Collect case overview, activity, work, documents, quality checks, and billing readiness.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'find_billable_cases',
    title: 'Find Ordrestyring billable cases',
    description: 'Find operational cases that look ready for billing review.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'get_invoice_readiness',
    title: 'Get Ordrestyring invoice readiness',
    description: 'Inspect one case for billing readiness: overview, uninvoiced work, draft invoice, and financials.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'search_customers',
    title: 'Search Ordrestyring customers',
    description: 'Search or list customers, for example to find the customer of a new case or offer.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'search_products',
    title: 'Search Ordrestyring products',
    description: 'Search products/items by number or description, for example to pick the material to add to a case.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'search_hour_types',
    title: 'Search Ordrestyring hour types',
    description: 'Search or list hour types and their linked time products.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'list_case_time_entries',
    title: 'List Ordrestyring time entries',
    description: 'List registered hours on a case, with optional date range and employee.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'list_case_materials',
    title: 'List Ordrestyring case materials',
    description: 'List materials registered on a case.',
    riskLevel: 'read',
    upstream: [QUERY],
  },
  {
    name: 'create_customer',
    title: 'Create Ordrestyring customer',
    description: 'Create an operational customer in Ordrestyring when writes and policy explicitly allow it.',
    riskLevel: 'write',
    upstream: [QUERY, MUTATION],
  },
  {
    name: 'create_case',
    title: 'Create Ordrestyring case',
    description: 'Create a case/order in Ordrestyring when writes and policy explicitly allow it. `input` holds CreateCaseInput fields, for example { customerId, description, statusId }.',
    riskLevel: 'write',
    upstream: [QUERY, MUTATION],
  },
  {
    name: 'create_case_activity',
    title: 'Add Ordrestyring case note',
    description: 'Add a note or activity to a case in Ordrestyring when writes and policy explicitly allow it. `input` holds CreateCaseActivityInput fields, for example the case id and the note text.',
    riskLevel: 'write',
    upstream: [QUERY, MUTATION],
  },
  {
    name: 'create_offer',
    title: 'Create Ordrestyring offer',
    description: 'Create an offer in Ordrestyring when writes and policy explicitly allow it; nothing is sent to the customer. `input` holds CreateOfferInput fields, for example { customerId, description }.',
    riskLevel: 'write',
    upstream: [QUERY, MUTATION],
  },
  {
    name: 'convert_offer_to_case',
    title: 'Convert Ordrestyring offer to case',
    description: 'Convert an accepted offer to a case/order in Ordrestyring when writes and policy explicitly allow it. `input` is { id } with the numeric offer id and optional `options`.',
    riskLevel: 'write',
    upstream: [QUERY, MUTATION],
  },
  {
    name: 'create_case_material',
    title: 'Add Ordrestyring case material',
    description: 'Register material on a case in Ordrestyring when writes and policy explicitly allow it. `input` holds CreateCaseMaterialInput fields, for example { caseId, description, quantity, type: "MATERIAL" }.',
    riskLevel: 'write',
    upstream: [QUERY, MUTATION],
  },
  {
    name: 'delete_products',
    title: 'Delete Ordrestyring products',
    description: 'Delete product/item master data in Ordrestyring when writes and policy explicitly allow it.',
    riskLevel: 'destructive',
    upstream: [QUERY, MUTATION],
  },
];

type RegisteredHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  inputSchema: z.ZodType;
  handler: RegisteredHandler;
}

/**
 * The MCP server's tools as registered: the zod input schema (strict: an
 * unknown field is refused, not dropped) and the handler bound to `client`.
 */
function registeredTools(client: OrdrestyringClient): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }, handler: RegisteredHandler): void {
      tools.set(name, { inputSchema: z.strictObject(config.inputSchema ?? {}), handler });
    },
  };
  registerOrdrestyringTools(server as never, client);
  return tools;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` is dropped: validators such as Ajv reject
 * unknown formats in strict mode, and zod checks the values when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// Schemas only: registration binds the handlers to a client but never calls it.
const schemas = registeredTools(
  new OrdrestyringClient({ apiToken: 'schema-only', credentialEnv: {}, redactor: new SecretRedactor(), timeoutMs: 1 }),
);

function definition(tool: (typeof GATEWAY_TOOLS)[number]): GatewayToolDefinition {
  const registered = schemas.get(`${TOOL_PREFIX}${tool.name}`);
  if (!registered) {
    throw new Error(`Ordrestyring gateway tool is not registered: ${tool.name}`);
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(registered.inputSchema),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const ordrestyringGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `ordrestyringGatewayTools` and deeply frozen. Hosts can use it to build
 * their own permission model without creating a gateway instance.
 */
export const ordrestyringToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

const GATEWAY_TOOL_NAMES: readonly string[] = GATEWAY_TOOLS.map(tool => `${TOOL_PREFIX}${tool.name}`);

function requiredToken(options: OrdrestyringGatewayOptions | undefined): string {
  const value: unknown = options?.apiToken;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(
      'createOrdrestyringGateway requires options.apiToken. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the token; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new GatewayConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/** A caller or request id from the host: redacted before it is cut short, so no part of a token survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiToken` is required and is the only
 * credential the instance uses; a missing or short token fails here.
 */
export function createOrdrestyringGateway(options: OrdrestyringGatewayOptions) {
  let apiToken: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const given: unknown = (options as Partial<OrdrestyringGatewayOptions> | undefined)?.apiToken;
  const secrets = typeof given === 'string' ? [given, given.trim()] : [];
  try {
    // Admission first, before a redactor is built from the token.
    apiToken = requiredToken(options);
    guard = new SecretRedactor().addSecret(apiToken);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the token.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(keyRefusedText(apiToken));
    }
    const gateway = buildOrdrestyringGateway(options, apiToken, guard);
    // The tool list leaves the gateway as it is: a token that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(keyRefusedText(apiToken));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && apiToken !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the token
      // becomes the fixed refusal.
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = keyRefusedText(apiToken);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the token. Then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && apiToken !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(keyRefusedText(apiToken)), ...secrets);
    }
    throw final;
  }
}

function buildOrdrestyringGateway(options: OrdrestyringGatewayOptions, apiToken: string, redactor: SecretRedactor) {
  const { policy: hostPolicy, apiToken: _token, baseUrl, ...clientOptions } = options;
  const policy: ResolvedInstancePolicy | undefined =
    hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, GATEWAY_TOOL_NAMES);
  const client = new OrdrestyringClient({
    ...clientOptions,
    apiToken,
    baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    credentialEnv: {},
    redactor,
  });
  const handlers = registeredTools(client);
  const prepareSecret = randomBytes(32);

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: ordrestyringGatewayTools.filter(tool => !policy?.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // Every call in a scope of its own, with or without a host policy.
      return runInCallScope(
        {
          ...(policy ? { policy } : {}),
          redactor,
          caller: contextValue(context?.caller, redactor),
          requestId: contextValue(context?.requestId, redactor) ?? randomUUID(),
          prepareSecret,
        },
        // A successful result is already redacted as data by normalizeResult, and its JSON text is built from that
        // data: it is not redacted again as text, which could break the JSON. An error result is our own text, and
        // is redacted as a whole.
        () =>
          runCall(toolName, input).then(result => {
            // The failure metadata is checked again after redaction: an id that redaction changed is dropped.
            const final = withFailureInForm(
              result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result,
            );
            // The sink check, as the very last step: a result that holds a piece of the token anywhere, outer fields
            // and the JSON text included, is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = GATEWAY_TOOL_NAMES.includes(name) ? handlers.get(name) : undefined;
      if (!tool) {
        // Redacted before it is cut short: a cut token would no longer match the redactor.
        const shown = redactor.redact(String(toolName)).slice(0, 100);
        await writeAuditEvent({ tool: shown, action: 'rejected', reason: 'unsupported tool' });
        return errorResult(formatUnknownError(`Unsupported Ordrestyring gateway tool: ${shown}`));
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        const short = name.slice(TOOL_PREFIX.length);
        return errorResult(formatUnknownError(`Invalid input for ${short}: ${z.prettifyError(parsed.error)}`));
      }

      return normalizeResult(await tool.handler(parsed.data as Record<string, unknown>), redactor);
    } catch (error) {
      return errorResult(formatUnknownError(error), failureMetadata(error));
    }
  }
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the redactor, and every number or boolean whose string form would
 * be redacted replaced by the string "‹redacted›". Anything nested deeper
 * than MAX_REDACT_DEPTH is replaced, never passed on.
 */
function redactDeep(value: unknown, redactor: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactor.redact(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // The string form of a primitive is checked too; a match becomes the string "‹redacted›", so JSON stays valid.
    const text = String(value);
    if (redactor.redact(text) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactor.redact(key), redactDeep(entry, redactor, depth + 1)]),
  );
}

/** One gateway instance, as returned by createOrdrestyringGateway. */
export type OrdrestyringGateway = ReturnType<typeof createOrdrestyringGateway>;

/**
 * The handler's result as the gateway returns it. The handler's text is
 * never kept: its data is parsed, redacted (values and keys), and only then
 * serialised again, so a token cannot survive in an escaped form.
 */
function normalizeResult(result: unknown, redactor: SecretRedactor): GatewayToolResult {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { content?: unknown }).content)) {
    // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
    return jsonResult('Ordrestyring gateway result.', redactDeep(redactDeep(result, redactor), redactor));
  }

  const content = (result as { content: Array<{ type?: unknown; text?: unknown }> }).content;
  const text = content[0]?.text;
  if (typeof text === 'string') {
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = undefined;
    }
    if (data !== undefined) {
      // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
      const safe = redactDeep(redactDeep(data, redactor), redactor);
      return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], structuredContent: toGatewayJson(safe) };
    }
  }
  // Not JSON: each text redacted on its own.
  return {
    content: content
      .filter((entry): entry is { type: 'text'; text: string } => typeof entry.text === 'string')
      .map(entry => ({ type: 'text' as const, text: redactor.redact(entry.text) })),
  };
}

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
