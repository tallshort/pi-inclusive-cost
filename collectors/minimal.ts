import {
	asRecord,
	finiteNonNegative,
	readJsonLines,
	setGreatestContribution,
	sumContributions,
	type CollectorSummary,
} from "./shared.js";

const REGISTRY_ENTRY_TYPE = "minimal-subagents.registry";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const AGENT_ID = /^(?:root\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/;
const FRIENDLY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const COORDINATOR_TOOLS = new Set([
	"subagent",
	"agent_message",
	"subagent_wait",
	"subagent_status",
	"subagent_cancel",
	"subagent_delete",
]);

interface AgentState {
	activeTurnId?: string;
	latestTurnId?: string;
	parentId?: string;
}

export function collectMinimal(rootFile: string): CollectorSummary {
	const entries = readJsonLines(rootFile);
	const header = asRecord(entries[0]);
	if (header?.type !== "session" || !nonEmptyString(header.id)) return { cost: 0, count: 0 };

	const contributions = new Map<string, number>();
	let agents = new Map<string, AgentState>();
	const tombstones = new Set<string>();
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record?.type !== "custom" || record.customType !== REGISTRY_ENTRY_TYPE) continue;
		const event = registryEvent(record.data, header.id);
		if (!event) continue;

		switch (event.event) {
			case "checkpoint": {
				const restored = checkpointAgents(event.snapshot, event.version as 1 | 2);
				if (!restored) break;
				agents = restored.agents;
				tombstones.clear();
				for (const agentId of restored.tombstones) tombstones.add(agentId);
				break;
			}
			case "agent-created": {
				const rawAgent = asRecord(event.agent);
				const agent = registryAgent(rawAgent, event.version as 1 | 2);
				if (!agent || agent.activeTurnId || agents.has(agent.id) || tombstones.has(agent.id)) break;
				if (rawAgent?.latest_result !== undefined || (rawAgent?.recent_messages as unknown[])?.length) break;
				if (agent.parentId !== "root" && !agents.has(agent.parentId)) break;
				agents.set(agent.id, { parentId: agent.parentId });
				break;
			}
			case "turn-started": {
				if (!nonEmptyString(event.agent_id) || !ownedTurnId(event.agent_id, event.turn_id)) break;
				if (!isoTimestamp(event.started_at)) break;
				const agent = agents.get(event.agent_id);
				if (!agent || agent.activeTurnId !== undefined) break;
				agent.activeTurnId = event.turn_id;
				break;
			}
			case "turn-settled": {
				const result = asRecord(event.result);
				if (!isSettledTurnResult(result)) break;
				if (event.settled_at !== undefined && !isoTimestamp(event.settled_at)) break;
				if (event.session_leaf_id !== undefined && !nonEmptyString(event.session_leaf_id)) break;
				const agent = agents.get(result.agent_id);
				if (!agent || agent.activeTurnId !== result.turn_id) break;
				agent.activeTurnId = undefined;
				agent.latestTurnId = result.turn_id;
				const cost = registryUsageCost(result.usage);
				if (cost === undefined) break;
				setGreatestContribution(
					contributions,
					`minimal:${header.id}:${result.agent_id}:${result.turn_id}`,
					cost,
				);
				break;
			}
			case "agent-deleted": {
				if (!stringArray(event.agent_ids) || event.agent_ids.length === 0) break;
				if (event.agent_ids.some((agentId) => agentId === "root" || !AGENT_ID.test(agentId))) break;
				const deleting = new Set(event.agent_ids);
				if (event.agent_ids.some((agentId) => !agents.has(agentId))) break;
				if ([...agents.entries()].some(([id, agent]) => {
					const parentId = agent.parentId;
					return !deleting.has(id) && parentId !== undefined && deleting.has(parentId);
				})) break;
				for (const agentId of event.agent_ids) {
					agents.delete(agentId);
					tombstones.add(agentId);
				}
				break;
			}
		}
	}

	return { cost: sumContributions(contributions), count: contributions.size };
}

