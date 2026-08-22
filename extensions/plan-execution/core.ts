import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const RUN_STATUSES = new Set(["draft", "approved", "running", "paused", "completed", "failed"]);
const TASK_STATUSES = new Set(["pending", "running", "passed", "failed"]);
const OUTPUT_LIMIT = 50 * 1024;

export type RunStatus = "draft" | "approved" | "running" | "paused" | "completed" | "failed";
export type TaskStatus = "pending" | "running" | "passed" | "failed";
export type EvidenceKind = "worker" | "integrity" | "verification";

export type TaskEvidence = {
	attempt: number;
	kind: EvidenceKind;
	command?: string;
	exitCode: number;
	output: string;
};

export type PlanTask = {
	id: string;
	title: string;
	instructions: string;
	acceptance: string[];
	dependsOn: string[];
	expectedFiles: string[];
	verification: string;
	status: TaskStatus;
	attempts: number;
	evidence: TaskEvidence[];
};

export type TaskGraph = {
	version: 1;
	sourcePlan: string;
	status: RunStatus;
	baseline: { gitStatus: string; gitDiff: string };
	tasks: PlanTask[];
};

export type ProtectedSnapshot = {
	path: string;
	content: Buffer;
	mode: number;
	device: number;
	inode: number;
	links: number;
	hash: string;
};

export type ProcessResult = {
	code: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
};

export type PiResult = ProcessResult & {
	output: string;
	stopReason?: string;
	errorMessage?: string;
};

export type ProcessOutputHandler = (stream: "stdout" | "stderr", chunk: string) => void;

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function strings(value: unknown, label: string, allowEmpty = false): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
	return value.map((item, index) => string(item, `${label}[${index}]`));
}

function parseEvidence(value: unknown, label: string): TaskEvidence {
	const input = object(value, label);
	if (!Number.isInteger(input.attempt) || Number(input.attempt) < 1) throw new Error(`${label}.attempt must be a positive integer`);
	if (input.kind !== "worker" && input.kind !== "integrity" && input.kind !== "verification") throw new Error(`${label}.kind is invalid`);
	if (!Number.isInteger(input.exitCode)) throw new Error(`${label}.exitCode must be an integer`);
	return {
		attempt: Number(input.attempt),
		kind: input.kind,
		command: input.command === undefined ? undefined : string(input.command, `${label}.command`),
		exitCode: Number(input.exitCode),
		output: typeof input.output === "string" ? input.output : "",
	};
}

function parseTask(value: unknown, index: number): PlanTask {
	const input = object(value, `tasks[${index}]`);
	const status = input.status;
	if (typeof status !== "string" || !TASK_STATUSES.has(status)) throw new Error(`tasks[${index}].status is invalid`);
	if (!Number.isInteger(input.attempts) || Number(input.attempts) < 0) throw new Error(`tasks[${index}].attempts must be a non-negative integer`);
	const evidenceInput = input.evidence;
	if (evidenceInput !== undefined && !Array.isArray(evidenceInput)) throw new Error(`tasks[${index}].evidence must be an array`);
	return {
		id: string(input.id, `tasks[${index}].id`),
		title: string(input.title, `tasks[${index}].title`),
		instructions: string(input.instructions, `tasks[${index}].instructions`),
		acceptance: strings(input.acceptance, `tasks[${index}].acceptance`),
		dependsOn: strings(input.dependsOn, `tasks[${index}].dependsOn`, true),
		expectedFiles: strings(input.expectedFiles, `tasks[${index}].expectedFiles`, true),
		verification: string(input.verification, `tasks[${index}].verification`),
		status: status as TaskStatus,
		attempts: Number(input.attempts),
		evidence: (evidenceInput ?? []).map((item, evidenceIndex) => parseEvidence(item, `tasks[${index}].evidence[${evidenceIndex}]`)),
	};
}

