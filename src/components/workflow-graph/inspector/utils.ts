/**
 * InspectorDrawer Utilities & Helper Functions
 */

export function buildToolNodeInputSchema(
  toolName: string,
  rawSchema?: Record<string, unknown>,
  serverVersion?: string,
): Record<string, unknown> {
  const argsSchema =
    rawSchema &&
    typeof rawSchema === "object" &&
    rawSchema.properties &&
    (rawSchema.properties as Record<string, unknown>).arguments
      ? (rawSchema.properties as Record<string, unknown>).arguments
      : rawSchema ?? { type: "object", properties: {}, additionalProperties: true };

  return {
    type: "object",
    required: ["name", "arguments"],
    properties: {
      name: { const: toolName },
      arguments: argsSchema,
    },
    ...(serverVersion && { server_version: serverVersion }),
  };
}
