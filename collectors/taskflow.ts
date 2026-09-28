import path from "node:path";

import {
	asRecord,
	contentText,
	finiteNonNegative,
	readJsonFile,
	readJsonLines,
	sumContributions,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

interface TaskflowRunReference {
	cwd: string;
}

interface TaskflowIndexEntry {
	runId?: string;
	relPath?: string;
}

interface TaskflowRunState {
	runId?: string;
	flowName?: string;
	parentRunId?: string;
	createdAt?: number;
	phases?: Record<string, TaskflowPhaseState>;
}

interface TaskflowPhaseState {
	status?: string;
	cacheHit?: string;
	startedAt?: number;
	endedAt?: number;
	model?: string;
	usage?: { cost?: number };
}

export function collectTaskflow(toolResults: AttributedToolResult[]): CollectorSummary {
	const runs = new Map<string, TaskflowRunReference>();
	for (const result of toolResults) {
		if (result.toolName !== "taskflow") continue;
		for (const [runId, reference] of extractTaskflowRuns(result)) {
			const previous = runs.get(runId);
			runs.set(runId, previous && reference.fromState === false
				? { cwd: previous.cwd }
				: { cwd: reference.cwd });
		}
	}
	return {
		cost: sumContributions(collectTaskflowContributions(runs)),
		count: runs.size,
	};
}

function extractTaskflowRuns(
	result: AttributedToolResult,
): Map<string, { cwd: string; fromState: boolean }> {
	const found = new Map<string, { cwd: string; fromState: boolean }>();
	const details = asRecord(result.details);
	const state = asRecord(details?.state);
	if (typeof state?.runId === "string") {
		const stateCwd = typeof state.cwd === "string" ? state.cwd : result.cwd;
		if (stateCwd) found.set(state.runId, { cwd: stateCwd, fromState: true });
	}
	if (result.cwd) {
		for (const match of contentText(result.content).matchAll(/\bRun id:\s*([A-Za-z0-9._-]+)/g)) {
			if (match[1] && !found.has(match[1])) found.set(match[1], { cwd: result.cwd, fromState: false });
		}
	}
	return found;
}

function collectTaskflowContributions(
	runs: Map<string, TaskflowRunReference>,
): Map<string, number> {
	const contributions = new Map<string, number>();
	const fallbackFingerprints = new Set<string>();
	for (const [runId, reference] of runs) {
		const loaded = loadTaskflowRun(reference.cwd, runId);
		if (!loaded) continue;
		const traceEntries = readJsonLines(loaded.traceFile);
		let usableCostCount = 0;
		for (let index = 0; index < traceEntries.length; index++) {
			const event = asRecord(traceEntries[index]);
			if (event?.kind !== "subagent-call") continue;
			const output = asRecord(event.output);
			const usage = asRecord(output?.usage);
			const cost = finiteNonNegative(usage?.cost);
			if (cost !== undefined) {
				usableCostCount++;
				contributions.set(`taskflow:${runId}:${index}`, cost);
			}
		}
		if (usableCostCount > 0) continue;
		collectTaskflowSnapshotFallback(loaded.state, fallbackFingerprints, contributions);
	}
	return contributions;
}

function loadTaskflowRun(cwd: string, runId: string): { state: TaskflowRunState; traceFile: string } | null {
	const runsRoot = path.join(cwd, ".pi", "taskflows", "runs");
	const index = readJsonFile(path.join(runsRoot, "index.json"));
	if (!Array.isArray(index)) return null;
	const item = index
		.map((entry) => asRecord(entry) as TaskflowIndexEntry | null)
		.find((entry) => entry?.runId === runId && typeof entry.relPath === "string");
	if (!item?.relPath) return null;
	const stateFile = path.resolve(runsRoot, item.relPath);
	const resolvedRoot = path.resolve(runsRoot);
	if (stateFile !== resolvedRoot && !stateFile.startsWith(`${resolvedRoot}${path.sep}`)) return null;
	const state = readJsonFile(stateFile) as TaskflowRunState | null;
	if (!state || state.runId !== runId) return null;
	return { state, traceFile: stateFile.replace(/\.json$/, ".trace.jsonl") };
}

function collectTaskflowSnapshotFallback(
	state: TaskflowRunState,
	fingerprints: Set<string>,
	contributions: Map<string, number>,
): void {
	for (const [phaseId, phase] of Object.entries(state.phases ?? {})) {
		if (phase.cacheHit) continue;
		if (state.parentRunId && typeof phase.endedAt === "number" && typeof state.createdAt === "number"
			&& phase.endedAt < state.createdAt) continue;
		const cost = finiteNonNegative(phase.usage?.cost);
		if (cost === undefined) continue;
		const fingerprint = [
			state.flowName ?? "",
			phaseId,
			phase.startedAt ?? "",
			phase.endedAt ?? "",
			phase.model ?? "",
			cost,
		].join(":");
		if (fingerprints.has(fingerprint)) continue;
		fingerprints.add(fingerprint);
		contributions.set(`taskflow-fallback:${fingerprint}`, cost);
	}
}
