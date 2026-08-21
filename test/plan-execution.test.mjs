import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import planExecutionExtension from "../extensions/plan-execution.ts";
import planWorkerGuard from "../extensions/plan-execution/worker-guard.ts";
import {
	applyAttemptResult,
	captureProtectedFiles,
	loadTaskGraph,
	nextReadyTask,
	normalizeForResume,
	parseTaskGraph,
	restoreChangedFiles,
	runPi,
	runVerification,
	saveTaskGraph,
} from "../extensions/plan-execution/core.ts";
import { activityFromPiEvent, PlanDashboard } from "../extensions/plan-execution/ui.ts";

function graph(tasks = [task("T001")]) {
	return {
		version: 1,
		sourcePlan: "plan.md",
		status: "approved",
		baseline: { gitStatus: "", gitDiff: "" },
		tasks,
	};
}

function task(id, dependsOn = []) {
	return {
		id,
		title: id,
		instructions: `Implement ${id}`,
		acceptance: [`${id} works`],
		dependsOn,
		expectedFiles: [],
		verification: "true",
		status: "pending",
		attempts: 0,
		evidence: [],
	};
}

async function temporaryDirectory(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function waitFor(check, timeout = 5_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = await check();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for plan execution");
}

function extensionHarness(directory, selection, options = {}) {
	const commands = new Map();
	const messages = [];
	const notifications = [];
	planExecutionExtension({
		registerCommand(name, command) { commands.set(name, command); },
		sendMessage(message) { messages.push(message); },
		on() {},
	});
	return {
		commands,
		messages,
		notifications,
		ctx: {
			cwd: directory,
			hasUI: true,
			mode: options.mode,
			model: { provider: "fake", id: "model" },
			thinkingLevel: "off",
			modelRegistry: { hasConfiguredAuth: () => true },
			waitForIdle: async () => {},
			ui: {
				select: async (_title, choices) => choices.includes(selection) ? selection : choices[0],
				confirm: async () => true,
				editor: async () => "",
				notify: (message, level) => notifications.push({ message, level }),
				setStatus: () => {},
				...options.ui,
			},
		},
	};
}

function useFakePi(t, path) {
	const previous = process.env.PI_PLAN_PI_BINARY;
	process.env.PI_PLAN_PI_BINARY = path;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PLAN_PI_BINARY;
		else process.env.PI_PLAN_PI_BINARY = previous;
	});
}

test("turns known Pi tool events into concise activity text", () => {
	assert.equal(activityFromPiEvent({ type: "tool_execution_start", toolName: "read", args: { path: "src/app.ts" } }), "Reading src/app.ts");
	assert.equal(activityFromPiEvent({ type: "tool_execution_start", toolName: "grep", args: { pattern: "parse", path: "test/" } }), "Searching test/ for parse");
	assert.equal(activityFromPiEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test\nrm -rf nope" } }), "Running npm test rm -rf nope");
	assert.equal(activityFromPiEvent({ type: "tool_execution_start", toolName: "unknown", args: {} }), undefined);
});

test("dashboard bounds activity history and confirms cancellation", async () => {
	let cancellations = 0;
	const tui = { terminal: { rows: 80 }, requestRender() {} };
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const dashboard = new PlanDashboard(tui, theme, "plan.md", "planning", () => { cancellations++; }, 10);
	for (let index = 0; index < 205; index++) dashboard.addActivity(`Activity ${index}`);
	assert.match(dashboard.render(100).join("\n"), /176 earlier activities/);

	dashboard.handleInput("\x1b");
	await new Promise((resolve) => setTimeout(resolve, 20));
	dashboard.handleInput("\x1b");
	assert.equal(cancellations, 0);
	dashboard.handleInput("\x1b");
	assert.equal(cancellations, 1);
	dashboard.dispose();
});

test("streams split Pi JSON events without letting observers change results", async (t) => {
	const directory = await temporaryDirectory(t);
	const fakePi = join(directory, "fake-pi.mjs");
	const event = JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "plan.md" } });
	const final = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } });
	await writeFile(fakePi, `#!/usr/bin/env node\nconst event = ${JSON.stringify(event)};\nprocess.stdout.write(event.slice(0, 20));\nsetTimeout(() => process.stdout.write(event.slice(20) + "\\n" + ${JSON.stringify(final)} + "\\n"), 10);\n`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);
	const events = [];

	const result = await runPi({ cwd: directory, prompt: "test", model: "fake/model", tools: [], onEvent(event) { events.push(event); throw new Error("UI failed"); } });
	assert.equal(events.length, 2);
	assert.equal(events[0].type, "tool_execution_start");
	assert.equal(result.output, "done");
	assert.equal(result.code, 0);
});

