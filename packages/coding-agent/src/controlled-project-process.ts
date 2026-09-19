import { getActiveControlledToolsPolicy } from "./controlled-tools-policy";

export interface ResolvedProjectProcess {
	readonly command: string[];
	readonly cwd: string;
}

export function resolveProjectProcessCommand(command: readonly string[], cwd: string): ResolvedProjectProcess {
	if (command.length === 0 || command.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
		throw new Error("Project process argv must contain only non-NUL strings");
	}
	const controlled = getActiveControlledToolsPolicy();
	if (!controlled) return { command: [...command], cwd };
	const prefix = controlled.policy.subprocess_argv;
	if (prefix.length === 0) throw new Error("Controlled project process refused: subprocess_argv is empty");
	if (cwd.length === 0) throw new Error("Controlled project process refused: an explicit cwd is required");
	return {
		command: [...prefix, "--cwd", cwd, "--", ...command],
		cwd: controlled.bootstrapCwd,
	};
}

/**
 * Spawn a process whose executable or arguments can come from project files.
 * Controlled sessions route the exact argv through their policy launcher.
 */
export function spawnProjectProcess<
	const In extends Bun.SpawnOptions.Writable = "ignore",
	const Out extends Bun.SpawnOptions.Readable = "pipe",
	const Err extends Bun.SpawnOptions.Readable = "inherit",
>(command: readonly string[], options: Bun.SpawnOptions.SpawnOptions<In, Out, Err>) {
	const requestedCwd = options.cwd;
	if (typeof requestedCwd !== "string") {
		const controlled = getActiveControlledToolsPolicy();
		if (controlled) throw new Error("Controlled project process refused: an explicit cwd is required");
		return Bun.spawn([...command], options);
	}
	const resolved = resolveProjectProcessCommand(command, requestedCwd);
	return Bun.spawn(resolved.command, { ...options, cwd: resolved.cwd });
}
