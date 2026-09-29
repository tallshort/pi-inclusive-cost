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

interface ReplayState {
	rootSessionId: string;
	agents: Map<string, AgentState>;
	tombstones: Set<string>;
	contributions: Map<string, number>;
}

export function collectMinimal(rootFile: string): CollectorSummary {
	const entries = readJsonLines(rootFile);
	const header = asRecord(entries[0]);
	if (header?.type !== "session" || !nonEmptyString(header.id)) return { cost: 0, count: 0 };

	const state: ReplayState = {
		rootSessionId: header.id,
		agents: new Map(),
		tombstones: new Set(),
		contributions: new Map(),
	};
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record?.type !== "custom" || record.customType !== REGISTRY_ENTRY_TYPE) continue;
		const event = registryEvent(record.data, header.id);
		if (event) applyRegistryEvent(state, event);
	}
	return { cost: sumContributions(state.contributions), count: state.contributions.size };
}

function applyRegistryEvent(state: ReplayState, event: Record<string, unknown>): void {
	switch (event.event) {
		case "checkpoint": applyCheckpoint(state, event.snapshot); break;
		case "agent-created": applyAgentCreated(state, event.agent); break;
		case "turn-started": applyTurnStarted(state, event); break;
		case "turn-settled": applyTurnSettled(state, event); break;
		case "agent-deleted": applyAgentDeleted(state, event.agent_ids); break;
	}
}

function applyCheckpoint(state: ReplayState, value: unknown): void {
	const restored = checkpointAgents(value);
	if (!restored) return;
	state.agents = restored.agents;
	state.tombstones = new Set(restored.tombstones);
}

function applyAgentCreated(state: ReplayState, value: unknown): void {
	const rawAgent = asRecord(value);
	const agent = registryAgent(rawAgent);
	if (!agent || agent.activeTurnId || state.agents.has(agent.id) || state.tombstones.has(agent.id)) return;
	if (rawAgent?.latest_result !== undefined || (rawAgent?.recent_messages as unknown[])?.length) return;
	if (agent.parentId !== "root" && !state.agents.has(agent.parentId)) return;
	state.agents.set(agent.id, { parentId: agent.parentId });
}

function applyTurnStarted(state: ReplayState, event: Record<string, unknown>): void {
	if (!nonEmptyString(event.agent_id) || !ownedTurnId(event.agent_id, event.turn_id)) return;
	if (!isoTimestamp(event.started_at)) return;
	const agent = state.agents.get(event.agent_id);
	if (!agent || agent.activeTurnId !== undefined) return;
	agent.activeTurnId = event.turn_id;
}

function applyTurnSettled(state: ReplayState, event: Record<string, unknown>): void {
	const result = asRecord(event.result);
	if (!isSettledTurnResult(result)) return;
	if (event.settled_at !== undefined && !isoTimestamp(event.settled_at)) return;
	if (event.session_leaf_id !== undefined && !nonEmptyString(event.session_leaf_id)) return;
	const agent = state.agents.get(result.agent_id);
	if (!agent || agent.activeTurnId !== result.turn_id) return;
	agent.activeTurnId = undefined;
	agent.latestTurnId = result.turn_id;
	const cost = registryUsageCost(result.usage);
	if (cost === undefined) return;
	setGreatestContribution(
		state.contributions,
		`minimal:${state.rootSessionId}:${result.agent_id}:${result.turn_id}`,
		cost,
	);
}

function applyAgentDeleted(state: ReplayState, value: unknown): void {
	if (!stringArray(value) || value.length === 0) return;
	if (value.some((agentId) => agentId === "root" || !AGENT_ID.test(agentId))) return;
	const deleting = new Set(value);
	if (value.some((agentId) => !state.agents.has(agentId))) return;
	if ([...state.agents.entries()].some(([id, agent]) => {
		const parentId = agent.parentId;
		return !deleting.has(id) && parentId !== undefined && deleting.has(parentId);
	})) return;
	for (const agentId of value) {
		state.agents.delete(agentId);
		state.tombstones.add(agentId);
	}
}

