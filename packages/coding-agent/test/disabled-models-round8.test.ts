import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { createStrictCompletionProbe } from "../src/cli/auth-gateway-cli";
import { Settings } from "../src/config/settings";
import type { ModelRegistry } from "../src/config/model-registry";
import { generateTextReviewContextSummary } from "../src/extensibility/custom-commands/bundled/annotate/text-summary";
import { createExtensionModelQuery } from "../src/extensibility/extensions/model-api";
import { createSetupHost } from "../src/modes/setup";
import type { InteractiveModeContext } from "../src/modes/types";

/** An aborted signal makes the probe report the first candidate it would try, with no network. */
async function firstProbeModel(settings: Settings): Promise<{ ok: boolean | null; modelId?: string; reason?: string }> {
	const controller = new AbortController();
	controller.abort();
	return createStrictCompletionProbe(settings)({
		provider: "openai",
		credentialId: 1,
		credential: { type: "api_key", apiKey: "k" },
		signal: controller.signal,
	} as never);
}

describe("round 8: strict credential probe honours disabledModels", () => {
	it("filters denied models before the candidate limit", async () => {
		const denied: string[] = [];
		for (let i = 0; i < 4; i++) {
			const result = await firstProbeModel(Settings.isolated({ disabledModels: denied.map(id => `openai/${id}`) }));
			expect(result.modelId).toBeDefined();
			expect(denied).not.toContain(result.modelId!);
			denied.push(result.modelId!);
		}
		// Four candidates are denied; an allowed fifth still fills the limit.
		const next = await firstProbeModel(Settings.isolated({ disabledModels: denied.map(id => `openai/${id}`) }));
		expect(next.ok).toBe(false);
		expect(next.reason).toBe("aborted");
		expect(denied).not.toContain(next.modelId!);
	});

	it("reports a skipped check when every candidate is denied", async () => {
		const result = await firstProbeModel(Settings.isolated({ disabledModels: ["openai/*"] }));
		expect(result.ok).toBeNull();
		expect(result.reason).toContain("disabledModels");
	});
});

describe("round 8: model listings honour disabledModels", () => {
	const models = getBundledModels("openai").slice(0, 3) as Model<Api>[];
	const rule = `${models[0].provider}/${models[0].id}`;
	const settings = Settings.isolated({ disabledModels: [rule] });

	it("extension ctx.models.list omits denied models", () => {
		const registry = { getAvailable: () => models } as unknown as ModelRegistry;
		const query = createExtensionModelQuery(registry, settings, () => undefined);
		expect(query.list().map(m => m.id)).toEqual(models.slice(1).map(m => m.id));
	});

	it("setup model browser omits denied models", () => {
		const ctx = {
			settings,
			session: {
				modelRegistry: { getAvailable: () => models, getAll: () => models },
				model: undefined,
				effectiveServiceTier: () => undefined,
			},
		} as unknown as InteractiveModeContext;
		const { available, all } = createSetupHost(ctx).getModels();
		expect(available.map(m => m.id)).toEqual(models.slice(1).map(m => m.id));
		expect(all.map(m => m.id)).toEqual(models.slice(1).map(m => m.id));
	});
});

describe("round 8: annotate summary honours disabledModels", () => {
	it("refuses a denied session model with the rule diagnostic before any request", async () => {
		const model = getBundledModels("openai")[0] as Model<Api>;
		const notices: Array<[string, string | undefined]> = [];
		const ctx = {
			model,
			settings: Settings.isolated({ disabledModels: [`${model.provider}/${model.id}`] }),
			modelRegistry: {
				resolver: () => {
					throw new Error("credential resolved for a denied model");
				},
			},
			sessionManager: { getSessionId: () => "s" },
			ui: { notify: (message: string, type?: string) => notices.push([message, type]) },
		} as unknown as Parameters<typeof generateTextReviewContextSummary>[0];

		expect(await generateTextReviewContextSummary(ctx, "source")).toBeUndefined();
		expect(notices).toEqual([
			[
				`Model "${model.provider}/${model.id}" is disabled by disabledModels rule "${model.provider}/${model.id}". Remove or narrow that rule to use it.`,
				"error",
			],
		]);
	});
});
