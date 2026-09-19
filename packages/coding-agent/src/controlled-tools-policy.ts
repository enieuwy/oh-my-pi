import * as fs from "node:fs";
import * as path from "node:path";

export const CONTROLLED_TOOLS_POLICY_VERSION = 1 as const;
export const CONTROLLED_TOOLS_CAPABILITIES = {
	version: 1,
	policy_version: CONTROLLED_TOOLS_POLICY_VERSION,
	subprocess_argv: true,
} as const;

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 256;
const MAX_STRING_BYTES = 4096;
const TOOL_NAME_RE = /^(?:xd:\/\/)?[a-z][a-z0-9_]*$/;
const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_.:-]+$/;
const FORBIDDEN_NATIVE_TOOLS: Record<string, true> = {
	bash: true,
	task: true,
	eval: true,
	browser: true,
	computer: true,
	web_search: true,
};

export interface ControlledToolsPolicy {
	readonly version: 1;
	readonly tools: readonly string[];
	readonly native_tools: readonly string[];
	readonly extensions: readonly string[];
	readonly model: string;
	readonly mcp_servers: readonly string[];
	readonly subprocess_argv: readonly string[];
}

export interface ActiveControlledToolsPolicy {
	readonly path: string;
	readonly bootstrapCwd: string;
	readonly policy: ControlledToolsPolicy;
}

let activePolicy: ActiveControlledToolsPolicy | undefined;

function policyError(message: string): Error {
	return new Error(`Invalid controlled tools policy: ${message}`);
}

function assertClosedObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError("expected a JSON object");
	const record = value as Record<string, unknown>;
	const allowed = new Set(["version", "tools", "native_tools", "extensions", "model", "mcp_servers", "subprocess_argv"]);
	const unknown = Object.keys(record).filter(key => !allowed.has(key));
	if (unknown.length > 0) throw policyError(`unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	for (const key of allowed) {
		if (!Object.hasOwn(record, key)) throw policyError(`missing field: ${key}`);
	}
	return record;
}

function parseStringList(value: unknown, field: string, pattern?: RegExp): string[] {
	if (!Array.isArray(value)) throw policyError(`${field} must be an array`);
	if (value.length > MAX_LIST_ITEMS) throw policyError(`${field} exceeds ${MAX_LIST_ITEMS} entries`);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item.length === 0 || Buffer.byteLength(item) > MAX_STRING_BYTES || item.includes("\0")) {
			throw policyError(`${field} entries must be non-empty bounded strings`);
		}
		if (pattern && !pattern.test(item)) throw policyError(`${field} contains an invalid name: ${item}`);
		if (seen.has(item)) throw policyError(`${field} contains a duplicate: ${item}`);
		seen.add(item);
		result.push(item);
	}
	return result;
}
/** Convert direct and xd:// spellings to one registry name. */
export function canonicalControlledToolName(name: string): string {
	return name.startsWith("xd://") ? name.slice("xd://".length) : name;
}

/** Return the exact canonical registry ceiling for a policy. */
export function controlledPolicyCanonicalToolNames(policy: ControlledToolsPolicy): string[] {
	return policy.tools.map(canonicalControlledToolName);
}


function assertNormalFile(filePath: string, field: string, executable = false): string {
	if (!path.isAbsolute(filePath)) throw policyError(`${field} must be absolute: ${filePath}`);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch (error) {
		throw policyError(`${field} is unavailable: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw policyError(`${field} must name a regular non-symlink file: ${filePath}`);
	if (executable) {
		try {
			fs.accessSync(filePath, fs.constants.X_OK);
		} catch {
			throw policyError(`${field} is not executable: ${filePath}`);
		}
	}
	return filePath;
}

export function parseControlledToolsPolicy(value: unknown): ControlledToolsPolicy {
	const record = assertClosedObject(value);
	if (record.version !== CONTROLLED_TOOLS_POLICY_VERSION) {
		throw policyError(`version must be ${CONTROLLED_TOOLS_POLICY_VERSION}`);
	}
	const tools = parseStringList(record.tools, "tools", TOOL_NAME_RE);
	const canonicalTools = tools.map(canonicalControlledToolName);
	const toolSet = new Set(canonicalTools);
	if (toolSet.size !== tools.length) {
		throw policyError("tools cannot contain direct and xd:// spellings of the same canonical name");
	}
	const nativeTools = parseStringList(record.native_tools, "native_tools", TOOL_NAME_RE);
	for (const name of nativeTools) {
		if (name.startsWith("xd://")) throw policyError(`native_tools must use a direct canonical name: ${name}`);
		if (!toolSet.has(name)) throw policyError(`native_tools must be a subset of tools: ${name}`);
		if (Object.hasOwn(FORBIDDEN_NATIVE_TOOLS, name)) throw policyError(`native_tools cannot contain ${name}`);
	}
	const extensions = parseStringList(record.extensions, "extensions").map(extensionPath =>
		assertNormalFile(extensionPath, "extensions entry"),
	);
	const model = record.model;
	if (
		typeof model !== "string" ||
		model.length === 0 ||
		Buffer.byteLength(model) > MAX_STRING_BYTES ||
		model.includes("\0") ||
		model.indexOf("/") <= 0 ||
		model.endsWith("/") ||
		model.trim() !== model
	) {
		throw policyError("model must be an exact provider/model id");
	}
	const mcpServers = parseStringList(record.mcp_servers, "mcp_servers", MCP_SERVER_NAME_RE);
	const subprocessArgv = parseStringList(record.subprocess_argv, "subprocess_argv");
	if (subprocessArgv.length > 0) assertNormalFile(subprocessArgv[0], "subprocess_argv[0]", true);
	if (nativeTools.includes("lsp") && subprocessArgv.length === 0) {
		throw policyError("native_tools contains lsp but subprocess_argv is empty");
	}
	return Object.freeze({
		version: CONTROLLED_TOOLS_POLICY_VERSION,
		tools: Object.freeze(tools),
		native_tools: Object.freeze(nativeTools),
		extensions: Object.freeze(extensions),
		model,
		mcp_servers: Object.freeze(mcpServers),
		subprocess_argv: Object.freeze(subprocessArgv),
	});
}

