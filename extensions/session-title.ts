import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHEAP_MODEL_IDS = ["gpt-5.4-nano", "gpt-5.4-mini", "gemini-3-flash", "claude-haiku-4-5"];
const MAX_CONTEXT_CHARS = 24_000;

type NamedModel = { id: string };
type MessageEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

export function titleModelCandidates<T extends NamedModel>(available: readonly T[], active?: T): T[] {
	const models = CHEAP_MODEL_IDS.flatMap((id) => available.find((candidate) => candidate.id === id) ?? []);
	if (active && !models.includes(active)) models.push(active);
	return models;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function conversation(entries: MessageEntry[]): string {
	const transcript = entries.flatMap((entry) => {
		const message = entry.message;
		const role = message?.role;
		if (entry.type !== "message" || !message || (role !== "user" && role !== "assistant")) return [];
		const content = text(message.content).trim();
		return content ? [`${role}: ${content}`] : [];
	}).join("\n");

	if (transcript.length <= MAX_CONTEXT_CHARS) return transcript;
	return `${transcript.slice(0, MAX_CONTEXT_CHARS / 2)}\n[…]\n${transcript.slice(-MAX_CONTEXT_CHARS / 2)}`;
}

function cleanTitle(value: string): string {
	return value
		.replace(/^[\s#*`"']+|[\s#*`"']+$/g, "")
		.replace(/\s+/g, " ")
		.slice(0, 80)
		.trim();
}

async function generateTitle(ctx: ExtensionContext, transcript: string): Promise<string> {
	const model = titleModelCandidates(ctx.modelRegistry.getAvailable(), ctx.model)
		.find((candidate) => ctx.modelRegistry.hasConfiguredAuth(candidate));
	if (!model) throw new Error("No authenticated model available for session naming");

	const response = await ctx.modelRegistry.complete(model, {
		systemPrompt: "Create stable, concise coding-session titles. Output only the title.",
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: `Name this coding session in 3-7 words. Describe the overall task, not recent progress, status, or next steps.\n\n<conversation>\n${transcript}\n</conversation>`,
			}],
			timestamp: Date.now(),
		}],
	}, {
		maxTokens: 40,
		cacheRetention: "none",
		signal: AbortSignal.timeout(15_000),
	});

	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Title generation failed");
	return cleanTitle(response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(" "));
}

export default function sessionTitleExtension(pi: ExtensionAPI) {
	let shouldAutoName = false;

	async function nameSession(ctx: ExtensionContext, transcript: string) {
		try {
			const title = await generateTitle(ctx, transcript);
			if (!title) throw new Error("Title model returned an empty response");
			pi.setSessionName(title);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not name session: ${message}`, "warning");
		}
	}

	pi.on("session_start", (_event, ctx) => {
		const hasAssistantReply = ctx.sessionManager.getBranch().some(
			(entry) => entry.type === "message" && entry.message?.role === "assistant",
		);
		shouldAutoName = !pi.getSessionName() && !hasAssistantReply;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!shouldAutoName || pi.getSessionName()) return;
		shouldAutoName = false;
		await nameSession(ctx, conversation(ctx.sessionManager.getBranch()));
	});

	pi.registerCommand("rename-session", {
		description: "Regenerate the session title from the conversation",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const transcript = conversation(ctx.sessionManager.getBranch());
			if (!transcript) {
				ctx.ui.notify("Nothing to name yet", "info");
				return;
			}
			await nameSession(ctx, transcript);
		},
	});
}
