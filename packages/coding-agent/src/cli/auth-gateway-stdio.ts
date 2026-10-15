/**
 * `omp auth-gateway stdio`: the gateway's routes as JSON lines on stdin and
 * stdout (`serveAuthGatewayStdio`), for a parent process that wants omp's
 * inference without an HTTP listener or a bearer token.
 *
 * Unlike `serve` it runs on this omp's own credentials (the broker when one is
 * configured, else the local store), models (`models.yml` and extension
 * providers included) and settings. A request's `model` is an omp model
 * selector, as `--model` takes it ({@link selectorCandidates}); an attempt
 * that fails before its reply starts moves on to the next candidate. Serving
 * ends when stdin does.
 */
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { type AuthGatewayRouter, createAuthGatewayRouter, serveAuthGatewayStdio } from "@oh-my-pi/pi-ai/auth-gateway";
import { getProjectDir, isRecord, logger, postmortem, VERSION } from "@oh-my-pi/pi-utils";
import { formatDisabledModelError } from "../config/disabled-models";
import { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, normalizeModelPatternList, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { claimRpcInput } from "../modes/rpc/rpc-input";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "../tiny/online-candidates";
import { gatewayRequestRefusal } from "./auth-gateway-cli";

/** Names the caller in the gateway's logs. */
const STDIO_PEER = "stdio";

/**
 * The models a request naming `selector` may run on, in order: the model
 * `--model` would pick (the first entry of a comma list that resolves), then
 * that model's `retry.fallbackChains` (its role's chain when the entry named a
 * role). Empty when no entry resolves.
 */
export function selectorCandidates(
	selector: string,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): Model<Api>[] {
	const available = registry.getAvailable();
	for (const pattern of normalizeModelPatternList(selector)) {
		const { model, configuredRole } = resolveCliModel({ cliModel: pattern, modelRegistry: registry, settings });
		if (!model) continue;
		const chain = configuredRole
			? collectOnlineTinyCandidates([configuredRole], settings, available).map(candidate => candidate.model)
			: expandOnlineTinyModelFallbacks(model, settings, available);
		const seen = new Set<string>();
		return [model, ...chain].filter(candidate => {
			const key = formatModelStringWithRouting(candidate);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	return [];
}

/**
 * The `disabledModels` denial for `selector` when no entry resolves: the first
 * denied entry's diagnostic, so a denied model reads as refused, not unknown.
 */
export function selectorDenial(
	selector: string,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): string | undefined {
	for (const pattern of normalizeModelPatternList(selector)) {
		const { model, disabledModel } = resolveCliModel({ cliModel: pattern, modelRegistry: registry, settings });
		if (model) return undefined;
		if (disabledModel) return formatDisabledModelError(disabledModel.label, disabledModel.rule);
	}
	return undefined;
}

/**
 * The gateway router for the stdio host: it resolves only models in `routed` and refuses a
 * request that `disabledModels` denies under its routing options, as the HTTP host does.
 */
export function createStdioGatewayRouter(
	storage: AuthStorage,
	registry: Pick<ModelRegistry, "getAvailable">,
	settings: Settings,
	routed: ReadonlyMap<string, Model<Api>>,
): AuthGatewayRouter {
	return createAuthGatewayRouter({
		storage,
		resolveModel: id => routed.get(id),
		listModels: () => registry.getAvailable(),
		requestRefusal: (model, options) => gatewayRequestRefusal(model, options, settings),
	});
}

/**
 * The stdio host's request handler: it picks the models a request's selector names, tries them in
 * order through `router`, and answers 403 with the `disabledModels` diagnostic when the selector
 * names only denied models, 404 when it names nothing.
 */
export function createStdioRoute(
	router: Pick<AuthGatewayRouter, "route">,
	routed: Map<string, Model<Api>>,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): (req: Request) => Promise<Response> {
	return async req => {
		// Unparseable bodies pass through for the route to reject in its own wire format.
		const body: unknown = req.body
			? await req
					.clone()
					.json()
					.catch(() => undefined)
			: undefined;
		if (!isRecord(body) || typeof body.model !== "string") return router.route(req, STDIO_PEER);
		const selector = body.model;
		const candidates = selectorCandidates(selector, settings, registry);
		const denial = candidates.length === 0 ? selectorDenial(selector, settings, registry) : undefined;
		let response =
			denial === undefined
				? Response.json(
						{ error: { message: `No available model matches "${selector}"`, type: "invalid_request_error" } },
						{ status: 404 },
					)
				: Response.json({ error: { message: denial, type: "permission_error" } }, { status: 403 });
		for (const model of candidates) {
			const key = formatModelStringWithRouting(model);
			routed.set(key, model);
			const attempt = new Request(req.url, {
				method: req.method,
				headers: req.headers,
				body: JSON.stringify({ ...body, model: key }),
			});
			response = await router.route(attempt, STDIO_PEER);
			// 400 is the request's own fault and 499 its caller's: another model would fare no better.
			if (response.status <= 400 || response.status === 499) return response;
			logger.warn("auth-gateway stdio attempt failed", { selector, model: key, status: response.status });
		}
		return response;
	};
}

/** Serves the gateway on stdin/stdout until stdin ends, then exits. */
export async function runAuthGatewayStdio(): Promise<void> {
	// Claimed before extension discovery so no in-process module can read the protocol's input.
	const input = claimRpcInput();
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const storage = await discoverAuthStorage(undefined, { settings });
	const registry = new ModelRegistry(storage);
	await registry.refresh();
	await loadCliExtensionProviders(registry, settings, cwd);

	// Candidates are routed by their exact `provider/id[@upstream]`, so the
	// router only ever resolves a model this process picked for the request.
	const routed = new Map<string, Model<Api>>();
	const router = createStdioGatewayRouter(storage, registry, settings, routed);
	const route = createStdioRoute(router, routed, settings, registry);

	try {
		await serveAuthGatewayStdio({ input, write: line => process.stdout.write(line), route, version: VERSION });
	} finally {
		router.close();
		storage.close();
	}
	// Idle provider sockets and settings timers would otherwise keep the process alive past stdin's end.
	await postmortem.quit(0);
}
