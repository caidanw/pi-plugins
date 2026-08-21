import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	applyAttemptResult,
	boundedOutput,
	captureProtectedFiles,
	initializeGraph,
	loadTaskGraph,
	nextReadyTask,
	normalizeForResume,
	parseTaskGraph,
	planPaths,
	restoreChangedFiles,
	runPi,
	runVerification,
	saveTaskGraph,
	type PlanTask,
	type TaskEvidence,
	type TaskGraph,
} from "./plan-execution/core.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const WORKER_GUARD = fileURLToPath(new URL("./plan-execution/worker-guard.ts", import.meta.url));
const STATUS_KEY = "plan-execution";

type ActiveRun = {
	paths: ReturnType<typeof planPaths>;
	graph: TaskGraph;
	ctx: ExtensionCommandContext;
	phase: "worker" | "verification" | "audit";
	currentTaskId?: string;
	abort?: AbortController;
	stopRequested: boolean;
	done: Promise<void>;
};

function modelName(ctx: ExtensionCommandContext): string {
	if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("No authenticated active model");
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function cleanJsonOutput(output: string): string {
	const trimmed = output.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced?.[1] ?? trimmed;
}

function reviewText(graph: TaskGraph): string {
	return graph.tasks.map((task) => [
		`${task.id}: ${task.title}`,
		`Depends on: ${task.dependsOn.join(", ") || "none"}`,
		`Acceptance: ${task.acceptance.join("; ")}`,
		`Files: ${task.expectedFiles.join(", ") || "unspecified"}`,
		`Verify: ${task.verification}`,
	].join("\n")).join("\n\n");
}

function plannerPrompt(sourcePlan: string, plan: string, current?: TaskGraph, feedback?: string): string {
	return `You are a read-only implementation planner. Convert the source Markdown plan into the smallest complete sequentially-executable task DAG. Inspect the repository only as needed. Do not modify files.

Output exactly one JSON object and no commentary. Use this shape:
{
  "version": 1,
  "sourcePlan": ${JSON.stringify(sourcePlan)},
  "status": "approved",
  "baseline": { "gitStatus": "", "gitDiff": "" },
  "tasks": [{
    "id": "T001",
    "title": "Short title",
    "instructions": "Bounded implementation instructions",
    "acceptance": ["Observable criterion"],
    "dependsOn": [],
    "expectedFiles": ["path"],
    "verification": "one non-interactive shell command",
    "status": "pending",
    "attempts": 0,
    "evidence": []
  }]
}

Rules:
- Include every source-plan requirement exactly once.
- Keep tasks independently verifiable and ordered by dependency.
- Use unique stable IDs and valid dependency IDs.
- Verification commands must be non-interactive, project-local, and specific enough to gate completion.
- Do not add speculative work.

<source-plan path=${JSON.stringify(sourcePlan)}>
${plan}
</source-plan>
${current ? `\n<current-task-graph>\n${JSON.stringify(current, null, 2)}\n</current-task-graph>` : ""}
${feedback ? `\n<user-feedback>\n${feedback}\n</user-feedback>` : ""}`;
}

function workerPrompt(sourcePlan: string, graph: TaskGraph, task: PlanTask): string {
	const dependencies = task.dependsOn.map((id) => {
		const dependency = graph.tasks.find((candidate) => candidate.id === id);
		return dependency ? `${dependency.id}: ${dependency.title}\n${JSON.stringify(dependency.evidence)}` : id;
	}).join("\n\n");
	const previousFailure = task.evidence.at(-1);
	return `You are the implementation worker for exactly one approved task. Work in the current repository and finish this task. You may inspect the source plan and repository for context. Do not edit the source plan or task graph. Do not implement unrelated future tasks. Do not make Git commits. The controller will run verification after you exit.

Source plan: ${sourcePlan}
Task: ${task.id} — ${task.title}
Instructions: ${task.instructions}
Acceptance:
${task.acceptance.map((criterion) => `- ${criterion}`).join("\n")}
Expected files:
${task.expectedFiles.map((path) => `- ${path}`).join("\n") || "- Unspecified"}
Verification command: ${task.verification}
${dependencies ? `\nCompleted dependencies:\n${dependencies}` : ""}
${previousFailure ? `\nPrevious attempt failed:\n${previousFailure.output}` : ""}`;
}

function auditPrompt(plan: string, graph: TaskGraph, finalStatus: string, finalDiff: string): string {
	return `You are a fresh read-only final auditor. Compare the source plan, approved task graph, verification evidence, and repository state. Do not modify files. Report concise findings under severity headings. If no problems are found, say so.

Check for:
- Source-plan requirements omitted from the DAG.
- Tasks incompletely represented in the implementation.
- Missing wiring or dead implementations.
- Unplanned scope changes.
- Claims unsupported by verification evidence.

<source-plan>\n${plan}\n</source-plan>
<task-graph>\n${JSON.stringify(graph, null, 2)}\n</task-graph>
<baseline-git-status>\n${graph.baseline.gitStatus}\n</baseline-git-status>
<baseline-git-diff>\n${graph.baseline.gitDiff}\n</baseline-git-diff>
<final-git-status>\n${finalStatus}\n</final-git-status>
<final-git-diff>\n${finalDiff}\n</final-git-diff>`;
}

function piFailure(result: Awaited<ReturnType<typeof runPi>>): string | undefined {
	if (result.aborted) return "Pi process was aborted";
	if (result.code !== 0) return result.stderr || result.output || `Pi exited with code ${result.code}`;
	if (result.stopReason === "error" || result.stopReason === "aborted") return result.errorMessage || result.output || `Pi stopped: ${result.stopReason}`;
	return undefined;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function gitState(cwd: string): Promise<{ gitStatus: string; gitDiff: string }> {
	const [status, working, staged] = await Promise.all([
		runVerification("git status --short", cwd, undefined, 10_000),
		runVerification("git diff --no-ext-diff", cwd, undefined, 10_000),
		runVerification("git diff --cached --no-ext-diff", cwd, undefined, 10_000),
	]);
	const diff = [
		working.code === 0 && working.stdout ? `## Working tree\n${working.stdout}` : "",
		staged.code === 0 && staged.stdout ? `## Staged\n${staged.stdout}` : "",
	].filter(Boolean).join("\n\n");
	return {
		gitStatus: status.code === 0 ? boundedOutput(status.stdout) : "",
		gitDiff: boundedOutput(diff),
	};
}

function evidence(task: PlanTask, kind: TaskEvidence["kind"], exitCode: number, output: string, command?: string): TaskEvidence {
	return { attempt: task.attempts, kind, command, exitCode, output: boundedOutput(output) };
}

export default function planExecutionExtension(pi: ExtensionAPI) {
	let active: ActiveRun | undefined;
	let planningAbort: AbortController | undefined;

	function report(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
		ctx.ui.notify(message, level);
		try {
			pi.sendMessage({ customType: "plan-execution-status", content: `[plan] ${message}`, display: true }, { triggerTurn: false });
		} catch {
			// Notifications remain available when the session cannot accept a durable message.
		}
	}

	async function runPlanner(
		ctx: ExtensionCommandContext,
		sourcePath: string,
		storedSourcePath: string,
		current?: TaskGraph,
		feedback?: string,
	): Promise<TaskGraph> {
		const result = await runPi({
			cwd: ctx.cwd,
			prompt: plannerPrompt(storedSourcePath, await readFile(sourcePath, "utf8"), current, feedback),
			model: modelName(ctx),
			thinkingLevel: ctx.thinkingLevel,
			tools: READ_ONLY_TOOLS,
			signal: planningAbort?.signal,
		});
		const failure = piFailure(result);
		if (failure) throw new Error(`Planner failed: ${failure}`);
		if (!result.output.trim()) throw new Error("Planner returned no task graph");
		return initializeGraph(parseTaskGraph(JSON.parse(cleanJsonOutput(result.output)) as unknown), storedSourcePath);
	}

	async function planAndApprove(
		ctx: ExtensionCommandContext,
		sourcePath: string,
		storedSourcePath: string,
		current?: TaskGraph,
	): Promise<TaskGraph | undefined> {
		let candidate = current;
		let feedback: string | undefined;
		while (!planningAbort?.signal.aborted) {
			try {
				candidate = await runPlanner(ctx, sourcePath, storedSourcePath, candidate, feedback);
				feedback = undefined;
			} catch (error: unknown) {
				if (planningAbort?.signal.aborted) return undefined;
				const message = error instanceof Error ? error.message : String(error);
				const action = await ctx.ui.select(`Task graph error\n\n${message}`, ["Try again", "Add feedback", "Cancel"]);
				if (action === "Cancel" || !action) return undefined;
				if (action === "Add feedback") feedback = await ctx.ui.editor("Planner feedback", "");
				continue;
			}

			const action = await ctx.ui.select(`Review generated task graph\n\n${reviewText(candidate)}`, ["Approve and run", "Add feedback", "Cancel"]);
			if (action === "Approve and run") return candidate;
			if (action === "Cancel" || !action) return undefined;
			feedback = await ctx.ui.editor("Planner feedback", "");
			if (feedback === undefined) feedback = "";
		}
		return undefined;
	}

	async function runAudit(run: ActiveRun): Promise<void> {
		run.phase = "audit";
		run.currentTaskId = undefined;
		run.abort = new AbortController();
		run.ctx.ui.setStatus(STATUS_KEY, "auditing plan");
		const [plan, final] = await Promise.all([readFile(run.paths.sourcePlan, "utf8"), gitState(run.ctx.cwd)]);
		const result = await runPi({
			cwd: run.ctx.cwd,
			prompt: auditPrompt(plan, run.graph, final.gitStatus, final.gitDiff),
			model: modelName(run.ctx),
			thinkingLevel: run.ctx.thinkingLevel,
			tools: READ_ONLY_TOOLS,
			signal: run.abort.signal,
		});
		run.abort = undefined;
		const failure = piFailure(result);
		if (failure || !result.output.trim()) {
			report(run.ctx, `Plan completed, but audit failed: ${failure ?? "no audit output"}`, "warning");
			return;
		}
		await writeFile(run.paths.audit, `${result.output.trim()}\n`, "utf8");
		report(run.ctx, `Plan completed. Audit: ${relative(run.ctx.cwd, run.paths.audit)}`, "info");
	}

	async function pauseTask(run: ActiveRun, task: PlanTask): Promise<void> {
		task.status = "pending";
		run.graph.status = "paused";
		run.abort = undefined;
		await saveTaskGraph(run.paths.tasks, run.graph);
		report(run.ctx, `Plan paused at ${task.id}`, "info");
	}

	async function execute(run: ActiveRun): Promise<void> {
		while (!run.stopRequested) {
			const task = nextReadyTask(run.graph);
			if (!task) {
				if (run.graph.tasks.every((candidate) => candidate.status === "passed")) {
					run.graph.status = "completed";
					await saveTaskGraph(run.paths.tasks, run.graph);
					await runAudit(run);
					return;
				}
				run.graph.status = "failed";
				await saveTaskGraph(run.paths.tasks, run.graph);
				report(run.ctx, "Plan stopped: pending tasks are blocked", "error");
				return;
			}

			if (task.attempts >= 2) {
				task.status = "failed";
				run.graph.status = "failed";
				await saveTaskGraph(run.paths.tasks, run.graph);
				report(run.ctx, `${task.id} has no attempts remaining`, "error");
				return;
			}

			run.abort = new AbortController();
			task.attempts++;
			task.status = "running";
			run.graph.status = "running";
			run.phase = "worker";
			run.currentTaskId = task.id;
			await saveTaskGraph(run.paths.tasks, run.graph);
			if (run.stopRequested || run.abort.signal.aborted) {
				task.attempts--;
				await pauseTask(run, task);
				return;
			}
			const snapshots = await captureProtectedFiles([run.paths.sourcePlan, run.paths.tasks]);
			if (run.stopRequested || run.abort.signal.aborted) {
				task.attempts--;
				await pauseTask(run, task);
				return;
			}
			run.ctx.ui.setStatus(STATUS_KEY, `${task.id}: implementing (${task.attempts}/2)`);
			const worker = await runPi({
				cwd: run.ctx.cwd,
				prompt: workerPrompt(run.graph.sourcePlan, run.graph, task),
				model: modelName(run.ctx),
				thinkingLevel: run.ctx.thinkingLevel,
				tools: WORKER_TOOLS,
				extensions: [WORKER_GUARD],
				env: { PI_PLAN_PROTECTED_PATHS: JSON.stringify(snapshots.map((snapshot) => snapshot.path)) },
				signal: run.abort.signal,
			});
			const changed = await restoreChangedFiles(snapshots);

			if (run.stopRequested || worker.aborted) {
				await pauseTask(run, task);
				return;
			}

			let result: "passed" | "retry" | "failed";
			if (changed.length > 0) {
				result = applyAttemptResult(task, evidence(task, "integrity", 1, `Worker changed protected files:\n${changed.join("\n")}`), false);
			} else {
				const workerFailure = piFailure(worker);
				if (workerFailure) {
					result = applyAttemptResult(task, evidence(task, "worker", worker.code || 1, workerFailure), false);
				} else {
					run.phase = "verification";
					run.ctx.ui.setStatus(STATUS_KEY, `${task.id}: verifying`);
					const verification = await runVerification(task.verification, run.ctx.cwd, run.abort.signal);
					if (run.stopRequested || verification.aborted && !verification.timedOut) {
						await pauseTask(run, task);
						return;
					}
					const delayedChanges = await restoreChangedFiles(snapshots);
					if (delayedChanges.length > 0) {
						result = applyAttemptResult(task, evidence(task, "integrity", 1, `Protected files changed after worker exit:\n${delayedChanges.join("\n")}`), false);
					} else {
						const output = [verification.stdout, verification.stderr, verification.timedOut ? "Verification timed out after 10 minutes." : ""].filter(Boolean).join("\n");
						result = applyAttemptResult(task, evidence(task, "verification", verification.code, output, task.verification), verification.code === 0 && !verification.timedOut);
					}
				}
			}
			run.abort = undefined;
			if (result === "failed") run.graph.status = "failed";
			await saveTaskGraph(run.paths.tasks, run.graph);
			if (result === "failed") {
				report(run.ctx, `${task.id} failed after two attempts`, "error");
				return;
			}
		}

		run.graph.status = "paused";
		await saveTaskGraph(run.paths.tasks, run.graph);
	}

	async function startExecution(ctx: ExtensionCommandContext, paths: ReturnType<typeof planPaths>, graph: TaskGraph): Promise<void> {
		graph.status = "running";
		await saveTaskGraph(paths.tasks, graph);
		const run: ActiveRun = {
			paths,
			graph,
			ctx,
			phase: "worker",
			stopRequested: false,
			done: Promise.resolve(),
		};
		active = run;
		run.done = execute(run).catch(async (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (run.graph.status !== "completed") {
				run.graph.status = run.stopRequested ? "paused" : "failed";
				await saveTaskGraph(run.paths.tasks, run.graph).catch(() => {});
			}
			report(run.ctx, `Plan execution stopped: ${message}`, "error");
		}).finally(() => {
			run.ctx.ui.setStatus(STATUS_KEY, undefined);
			if (active === run) active = undefined;
		});
	}

	pi.registerCommand("execute-plan", {
		description: "Plan, approve, execute, verify, and audit a Markdown plan",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!ctx.hasUI) throw new Error("/execute-plan requires an interactive UI");
			if (active || planningAbort) {
				report(ctx, "A plan is already active", "warning");
				return;
			}
			if (!args.trim()) {
				report(ctx, "Usage: /execute-plan <plan.md>", "warning");
				return;
			}

			let sourcePath: string;
			try {
				sourcePath = await realpath(resolve(ctx.cwd, args.trim()));
			} catch {
				report(ctx, `Plan not found: ${args.trim()}`, "error");
				return;
			}
			try {
				modelName(ctx);
			} catch (error: unknown) {
				report(ctx, error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const paths = planPaths(sourcePath);
			const storedSourcePath = relative(ctx.cwd, sourcePath) || sourcePath;
			let existing: TaskGraph | undefined;
			if (await fileExists(paths.tasks)) {
				try {
					existing = normalizeForResume(await loadTaskGraph(paths.tasks));
					if (await realpath(resolve(ctx.cwd, existing.sourcePlan)) !== sourcePath) throw new Error("Task graph belongs to a different source plan");
				} catch (error: unknown) {
					report(ctx, `Cannot load ${relative(ctx.cwd, paths.tasks)}: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				if (existing.status === "completed") {
					report(ctx, `Plan already completed: ${relative(ctx.cwd, paths.tasks)}`, "info");
					return;
				}
				const choices = existing.status === "failed" ? ["Regenerate", "Cancel"] : ["Resume", "Regenerate", "Cancel"];
				const action = await ctx.ui.select("Unfinished task graph found", choices);
				if (action === "Resume") {
					report(ctx, `Resuming ${storedSourcePath}`, "info");
					await saveTaskGraph(paths.tasks, existing);
					await startExecution(ctx, paths, existing);
					return;
				}
				if (action !== "Regenerate") return;
				if (!await ctx.ui.confirm("Regenerate task graph?", "This discards all task state and evidence.")) return;
			}

			planningAbort = new AbortController();
			ctx.ui.setStatus(STATUS_KEY, "planning tasks");
			report(ctx, `Planning ${storedSourcePath}`, "info");
			try {
				const graph = await planAndApprove(ctx, sourcePath, storedSourcePath, existing);
				if (!graph) return;
				const baseline = await gitState(ctx.cwd);
				if (baseline.gitStatus && !await ctx.ui.confirm("Dirty worktree", `Existing changes will be recorded for the auditor:\n\n${baseline.gitStatus}\n\nContinue?`)) return;
				graph.baseline = baseline;
				await saveTaskGraph(paths.tasks, graph);
				report(ctx, "Plan approved. Keep this checkout read-only while workers run.", "warning");
				await startExecution(ctx, paths, graph);
			} catch (error: unknown) {
				if (!planningAbort.signal.aborted) report(ctx, error instanceof Error ? error.message : String(error), "error");
			} finally {
				planningAbort = undefined;
				if (!active) ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show plan execution status",
		handler: async (_args, ctx) => {
			if (planningAbort) {
				report(ctx, "Plan status: planning", "info");
				return;
			}
			if (!active) {
				report(ctx, "No active plan", "info");
				return;
			}
			const passed = active.graph.tasks.filter((task) => task.status === "passed").length;
			const failed = active.graph.tasks.find((task) => task.status === "failed");
			report(ctx, [
				`Plan: ${active.graph.sourcePlan}`,
				`Status: ${active.graph.status}`,
				`Phase: ${active.phase}`,
				`Task: ${active.currentTaskId ?? "none"}`,
				`Passed: ${passed}/${active.graph.tasks.length}`,
				failed ? `Failed: ${failed.id}` : "",
			].filter(Boolean).join("\n"), failed ? "error" : "info");
		},
	});

	pi.registerCommand("plan-stop", {
		description: "Stop and pause the active plan",
		handler: async (_args, ctx) => {
			if (planningAbort) {
				planningAbort.abort();
				report(ctx, "Planning stopped", "info");
				return;
			}
			if (!active) {
				report(ctx, "No active plan", "info");
				return;
			}
			active.stopRequested = true;
			active.abort?.abort();
			await active.done;
		},
	});

	pi.on("session_shutdown", async () => {
		planningAbort?.abort();
		if (!active) return;
		active.stopRequested = true;
		active.abort?.abort();
		await active.done;
	});
}
