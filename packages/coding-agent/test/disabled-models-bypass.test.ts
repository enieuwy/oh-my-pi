import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as transcription from "@oh-my-pi/pi-ai/transcription";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgDisabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildModelSelectorCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { ttsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { generateTitleOnline } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { logger } from "@oh-my-pi/pi-utils";

function listed(id: string, provider = "a"): Model {
	return buildModel({
		provider,
		id,
		name: id.toUpperCase(),
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("live disabledModels: automatic transports re-check the denylist at the point of use", () => {
	it("title generation skips a candidate denied after selection, before any credential lookup", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const rule = `${model.provider}/${model.id}`;
		const settings = Settings.isolated({ modelRoles: { tiny: rule } });
		const getApiKey = vi.fn(async () => "key");
		const registry = {
			getAvailable: () => [model],
			getApiKey,
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "key",
		} as never;
		const complete = vi.spyOn(ai, "completeSimple");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// The denylist changes after the candidate list is built, as a live settings edit would.
		const debug = vi.spyOn(logger, "debug").mockImplementation(message => {
			if (message === "title-generator: start") cfgDisabledModels.set(settings, [rule]);
		});

		expect(await generateTitleOnline("Investigate the resolver", registry, settings, "s1", model)).toBeNull();

		expect(debug).toHaveBeenCalled();
		expect(getApiKey).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
		expect(warn.mock.calls.some(([message]) => String(message).includes(`disabledModels rule "${rule}"`))).toBe(true);
	});

	it("title generation sends no retry to a candidate denied after its first transient failure", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const rule = `${model.provider}/${model.id}`;
		const settings = Settings.isolated({ modelRoles: { tiny: rule } });
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "key",
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "key",
		} as never;
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// The first request fails transiently; the deny lands before the retry.
		const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			cfgDisabledModels.set(settings, [rule]);
			throw Object.assign(new Error("503 service unavailable"), { status: 503 });
		});

		expect(await generateTitleOnline("Investigate the resolver", registry, settings, "s1", model)).toBeNull();

		expect(complete).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls.some(call => JSON.stringify(call).includes(`disabledModels rule \\"${rule}\\"`))).toBe(
			true,
		);
	});

	describe("buffered cloud dictation", () => {
		it("refuses a model denied while recording: no audio sent, warning shown, cleanup finished", async () => {
			const model = getBundledModel("openai", "whisper-1") as Model;
			const rule = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({ modelRoles: { dictation: rule } });
			const resolver = vi.fn(() => vi.fn().mockResolvedValue("cloud-key"));
			const registry = { getError: () => undefined, getAvailable: () => [model], getAll: () => [model], resolver };
			const transcribe = vi.spyOn(transcription, "transcribeAudio");
			const stopCapture = vi.fn();
			const controller = new STTController(() => ({ stop: stopCapture }), { settings, registry });
			const editor = {
				insertText: vi.fn(),
				setVolatileText: vi.fn(),
				clearVolatileText: vi.fn(),
				commitVolatileText: vi.fn(),
				submit: vi.fn(),
				deleteBeforeCursor: vi.fn(),
			};
			const options = { showWarning: vi.fn(), showStatus: vi.fn(), onStateChange: vi.fn() };
			try {
				await controller.toggle(editor, options);
				expect(controller.state).toBe("recording");
				cfgDisabledModels.set(settings, [rule]);
				await controller.toggle(editor, options);

				expect(transcribe).not.toHaveBeenCalled();
				expect(resolver).not.toHaveBeenCalled();
				expect(stopCapture).toHaveBeenCalledTimes(1);
				expect(options.showWarning).toHaveBeenCalledWith(expect.stringContaining(`disabledModels rule "${rule}"`));
				expect(controller.state).toBe("idle");
			} finally {
				controller.dispose();
			}
		});
	});

	describe("speech fallback loop", () => {
		let authStorage: AuthStorage;
		let tempDir: string;

		beforeEach(async () => {
			authStorage = await AuthStorage.create(":memory:");
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tts-denied-"));
		});

		afterEach(() => {
			authStorage.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("skips a fallback candidate denied after the first one failed and keeps the rule in the diagnostic", async () => {
			await authStorage.credentials.set("xai", [{ type: "api_key", key: "xai-test-key" }]);
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
			const synthesize = spyOn(ttsClient, "synthesize").mockResolvedValue({
				pcm: new Float32Array([0]),
				sampleRate: 24_000,
			});
			// The cloud candidate fails; meanwhile the local fallback becomes denied.
			const fetchImpl: FetchImpl = async () => {
				cfgDisabledModels.set(settings, ["local/kokoro"]);
				return new Response("rate limited", { status: 429 });
			};
			const ctx: CustomToolContext = {
				sessionManager: SessionManager.create(tempDir, tempDir),
				modelRegistry: registry,
				model: undefined,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort() {},
				settings,
				fetch: fetchImpl,
			};

			const result = await ttsTool.execute(
				"tts-denied",
				{ text: "Fall back", language: "en", output_path: "voice.mp3" },
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(synthesize).not.toHaveBeenCalled();
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
			expect(text).toContain('disabledModels rule "local/kokoro"');
		});
	});
});

describe("disabledModels: offers exclude denied models", () => {
	const allowed = listed("x");
	const denied = listed("y", "b");
	const rule = "b/y";

	it("mention lookup refuses a denied selector without storing a pseudonym", async () => {
		const auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth, "/nonexistent/disabled-mentions/models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue([allowed, denied]);
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: allowed, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false, disabledModels: [rule] }),
		});
		try {
			expect(session.findMentionableModel("a/x")).toBe(allowed);
			expect(session.findMentionableModel(rule)).toBeUndefined();
			await session.prompt("ask ^b/y");
			expect(session.modelMentions).toEqual([]);
			expect(sessionManager.getBranch().some(entry => JSON.stringify(entry).includes('"selector":"b/y"'))).toBe(
				false,
			);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("slash-command model completion omits denied models", () => {
		const settings = Settings.isolated({ disabledModels: [rule] });
		const runtime = {
			ctx: {
				settings,
				session: {
					modelRegistry: { getError: () => undefined, getAvailable: () => [allowed, denied], getAll: () => [] },
					scopedModels: [],
					effectiveServiceTier: () => undefined,
				},
			},
		} as never;
		const items = buildModelSelectorCompletions(runtime)("") ?? [];
		expect(items.map(item => item.label)).toContain("a/x");
		expect(items.map(item => item.label)).not.toContain(rule);
	});

	it("agents hub model list omits denied models", () => {
		const settings = Settings.isolated({ disabledModels: [rule] });
		const registry = { getAvailable: () => [allowed, denied] } as unknown as ModelRegistry;
		const deps = createAgentsHubDeps(process.cwd(), settings, registry, () => ({}) as never);
		expect(deps.getAvailableModels().map(model => `${model.provider}/${model.id}`)).toEqual(["a/x"]);
	});
});
