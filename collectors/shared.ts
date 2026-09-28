import fs from "node:fs";

export interface AttributedToolResult {
	toolName: string;
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

export function sumAssistantCost(entries: unknown[]): number {
	let total = 0;
	for (const entry of entries) {
		const record = asRecord(entry);
		const message = asRecord(record?.message);
		if (record?.type !== "message" || message?.role !== "assistant") continue;
		const usage = asRecord(message.usage);
		const cost = asRecord(usage?.cost);
		const value = finiteNonNegative(cost?.total);
		if (value !== undefined) total += value;
	}
	return total;
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

export function sumContributions(contributions: Map<string, number>): number {
	let total = 0;
	for (const cost of contributions.values()) total += cost;
	return total;
}
