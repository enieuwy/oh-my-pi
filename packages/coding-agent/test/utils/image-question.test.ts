import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveImageQuestionModel } from "@oh-my-pi/pi-coding-agent/utils/image-question";

function makeProxyModel(id: string, compat?: ModelSpec["compat"]): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "myproxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat,
	} as ModelSpec);
}

function makeSession(active: Model<Api>, available: Model<Api>[]): ToolSession {
	return {
		settings: Settings.isolated(),
		modelRegistry: {
			getAvailable: () => available,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
		getModelString: () => `${active.provider}/${active.id}`,
		getActiveModelString: () => `${active.provider}/${active.id}`,
	} as unknown as ToolSession;
}

describe("resolveImageQuestionModel wire truth (#9697)", () => {
	it("skips a wire-stripped model that declares image input", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		const vision = makeProxyModel("qwen-vl", { stripImageInput: false });
		const resolved = resolveImageQuestionModel(makeSession(stripped, [stripped, vision]));
		expect(resolved.model.id).toBe("qwen-vl");
	});

	it("throws instead of returning the stripped model when nothing else can see", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		expect(() => resolveImageQuestionModel(makeSession(stripped, [stripped]))).toThrow(
			"Resolved model myproxy/deepseek-v4-flash does not support image input.",
		);
	});
});

describe("resolveImageQuestionModel with disabledModels", () => {
	const vision = makeProxyModel("qwen-vl");
	const denied = makeProxyModel("blocked-vl");
	const sessionWith = (roles: Record<string, string>) => {
		const session = makeSession(vision, [vision, denied]);
		return {
			...session,
			settings: Settings.isolated({ disabledModels: ["myproxy/blocked-vl"], modelRoles: roles }),
		} as ToolSession;
	};

	it("serves an allowed vision role even when the default role is denied", () => {
		const resolved = resolveImageQuestionModel(
			sessionWith({ vision: "myproxy/qwen-vl", default: "myproxy/blocked-vl" }),
		);
		expect(resolved.model.id).toBe("qwen-vl");
	});

	it("refuses a denied vision role, naming the rule, instead of using another model", () => {
		expect(() => resolveImageQuestionModel(sessionWith({ vision: "myproxy/blocked-vl" }))).toThrow(
			'Model "myproxy/blocked-vl" is disabled by disabledModels rule "myproxy/blocked-vl". Remove or narrow that rule to use it.',
		);
	});

	it("refuses the denied default role when the configured vision role is unavailable", () => {
		expect(() =>
			resolveImageQuestionModel(sessionWith({ vision: "myproxy/not-installed", default: "myproxy/blocked-vl" })),
		).toThrow(
			'Model "myproxy/blocked-vl" is disabled by disabledModels rule "myproxy/blocked-vl". Remove or narrow that rule to use it.',
		);
	});
});
