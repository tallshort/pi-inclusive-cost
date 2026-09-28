import { isDeepStrictEqual } from "node:util";

import {
	asRecord,
	finiteNonNegative,
	setGreatestContribution,
	sumContributions,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

interface ArchimedesResult {
	identity: string;
	record: Record<string, unknown>;
}

export function collectArchimedes(toolResults: AttributedToolResult[]): CollectorSummary {
	const contributions = new Map<string, number>();
	const parentReported = new Set<string>();

	for (const result of toolResults) {
		if (reportedToolCost(result.usage) === undefined) continue;
		for (const child of archimedesResults(result)) parentReported.add(child.identity);
	}

	for (const result of toolResults) {
		for (const child of archimedesResults(result)) {
			if (parentReported.has(child.identity)) continue;
			const cost = finiteNonNegative(asRecord(child.record.usage)?.cost);
			if (cost !== undefined) setGreatestContribution(contributions, child.identity, cost);
		}
	}

	return {
		cost: sumContributions(contributions),
		count: contributions.size,
	};
}

function archimedesResults(result: AttributedToolResult): ArchimedesResult[] {
	if (result.toolName !== "subagent") return [];
	const details = asRecord(result.details);
	if (!details || !Array.isArray(details.results) || !Array.isArray(details.progress)) return [];
	if (details.mode !== "single" && details.mode !== "parallel") return [];
	if (details.progress.length !== details.results.length) return [];

	const children: ArchimedesResult[] = [];
	for (let index = 0; index < details.results.length; index++) {
		const record = asRecord(details.results[index]);
		const progress = asRecord(details.progress[index]);
		if (!isArchimedesResult(record, progress)) continue;
		const identity = archimedesIdentity(result, record, index);
		if (identity) children.push({ identity, record });
	}
	return children;
}

function isArchimedesResult(
	result: Record<string, unknown> | null,
	detailsProgress: Record<string, unknown> | null,
): result is Record<string, unknown> {
	if (!result || !detailsProgress || typeof result.agent !== "string" || typeof result.task !== "string") return false;
	if (typeof result.exitCode !== "number") return false;
	if (result.childSessionId !== undefined && typeof result.childSessionId !== "string") return false;
	if (result.model !== undefined && typeof result.model !== "string") return false;
	if (result.finalOutput !== undefined && typeof result.finalOutput !== "string") return false;
	if (result.error !== undefined && typeof result.error !== "string") return false;

	const progress = asRecord(result.progress);
	if (!progress || (progress.status !== "completed" && progress.status !== "failed")) return false;
	if (progress.agent !== result.agent || progress.task !== result.task) return false;
	for (const field of ["toolCount", "inputTokens", "outputTokens", "tokens", "cost", "durationMs"] as const) {
		if (finiteNonNegative(progress[field]) === undefined) return false;
	}
	if (!isDeepStrictEqual(detailsProgress, progress)) return false;

	const summary = asRecord(result.progressSummary);
	if (!summary || finiteNonNegative(summary.toolCount) === undefined
		|| finiteNonNegative(summary.tokens) === undefined
		|| finiteNonNegative(summary.durationMs) === undefined) return false;
	if (summary.toolCount !== progress.toolCount || summary.tokens !== progress.tokens
		|| summary.durationMs !== progress.durationMs) return false;

	const usage = asRecord(result.usage);
	if (result.usage !== undefined && !isArchimedesUsage(usage)) return false;
	return true;
}

function archimedesIdentity(
	result: AttributedToolResult,
	child: Record<string, unknown>,
	index: number,
): string | undefined {
	if (typeof child.childSessionId === "string" && isPiSessionId(child.childSessionId)) {
		return `archimedes:${child.childSessionId.toLowerCase()}`;
	}
	if (!result.toolCallId) return undefined;
	return `archimedes-fallback:${result.sessionFile}:${result.toolCallId}:${index}`;
}

function isArchimedesUsage(usage: Record<string, unknown> | null): boolean {
	if (!usage) return false;
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
		if (finiteNonNegative(usage[field]) === undefined) return false;
	}
	return true;
}

function isPiSessionId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function reportedToolCost(value: unknown): number | undefined {
	return finiteNonNegative(asRecord(asRecord(value)?.cost)?.total);
}
