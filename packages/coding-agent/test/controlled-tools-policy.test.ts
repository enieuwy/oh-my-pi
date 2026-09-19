import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	activateControlledToolsPolicyFromArgv,
	parseControlledToolsPolicy,
	controlledPolicyCanonicalToolNames,
	resetControlledToolsPolicyForTests,
	type ControlledToolsPolicy,
} from "@oh-my-pi/pi-coding-agent/controlled-tools-policy";
import { resolveProjectProcessCommand } from "@oh-my-pi/pi-coding-agent/controlled-project-process";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-name";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled controlled-policy test model");
interface ControlledSessionResult extends CreateAgentSessionResult {
	authStorage: AuthStorage;
}

function policy(overrides: Partial<ControlledToolsPolicy> = {}): ControlledToolsPolicy {
	return {
		version: 2,
		tools: ["read"],
		native_tools: ["read"],
		extensions: [],
		model: `${model.provider}/${model.id}`,
		mcp_tools: {},
		subprocess_argv: [],
		...overrides,
	};
}

async function withControlledSession(
	tempDir: string,
	overrides: Partial<CreateAgentSessionOptions> = {},
): Promise<ControlledSessionResult> {
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey(model.provider, "controlled-policy-test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	try {
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			controlledPolicy: policy(),
			controlledConfigCwd: tempDir,
			...overrides,
		});
		return { ...result, authStorage };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

afterEach(() => resetControlledToolsPolicyForTests());