export function loadControlledToolsPolicy(policyPath: string): ControlledToolsPolicy {
	if (!path.isAbsolute(policyPath)) throw policyError(`policy path must be absolute: ${policyPath}`);
	const noFollow = fs.constants.O_NOFOLLOW;
	if (typeof noFollow !== "number") throw policyError("this platform cannot reject policy symlinks");
	let fd: number | undefined;
	try {
		fd = fs.openSync(policyPath, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw policyError(`policy must be a regular file: ${policyPath}`);
		if (stat.size > MAX_POLICY_BYTES) throw policyError(`policy exceeds ${MAX_POLICY_BYTES} bytes`);
		const content = fs.readFileSync(fd, "utf8");
		if (Buffer.byteLength(content) > MAX_POLICY_BYTES) throw policyError(`policy exceeds ${MAX_POLICY_BYTES} bytes`);
		return parseControlledToolsPolicy(JSON.parse(content) as unknown);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Invalid controlled tools policy:")) throw error;
		throw policyError(`cannot read ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

const CONTROLLED_STRING_FLAGS = new Set([
	"--controlled-tools-policy",
	"--cwd",
	"--mode",
	"--max-time",
	"--thinking",
	"--service-tier",
	"--system-prompt",
	"--append-system-prompt",
	"--provider-session-id",
	"--prompt-cache-key",
	"--session-dir",
	"--skills",
	"--approval-mode",
]);
const CONTROLLED_BOOLEAN_FLAGS = new Set([
	"--no-session",
	"--no-pty",
	"--hide-thinking",
	"--print",
	"-p",
	"--print-thoughts",
	"--no-title",
	"--auto-approve",
	"--yolo",
	"--no-skills",
]);

function validateControlledArgv(argv: readonly string[]): void {
	let printMode = false;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--") break;
		if (!token.startsWith("-")) {
			if (token === "acp" || token === "launch") throw policyError("controlled mode supports print workers only");
			continue;
		}
		const equals = token.startsWith("--") ? token.indexOf("=") : -1;
		const flag = equals === -1 ? token : token.slice(0, equals);
		if (CONTROLLED_BOOLEAN_FLAGS.has(flag)) {
			if (equals !== -1) throw policyError(`${flag} does not take a value`);
			if (flag === "--print" || flag === "-p") printMode = true;
			continue;
		}
		if (CONTROLLED_STRING_FLAGS.has(flag)) {
			const value = equals !== -1 ? token.slice(equals + 1) : argv[++index];
			if (!value || value.startsWith("--")) throw policyError(`${flag} requires a value`);
			if (flag === "--mode" && value !== "text" && value !== "json") {
				throw policyError("controlled mode supports text/json print workers only");
			}
			continue;
		}
		throw policyError(`flag is not allowed in controlled mode: ${flag}`);
	}
	if (!printMode) throw policyError("controlled mode requires --print");
}

export function activateControlledToolsPolicyFromArgv(
	argv: readonly string[],
	bootstrapCwd: string,
): ActiveControlledToolsPolicy | undefined {
	const matches: Array<{ index: number; path: string }> = [];
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token.startsWith("--controlled-tools-policy=")) {
			throw policyError("--controlled-tools-policy requires a separate path argument");
		}
		if (token !== "--controlled-tools-policy") continue;
		const policyPath = argv[index + 1];
		if (!policyPath || policyPath.startsWith("-")) throw policyError("--controlled-tools-policy requires a path");
		matches.push({ index, path: policyPath });
		index++;
	}
	if (matches.length === 0) return undefined;
	if (matches.length !== 1) throw policyError("--controlled-tools-policy must appear exactly once");
	if (process.env.OMP_PROFILE || process.env.PI_PROFILE) {
		throw policyError("OMP_PROFILE and PI_PROFILE are not allowed in controlled mode");
	}
	validateControlledArgv(argv);
	const match = matches[0];
	const policy = loadControlledToolsPolicy(match.path);
	activePolicy = Object.freeze({ path: match.path, bootstrapCwd: path.resolve(bootstrapCwd), policy });
	return activePolicy;
}

export function getActiveControlledToolsPolicy(): ActiveControlledToolsPolicy | undefined {
	return activePolicy;
}

export function resetControlledToolsPolicyForTests(): void {
	activePolicy = undefined;
}
