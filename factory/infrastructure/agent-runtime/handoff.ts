import { z } from "zod";

export const HANDOFF_TOOL_NAME = "submit_handoff";

export type JsonSchema = Readonly<{
  type?: string;
  properties?: Readonly<Record<string, unknown>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}>;

export interface AgentHandoffDefinition<T> {
  readonly toolName: typeof HANDOFF_TOOL_NAME;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  validate(value: unknown): T;
}

export class MissingAgentHandoffError extends Error {
  constructor() {
    super("agent run ended without an accepted submit_handoff call");
    this.name = "MissingAgentHandoffError";
  }
}

export class AgentHandoffValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHandoffValidationError";
  }
}

export class AgentHandoffTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHandoffTransportError";
  }
}

/** Build the generic runtime contract while leaving the schema and result type owned by the feature. */
export function createAgentHandoff<T>(description: string, schema: z.ZodType<T>): AgentHandoffDefinition<T> {
  const inputSchema = z.toJSONSchema(schema, { target: "draft-07", unrepresentable: "any" }) as JsonSchema;
  return {
    toolName: HANDOFF_TOOL_NAME,
    description,
    inputSchema,
    validate(value: unknown): T {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`}: ${issue.message}`).join("; ");
        throw new AgentHandoffValidationError(`Agent handoff validation failed: ${issues}`, { cause: parsed.error });
      }
      return parsed.data;
    },
  };
}