function registryEvent(value: unknown, rootSessionId: string): Record<string, unknown> | undefined {
	const event = asRecord(value);
	if (!event || (event.version !== 1 && event.version !== 2)) return undefined;
	if (event.root_session_id !== rootSessionId || !isoTimestamp(event.timestamp)) return undefined;
	return typeof event.event === "string" ? event : undefined;
}

function checkpointAgents(value: unknown, version: 1 | 2): {
	agents: Map<string, AgentState>;
	tombstones: string[];
} | undefined {
	const snapshot = asRecord(value);
	if (!snapshot || !Array.isArray(snapshot.agents)) return undefined;
	if (!stringArray(snapshot.tombstones) || !Array.isArray(snapshot.deliveries)) return undefined;
	if (version === 2) {
		if (!Array.isArray(snapshot.coordination_deliveries)) return undefined;
		if (!stringArray(snapshot.wait_claimed_turns)) return undefined;
		if (!safeSequence(snapshot.next_delivery_sequence)) return undefined;
	} else {
		if (snapshot.coordination_deliveries !== undefined && !Array.isArray(snapshot.coordination_deliveries)) return undefined;
		if (snapshot.wait_claimed_turns !== undefined && !stringArray(snapshot.wait_claimed_turns)) return undefined;
		if (snapshot.next_delivery_sequence !== undefined && !safeSequence(snapshot.next_delivery_sequence)) return undefined;
	}
	const tombstones = new Set(snapshot.tombstones);
	if ([...tombstones].some((id) => id === "root" || !AGENT_ID.test(id))) return undefined;
	const agents = new Map<string, AgentState>();
	for (const value of snapshot.agents) {
		const agent = registryAgent(value, version);
		if (!agent || agents.has(agent.id) || tombstones.has(agent.id)) return undefined;
		agents.set(agent.id, {
			activeTurnId: agent.activeTurnId,
			latestTurnId: agent.latestTurnId,
			parentId: agent.parentId,
		});
	}
	for (const [id, agent] of agents) {
		if (agent.parentId !== "root" && !agents.has(agent.parentId ?? "")) return undefined;
		if (agent.parentId !== "root" && !id.startsWith(`${agent.parentId}.`)) return undefined;
	}
	for (const value of snapshot.agents) {
		const rawAgent = asRecord(value);
		if (!rawAgent || !nonEmptyString(rawAgent.agent_id)) return undefined;
		for (const value of rawAgent.recent_messages as unknown[]) {
			const message = asRecord(value);
			if (!message || !adjacent(message.source_agent_id as string, rawAgent.agent_id, agents)) return undefined;
		}
	}
	if (!validCheckpointLedger(snapshot, version, agents)) return undefined;
	return { agents, tombstones: [...tombstones] };
}

interface DeliveryReference {
	sourceAgentId: string;
	sourceTurnId: string;
	sequence?: number;
	coordinationId?: string;
	path?: "wait" | "message";
}

