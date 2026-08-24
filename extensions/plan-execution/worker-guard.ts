import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function canonical(path: string, cwd: string): string {
	let existing = resolve(cwd, path.replace(/^@/, ""));
	const suffix: string[] = [];
	while (true) {
		try {
			existing = join(realpathSync.native(existing), ...suffix);
			break;
		} catch {
			const parent = dirname(existing);
			if (parent === existing) break;
			suffix.unshift(basename(existing));
			existing = parent;
		}
	}
	return process.platform === "darwin" ? existing.toLowerCase() : existing;
}

export default function planWorkerGuard(pi: ExtensionAPI) {
	const raw = process.env.PI_PLAN_PROTECTED_PATHS;
	if (!raw) return;
	const protectedPaths = new Set((JSON.parse(raw) as string[]).map((path) => canonical(path, process.cwd())));

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string" && /\bgit\b[^\n;&|]*\b(?:add|am|apply|branch|checkout|cherry-pick|clean|commit|merge|rebase|reset|restore|revert|stash|switch|tag|update-ref)\b/.test(command)) {
				return { block: true, reason: "The plan controller owns Git mutations and task commits." };
			}
			return;
		}
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const input = event.input as { path?: unknown; file_path?: unknown };
		const path = typeof input.path === "string" ? input.path : input.file_path;
		if (typeof path !== "string" || !protectedPaths.has(canonical(path, ctx.cwd))) return;
		return { block: true, reason: `Plan execution protects ${path} from worker writes.` };
	});
}