test("dashboard lifecycle failures do not stop planning or execution", async (t) => {
	const directory = await temporaryDirectory(t);
	const fakePi = join(directory, "fake-pi.mjs");
	await writeFile(join(directory, "plan.md"), "# Plan\n");
	await writeFile(fakePi, `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? "";
const emit = (text) => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));
if (prompt.includes("read-only implementation planner")) setTimeout(() => emit(JSON.stringify(${JSON.stringify(graph())})), 20);
else if (prompt.includes("implementation worker")) emit("done");
else if (prompt.includes("fresh read-only final auditor")) emit("No findings.");
else process.exit(2);
`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);
	const ui = {
		custom: (factory) => {
			const component = factory(
				{ terminal: { rows: 40 }, requestRender() {} },
				{ fg: (_color, text) => text, bold: (text) => text },
				{},
				() => {},
			);
			component.dispose();
			return Promise.reject(new Error("render failed"));
		},
	};
	const { commands, ctx, notifications } = extensionHarness(directory, "Approve and run", { mode: "tui", ui });

	await commands.get("execute-plan").handler("plan.md", ctx);
	await waitFor(() => loadTaskGraph(join(directory, "plan.tasks.json")).then(({ status }) => status === "completed").catch(() => false));
	assert.ok(notifications.some(({ message }) => message.includes("planning continues")));
	assert.ok(notifications.some(({ message }) => message.includes("Progress dashboard closed")));
});

test("plan commands leave durable visible feedback", async (t) => {
	const directory = await temporaryDirectory(t);
	const { commands, ctx, messages } = extensionHarness(directory, "");

	await commands.get("plan-status").handler("", ctx);
	assert.match(messages.at(-1).content, /No active plan/);
});

test("rejects malformed and cyclic task graphs", () => {
	assert.throws(() => parseTaskGraph({}), /version/);
	assert.throws(() => parseTaskGraph(graph([task("T001", ["T002"]), task("T002", ["T001"])])), /cycle/);
});

test("dispatches the first dependency-ready task in array order", () => {
	const first = task("T001");
	const second = task("T002", ["T001"]);
	const independent = task("T003");
	const value = graph([second, independent, first]);

	assert.equal(nextReadyTask(value)?.id, "T003");
	independent.status = "passed";
	assert.equal(nextReadyTask(value)?.id, "T001");
	first.status = "passed";
	assert.equal(nextReadyTask(value)?.id, "T002");
});

test("passes only successful verification and allows one repair", () => {
	const value = task("T001");
	value.attempts = 1;
	assert.equal(applyAttemptResult(value, { attempt: 1, kind: "verification", command: "true", exitCode: 1, output: "failed" }, false), "retry");
	assert.equal(value.status, "pending");

	value.attempts = 2;
	assert.equal(applyAttemptResult(value, { attempt: 2, kind: "verification", command: "true", exitCode: 1, output: "failed again" }, false), "failed");
	assert.equal(value.status, "failed");

	const passing = task("T002");
	passing.attempts = 1;
	assert.equal(applyAttemptResult(passing, { attempt: 1, kind: "verification", command: "true", exitCode: 0, output: "ok" }, true), "passed");
	assert.equal(passing.status, "passed");
});

test("restores protected files changed, deleted, renamed, chmodded, or hard-linked by a worker", async (t) => {
	const directory = await temporaryDirectory(t);
	const paths = ["changed.md", "deleted.json", "renamed.md", "mode.md", "linked.md"].map((name) => join(directory, name));
	await Promise.all(paths.map((path) => writeFile(path, "original", { mode: 0o600 })));
	const snapshots = await captureProtectedFiles(paths);
	await writeFile(paths[0], "worker change");
	await rm(paths[1]);
	await rename(paths[2], join(directory, "moved.md"));
	await chmod(paths[3], 0o400);
	const unrelated = join(directory, "unrelated.md");
	await writeFile(unrelated, "original");
	await rm(paths[4]);
	await link(unrelated, paths[4]);

	const restored = await restoreChangedFiles(snapshots);
	assert.deepEqual(restored.sort(), snapshots.map((snapshot) => snapshot.path).sort());
	assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), paths.map(() => "original"));
	assert.equal((await stat(paths[3])).mode & 0o777, 0o600);
	await writeFile(paths[4], "restored path changed");
	assert.equal(await readFile(unrelated, "utf8"), "original");
});

