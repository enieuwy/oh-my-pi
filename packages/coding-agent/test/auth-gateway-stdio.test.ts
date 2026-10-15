import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	createStdioGatewayRouter,
	createStdioRoute,
	selectorCandidates,
} from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const fast = getBundledModel("google", "gemini-3.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-3.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	it("answers a denied selector with a 403 disabledModels refusal, not a 404 unknown model", async () => {
		const settings = Settings.isolated({ disabledModels: [key(mini)] });
		const storage = createInMemoryAuthStorage();
		try {
			const routed = new Map<string, Model<Api>>();
			const router = createStdioGatewayRouter(storage, registry, settings, routed);
			const route = createStdioRoute(router, routed, settings, registry);
			const post = (model: string) =>
				route(
					new Request("http://stdio/v1/chat/completions", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
					}),
				);
			const denied = await post(key(mini));
			expect(denied.status).toBe(403);
			expect(JSON.stringify(await denied.json())).toContain("is disabled by disabledModels rule");
			expect((await post("@commit")).status).toBe(404);
			router.close();
		} finally {
			storage.close();
		}
	});

	it("refuses a request whose routing options name a denied catalog identity", async () => {
		const variantModel = getBundledModel("openrouter", "openai/gpt-4o");
		if (!variantModel) throw new Error("bundled model missing");
		const storage = createInMemoryAuthStorage();
		try {
			const settings = Settings.isolated({ disabledModels: ["openrouter/openai/gpt-4o:floor"] });
			const routed = new Map([[key(variantModel), variantModel]]);
			const router = createStdioGatewayRouter(storage, registry, settings, routed);
			const post = (options: Record<string, unknown>) =>
				router.route(
					new Request("http://stdio/v1/pi/stream", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							modelId: key(variantModel),
							context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
							options,
							stream: false,
						}),
					}),
					"stdio",
				);
			const refused = await post({ openrouterVariant: "floor" });
			expect(refused.status).toBe(403);
			expect(JSON.stringify(await refused.json())).toContain("is disabled by disabledModels rule");
			router.close();
		} finally {
			storage.close();
		}
	});
});
