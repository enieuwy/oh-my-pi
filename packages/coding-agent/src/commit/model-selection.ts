import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import { formatDisabledModelError } from "../config/disabled-models";
import {
	getModelMatchPreferences,
	type ModelLookupRegistry,
	parseModelPattern,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { CHAT_MODEL_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	/**
	 * Commit-time inference is stateless: session-level auto classification
	 * isn't available, so an explicit `:auto` selector collapses to "no
	 * override" and the model's own default level fills in.
	 */
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry &
	ApiKeyResolverRegistry & {
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	};

/** An explicit selection that resolves only to a `disabledModels` model fails with the rule; no other model is substituted. */
function refuseDeniedRoleValue(resolved: ResolvedModelRoleValue): ResolvedModelRoleValue {
	if (resolved.model === undefined && resolved.disabledModel) {
		throw new Error(formatDisabledModelError(resolved.disabledModel.label, resolved.disabledModel.rule));
	}
	return resolved;
}

/**
 * First configured role that resolves to an available model. A configured role
 * that resolves only to denied models stops the walk with the `disabledModels`
 * diagnostic instead of falling through to the next role.
 */
function resolveCommitRoleSelection(
	roles: readonly string[],
	settings: Settings,
	available: Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const matchPreferences = getModelMatchPreferences(settings);
	for (const role of roles) {
		const resolved = refuseDeniedRoleValue(
			resolveModelRoleValue(settings.getModelRole(role), available, { settings, matchPreferences }),
		);
		if (resolved.model) return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}
	return undefined;
}

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = override
		? refuseDeniedRoleValue(resolveModelRoleValue(override, available, { settings, matchPreferences }))
		: resolveCommitRoleSelection(["commit", "smol", ...CHAT_MODEL_ROLE_IDS], settings, available);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return {
		model,
		apiKey: modelRegistry.resolver(model),
		thinkingLevel: concreteThinkingLevel(resolved?.thinkingLevel),
	};
}

export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: ApiKey,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolvedSmol = resolveCommitRoleSelection(["smol"], settings, available);
	if (resolvedSmol?.model) {
		const apiKey = await modelRegistry.getApiKey(resolvedSmol.model);
		if (apiKey) {
			return {
				model: resolvedSmol.model,
				apiKey: modelRegistry.resolver(resolvedSmol.model),
				thinkingLevel: concreteThinkingLevel(resolvedSmol.thinkingLevel),
			};
		}
	}

	const matchPreferences = getModelMatchPreferences(settings);
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences).model;
		if (!candidate) continue;
		const apiKey = await modelRegistry.getApiKey(candidate);
		if (apiKey) {
			return {
				model: candidate,
				apiKey: modelRegistry.resolver(candidate),
			};
		}
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