test("worker guard blocks path aliases without blocking unrelated new files", async (t) => {
	const directory = await temporaryDirectory(t);
	const protectedPath = join(directory, "plan.md");
	await writeFile(protectedPath, "plan");
	const previous = process.env.PI_PLAN_PROTECTED_PATHS;
	process.env.PI_PLAN_PROTECTED_PATHS = JSON.stringify([protectedPath]);
	let handler;
	planWorkerGuard({ on(name, callback) { if (name === "tool_call") handler = callback; } });
	if (previous === undefined) delete process.env.PI_PLAN_PROTECTED_PATHS;
	else process.env.PI_PLAN_PROTECTED_PATHS = previous;

	assert.equal(handler({ toolName: "write", input: { path: join(directory, "nested", "..", "plan.md") } }, { cwd: directory }).block, true);
	assert.equal(handler({ toolName: "write", input: { path: "new/deep/file.ts" } }, { cwd: directory }), undefined);
});

test("normalizes stale running state and preserves it across persistence", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "plan.tasks.json");
	const value = graph();
	value.status = "running";
	value.tasks[0].status = "running";
	value.tasks[0].attempts = 1;

	const normalized = normalizeForResume(value);
	assert.equal(normalized.status, "paused");
	assert.equal(normalized.tasks[0].status, "pending");
	assert.equal(normalized.tasks[0].attempts, 1);
	await saveTaskGraph(path, normalized);
	assert.deepEqual(await loadTaskGraph(path), normalized);
});

test("cleans up pipe-inheriting background descendants before verification returns", async (t) => {
	const directory = await temporaryDirectory(t);
	const delayed = join(directory, "delayed.txt");
	const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(delayed)}, "escaped"), 300); setInterval(() => {}, 1000)`;
	const result = await runVerification(`node -e ${JSON.stringify(script)} &`, directory, undefined, 2_000);
	assert.equal(result.code, 0);
	assert.equal(result.timedOut, false);
	await new Promise((resolve) => setTimeout(resolve, 500));
	await assert.rejects(readFile(delayed));
});

test("resume does not grant a third worker attempt", async (t) => {
	const directory = await temporaryDirectory(t);
	const planPath = join(directory, "plan.md");
	const tasksPath = join(directory, "plan.tasks.json");
	const fakePi = join(directory, "fake-pi.mjs");
	const marker = join(directory, "spawned.txt");
	await writeFile(planPath, "# Plan\n");
	const value = graph();
	value.status = "paused";
	value.tasks[0].attempts = 2;
	await saveTaskGraph(tasksPath, value);
	await writeFile(fakePi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\n`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);
	const { commands, ctx } = extensionHarness(directory, "Resume");

	await commands.get("execute-plan").handler("plan.md", ctx);
	const failed = await waitFor(async () => (await loadTaskGraph(tasksPath)).status === "failed");
	assert.equal(failed, true);
	assert.equal((await loadTaskGraph(tasksPath)).tasks[0].attempts, 2);
	await assert.rejects(readFile(marker));
});

