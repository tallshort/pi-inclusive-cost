import {
	asRecord,
	finiteNonNegative,
	setGreatestContribution,
	sumContributions,
	type AttributedCustomMessage,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const TERMINAL_STATUSES = new Set(["completed", "turn_limited", "aborted", "stopped", "error"]);
const COMPLETION_HEADER = /^\[Subagent "[^"\r\n]+" ([0-9a-f]{8}) (completed|turn_limited|aborted|stopped|error)\](?:\r?\n|$)/i;

export function collectLite(
	toolResults: AttributedToolResult[],
	customMessages: AttributedCustomMessage[],
): CollectorSummary {
	const contributions = new Map<string, number>();
	const parentReportedForeground = new Set<string>();
	const backgroundLaunches = new Map<string, Set<string>>();
	const parentReportedBackground = new Set<string>();

	for (const result of toolResults) {
		const foregroundIdentity = liteForegroundIdentity(result);
		if (foregroundIdentity && reportedToolCost(result.usage) !== undefined) {
			parentReportedForeground.add(foregroundIdentity);
		}

		const agentId = liteBackgroundLaunchId(result);
		if (!agentId) continue;
		const launches = backgroundLaunches.get(result.sessionFile) ?? new Set<string>();
		launches.add(agentId);
		backgroundLaunches.set(result.sessionFile, launches);
		if (reportedToolCost(result.usage) !== undefined) {
			parentReportedBackground.add(backgroundIdentity(result.sessionFile, agentId));
		}
	}

	for (const result of toolResults) {
		const identity = liteForegroundIdentity(result);
		if (!identity || parentReportedForeground.has(identity)) continue;
		const details = asRecord(result.details);
		const cost = finiteNonNegative(details?.cost);
		if (cost !== undefined) setGreatestContribution(contributions, identity, cost);
	}

	for (const message of customMessages) {
		const completion = liteCompletion(message);
		if (!completion) continue;
		const launches = backgroundLaunches.get(message.sessionFile);
		if (!launches) continue;
		const matches = [...launches].filter((agentId) => agentId.startsWith(completion.shortId));
		if (matches.length !== 1) continue;
		const identity = backgroundIdentity(message.sessionFile, matches[0]!);
		if (parentReportedBackground.has(identity)) continue;
		setGreatestContribution(contributions, identity, completion.cost);
	}

	return {
		cost: sumContributions(contributions),
		count: contributions.size,
	};
}

function liteForegroundIdentity(result: AttributedToolResult): string | undefined {
	if (result.toolName !== "Agent" || !result.toolCallId) return undefined;
	const details = asRecord(result.details);
	if (!isLiteStats(details) || details.status !== undefined || details.agentId !== undefined) return undefined;
	return `lite-foreground:${result.sessionFile}:${result.toolCallId}`;
}

function liteBackgroundLaunchId(result: AttributedToolResult): string | undefined {
	if (result.toolName !== "Agent") return undefined;
	const details = asRecord(result.details);
	if (!details || typeof details.type !== "string" || typeof details.description !== "string") return undefined;
	if (details.status !== "running" && details.status !== "queued") return undefined;
	if (typeof details.agentId !== "string" || !isLiteAgentId(details.agentId)) return undefined;
	return details.agentId.toLowerCase();
}

function liteCompletion(message: AttributedCustomMessage): { shortId: string; cost: number } | undefined {
	if (message.customType !== "subagent-result" || typeof message.content !== "string") return undefined;
	const match = COMPLETION_HEADER.exec(message.content);
	if (!match) return undefined;
	const details = asRecord(message.details);
	if (!isLiteStats(details) || typeof details.status !== "string" || !TERMINAL_STATUSES.has(details.status)) return undefined;
	if (details.status !== match[2]) return undefined;
	const cost = finiteNonNegative(details.cost);
	return cost === undefined ? undefined : { shortId: match[1]!.toLowerCase(), cost };
}

function isLiteStats(details: Record<string, unknown> | null): details is Record<string, unknown> {
	if (!details || typeof details.type !== "string" || typeof details.description !== "string") return false;
	for (const field of [
		"turnCount",
		"toolUses",
		"input",
		"output",
		"durationMs",
		"compactions",
	] as const) {
		if (finiteNonNegative(details[field]) === undefined) return false;
	}
	if (details.maxTurns !== undefined && finiteNonNegative(details.maxTurns) === undefined) return false;
	if (details.contextPercent !== null && finiteNonNegative(details.contextPercent) === undefined) return false;
	for (const field of ["modelName", "modelId", "thinkingLevel"] as const) {
		if (details[field] !== undefined && typeof details[field] !== "string") return false;
	}
	return true;
}

function isLiteAgentId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{2}$/i.test(value);
}

function backgroundIdentity(sessionFile: string, agentId: string): string {
	return `lite-background:${sessionFile}:${agentId}`;
}

function reportedToolCost(value: unknown): number | undefined {
	return finiteNonNegative(asRecord(asRecord(value)?.cost)?.total);
}
