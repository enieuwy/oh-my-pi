/**
 * `disabledModels` for OpenAI-native compaction. A route's `remoteCompaction.model`
 * (models.yml compat) replaces the model id in the native request, so the request
 * names an identity other than the candidate that `disabledModels` already admitted.
 */
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import { shouldUseCompactionV2Streaming } from "@oh-my-pi/pi-agent-core/compaction/compaction-v2-streaming";
import { shouldUseOpenAiRemoteCompaction } from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { disabledModelRule } from "../config/disabled-models";
import type { Settings } from "../config/settings";

/**
 * `preparation`, with native compaction switched off when `candidate`'s OpenAI native
 * request (V1 or V2) would name a model `disabledModels` denies. The compaction then
 * summarizes through the guarded transport on `candidate` itself. Unchanged otherwise.
 */
export function withoutDeniedNativeCompaction(
	preparation: CompactionPreparation,
	candidate: Model<Api>,
	settings: Settings | undefined,
): CompactionPreparation {
	const requestModelId = candidate.remoteCompaction?.model;
	if (requestModelId === undefined || preparation.settings.remoteEnabled === false) return preparation;
	const usesOpenAiNative =
		shouldUseOpenAiRemoteCompaction(candidate) ||
		(preparation.settings.remoteStreamingV2Enabled !== false && shouldUseCompactionV2Streaming(candidate));
	if (!usesOpenAiNative) return preparation;
	const rule = disabledModelRule({ provider: candidate.provider, id: requestModelId }, settings);
	if (rule === undefined) return preparation;
	logger.warn("Skipping native compaction: remoteCompaction.model is denied by disabledModels", {
		model: `${candidate.provider}/${candidate.id}`,
		remoteCompactionModel: `${candidate.provider}/${requestModelId}`,
		rule,
	});
	return { ...preparation, settings: { ...preparation.settings, remoteEnabled: false } };
}
