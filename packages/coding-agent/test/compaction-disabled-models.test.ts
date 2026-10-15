/**
 * Contract (`disabledModels`, rules match catalog identities only): the native
 * compaction request names `remoteCompaction.model` in place of the model id, so a
 * denied replacement is never requested natively; and automatic compaction
 * sends its summary requests through the session-aware transport like manual does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getTestModel } from "./helpers/model-fixtures";
import { assistantMsg, userMsg } from "./utilities";

describe("compaction under disabledModels", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let dispatched: string[];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compaction-disabled-");
		dispatched = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(
		remoteCompactionModel: string | undefined,
		disabledModels: string[],
		methodOrder: Array<"remote" | "soft"> = ["remote"],
	) {
		const base = getTestModel(
			"openai",
			model =>
				model.api === "openai-responses" &&
				model.input.includes("text") &&
				(model.contextWindow ?? 0) > 0 &&
				compactionModule.shouldUseProviderNativeCompaction(model, {
					remoteEnabled: true,
					remoteStreamingV2Enabled: true,
				}),
		);
		const currentModel = {
			...base,
			remoteCompaction: {
				...base.remoteCompaction,
				...(remoteCompactionModel ? { model: remoteCompactionModel } : {}),
			},
		};
		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": methodOrder,
			"contextPromotion.enabled": false,
			disabledModels,
		});
		settings.setModelRole("smol", `${currentModel.provider}/${currentModel.id}`);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "openai-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			sideStreamFn: createSettingsAwareStreamFn(settings, model => {
				dispatched.push(`${model.provider}/${model.id}`);
				throw new Error("network is disabled in this test");
			}),
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const triggerAutoCompaction = async (): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") resolve();
			});
			const contextWindow = currentModel.contextWindow;
			if (!contextWindow) throw new Error("Expected current model context window");
			const assistant = {
				...assistantMsg("threshold reached"),
				api: currentModel.api,
				provider: currentModel.provider,
				model: currentModel.id,
				usage: {
					input: contextWindow,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: contextWindow + 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
			await promise;
			await session.waitForIdle();
		};
		return { currentModel, triggerAutoCompaction };
	}

	function spyOnCompact() {
		const calls: Array<{ remoteEnabled: boolean | undefined; completeImpl: unknown }> = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, _model, _key, _i, _s, options) => {
			calls.push({ remoteEnabled: preparation.settings.remoteEnabled, completeImpl: options?.completeImpl });
			return {
				summary: "summary",
				shortSummary: "summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});
		return calls;
	}

	it("does not request natively a denied remoteCompaction.model (manual)", async () => {
		await createSession("denied-replacement", ["openai/denied-replacement"]);
		const calls = spyOnCompact();

		await session.compact();

		expect(calls.map(call => call.remoteEnabled)).toEqual([false]);
	});

	it("does not request natively a denied remoteCompaction.model (automatic)", async () => {
		const { triggerAutoCompaction } = await createSession("denied-replacement", ["openai/denied-replacement"]);
		const calls = spyOnCompact();

		await triggerAutoCompaction();

		expect(calls.map(call => call.remoteEnabled)).toEqual([false]);
	});

	it("keeps native compaction for an allowed remoteCompaction.model", async () => {
		await createSession("allowed-replacement", ["openai/some-other-model"]);
		const calls = spyOnCompact();

		await session.compact();

		expect(calls.map(call => call.remoteEnabled)).toEqual([true]);
	});

	it("never selects a denied compaction candidate, so no credential lookup or request happens for it", async () => {
		await createSession(undefined, ["openai/*"]);
		const calls = spyOnCompact();
		const keyLookups = vi.spyOn(session.modelRegistry, "getApiKey");

		await session.compact().catch(() => undefined);

		expect(calls).toEqual([]);
		expect(keyLookups).not.toHaveBeenCalled();
	});

	it("scans past a session-denied largest-context model to an allowed one when the preferred model is denied", async () => {
		const { currentModel } = await createSession(undefined, ["openai/*", "anthropic/denied-largest"], ["soft"]);
		const contextWindow = currentModel.contextWindow ?? 100_000;
		const denied: Model = {
			...currentModel,
			provider: "anthropic",
			id: "denied-largest",
			contextWindow: contextWindow * 4,
		};
		const allowed: Model = {
			...currentModel,
			provider: "google",
			id: "allowed-middle",
			contextWindow: contextWindow * 2,
		};
		// The registry's own settings are broader (no rules), so it still lists the denied models.
		vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([denied, allowed, currentModel]);
		const compacted: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			compacted.push(`${model.provider}/${model.id}`);
			return {
				summary: "summary",
				shortSummary: "summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await session.compact();

		expect(compacted).toEqual(["google/allowed-middle"]);
	});

	it("sends automatic compaction requests through the session-aware transport", async () => {
		const { currentModel, triggerAutoCompaction } = await createSession(undefined, ["anthropic/claude-*"]);
		const calls = spyOnCompact();

		await triggerAutoCompaction();

		const completeImpl = calls[0]?.completeImpl as
			| ((model: Model, context: never, options: never) => Promise<unknown>)
			| undefined;
		expect(completeImpl).toBeDefined();
		const denied = getTestModel("anthropic", model => model.api === "anthropic-messages");
		await expect(completeImpl!(denied, { messages: [] } as never, {} as never)).rejects.toThrow(
			'disabledModels rule "anthropic/claude-*"',
		);
		expect(dispatched).toEqual([]);
		// Control: an allowed model reaches the base transport through the same wrapper.
		await expect(completeImpl!(currentModel, { messages: [] } as never, {} as never)).rejects.toThrow(
			"network is disabled",
		);
		expect(dispatched).toEqual([`${currentModel.provider}/${currentModel.id}`]);
	});
});