function validCheckpointLedger(
	snapshot: Record<string, unknown>,
	version: 1 | 2,
	agents: Map<string, AgentState>,
): boolean {
	const deliveries: DeliveryReference[] = [];
	for (const value of snapshot.deliveries as unknown[]) {
		const delivery = terminalDelivery(value, version, agents);
		if (!delivery) return false;
		deliveries.push(delivery);
	}
	const coordination: DeliveryReference[] = [];
	for (const value of (snapshot.coordination_deliveries as unknown[] | undefined) ?? []) {
		const delivery = coordinationDelivery(value, version, agents);
		if (!delivery) return false;
		coordination.push(delivery);
	}
	const identities = deliveries.map(({ sourceAgentId, sourceTurnId }) => `${sourceAgentId}\0${sourceTurnId}`);
	if (new Set(identities).size !== identities.length) return false;
	const coordinationIds = coordination.map(({ coordinationId }) => coordinationId);
	if (new Set(coordinationIds).size !== coordinationIds.length) return false;
	const waitCounts = new Map<string, number>();
	for (const delivery of deliveries) {
		if (delivery.path !== "wait") continue;
		const count = (waitCounts.get(delivery.sourceAgentId) ?? 0) + 1;
		if (version === 2 && count > 20) return false;
		waitCounts.set(delivery.sourceAgentId, count);
	}
	const sequences = [...deliveries, ...coordination].flatMap(({ sequence }) => sequence === undefined ? [] : [sequence]);
	if (new Set(sequences).size !== sequences.length) return false;
	const nextSequence = snapshot.next_delivery_sequence;
	if (typeof nextSequence === "number"
		&& sequences.some((sequence) => sequence >= nextSequence)) return false;
	for (const claim of (snapshot.wait_claimed_turns as string[] | undefined) ?? []) {
		const separator = claim.indexOf("\0");
		if (separator <= 0 || separator !== claim.lastIndexOf("\0")) return false;
		const agentId = claim.slice(0, separator);
		const turnId = claim.slice(separator + 1);
		const agent = agents.get(agentId);
		if (!agent || !ownedTurnId(agentId, turnId)) return false;
		const retained = [...deliveries, ...coordination]
			.some((item) => item.sourceAgentId === agentId && item.sourceTurnId === turnId);
		if (agent.activeTurnId !== turnId && agent.latestTurnId !== turnId && !retained) return false;
	}
	return true;
}

function terminalDelivery(
	value: unknown,
	version: 1 | 2,
	agents: Map<string, AgentState>,
): DeliveryReference | undefined {
	const delivery = asRecord(value);
	if (!delivery || !nonEmptyString(delivery.source_agent_id)) return undefined;
	if (!ownedTurnId(delivery.source_agent_id, delivery.source_turn_id)) return undefined;
	if (!nonEmptyString(delivery.destination_agent_id)) return undefined;
	if (delivery.path !== "wait" && delivery.path !== "message") return undefined;
	if (typeof delivery.settled !== "boolean") return undefined;
	if (delivery.sequence !== undefined && !safeSequence(delivery.sequence)) return undefined;
	if (version === 2 && (delivery.sequence === undefined || delivery.settled !== false)) return undefined;
	const result = delivery.result === undefined ? undefined : asRecord(delivery.result);
	if (version === 2 && !result) return undefined;
	if (result) {
		if (!isSettledTurnResult(result) || result.status !== "completed") return undefined;
		if (result.agent_id !== delivery.source_agent_id || result.turn_id !== delivery.source_turn_id) return undefined;
		if (result.usage !== undefined && registryUsageCost(result.usage) === undefined) return undefined;
	}
	if (delivery.error !== undefined && typeof delivery.error !== "string") return undefined;
	const source = agents.get(delivery.source_agent_id);
	if (!source || source.parentId !== delivery.destination_agent_id) return undefined;
	return {
		sourceAgentId: delivery.source_agent_id,
		sourceTurnId: delivery.source_turn_id,
		sequence: delivery.sequence as number | undefined,
		path: delivery.path,
	};
}