function registryEvent(value: unknown, rootSessionId: string): Record<string, unknown> | undefined {
	const event = asRecord(value);
	if (!event || event.version !== 2) return undefined;
	if (event.root_session_id !== rootSessionId || !isoTimestamp(event.timestamp)) return undefined;
	return typeof event.event === "string" ? event : undefined;
}

function checkpointAgents(value: unknown): {
	agents: Map<string, AgentState>;
	tombstones: string[];
} | undefined {
	const snapshot = checkpointSnapshot(value);
	if (!snapshot) return undefined;
	const tombstones = checkpointTombstones(snapshot.tombstones);
	if (!tombstones) return undefined;
	const agents = checkpointAgentMap(snapshot.agents as unknown[], tombstones);
	if (!agents || !validAgentHierarchy(agents)) return undefined;
	if (!validCheckpointMessages(snapshot.agents as unknown[], agents)) return undefined;
	if (!validCheckpointLedger(snapshot, agents)) return undefined;
	return { agents, tombstones: [...tombstones] };
}

function checkpointSnapshot(value: unknown): Record<string, unknown> | undefined {
	const snapshot = asRecord(value);
	if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.deliveries)) return undefined;
	if (!stringArray(snapshot.tombstones) || !Array.isArray(snapshot.coordination_deliveries)) return undefined;
	if (!stringArray(snapshot.wait_claimed_turns) || !safeSequence(snapshot.next_delivery_sequence)) return undefined;
	return snapshot;
}

function checkpointTombstones(value: unknown): Set<string> | undefined {
	if (!stringArray(value)) return undefined;
	const tombstones = new Set(value);
	return [...tombstones].some((id) => id === "root" || !AGENT_ID.test(id)) ? undefined : tombstones;
}

function checkpointAgentMap(values: unknown[], tombstones: Set<string>): Map<string, AgentState> | undefined {
	const agents = new Map<string, AgentState>();
	for (const value of values) {
		const agent = registryAgent(value);
		if (!agent || agents.has(agent.id) || tombstones.has(agent.id)) return undefined;
		agents.set(agent.id, {
			activeTurnId: agent.activeTurnId,
			latestTurnId: agent.latestTurnId,
			parentId: agent.parentId,
		});
	}
	return agents;
}

function validAgentHierarchy(agents: Map<string, AgentState>): boolean {
	for (const [id, agent] of agents) {
		if (agent.parentId !== "root" && !agents.has(agent.parentId ?? "")) return false;
		if (agent.parentId !== "root" && !id.startsWith(`${agent.parentId}.`)) return false;
	}
	return true;
}

function validCheckpointMessages(values: unknown[], agents: Map<string, AgentState>): boolean {
	for (const value of values) {
		const rawAgent = asRecord(value);
		if (!rawAgent || !nonEmptyString(rawAgent.agent_id) || !Array.isArray(rawAgent.recent_messages)) return false;
		for (const value of rawAgent.recent_messages) {
			const message = asRecord(value);
			if (!message || !adjacent(message.source_agent_id as string, rawAgent.agent_id, agents)) return false;
		}
	}
	return true;
}

interface DeliveryReference {
	sourceAgentId: string;
	sourceTurnId: string;
	sequence: number;
	coordinationId?: string;
	path: "wait" | "message";
}

function validCheckpointLedger(
	snapshot: Record<string, unknown>,
	agents: Map<string, AgentState>,
): boolean {
	const deliveries = deliveryReferences(snapshot.deliveries as unknown[], agents, terminalDelivery);
	const coordination = deliveryReferences(snapshot.coordination_deliveries as unknown[], agents, coordinationDelivery);
	if (!deliveries || !coordination) return false;
	if (!uniqueDeliveryReferences(deliveries, coordination)) return false;
	if (!validWaitRetention(deliveries)) return false;
	const sequences = [...deliveries, ...coordination].map(({ sequence }) => sequence);
	if (new Set(sequences).size !== sequences.length) return false;
	if (sequences.some((sequence) => sequence >= (snapshot.next_delivery_sequence as number))) return false;
	return validWaitClaims(snapshot.wait_claimed_turns as string[], deliveries, coordination, agents);
}

