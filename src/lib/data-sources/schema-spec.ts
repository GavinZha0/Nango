/**
 * Data Source — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Data Source module.
 */

export const DATASOURCE_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "datasource",
  description:
    "DataSource Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 63,
      description:
        "Unique database identifier matching /^[a-z][a-z0-9_-]{0,62}$/ (e.g. 'analytics_prod', 'sales_db')",
    },
    description: {
      type: "string",
      editable: true,
      description:
        "Description injected into agent system prompt explaining schema contents, business domain, and query guidelines",
    },
    provider: {
      type: "string",
      enum: ["postgres", "mysql", "mariadb", "vertica"],
      editable: true,
      description: "Database engine dialect",
    },
    credentialId: {
      type: "string",
      editable: true,
      description:
        "UUID of the bound credential storing username and password",
    },
    host: {
      type: "string",
      editable: true,
      description: "Database server hostname or IP address",
    },
    port: {
      type: "integer",
      editable: true,
      minimum: 1,
      maximum: 65535,
      description:
        "Connection port (e.g. 5432 for PostgreSQL, 3306 for MySQL)",
    },
    database: {
      type: "string",
      editable: true,
      description: "Target database or catalog name",
    },
    params: {
      type: "object",
      editable: true,
      description:
        "Key-value map of extra connection parameters (e.g. {'sslmode': 'require', 'connectTimeout': '10'})",
    },
    readOnly: {
      type: "boolean",
      editable: true,
      description:
        "When true, enforces read-only access via SQL statement analysis and transaction constraints (default: true)",
    },
    tableAllowlist: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of permitted table names (null or empty array allows all tables)",
    },
    tableDenylist: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of denied table names (takes precedence over allowlist)",
    },
  },
  required: ["name", "provider", "credentialId", "host", "port", "database"],
} as const;