function coordinationDelivery(
	value: unknown,
	version: 1 | 2,
	agents: Map<string, AgentState>,
): DeliveryReference | undefined {
	const delivery = asRecord(value);
	if (!delivery || !nonEmptyString(delivery.delivery_id) || !safeSequence(delivery.sequence)) return undefined;
	if (!nonEmptyString(delivery.destination_agent_id)) return undefined;
	if (delivery.path !== "wait" && delivery.path !== "message") return undefined;
	if (typeof delivery.settled !== "boolean" || (version === 2 && delivery.settled)) return undefined;
	if (delivery.error !== undefined && typeof delivery.error !== "string") return undefined;
	const message = asRecord(delivery.message);
	const details = asRecord(message?.details);
	if (message?.customType !== "minimal-subagents.message" || typeof message.content !== "string") return undefined;
	if (!details || !nonEmptyString(details.source_agent_id)) return undefined;
	if (!ownedTurnId(details.source_agent_id, details.source_turn_id)) return undefined;
	if (!nonEmptyString(details.message_id) || details.delivery_id !== delivery.delivery_id) return undefined;
	if (delivery.delivery_id !== `message:${details.message_id}`) return undefined;
	if (details.destination_agent_id !== delivery.destination_agent_id) return undefined;
	if (details.status !== undefined || details.elapsed_ms !== undefined || details.usage !== undefined) return undefined;
	if (!adjacent(details.source_agent_id, delivery.destination_agent_id, agents)) return undefined;
	return {
		sourceAgentId: details.source_agent_id,
		sourceTurnId: details.source_turn_id,
		sequence: delivery.sequence,
		coordinationId: delivery.delivery_id,
	};
}

function adjacent(sourceId: string, destinationId: string, agents: Map<string, AgentState>): boolean {
	if (sourceId === destinationId) return false;
	const source = sourceId === "root" ? undefined : agents.get(sourceId);
	const destination = destinationId === "root" ? undefined : agents.get(destinationId);
	if (sourceId === "root") return destination?.parentId === "root";
	if (destinationId === "root") return source?.parentId === "root";
	if (!source || !destination) return false;
	return source.parentId === destinationId
		|| destination.parentId === sourceId
		|| source.parentId === destination.parentId;
}

function registryAgent(value: unknown, version: 1 | 2): {
	id: string;
	parentId: string;
	activeTurnId?: string;
	latestTurnId?: string;
} | undefined {
	const agent = asRecord(value);
	if (!agent || !nonEmptyString(agent.agent_id) || agent.agent_id === "root" || !AGENT_ID.test(agent.agent_id)) return undefined;
	if (!nonEmptyString(agent.friendly_id) || !FRIENDLY_ID.test(agent.friendly_id)) return undefined;
	if (agent.friendly_id === "root" || agent.friendly_id === "parent" || !nonEmptyString(agent.parent_id)) return undefined;
	const expectedIds = agent.parent_id === "root"
		? [agent.friendly_id, `root.${agent.friendly_id}`]
		: [`${agent.parent_id}.${agent.friendly_id}`];
	if (!expectedIds.includes(agent.agent_id)) return undefined;
	if (!isoTimestamp(agent.created_at) || !nonEmptyString(agent.spawn_entry_id)) return undefined;
	const capabilityCeiling = agent.capability_ceiling;
	if (!stringArray(capabilityCeiling) || !stringArray(agent.missing_dependencies)) return undefined;
	if (!Array.isArray(agent.recent_messages)) return undefined;
	if (agent.recent_messages.some((message) => !validRecentMessage(message))) return undefined;
	if (version === 2 && agent.recent_messages.length > 20) return undefined;
	if (agent.availability !== "available" && agent.availability !== "unavailable") return undefined;
	const ordinaryTools = validLaunchContract(agent.launch_contract);
	if (!ordinaryTools || ordinaryTools.length !== capabilityCeiling.length) return undefined;
	if (ordinaryTools.some((tool) => !capabilityCeiling.includes(tool))) return undefined;
	if ((agent.session_file === undefined) !== (agent.session_id === undefined)) return undefined;
	if (version === 2 && (agent.session_id === undefined) !== (agent.session_leaf_id === undefined)) return undefined;
	for (const field of ["task", "latest_activity_at", "session_file", "session_id", "session_leaf_id", "clone_error", "unavailable_reason"] as const) {
		if (agent[field] !== undefined && !nonEmptyString(agent[field])) return undefined;
	}
	if (agent.latest_activity_at !== undefined && !isoTimestamp(agent.latest_activity_at)) return undefined;
	if (agent.clone_error !== undefined && agent.availability !== "unavailable") return undefined;
	if (agent.active_turn_id !== undefined && !ownedTurnId(agent.agent_id, agent.active_turn_id)) return undefined;
	if (agent.active_turn_started_at !== undefined && !isoTimestamp(agent.active_turn_started_at)) return undefined;
	if ((agent.active_turn_id === undefined) !== (agent.active_turn_started_at === undefined)) return undefined;
	if (agent.latest_result !== undefined) {
		const latest = asRecord(agent.latest_result);
		if (!isSettledTurnResult(latest) || latest.agent_id !== agent.agent_id) return undefined;
		if (latest.usage !== undefined && registryUsageCost(latest.usage) === undefined) return undefined;
		if (latest.turn_id === agent.active_turn_id) return undefined;
	}
	return {
		id: agent.agent_id,
		parentId: agent.parent_id,
		activeTurnId: agent.active_turn_id as string | undefined,
		latestTurnId: asRecord(agent.latest_result)?.turn_id as string | undefined,
	};
}