function deliveryReferences(
	values: unknown[],
	agents: Map<string, AgentState>,
	parse: (value: unknown, agents: Map<string, AgentState>) => DeliveryReference | undefined,
): DeliveryReference[] | undefined {
	const references: DeliveryReference[] = [];
	for (const value of values) {
		const delivery = parse(value, agents);
		if (!delivery) return undefined;
		references.push(delivery);
	}
	return references;
}

function uniqueDeliveryReferences(deliveries: DeliveryReference[], coordination: DeliveryReference[]): boolean {
	const identities = deliveries.map(({ sourceAgentId, sourceTurnId }) => `${sourceAgentId}\0${sourceTurnId}`);
	if (new Set(identities).size !== identities.length) return false;
	const coordinationIds = coordination.map(({ coordinationId }) => coordinationId);
	return new Set(coordinationIds).size === coordinationIds.length;
}

function validWaitRetention(deliveries: DeliveryReference[]): boolean {
	const waitCounts = new Map<string, number>();
	for (const delivery of deliveries) {
		if (delivery.path !== "wait") continue;
		const count = (waitCounts.get(delivery.sourceAgentId) ?? 0) + 1;
		if (count > 20) return false;
		waitCounts.set(delivery.sourceAgentId, count);
	}
	return true;
}

