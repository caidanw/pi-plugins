import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function undoExtension(pi: ExtensionAPI) {
	pi.registerCommand("undo", {
		description: "Undo the latest user turn",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			let targetId: string | undefined;
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "user") {
					targetId = entry.id;
					break;
				}
			}

			if (!targetId) {
				ctx.ui.notify("Nothing to undo", "info");
				return;
			}

			const result = await ctx.navigateTree(targetId, { summarize: false });
			ctx.ui.notify(result.cancelled ? "Undo cancelled" : "Undid last turn", result.cancelled ? "warning" : "info");
		},
	});
}