function validLaunchContract(value: unknown): string[] | undefined {
	const contract = asRecord(value);
	if (!contract) return undefined;
	if (!["inherit", "compact", "omit"].includes(String(contract.session_context))) return undefined;
	if (contract.project_context !== "inherit" && contract.project_context !== "omit") return undefined;
	if (typeof contract.model !== "string" || !/^[^/]+\/.+$/.test(contract.model)) return undefined;
	if (typeof contract.thinking_level !== "string" || !THINKING_LEVELS.has(contract.thinking_level)) return undefined;
	if (!stringArray(contract.ordinary_tools) || hasCoordinatorTool(contract.ordinary_tools)) return undefined;
	if (contract.tools !== undefined) {
		const validPreset = contract.tools === "none" || contract.tools === "read" || contract.tools === "modify";
		if (!validPreset && (!stringArray(contract.tools) || hasCoordinatorTool(contract.tools))) return undefined;
	}
	if (contract.delegation !== undefined && contract.delegation !== "none" && contract.delegation !== "fanout") return undefined;
	return contract.ordinary_tools;
}

function isSettledTurnResult(result: Record<string, unknown> | null): result is Record<string, unknown> & {
	agent_id: string;
	turn_id: string;
} {
	if (!result || !nonEmptyString(result.agent_id) || !ownedTurnId(result.agent_id, result.turn_id)) return false;
	if (typeof result.status !== "string" || !TERMINAL_STATUSES.has(result.status)) return false;
	if (typeof result.output !== "string") return false;
	if (result.error !== undefined && typeof result.error !== "string") return false;
	if (result.elapsed_ms !== undefined && finiteNonNegative(result.elapsed_ms) === undefined) return false;
	if (result.usage !== undefined && registryUsageCost(result.usage) === undefined) return false;
	return true;
}

function registryUsageCost(value: unknown): number | undefined {
	const usage = asRecord(value);
	if (!usage) return undefined;
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (finiteNonNegative(usage[field]) === undefined) return undefined;
	}
	if (usage.cacheWrite1h !== undefined && finiteNonNegative(usage.cacheWrite1h) === undefined) return undefined;
	if (usage.reasoning !== undefined && finiteNonNegative(usage.reasoning) === undefined) return undefined;
	const cost = asRecord(usage.cost);
	if (!cost) return undefined;
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (finiteNonNegative(cost[field]) === undefined) return undefined;
	}
	return finiteNonNegative(cost.total);
}

function ownedTurnId(agentId: string, value: unknown): value is string {
	return typeof value === "string" && value.startsWith(`${agentId}:`) && !value.includes("\0");
}

function isoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function validRecentMessage(value: unknown): boolean {
	const message = asRecord(value);
	return !!message
		&& nonEmptyString(message.source_agent_id)
		&& ownedTurnId(message.source_agent_id, message.turn_id)
		&& typeof message.content === "string";
}

function hasCoordinatorTool(tools: string[]): boolean {
	return tools.some((tool) => COORDINATOR_TOOLS.has(tool));
}

function safeSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
}
