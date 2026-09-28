import path from "node:path";

import {
	asRecord,
	finiteNonNegative,
	setGreatestContribution,
	sumContributions,
	sumStandardPiSessionFile,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const J0K3R_TOOL_NAMES = new Set([
	"subagent_run",
	"subagent_continue",
	"subagent_status",
	"subagent_result",
	"subagent_list_tasks",
	"subagent_cancel",
]);

export function collectJ0k3r(toolResults: AttributedToolResult[]): CollectorSummary {
	const contributions = new Map<string, number>();
	const tasksWithInlineUsage = new Set<string>();
	const fallbackPaths = new Map<string, string | null>();
	const tasksWithParentReportedUsage = new Set<string>();

	for (const result of toolResults) {
		if (!J0K3R_TOOL_NAMES.has(result.toolName)) continue;
		const usage = asRecord(result.usage);
		const reportedCost = finiteNonNegative(asRecord(usage?.cost)?.total);
		if (reportedCost === undefined) continue;
		for (const task of tasksFromDetails(result.details)) {
			const taskId = j0k3rTaskId(task);
			if (taskId) tasksWithParentReportedUsage.add(scopedTaskId(result.sessionFile, taskId));
		}
	}
	for (const result of toolResults) {
		if (!J0K3R_TOOL_NAMES.has(result.toolName)) continue;
		for (const task of tasksFromDetails(result.details)) {
			const taskId = j0k3rTaskId(task);
			if (!taskId) continue;
			const identity = scopedTaskId(result.sessionFile, taskId);
			if (tasksWithParentReportedUsage.has(identity)) continue;

			const attemptValue = finiteNonNegative(task.attempt);
			const attempt = attemptValue !== undefined && Number.isInteger(attemptValue) && attemptValue >= 1
				? attemptValue
				: 1;
			const usage = asRecord(task.usage);
			const cost = finiteNonNegative(usage?.cost);
			if (cost !== undefined) {
				tasksWithInlineUsage.add(identity);
				setGreatestContribution(contributions, `j0k3r:${result.sessionFile}:${taskId}:${attempt}`, cost);
			}

			if (typeof task.nested_session_path === "string" && task.nested_session_path.length > 0) {
				const resolvedPath = path.resolve(result.cwd ?? process.cwd(), task.nested_session_path);
				const previousPath = fallbackPaths.get(identity);
				if (!fallbackPaths.has(identity)) fallbackPaths.set(identity, resolvedPath);
				else if (previousPath !== resolvedPath) fallbackPaths.set(identity, null);
			}
		}
	}

	for (const [identity, sessionPath] of fallbackPaths) {
		if (tasksWithInlineUsage.has(identity) || sessionPath === null) continue;
		const cost = sumStandardPiSessionFile(sessionPath);
		if (cost !== undefined) contributions.set(`j0k3r-session:${sessionPath}`, cost);
	}

	return {
		cost: sumContributions(contributions),
		count: contributions.size,
	};
}

function scopedTaskId(sessionFile: string, taskId: string): string {
	return `${sessionFile}\0${taskId}`;
}

function j0k3rTaskId(task: Record<string, unknown>): string | undefined {
	return typeof task.id === "string" && task.id.startsWith("subtask_") ? task.id : undefined;
}

function tasksFromDetails(details: unknown): Record<string, unknown>[] {
	const record = asRecord(details);
	if (!record) return [];
	const tasks: Record<string, unknown>[] = [];
	const task = asRecord(record.task);
	if (task) tasks.push(task);
	for (const key of ["tasks", "results"] as const) {
		const values = record[key];
		if (!Array.isArray(values)) continue;
		for (const value of values) {
			const item = asRecord(value);
			if (item) tasks.push(item);
		}
	}
	return tasks;
}
