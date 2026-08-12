import assert from "node:assert/strict";
import test from "node:test";
import undoExtension from "../extensions/undo.ts";

test("/undo navigates to the latest user turn without a summary", async () => {
	let command;
	undoExtension({
		registerCommand(name, options) {
			assert.equal(name, "undo");
			command = options;
		},
	});

	let navigation;
	await command.handler("", {
		waitForIdle: async () => {},
		sessionManager: {
			getBranch: () => [
				{ id: "user-1", type: "message", message: { role: "user" } },
				{ id: "assistant-1", type: "message", message: { role: "assistant" } },
				{ id: "user-2", type: "message", message: { role: "user" } },
				{ id: "assistant-2", type: "message", message: { role: "assistant" } },
			],
		},
		navigateTree: async (targetId, options) => {
			navigation = { targetId, options };
			return { cancelled: false };
		},
		ui: { notify: () => {} },
	});

	assert.deepEqual(navigation, { targetId: "user-2", options: { summarize: false } });
});
