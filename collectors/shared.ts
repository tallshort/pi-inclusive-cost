import fs from "node:fs";

export interface AttributedToolResult {
	sessionFile: string;
	sessionId?: string;
	toolName: string;
	toolCallId?: string;
	content: unknown;
	details: unknown;
	usage?: unknown;
	cwd?: string;
}

export interface AttributedCustomMessage {
	sessionFile: string;
	sessionId?: string;
	customType: string;
	content: unknown;
	details: unknown;
	cwd?: string;
}

export interface CollectorSummary {
	cost: number;
	count: number;
}

export function readJsonLines(filePath: string): unknown[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const entries: unknown[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Ignore incomplete or unrelated lines; persisted records are append-only.
		}
	}
	return entries;
}

export function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

export function sumAssistantCost(entries: unknown[], excludedEntryIds?: ReadonlySet<string>): number {
	return assistantCostSummary(entries, excludedEntryIds).cost;
}

export function assistantCostSummary(
	entries: unknown[],
	excludedEntryIds?: ReadonlySet<string>,
): { cost: number; pricedMessages: number } {
	let cost = 0;
	let pricedMessages = 0;
	for (const entry of entries) {
		const record = asRecord(entry);
		if (typeof record?.id === "string" && excludedEntryIds?.has(record.id)) continue;
		const message = asRecord(record?.message);
		if (record?.type !== "message" || message?.role !== "assistant") continue;
		const value = finiteNonNegative(asRecord(asRecord(message.usage)?.cost)?.total);
		if (value === undefined) continue;
		cost += value;
		pricedMessages += 1;
	}
	return { cost, pricedMessages };
}
export function sessionEntryIds(entries: unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const id = asRecord(entry)?.id;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}

export function sumStandardPiSessionFile(filePath: string, expectedSessionId?: string): number | undefined {
	const entries = readJsonLines(filePath);
	const header = asRecord(entries[0]);
	if (header?.type !== "session") return undefined;
	if (expectedSessionId !== undefined && header.id !== expectedSessionId) return undefined;
	return sumAssistantCost(entries);
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("\n");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

export function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function setGreatestContribution(
	contributions: Map<string, number>,
	key: string,
	cost: number,
): void {
	const previous = contributions.get(key);
	if (previous === undefined || cost > previous) contributions.set(key, cost);
}

export function sumContributions(contributions: Map<string, number>): number {
	let total = 0;
	for (const cost of contributions.values()) total += cost;
	return total;
}
