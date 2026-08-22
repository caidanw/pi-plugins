import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PlanTask, TaskGraph } from "./core.ts";

export type DashboardPhase = "planning" | "worker" | "verification" | "audit";

type DashboardTui = {
	terminal: { rows: number };
	requestRender(): void;
};

type ToolEvent = {
	type?: unknown;
	toolName?: unknown;
	args?: unknown;
};

const MAX_ACTIVITIES = 200;

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function field(input: Record<string, unknown>, key: string, fallback = ""): string {
	const value = input[key];
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function compact(value: string, limit = 160): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function activityFromPiEvent(value: unknown): string | undefined {
	const event = record(value) as ToolEvent;
	if (event.type !== "tool_execution_start" || typeof event.toolName !== "string") return undefined;
	const args = record(event.args);
	const path = field(args, "path", ".");

	switch (event.toolName) {
		case "read": return `Reading ${compact(path)}`;
		case "grep": return `Searching ${compact(field(args, "path", "."))} for ${compact(field(args, "pattern", "matches"))}`;
		case "find": return `Finding ${compact(field(args, "pattern", "files"))} in ${compact(field(args, "path", "."))}`;
		case "ls": return `Listing ${compact(path)}`;
		case "bash": return `Running ${compact(field(args, "command", "shell command"))}`;
		case "edit": return `Editing ${compact(path)}`;
		case "write": return `Writing ${compact(path)}`;
		default: return undefined;
	}
}

function clip(value: string, width: number): string {
	if (width < 2) return "";
	return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function elapsed(startedAt: number): string {
	const seconds = Math.floor((Date.now() - startedAt) / 1000);
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function phaseLabel(phase: DashboardPhase): string {
	switch (phase) {
		case "planning": return "Building task graph";
		case "worker": return "Implementing task";
		case "verification": return "Verifying task";
		case "audit": return "Running final audit";
	}
}

export class PlanDashboard {
	private readonly startedAt = Date.now();
	private readonly activities: string[] = [];
	private readonly tui: DashboardTui;
	private readonly theme: Theme;
	private readonly sourcePlan: string;
	private readonly onCancel: () => void;
	private readonly cancelWindowMs: number;
	private readonly isCancel: (data: string) => boolean;
	private phase: DashboardPhase;
	private graph?: TaskGraph;
	private task?: PlanTask;
	private verificationCommand = "";
	private verificationOutput = "";
	private cancelArmedUntil = 0;
	private cancelTimer?: NodeJS.Timeout;
	private tickTimer: NodeJS.Timeout;

	constructor(
		tui: DashboardTui,
		theme: Theme,
		sourcePlan: string,
		phase: DashboardPhase,
		onCancel: () => void,
		cancelWindowMs = 2_000,
		isCancel: (data: string) => boolean = (data) => data === "\x1b",
	) {
		this.tui = tui;
		this.theme = theme;
		this.sourcePlan = sourcePlan;
		this.phase = phase;
		this.onCancel = onCancel;
		this.cancelWindowMs = cancelWindowMs;
		this.isCancel = isCancel;
		this.tickTimer = setInterval(() => this.renderSoon(), 1_000);
	}

	setPhase(phase: DashboardPhase, graph?: TaskGraph, task?: PlanTask): void {
		this.phase = phase;
		this.graph = graph ?? this.graph;
		this.task = task;
		if (phase !== "verification") {
			this.verificationCommand = "";
			this.verificationOutput = "";
		}
		this.renderSoon();
	}

	addActivity(activity: string): void {
		const value = compact(activity);
		if (!value || this.activities.at(-1) === value) return;
		this.activities.push(value);
		if (this.activities.length > MAX_ACTIVITIES) this.activities.splice(0, this.activities.length - MAX_ACTIVITIES);
		this.renderSoon();
	}

	handlePiEvent(event: unknown): void {
		const activity = activityFromPiEvent(event);
		if (activity) this.addActivity(activity);
	}

	setVerification(command: string): void {
		this.verificationCommand = compact(command);
		this.verificationOutput = "";
		this.renderSoon();
	}

	appendVerificationOutput(stream: "stdout" | "stderr", chunk: string): void {
		const prefix = stream === "stderr" ? "! " : "";
		this.verificationOutput = `${this.verificationOutput}${prefix}${chunk}`.slice(-4_096);
		this.renderSoon();
	}

	handleInput(data: string): void {
		if (!this.isCancel(data)) return;
		const now = Date.now();
		if (this.cancelArmedUntil >= now) {
			this.cancelArmedUntil = 0;
			if (this.cancelTimer) clearTimeout(this.cancelTimer);
			this.addActivity("Stopping current work…");
			try { this.onCancel(); } catch { /* Controller state remains authoritative. */ }
			return;
		}

		this.cancelArmedUntil = now + this.cancelWindowMs;
		if (this.cancelTimer) clearTimeout(this.cancelTimer);
		this.cancelTimer = setTimeout(() => {
			this.cancelArmedUntil = 0;
			this.renderSoon();
		}, this.cancelWindowMs);
		this.renderSoon();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(10, width - 2);
		const lines: string[] = [];
		const title = `Plan Execution — ${this.sourcePlan}`;
		const time = elapsed(this.startedAt);
		lines.push(this.theme.bold(clip(`${title}  ${time}`, contentWidth)));
		lines.push(this.theme.fg("dim", "─".repeat(contentWidth)));
		lines.push(`${this.theme.fg("accent", "◉")} ${phaseLabel(this.phase)}${this.task ? ` — ${this.task.id} (${this.task.attempts}/2)` : ""}`);

		const taskLines = this.renderTasks(contentWidth);
		if (taskLines.length) lines.push("", ...taskLines);

		if (this.verificationCommand) {
			lines.push("", this.theme.bold("Verification"), clip(`  ${this.verificationCommand}`, contentWidth));
			const output = this.verificationOutput.split(/\r?\n/).filter(Boolean).slice(-3);
			lines.push(...output.map((line) => this.theme.fg("dim", clip(`  ${line}`, contentWidth))));
		}

		const activityLimit = Math.max(8, Math.min(24, this.tui.terminal.rows - lines.length - 6));
		const visible = this.activities.slice(-activityLimit);
		lines.push("", this.theme.bold("Activity"));
		if (this.activities.length > visible.length) lines.push(this.theme.fg("dim", `  … ${this.activities.length - visible.length} earlier activities`));
		lines.push(...(visible.length ? visible.map((activity) => clip(`  ${activity}`, contentWidth)) : [this.theme.fg("dim", "  Waiting for activity…")]));
		lines.push("");
		lines.push(this.cancelArmedUntil >= Date.now()
			? this.theme.fg("warning", "⚠ Press Esc again within 2 seconds to pause and exit")
			: this.theme.fg("dim", "Esc pause/stop and exit"));
		return lines;
	}

	invalidate(): void {
		this.renderSoon();
	}

	dispose(): void {
		clearInterval(this.tickTimer);
		if (this.cancelTimer) clearTimeout(this.cancelTimer);
	}

	private renderTasks(width: number): string[] {
		if (!this.graph) return [];
		const tasks = this.graph.tasks;
		const limit = Math.max(3, Math.min(12, Math.floor(this.tui.terminal.rows / 3)));
		const activeIndex = Math.max(0, tasks.findIndex((task) => task.id === this.task?.id));
		const start = Math.max(0, Math.min(activeIndex - 2, tasks.length - limit));
		const shown = tasks.slice(start, start + limit);
		const lines = [this.theme.bold(`Tasks — ${tasks.filter((task) => task.status === "passed").length}/${tasks.length} passed`)];
		if (start > 0) lines.push(this.theme.fg("dim", `  … ${start} earlier tasks`));
		for (const task of shown) {
			const marker = task.status === "passed" ? "✓" : task.status === "running" ? "◉" : task.status === "failed" ? "✗" : "○";
			const color = task.status === "passed" ? "success" : task.status === "running" ? "accent" : task.status === "failed" ? "error" : "dim";
			lines.push(`${this.theme.fg(color, marker)} ${clip(`${task.id}  ${task.title}`, width - 2)}`);
		}
		const hiddenAfter = tasks.length - start - shown.length;
		if (hiddenAfter > 0) lines.push(this.theme.fg("dim", `  … ${hiddenAfter} later tasks`));
		return lines;
	}

	private renderSoon(): void {
		try { this.tui.requestRender(); } catch { /* UI failures must not affect the controller. */ }
	}
}
