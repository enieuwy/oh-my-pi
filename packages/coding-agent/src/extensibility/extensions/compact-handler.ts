/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by print-mode, rpc-mode, and the executor.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { disabledModelRule, formatDisabledModelError } from "../../config/disabled-models";
import type { Settings } from "../../config/settings";
import type { CompactOptions } from "./types";

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
}

export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
): Promise<void> {
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	await session.compact(instructions, options);
}

interface SetModelCapableSession {
	settings: Settings;
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model): Promise<unknown>;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * Returns false when no API key is available for the requested model. Throws
 * when `disabledModels` denies the model, so the extension sees the matching rule
 * instead of a bare `false`.
 */
export async function runExtensionSetModel(session: SetModelCapableSession, model: Model): Promise<boolean> {
	const rule = disabledModelRule(model, session.settings);
	if (rule !== undefined) throw new Error(formatDisabledModelError(model, rule));
	const key = await session.modelRegistry.getApiKey(model);
	if (!key) return false;
	await session.setModel(model);
	return true;
}
