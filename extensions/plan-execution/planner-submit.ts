import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const task = Type.Object({
	id: Type.String({ description: "Unique stable task ID such as T001" }),
	title: Type.String({ description: "Short task title" }),
	instructions: Type.String({ description: "Bounded implementation instructions" }),
	acceptance: Type.Array(Type.String(), { minItems: 1, description: "Observable acceptance criteria" }),
	dependsOn: Type.Array(Type.String(), { description: "IDs of prerequisite tasks" }),
	expectedFiles: Type.Array(Type.String(), { description: "Repository-relative files likely to change" }),
	verification: Type.String({ description: "One non-interactive project-local shell command that gates completion" }),
}, { additionalProperties: false });

export default function plannerSubmit(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "submit_task_graph",
		label: "Submit task graph",
		description: "Submit the final complete implementation task DAG. Use this exactly once as your final action.",
		parameters: Type.Object({
			tasks: Type.Array(task, { minItems: 1, description: "Complete dependency-ordered implementation tasks" }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Submitted ${params.tasks.length} tasks.` }],
				details: { tasks: params.tasks },
				terminate: true,
			};
		},
	});
}