export function validateTaskGraph(graph: TaskGraph): void {
	if (graph.tasks.length === 0) throw new Error("Task graph must contain at least one task");
	const ids = new Set<string>();
	for (const task of graph.tasks) {
		if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
		ids.add(task.id);
	}
	for (const task of graph.tasks) {
		for (const dependency of task.dependsOn) {
			if (!ids.has(dependency)) throw new Error(`${task.id} depends on missing task ${dependency}`);
			if (dependency === task.id) throw new Error(`${task.id} cannot depend on itself`);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(graph.tasks.map((task) => [task.id, task]));
	function visit(id: string): void {
		if (visiting.has(id)) throw new Error(`Task graph contains a cycle at ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	}
	for (const task of graph.tasks) visit(task.id);
}

export function parseTaskGraph(value: unknown): TaskGraph {
	const input = object(value, "task graph");
	if (input.version !== 1) throw new Error("Unsupported task graph version");
	if (typeof input.status !== "string" || !RUN_STATUSES.has(input.status)) throw new Error("Task graph status is invalid");
	const baseline = input.baseline === undefined ? {} : object(input.baseline, "baseline");
	if (!Array.isArray(input.tasks)) throw new Error("tasks must be an array");
	const graph: TaskGraph = {
		version: 1,
		sourcePlan: string(input.sourcePlan, "sourcePlan"),
		status: input.status as RunStatus,
		baseline: {
			gitStatus: typeof baseline.gitStatus === "string" ? baseline.gitStatus : "",
			gitDiff: typeof baseline.gitDiff === "string" ? baseline.gitDiff : "",
		},
		tasks: input.tasks.map(parseTask),
	};
	validateTaskGraph(graph);
	return graph;
}

export function initializeGraph(graph: TaskGraph, sourcePlan: string): TaskGraph {
	const initialized: TaskGraph = {
		...graph,
		sourcePlan,
		status: "approved",
		baseline: { gitStatus: "", gitDiff: "" },
		tasks: graph.tasks.map((task) => ({ ...task, status: "pending", attempts: 0, evidence: [] })),
	};
	validateTaskGraph(initialized);
	return initialized;
}

export function parsePlannerTaskGraph(value: unknown, sourcePlan: string): TaskGraph {
	const input = object(value, "planner submission");
	if (!Array.isArray(input.tasks)) throw new Error("planner submission.tasks must be an array");
	return parseTaskGraph({
		version: 1,
		sourcePlan,
		status: "draft",
		baseline: { gitStatus: "", gitDiff: "" },
		tasks: input.tasks.map((task, index) => ({
			...object(task, `planner submission.tasks[${index}]`),
			status: "pending",
			attempts: 0,
			evidence: [],
		})),
	});
}

export function normalizeForResume(graph: TaskGraph): TaskGraph {
	const normalized = structuredClone(graph);
	let recovered = false;
	for (const task of normalized.tasks) {
		if (task.status === "running") {
			task.status = "pending";
			recovered = true;
		}
	}
	if (recovered && normalized.status === "running") normalized.status = "paused";
	return normalized;
}

export function nextReadyTask(graph: TaskGraph): PlanTask | undefined {
	const passed = new Set(graph.tasks.filter((task) => task.status === "passed").map((task) => task.id));
	return graph.tasks.find((task) => task.status === "pending" && task.dependsOn.every((id) => passed.has(id)));
}

export function applyAttemptResult(task: PlanTask, evidence: TaskEvidence, passed: boolean): "passed" | "retry" | "failed" {
	task.evidence.push(evidence);
	if (passed) {
		task.status = "passed";
		return "passed";
	}
	if (task.attempts < 2) {
		task.status = "pending";
		return "retry";
	}
	task.status = "failed";
	return "failed";
}

export function planPaths(sourcePlan: string): { sourcePlan: string; tasks: string; audit: string } {
	const absolute = resolve(sourcePlan);
	const extension = extname(absolute);
	const stem = extension ? absolute.slice(0, -extension.length) : absolute;
	return { sourcePlan: absolute, tasks: `${stem}.tasks.json`, audit: `${stem}.audit.md` };
}

export async function loadTaskGraph(path: string): Promise<TaskGraph> {
	return parseTaskGraph(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function saveTaskGraph(path: string, graph: TaskGraph): Promise<void> {
	validateTaskGraph(graph);
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

function digest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function captureProtectedFiles(paths: string[]): Promise<ProtectedSnapshot[]> {
	return Promise.all(paths.map(async (path) => {
		const canonical = await realpath(path);
		const [content, metadata] = await Promise.all([readFile(canonical), lstat(canonical)]);
		return {
			path: canonical,
			content,
			mode: metadata.mode,
			device: metadata.dev,
			inode: metadata.ino,
			links: metadata.nlink,
			hash: digest(content),
		};
	}));
}

export async function restoreChangedFiles(snapshots: ProtectedSnapshot[]): Promise<string[]> {
	const changed: string[] = [];
	for (const snapshot of snapshots) {
		let current: Buffer | undefined;
		let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
		try {
			[current, metadata] = await Promise.all([readFile(snapshot.path), lstat(snapshot.path)]);
		} catch {
			current = undefined;
			metadata = undefined;
		}
		const unchanged = current
			&& metadata?.isFile()
			&& digest(current) === snapshot.hash
			&& metadata.mode === snapshot.mode
			&& metadata.dev === snapshot.device
			&& metadata.ino === snapshot.inode
			&& metadata.nlink === snapshot.links;
		if (unchanged) continue;
		changed.push(snapshot.path);
		await rm(snapshot.path, { recursive: true, force: true });
		await mkdir(dirname(snapshot.path), { recursive: true });
		await writeFile(snapshot.path, snapshot.content, { mode: snapshot.mode & 0o7777 });
		await chmod(snapshot.path, snapshot.mode & 0o7777);
	}
	return changed;
}

export function boundedOutput(value: string, limit = OUTPUT_LIMIT): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= limit) return value;
	return `[${bytes.length - limit} bytes omitted]\n${bytes.subarray(bytes.length - limit).toString("utf8")}`;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const override = process.env.PI_PLAN_PI_BINARY;
	if (override) return { command: override, args };
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/")) return { command: process.execPath, args: [currentScript, ...args] };
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function killProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	try {
		if (process.platform === "win32" && child.pid) {
			spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
			return;
		}
		if (child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// The process already exited.
	}
}

function processGroupExists(pid: number | undefined): boolean {
	if (process.platform === "win32" || !pid) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function captureProcess(
	command: string,
	args: string[],
	options: {
		cwd: string;
		env?: NodeJS.ProcessEnv;
		shell?: boolean;
		signal?: AbortSignal;
		timeoutMs?: number;
		onStdoutLine?: (line: string) => void;
		onOutput?: ProcessOutputHandler;
	},
): Promise<ProcessResult> {
	return new Promise((resolveResult) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: options.shell ?? false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let stdoutLine = "";
		let aborted = false;
		let timedOut = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		let timeout: NodeJS.Timeout | undefined;
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		const append = (current: Buffer, chunk: Buffer): Buffer => {
			const combined = Buffer.concat([current, chunk]);
			return combined.length > OUTPUT_LIMIT ? combined.subarray(combined.length - OUTPUT_LIMIT) : combined;
		};
		const emitOutput = (stream: "stdout" | "stderr", text: string) => {
			if (!text) return;
			try { options.onOutput?.(stream, text); } catch { /* Observers cannot change process results. */ }
			if (stream !== "stdout" || !options.onStdoutLine) return;
			const lines = `${stdoutLine}${text}`.split("\n");
			stdoutLine = lines.pop() ?? "";
			for (const line of lines) {
				try { options.onStdoutLine(line.replace(/\r$/, "")); } catch { /* Observers cannot change process results. */ }
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
			emitOutput("stdout", stdoutDecoder.write(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
			emitOutput("stderr", stderrDecoder.write(chunk));
		});

		const terminate = (fromTimeout = false) => {
			if (settled) return;
			aborted = true;
			timedOut ||= fromTimeout;
			killProcess(child, "SIGTERM");
			killTimer ??= setTimeout(() => killProcess(child, "SIGKILL"), 5_000);
		};
		const abort = () => terminate(false);
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		if (options.timeoutMs) timeout = setTimeout(() => terminate(true), options.timeoutMs);

		child.on("error", (error) => { stderr = append(stderr, Buffer.from(error.message)); });
		child.on("exit", () => {
			if (!processGroupExists(child.pid)) return;
			killProcess(child, "SIGTERM");
			killTimer ??= setTimeout(() => killProcess(child, "SIGKILL"), 100);
		});
		child.on("close", (code) => {
			settled = true;
			emitOutput("stdout", stdoutDecoder.end());
			emitOutput("stderr", stderrDecoder.end());
			if (stdoutLine && options.onStdoutLine) {
				try { options.onStdoutLine(stdoutLine.replace(/\r$/, "")); } catch { /* Observers cannot change process results. */ }
				stdoutLine = "";
			}
			const finish = () => {
				if (timeout) clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", abort);
				resolveResult({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), aborted, timedOut });
			};

			if (!processGroupExists(child.pid)) {
				finish();
				return;
			}
			// ponytail: process groups catch ordinary descendants; OS sandboxing is needed for daemons that create a new session.
			killProcess(child, "SIGTERM");
			setTimeout(() => {
				killProcess(child, "SIGKILL");
				finish();
			}, 100);
		});
	});
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

export async function runPi(options: {
	cwd: string;
	prompt: string;
	model: string;
	thinkingLevel?: string;
	tools: string[];
	extensions?: string[];
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onEvent?: (event: unknown) => void;
}): Promise<PiResult> {
	const args = ["--mode", "json", "--no-session", "--no-extensions", "--model", options.model];
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
	else args.push("--no-tools");
	for (const extension of options.extensions ?? []) args.push("--extension", extension);
	args.push(options.prompt);
	const invocation = piInvocation(args);
	let output = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	const result = await captureProcess(invocation.command, invocation.args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		signal: options.signal,
		onStdoutLine: (line) => {
			let event: unknown;
			try { event = JSON.parse(line) as unknown; } catch { return; }
			if (typeof event === "object" && event !== null) {
				const candidate = event as { type?: unknown; message?: unknown };
				if (candidate.type === "message_end" && typeof candidate.message === "object" && candidate.message !== null) {
					const message = candidate.message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
					if (message.role === "assistant") {
						output = messageText(message.content);
						if (typeof message.stopReason === "string") stopReason = message.stopReason;
						if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
					}
				}
			}
			try { options.onEvent?.(event); } catch { /* Observers cannot change process results. */ }
		},
	});
	return { ...result, output, stopReason, errorMessage };
}

export async function runVerification(
	command: string,
	cwd: string,
	signal?: AbortSignal,
	timeoutMs = 600_000,
	onOutput?: ProcessOutputHandler,
): Promise<ProcessResult> {
	return captureProcess(command, [], { cwd, shell: true, signal, timeoutMs, onOutput });
}
