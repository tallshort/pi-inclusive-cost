import {
	asRecord,
	finiteNonNegative,
	setGreatestContribution,
	sumContributions,
	type AttributedCustomMessage,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const BACNH85_TOOL_NAME = "subagent";
const BACNH85_COMPLETION_TYPE = "pi-subagent-complete";

export function collectBacnh85(
	toolResults: AttributedToolResult[],
	customMessages: AttributedCustomMessage[],
): CollectorSummary {
	const contributions = new Map<string, number>();

	for (const result of toolResults) {
		if (result.toolName !== BACNH85_TOOL_NAME || !result.toolCallId) continue;
		if (reportedToolCost(result.usage) !== undefined) continue;
		const details = asRecord(result.details);
		if (!isBacnh85Details(details) || details.runner === "herdr") continue;
		const results = details.results as unknown[];
		for (let index = 0; index < results.length; index++) {
			const child = asRecord(results[index]);
			if (!isBacnh85Result(child)) continue;
			const cost = finiteNonNegative(asRecord(child.usage)?.cost);
			if (cost === undefined) continue;
			setGreatestContribution(
				contributions,
				`bacnh85:${result.sessionFile}:${result.toolCallId}:${index}`,
				cost,
			);
		}
	}

	for (const message of customMessages) {
		if (message.customType !== BACNH85_COMPLETION_TYPE) continue;
		const details = asRecord(message.details);
		if (details?.background !== true || typeof details.task_id !== "string" || !details.task_id.startsWith("bg-")) continue;
		const cost = finiteNonNegative(asRecord(details.usage)?.cost);
		if (cost === undefined) continue;
		setGreatestContribution(
			contributions,
			`bacnh85-background:${message.sessionFile}:${details.task_id}`,
			cost,
		);
	}

	return {
		cost: sumContributions(contributions),
		count: contributions.size,
	};
}

function isBacnh85Details(details: Record<string, unknown> | null): details is Record<string, unknown> & { results: unknown[] } {
	if (!details || !Array.isArray(details.results)) return false;
	if (details.mode !== "single" && details.mode !== "parallel" && details.mode !== "chain") return false;
	if (details.agentScope !== "user" && details.agentScope !== "project" && details.agentScope !== "both") return false;
	return details.projectAgentsDir === null || typeof details.projectAgentsDir === "string";
}

function isBacnh85Result(result: Record<string, unknown> | null): result is Record<string, unknown> {
	return result !== null
		&& typeof result.agent === "string"
		&& typeof result.task === "string"
		&& typeof result.exitCode === "number"
		&& Array.isArray(result.messages)
		&& typeof result.stderr === "string";
}

function reportedToolCost(value: unknown): number | undefined {
	const usage = asRecord(value);
	return finiteNonNegative(asRecord(usage?.cost)?.total);
}
