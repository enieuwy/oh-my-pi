/**
 * Create the canonical registry name for an MCP tool.
 *
 * Prefixes with the server name to avoid conflicts. If the tool name already
 * starts with the server name, the redundant prefix is removed.
 */
function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Longest tool name strict validators accept. OpenAI Responses/Completions and
 * Meta Responses enforce `^[a-zA-Z0-9_-]{1,64}$`.
 */
const MAX_MCP_TOOL_NAME_LENGTH = 64;
/** Length of the deterministic hash suffix appended when a minted name overflows. */
const MCP_TOOL_NAME_HASH_LENGTH = 8;

/**
 * Cap a minted MCP tool name while preserving a readable prefix and a stable
 * hash suffix. The fixed hash seed keeps the registry name stable across runs.
 */
function capMCPToolNameLength(name: string): string {
	if (name.length <= MAX_MCP_TOOL_NAME_LENGTH) return name;
	const hash = Bun.hash(name).toString(36).slice(0, MCP_TOOL_NAME_HASH_LENGTH);
	const keep = MAX_MCP_TOOL_NAME_LENGTH - hash.length - 1;
	return `${name.slice(0, keep)}_${hash}`;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");
	const prefixWithUnderscore = `${sanitizedServerName}_`;
	const normalizedToolName = sanitizedToolName.startsWith(prefixWithUnderscore)
		? sanitizedToolName.slice(prefixWithUnderscore.length)
		: sanitizedToolName;

	return capMCPToolNameLength(`mcp__${sanitizedServerName}_${normalizedToolName}`);
}
