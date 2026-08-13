import assert from "node:assert/strict";
import test from "node:test";
import { titleModelCandidates } from "../extensions/session-title.ts";

test("session titles try cheap models before the active model", () => {
	const active = { id: "claude-opus-4-6" };
	const mini = { id: "gpt-5.4-mini" };
	const haiku = { id: "claude-haiku-4-5" };

	assert.deepEqual(titleModelCandidates([active, haiku, mini], active), [mini, haiku, active]);
	assert.deepEqual(titleModelCandidates([active], active), [active]);
});