test("an immediate stop pauses before spawning a worker", async (t) => {
	const directory = await temporaryDirectory(t);
	const planPath = join(directory, "plan.md");
	const tasksPath = join(directory, "plan.tasks.json");
	const fakePi = join(directory, "fake-pi.mjs");
	const marker = join(directory, "spawned.txt");
	await writeFile(planPath, "# Plan\n");
	const value = graph();
	value.status = "paused";
	await saveTaskGraph(tasksPath, value);
	await writeFile(fakePi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\n`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);
	const { commands, ctx } = extensionHarness(directory, "Resume");

	await commands.get("execute-plan").handler("plan.md", ctx);
	await commands.get("plan-stop").handler("", ctx);
	const paused = await loadTaskGraph(tasksPath);
	assert.equal(paused.status, "paused");
	assert.equal(paused.tasks[0].status, "pending");
	assert.equal(paused.tasks[0].attempts, 0);
	await assert.rejects(readFile(marker));
});

test("confirmed dashboard cancellation pauses the active worker", async (t) => {
	const directory = await temporaryDirectory(t);
	const planPath = join(directory, "plan.md");
	const tasksPath = join(directory, "plan.tasks.json");
	const fakePi = join(directory, "fake-pi.mjs");
	const marker = join(directory, "worker-started.txt");
	await writeFile(planPath, "# Plan\n");
	const value = graph();
	value.status = "paused";
	await saveTaskGraph(tasksPath, value);
	await writeFile(fakePi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\nsetInterval(() => {}, 1_000);\n`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);

	let dashboard;
	const ui = {
		custom: (factory) => new Promise((resolve) => {
			const tui = { terminal: { rows: 40 }, requestRender() {} };
			const theme = { fg: (_color, text) => text, bold: (text) => text };
			dashboard = factory(tui, theme, {}, (result) => {
				dashboard?.dispose();
				resolve(result);
			});
		}),
	};
	const { commands, ctx } = extensionHarness(directory, "Resume", { mode: "tui", ui });
	const execution = commands.get("execute-plan").handler("plan.md", ctx);
	await waitFor(async () => dashboard && await readFile(marker, "utf8").catch(() => undefined));

	dashboard.handleInput("\x1b");
	assert.equal((await loadTaskGraph(tasksPath)).status, "running");
	dashboard.handleInput("\x1b");
	await execution;

	const paused = await loadTaskGraph(tasksPath);
	assert.equal(paused.status, "paused");
	assert.equal(paused.tasks[0].status, "pending");
	assert.equal(paused.tasks[0].attempts, 1);
});

test("cancellation restores protected files changed by verification", async (t) => {
	const directory = await temporaryDirectory(t);
	const planPath = join(directory, "plan.md");
	const tasksPath = join(directory, "plan.tasks.json");
	const fakePi = join(directory, "fake-pi.mjs");
	await writeFile(planPath, "# Original plan\n");
	const value = graph();
	value.status = "paused";
	value.tasks[0].verification = `printf changed > ${JSON.stringify(planPath)}; sleep 10`;
	await saveTaskGraph(tasksPath, value);
	await writeFile(fakePi, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }));\n`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);

	let dashboard;
	const ui = {
		custom: (factory) => new Promise((resolve) => {
			const tui = { terminal: { rows: 40 }, requestRender() {} };
			const theme = { fg: (_color, text) => text, bold: (text) => text };
			dashboard = factory(tui, theme, {}, (result) => {
				dashboard?.dispose();
				resolve(result);
			});
		}),
	};
	const { commands, ctx } = extensionHarness(directory, "Resume", { mode: "tui", ui });
	const execution = commands.get("execute-plan").handler("plan.md", ctx);
	await waitFor(async () => await readFile(planPath, "utf8") === "changed");

	dashboard.handleInput("\x1b");
	dashboard.handleInput("\x1b");
	await execution;

	assert.equal(await readFile(planPath, "utf8"), "# Original plan\n");
	assert.equal((await loadTaskGraph(tasksPath)).status, "paused");
});

test("launches one fresh repair worker, writes a successful audit, and preserves completed state", async (t) => {
	const directory = await temporaryDirectory(t);
	const planPath = join(directory, "plan.md");
	const fakePi = join(directory, "fake-pi.mjs");
	await writeFile(planPath, "# Repair plan\n\nCreate fixed.txt.\n");
	assert.equal((await runVerification("git init -q", directory, undefined, 10_000)).code, 0);
	await writeFile(join(directory, "baseline.txt"), "staged baseline\n");
	assert.equal((await runVerification("git add baseline.txt", directory, undefined, 10_000)).code, 0);
	await writeFile(fakePi, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const prompt = process.argv.at(-1) ?? "";
const emit = (text) => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));
if (prompt.includes("read-only implementation planner")) {
  emit(JSON.stringify(${JSON.stringify(graph([{ ...task("T001"), expectedFiles: ["fixed.txt"], verification: "test -f fixed.txt" }]))}));
} else if (prompt.includes("implementation worker")) {
  const countPath = join(process.cwd(), "worker-count.txt");
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  writeFileSync(countPath, String(count));
  if (count === 2) writeFileSync(join(process.cwd(), "fixed.txt"), "fixed\\n");
  emit("worker " + count);
} else if (prompt.includes("fresh read-only final auditor")) {
  writeFileSync(join(process.cwd(), "audit-prompt.txt"), prompt);
  emit("# Audit\\n\\nNo findings.");
} else {
  process.exit(2);
}
`);
	await chmod(fakePi, 0o755);
	useFakePi(t, fakePi);
	const { commands, ctx } = extensionHarness(directory, "Approve and run");

	await commands.get("execute-plan").handler("plan.md", ctx);
	await waitFor(() => readFile(join(directory, "plan.audit.md"), "utf8").catch(() => undefined));
	const completed = await loadTaskGraph(join(directory, "plan.tasks.json"));
	assert.equal(completed.status, "completed");
	assert.equal(completed.tasks[0].attempts, 2);
	assert.deepEqual(completed.tasks[0].evidence.map(({ exitCode }) => exitCode), [1, 0]);
	assert.equal(await readFile(join(directory, "worker-count.txt"), "utf8"), "2");
	assert.match(await readFile(join(directory, "plan.audit.md"), "utf8"), /No findings/);
	assert.match(await readFile(join(directory, "audit-prompt.txt"), "utf8"), /## Staged[\s\S]*staged baseline/);

	const reloaded = extensionHarness(directory, "Approve and run");
	await reloaded.commands.get("execute-plan").handler("plan.md", reloaded.ctx);
	assert.match(reloaded.notifications.at(-1).message, /already completed/);
	assert.equal(await readFile(join(directory, "worker-count.txt"), "utf8"), "2");
});

