import fs from "node:fs";
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

interface SessionReference {
	dir: string;
	id: string;
}

const FERRIS_STATES = new Set([
	"queued",
	"running",
	"interrupting",
	"interrupted",
	"settling",
	"completed",
	"failed",
	"stopped",
]);

export function collectFerris(toolResults: AttributedToolResult[]): CollectorSummary {
	const contributions = new Map<string, number>();
	const referencedRuns = new Set<string>();
	const runsWithInlineUsage = new Set<string>();
	const runsWithParentReportedUsage = new Set<string>();
	const fallbackReferences = new Map<string, SessionReference | null>();

	for (const result of toolResults) {
		const runs = ferrisLaunchRuns(result);
		for (const run of runs) {
			const identity = runIdentity(result.sessionFile, run.runId as number);
			referencedRuns.add(identity);
			if (reportedToolCost(result.usage) !== undefined) runsWithParentReportedUsage.add(identity);
		}
	}

	for (const result of toolResults) {
		if (reportedToolCost(result.usage) === undefined) continue;
		for (const run of ferrisStatusRuns(result)) {
			const identity = runIdentity(result.sessionFile, run.id as number);
			if (referencedRuns.has(identity)) runsWithParentReportedUsage.add(identity);
		}
	}

	for (const result of toolResults) {
		for (const run of ferrisLaunchRuns(result)) {
			if (run.exitCode === -1) continue;
			const identity = runIdentity(result.sessionFile, run.runId as number);
			if (runsWithParentReportedUsage.has(identity)) continue;
			recordInlineUsage(contributions, runsWithInlineUsage, identity, run);
			const reference = sessionReference(run, result.cwd);
			if (reference) recordFallbackReference(fallbackReferences, identity, reference);
		}

		for (const run of ferrisStatusRuns(result)) {
			const identity = runIdentity(result.sessionFile, run.id as number);
			if (!referencedRuns.has(identity) || runsWithParentReportedUsage.has(identity)) continue;
			recordInlineUsage(contributions, runsWithInlineUsage, identity, run);
		}
	}

	for (const [identity, reference] of fallbackReferences) {
		if (runsWithInlineUsage.has(identity) || reference === null) continue;
		const sessionFile = resolveSessionFile(reference);
		if (!sessionFile) continue;
		const cost = sumStandardPiSessionFile(sessionFile, reference.id);
		if (cost !== undefined) contributions.set(identity, cost);
	}

	return {
		cost: sumContributions(contributions),
		count: contributions.size,
	};
}

function ferrisLaunchRuns(result: AttributedToolResult): Array<Record<string, unknown> & { runId: number }> {
	if (result.toolName !== "subagent") return [];
	const details = asRecord(result.details);
	if (!details || !Array.isArray(details.results) || typeof details.background !== "boolean") return [];
	if (details.mode !== "single" && details.mode !== "parallel") return [];
	return details.results
		.map(asRecord)
		.filter((run): run is Record<string, unknown> & { runId: number } => ferrisLaunchRunId(run) !== undefined);
}

function ferrisLaunchRunId(run: Record<string, unknown> | null): number | undefined {
	if (!run || typeof run.runId !== "number" || !Number.isInteger(run.runId) || run.runId < 1) return undefined;
	if (typeof run.agent !== "string" || typeof run.task !== "string") return undefined;
	if (typeof run.exitCode !== "number" || !Array.isArray(run.messages) || typeof run.stderr !== "string") return undefined;
	if (typeof run.projectCwd !== "string" || (run.isolation !== "shared" && run.isolation !== "worktree")) return undefined;
	return run.runId;
}

function ferrisStatusRuns(result: AttributedToolResult): Array<Record<string, unknown> & { id: number }> {
	if (result.toolName !== "subagent_status") return [];
	const details = asRecord(result.details);
	if (!details || !Array.isArray(details.runs)) return [];
	return details.runs
		.map(asRecord)
		.filter((run): run is Record<string, unknown> & { id: number } => {
			return run !== null
				&& typeof run.id === "number"
				&& Number.isInteger(run.id)
				&& run.id >= 1
				&& typeof run.agent === "string"
				&& typeof run.state === "string"
				&& FERRIS_STATES.has(run.state);
		});
}

function recordInlineUsage(
	contributions: Map<string, number>,
	runsWithInlineUsage: Set<string>,
	identity: string,
	run: Record<string, unknown>,
): void {
	const cost = finiteNonNegative(asRecord(run.usage)?.cost);
	if (cost === undefined) return;
	runsWithInlineUsage.add(identity);
	setGreatestContribution(contributions, identity, cost);
}

function runIdentity(sessionFile: string, runId: number): string {
	return `ferris:${sessionFile}:${runId}`;
}

function sessionReference(run: Record<string, unknown>, cwd: string | undefined): SessionReference | undefined {
	if (typeof run.sessionDir !== "string" || run.sessionDir.length === 0) return undefined;
	if (typeof run.sessionId !== "string" || run.sessionId.length === 0) return undefined;
	return {
		dir: path.resolve(cwd ?? process.cwd(), run.sessionDir),
		id: run.sessionId,
	};
}

function recordFallbackReference(
	references: Map<string, SessionReference | null>,
	identity: string,
	reference: SessionReference,
): void {
	const previous = references.get(identity);
	if (!references.has(identity)) {
		references.set(identity, reference);
	} else if (previous === null || previous === undefined || previous.dir !== reference.dir || previous.id !== reference.id) {
		references.set(identity, null);
	}
}

function resolveSessionFile(reference: SessionReference): string | undefined {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(reference.dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const suffix = `_${reference.id}.jsonl`;
	const matches = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
	return matches.length === 1 ? path.join(reference.dir, matches[0]!.name) : undefined;
}

function reportedToolCost(value: unknown): number | undefined {
	return finiteNonNegative(asRecord(asRecord(value)?.cost)?.total);
}