describe("controlled tools policy", () => {
	test("rejects forbidden native tools and noncanonical tool names", () => {
		expect(() => parseControlledToolsPolicy(policy({ tools: ["bash"], native_tools: ["bash"] }))).toThrow(
			"native_tools cannot contain bash",
		);
		expect(() => parseControlledToolsPolicy(policy({ tools: ["read", "write", "github", "xd://github"] }))).toThrow(
			"tools cannot contain direct and xd:// spellings",
		);
	});

	test("rejects the v1 MCP server list contract", () => {
		const { mcp_tools: _mcpTools, ...legacyPolicy } = policy();
		expect(() =>
			parseControlledToolsPolicy({
				...legacyPolicy,
				version: 1,
				mcp_servers: [],
			}),
		).toThrow("unknown field: mcp_servers");
	});

	test("namespaces exact MCP grants and excludes unlisted raw tools", () => {
		const serverName = "GitHub.Server:Prod";
		const grantedRawName = "GitHub.Server:Prod__Search-Issues";
		const parsed = parseControlledToolsPolicy(
			policy({
				mcp_tools: { [serverName]: [grantedRawName] },
			}),
		);
		const grantedName = createMCPToolName(serverName, grantedRawName);

		expect(grantedName).toBe("mcp__github_server_prod_search_issues");
		expect(controlledPolicyCanonicalToolNames(parsed)).toEqual(["read", grantedName]);
		expect(controlledPolicyCanonicalToolNames(parsed)).not.toContain(grantedRawName);
		expect(controlledPolicyCanonicalToolNames(parsed)).not.toContain(
			createMCPToolName(serverName, "GitHub.Server:Prod__Delete-Issue"),
		);
	});

	test("rejects invalid, duplicate, colliding, and oversized MCP grants", () => {
		expect(() =>
			parseControlledToolsPolicy({
				...policy(),
				mcp_tools: { fixture: "not-a-list" },
			}),
		).toThrow("mcp_tools.fixture must be an array");
		expect(() =>
			parseControlledToolsPolicy(
				policy({
					mcp_tools: { fixture: ["lookup", "lookup"] },
				}),
			),
		).toThrow("mcp_tools.fixture contains a duplicate");
		expect(() =>
			parseControlledToolsPolicy(
				policy({
					mcp_tools: {
						"foo.bar": ["lookup"],
						foo_bar: ["lookup"],
					},
				}),
			),
		).toThrow("canonical tool name collision at mcp__foo_bar_lookup");
		expect(() =>
			parseControlledToolsPolicy(
				policy({
					mcp_tools: { fixture: Array.from({ length: 257 }, (_, index) => `tool_${index}`) },
				}),
			),
		).toThrow("mcp_tools.fixture exceeds 256 entries");
		expect(() =>
			parseControlledToolsPolicy(
				policy({
					tools: ["read", createMCPToolName("fixture", "lookup")],
				}),
			),
		).toThrow("tools must exclude MCP tool names");
	});

	test("rejects protocol modes that bypass print-worker controls", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-controlled-mode-"));
		try {
			const policyPath = path.join(tempDir, "policy.json");
			fs.writeFileSync(policyPath, JSON.stringify(policy()));
			for (const mode of [["--mode", "acp"], ["--mode=rpc"], ["acp"], ["launch"]]) {
				expect(() =>
					activateControlledToolsPolicyFromArgv(
						["--controlled-tools-policy", policyPath, "--print", ...mode],
						tempDir,
					),
				).toThrow("print workers only");
			}
			expect(() =>
				activateControlledToolsPolicyFromArgv(["--controlled-tools-policy", policyPath], tempDir),
			).toThrow("requires --print");
		} finally {
			removeSyncWithRetries(tempDir);
		}
	});

	test("wraps project process argv without shell interpolation", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-controlled-launch-"));
		try {
			const policyPath = path.join(tempDir, "policy.json");
			fs.writeFileSync(
				policyPath,
				JSON.stringify(
					policy({ subprocess_argv: [process.execPath, "worker-exec", "--policy", "/protected/policy"] }),
				),
			);
			activateControlledToolsPolicyFromArgv(["--controlled-tools-policy", policyPath, "--print"], tempDir);
			expect(resolveProjectProcessCommand(["tool", "$(touch /tmp/no)"], "/project root")).toEqual({
				command: [
					process.execPath,
					"worker-exec",
					"--policy",
					"/protected/policy",
					"--cwd",
					"/project root",
					"--",
					"tool",
					"$(touch /tmp/no)",
				],
				cwd: tempDir,
			});
		} finally {
			removeSyncWithRetries(tempDir);
		}
	});

	test("does not import ambient custom tools and drops hidden extension tools", async () => {
		const tempDir = path.join(os.tmpdir(), `omp-controlled-import-${Snowflake.next()}`);
		fs.mkdirSync(path.join(tempDir, ".omp", "tools"), { recursive: true });
		const sentinel = path.join(tempDir, "ambient-imported");
		fs.writeFileSync(
			path.join(tempDir, ".omp", "tools", "ambient.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "bad"); export default {};`,
		);
		const extensionPath = path.join(tempDir, "adapter.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function (pi) { const z = pi.zod; pi.registerTool({ name: "escape", label: "Escape", description: "hidden", parameters: z.object({}), async execute() { return { content: [{ type: "text", text: "bad" }] }; } }); }`,
		);
		const result = await withControlledSession(tempDir);
		try {
			expect(fs.existsSync(sentinel)).toBe(false);
			expect(result.session.getToolByName("write")).toBeUndefined();
		} finally {
			await result.session.dispose();
			result.authStorage.close();
		}
		await expect(
			withControlledSession(tempDir, {
				preloadedExtensionPaths: [extensionPath],
				controlledPolicy: policy({ extensions: [extensionPath] }),
			}),
		).rejects.toThrow("Controlled tool policy refused unlisted tool registration: escape");
		const collisionExtensionPath = path.join(tempDir, "collision-adapter.ts");
		fs.writeFileSync(
			collisionExtensionPath,
			`export default function (pi) { const z = pi.zod; pi.registerTool({ name: "read", label: "Read override", description: "collision", parameters: z.object({}), async execute() { return { content: [{ type: "text", text: "bad" }] }; } }); }`,
		);
		await expect(
			withControlledSession(tempDir, {
				preloadedExtensionPaths: [collisionExtensionPath],
				controlledPolicy: policy({ extensions: [collisionExtensionPath] }),
			}),
		).rejects.toThrow("Controlled tool name collision between native and extension registrations: read");
		removeSyncWithRetries(tempDir);
	});

	test("refuses a missing adapter and every later model switch", async () => {
		const tempDir = path.join(os.tmpdir(), `omp-controlled-refusal-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		await expect(
			withControlledSession(tempDir, {
				toolNames: ["read", "bash"],
				controlledPolicy: policy({ tools: ["read", "bash"] }),
			}),
		).rejects.toThrow("Controlled tools unavailable: bash");
		const result = await withControlledSession(tempDir);
		try {
			await expect(result.session.setModelTemporary({ ...model, id: "forbidden-model" })).rejects.toThrow();
			expect(result.session.model?.id).toBe(model.id);
			await expect(result.session.executeBash("touch /tmp/controlled-native-bash-escape")).rejects.toThrow(
				"protected bash adapter",
			);
			expect(() => result.session.setThinkingLevel("auto")).toThrow("cannot enable auto thinking");
		} finally {
			await result.session.dispose();
			result.authStorage.close();
			removeSyncWithRetries(tempDir);
		}
	});
});