test("unauthenticated resume leaves executable state untouched", async (t) => {
	const directory = await temporaryDirectory(t);
	await writeFile(join(directory, "plan.md"), "# Plan\n");
	const value = graph();
	value.status = "paused";
	await saveTaskGraph(join(directory, "plan.tasks.json"), value);
	const { commands, ctx, notifications } = extensionHarness(directory, "Resume");
	ctx.modelRegistry.hasConfiguredAuth = () => false;

	await commands.get("execute-plan").handler("plan.md", ctx);
	assert.equal((await loadTaskGraph(join(directory, "plan.tasks.json"))).status, "paused");
	assert.match(notifications.at(-1).message, /No authenticated active model/);
});

test("executes an approved two-task plan and keeps completion when the advisory audit fails", async (t) => {
	const directory = await temporaryDirectory(t);
	const planPath = join(directory, "plan.md");
	const fakePi = join(directory, "fake-pi.mjs");
	await writeFile(planPath, "# Build markers\n\nCreate first.txt, then second.txt.\n");
	await writeFile(fakePi, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const prompt = process.argv.at(-1) ?? "";
const emit = (text) => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }));
if (prompt.includes("read-only implementation planner")) {
  emit(JSON.stringify(${JSON.stringify(graph([
		{ ...task("T001"), expectedFiles: ["first.txt"], verification: "test -f first.txt" },
		{ ...task("T002", ["T001"]), expectedFiles: ["second.txt"], verification: "test -f second.txt" },
	]))}));
} else if (prompt.includes("implementation worker")) {
  const name = prompt.includes("Task: T001") ? "first.txt" : "second.txt";
  writeFileSync(join(process.cwd(), name), "done\\n");
  emit("implemented " + name);
} else if (prompt.includes("fresh read-only final auditor")) {
  process.exit(1);
} else {
  process.exit(2);
}
`);
	await chmod(fakePi, 0o755);

	useFakePi(t, fakePi);
	const { commands, notifications, ctx } = extensionHarness(directory, "Approve and run", { mode: "rpc" });

	await commands.get("execute-plan").handler("plan.md", ctx);
	const completed = await waitFor(async () => {
		try {
			const value = JSON.parse(await readFile(join(directory, "plan.tasks.json"), "utf8"));
			return value.status === "completed" ? value : undefined;
		} catch {
			return undefined;
		}
	});

	assert.deepEqual(completed.tasks.map(({ status }) => status), ["passed", "passed"]);
	assert.deepEqual(completed.tasks.map(({ evidence }) => evidence.at(-1).exitCode), [0, 0]);
	assert.deepEqual(await Promise.all(["first.txt", "second.txt"].map((name) => readFile(join(directory, name), "utf8"))), ["done\n", "done\n"]);
	await waitFor(() => notifications.some(({ message }) => message.includes("audit failed")));
});
