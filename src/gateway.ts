import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { formatUnknownError, MAX_REDACT_DEPTH, MIN_SECRET_LENGTH } from './errors.js';
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

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
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
    name: 'create_customer',
    title: 'Create Ordrestyring customer',
    description: 'Create an operational customer in Ordrestyring when writes and policy explicitly allow it.',
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
  // The redactor only protects secrets of MIN_SECRET_LENGTH characters or more; a shorter token could reach an error
  // or an audit record as it is. Refuse it instead of using it unprotected.
  if (value.trim().length < MIN_SECRET_LENGTH) {
    throw new GatewayConfigError(
      `createOrdrestyringGateway requires an apiToken of at least ${MIN_SECRET_LENGTH} characters.`,
    );
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
  const apiToken = requiredToken(options);
  const { policy: hostPolicy, apiToken: _token, baseUrl, ...clientOptions } = options;
  // The redactor comes first: every error from here on, also one about the options, is redacted with it before it
  // is cut short or thrown.
  const redactor = new SecretRedactor().addSecret(apiToken);
  let policy: ResolvedInstancePolicy | undefined;
  let client: OrdrestyringClient;
  try {
    policy = hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, GATEWAY_TOOL_NAMES);
    client = new OrdrestyringClient({
      ...clientOptions,
      apiToken,
      baseUrl: baseUrl ?? DEFAULT_BASE_URL,
      credentialEnv: {},
      redactor,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // This server's messages quote no configuration value; redacted all the same, and never cut.
    throw new GatewayConfigError(redactor.redact(message));
  }
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
        // The whole result, text and data (keys included, numbers by their string form), with this instance's token
        // redacted: upstream data can echo it, and so can an error. normalizeResult has already rebuilt a JSON text
        // from redacted data, so this pass finds nothing in it to break.
        () => runCall(toolName, input).then(result => redactDeep(result, redactor) as GatewayToolResult),
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
      return errorResult(formatUnknownError(error));
    }
  }
}

/**
 * A copy of a JSON value with every string, object keys included, passed
 * through the redactor, and every number or boolean whose string form would
 * be redacted replaced by the string "[REDACTED]". Anything nested deeper
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
    // The string form of a primitive is checked too; a match becomes the string "[REDACTED]", so JSON stays valid.
    const text = String(value);
    if (redactor.redact(text) !== text) return '[REDACTED]';
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
    return jsonResult('Ordrestyring gateway result.', redactDeep(result, redactor));
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
      const safe = redactDeep(data, redactor);
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

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: toGatewayJson(structuredContent),
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