function validWaitClaims(
	claims: string[],
	deliveries: DeliveryReference[],
	coordination: DeliveryReference[],
	agents: Map<string, AgentState>,
): boolean {
	for (const claim of claims) {
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
	agents: Map<string, AgentState>,
): DeliveryReference | undefined {
	const delivery = asRecord(value);
	if (!delivery || !nonEmptyString(delivery.source_agent_id)) return undefined;
	if (!ownedTurnId(delivery.source_agent_id, delivery.source_turn_id)) return undefined;
	if (!nonEmptyString(delivery.destination_agent_id)) return undefined;
	if (delivery.path !== "wait" && delivery.path !== "message") return undefined;
	if (delivery.settled !== false || !safeSequence(delivery.sequence)) return undefined;
	const result = asRecord(delivery.result);
	if (!result) return undefined;
	if (!isSettledTurnResult(result) || result.status !== "completed") return undefined;
	if (result.agent_id !== delivery.source_agent_id || result.turn_id !== delivery.source_turn_id) return undefined;
	if (result.usage !== undefined && registryUsageCost(result.usage) === undefined) return undefined;
	if (delivery.error !== undefined && typeof delivery.error !== "string") return undefined;
	const source = agents.get(delivery.source_agent_id);
	if (!source || source.parentId !== delivery.destination_agent_id) return undefined;
	return {
		sourceAgentId: delivery.source_agent_id,
		sourceTurnId: delivery.source_turn_id,
		sequence: delivery.sequence as number,
		path: delivery.path,
	};
}

function coordinationDelivery(
	value: unknown,
	agents: Map<string, AgentState>,
): DeliveryReference | undefined {
	const delivery = asRecord(value);
	if (!delivery || !nonEmptyString(delivery.delivery_id) || !safeSequence(delivery.sequence)) return undefined;
	if (!nonEmptyString(delivery.destination_agent_id)) return undefined;
	if (delivery.path !== "wait" && delivery.path !== "message") return undefined;
	if (delivery.settled !== false) return undefined;
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
		path: delivery.path,
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

interface RegistryAgent {
	id: string;
	parentId: string;
	activeTurnId?: string;
	latestTurnId?: string;
}

function registryAgent(value: unknown): RegistryAgent | undefined {
	const agent = asRecord(value);
	if (!agent) return undefined;
	const identity = registryAgentIdentity(agent);
	if (!identity || !validAgentCapabilities(agent) || !validAgentSessionMetadata(agent)) return undefined;
	const turns = registryAgentTurns(agent, identity.id);
	if (!turns) return undefined;
	return { ...identity, ...turns };
}

function registryAgentIdentity(agent: Record<string, unknown>): Pick<RegistryAgent, "id" | "parentId"> | undefined {
	if (!nonEmptyString(agent.agent_id) || agent.agent_id === "root" || !AGENT_ID.test(agent.agent_id)) return undefined;
	if (!nonEmptyString(agent.friendly_id) || !FRIENDLY_ID.test(agent.friendly_id)) return undefined;
	if (agent.friendly_id === "root" || agent.friendly_id === "parent" || !nonEmptyString(agent.parent_id)) return undefined;
	const expectedIds = agent.parent_id === "root"
		? [agent.friendly_id, `root.${agent.friendly_id}`]
		: [`${agent.parent_id}.${agent.friendly_id}`];
	if (!expectedIds.includes(agent.agent_id)) return undefined;
	if (!isoTimestamp(agent.created_at) || !nonEmptyString(agent.spawn_entry_id)) return undefined;
	return { id: agent.agent_id, parentId: agent.parent_id };
}

function validAgentCapabilities(agent: Record<string, unknown>): boolean {
	const capabilityCeiling = agent.capability_ceiling;
	if (!stringArray(capabilityCeiling) || !stringArray(agent.missing_dependencies)) return false;
	if (!Array.isArray(agent.recent_messages) || agent.recent_messages.length > 20) return false;
	if (agent.recent_messages.some((message) => !validRecentMessage(message))) return false;
	if (agent.availability !== "available" && agent.availability !== "unavailable") return false;
	const ordinaryTools = validLaunchContract(agent.launch_contract);
	if (!ordinaryTools || ordinaryTools.length !== capabilityCeiling.length) return false;
	return !ordinaryTools.some((tool) => !capabilityCeiling.includes(tool));
}

function validAgentSessionMetadata(agent: Record<string, unknown>): boolean {
	if (agent.task !== undefined && typeof agent.task !== "string") return false;
	if ((agent.session_file === undefined) !== (agent.session_id === undefined)) return false;
	if ((agent.session_id === undefined) !== (agent.session_leaf_id === undefined)) return false;
	for (const field of ["latest_activity_at", "session_file", "session_id", "session_leaf_id", "clone_error", "unavailable_reason"] as const) {
		if (agent[field] !== undefined && !nonEmptyString(agent[field])) return false;
	}
	if (agent.latest_activity_at !== undefined && !isoTimestamp(agent.latest_activity_at)) return false;
	return agent.clone_error === undefined || agent.availability === "unavailable";
}

function registryAgentTurns(
	agent: Record<string, unknown>,
	agentId: string,
): Pick<RegistryAgent, "activeTurnId" | "latestTurnId"> | undefined {
	if (agent.active_turn_id !== undefined && !ownedTurnId(agentId, agent.active_turn_id)) return undefined;
	if (agent.active_turn_started_at !== undefined && !isoTimestamp(agent.active_turn_started_at)) return undefined;
	if ((agent.active_turn_id === undefined) !== (agent.active_turn_started_at === undefined)) return undefined;
	if (agent.latest_result === undefined) {
		return { activeTurnId: agent.active_turn_id as string | undefined };
	}
	const latest = asRecord(agent.latest_result);
	if (!isSettledTurnResult(latest) || latest.agent_id !== agentId) return undefined;
	if (latest.usage !== undefined && registryUsageCost(latest.usage) === undefined) return undefined;
	if (latest.turn_id === agent.active_turn_id) return undefined;
	return {
		activeTurnId: agent.active_turn_id as string | undefined,
		latestTurnId: latest.turn_id,
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
