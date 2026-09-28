import fs from "node:fs";
import path from "node:path";

import {
	asRecord,
	contentText,
	finiteNonNegative,
	readJsonLines,
	sumAssistantCost,
	sumContributions,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const FABRIC_RUN_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface FabricRunReference {
	cost?: number;
}

interface FabricRunShape {
	hasExplicitRunId: boolean;
	hasUsage: boolean;
	hasName: boolean;
	hasStatus: boolean;
	hasRunner: boolean;
	hasTask: boolean;
	hasCwd: boolean;
}

export function collectFabric(
	rootFile: string,
	toolResults: AttributedToolResult[],
): CollectorSummary {
	const runs = new Map<string, FabricRunReference>();
	for (const result of toolResults) {
		if (result.toolName !== "fabric_exec") continue;
		mergeFabricRuns(runs, extractFabricRuns(result.content));
		mergeFabricRuns(runs, extractFabricAuditRuns(result.details));
	}
	return {
		cost: sumContributions(collectFabricContributions(rootFile, runs)),
		count: runs.size,
	};
}

function extractFabricRuns(content: unknown): Map<string, FabricRunReference> {
	const found = new Map<string, FabricRunReference>();
	const text = contentText(content);
	try {
		collectFabricObjects(JSON.parse(text), found);
	} catch {
		collectFabricYaml(text, found);
	}
	return found;
}

function extractFabricAuditRuns(details: unknown): Map<string, FabricRunReference> {
	const found = new Map<string, FabricRunReference>();
	const audits = asRecord(details)?.audits;
	if (!Array.isArray(audits)) return found;
	for (const value of audits) {
		const audit = asRecord(value);
		if (!audit || audit.ref !== "agents.run" || audit.provider !== "agents" || audit.tool !== "run") continue;
		if (audit.success !== true) continue;
		const run = asRecord(audit.result);
		if (run) collectFabricObject(run, found);
	}
	return found;
}

function mergeFabricRuns(
	target: Map<string, FabricRunReference>,
	source: Map<string, FabricRunReference>,
): void {
	for (const [runId, reference] of source) mergeFabricRun(target, runId, reference);
}

function collectFabricObjects(value: unknown, found: Map<string, FabricRunReference>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectFabricObjects(item, found);
		return;
	}
	const object = asRecord(value);
	if (!object) return;
	collectFabricObject(object, found);
	for (const child of Object.values(object)) collectFabricObjects(child, found);
}

function collectFabricObject(
	object: Record<string, unknown>,
	found: Map<string, FabricRunReference>,
): void {
	const usage = asRecord(object.usage);
	const explicitRunId = typeof object.runId === "string" && FABRIC_RUN_ID.test(object.runId)
		? object.runId
		: undefined;
	const id = typeof object.id === "string" && FABRIC_RUN_ID.test(object.id) ? object.id : undefined;
	const candidate = explicitRunId ?? id;
	const isRunRecord = candidate !== undefined && isFabricRunRecord({
		hasExplicitRunId: explicitRunId !== undefined,
		hasUsage: usage !== null,
		hasName: typeof object.name === "string",
		hasStatus: typeof object.status === "string",
		hasRunner: typeof object.runner === "string",
		hasTask: typeof object.task === "string",
		hasCwd: typeof object.cwd === "string",
	});
	if (!isRunRecord || candidate === undefined) return;
	const cost = finiteNonNegative(usage?.cost);
	mergeFabricRun(found, candidate, cost === undefined ? {} : { cost });
}

function mergeFabricRun(
	target: Map<string, FabricRunReference>,
	runId: string,
	reference: FabricRunReference,
): void {
	const previousCost = target.get(runId)?.cost;
	const nextCost = reference.cost;
	target.set(runId, {
		cost: previousCost === undefined
			? nextCost
			: nextCost === undefined ? previousCost : Math.max(previousCost, nextCost),
	});
}

function collectFabricYaml(text: string, found: Map<string, FabricRunReference>): void {
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const match = /^(\s*)(-\s+)?id:\s*["']?([^"'\s]+)["']?\s*$/.exec(lines[index] ?? "");
		if (!match || !FABRIC_RUN_ID.test(match[3] ?? "")) continue;
		const indent = (match[1]?.length ?? 0) + (match[2] ? 2 : 0);
		let runId = match[3] as string;
		let hasExplicitRunId = false;
		let cost: number | undefined;
		let inUsage = false;
		let hasUsage = false;
		let hasName = false;
		let hasStatus = false;
		let hasRunner = false;
		let hasTask = false;
		let hasCwd = false;
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			const line = lines[cursor] ?? "";
			if (!line.trim()) continue;
			const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
			if (lineIndent < indent || (lineIndent === indent && /^\s*(?:-\s+)?id:/.test(line))) break;
			if (lineIndent === indent) {
				hasName ||= /^\s*name:\s*\S/.test(line);
				hasStatus ||= /^\s*status:\s*\S/.test(line);
				hasRunner ||= /^\s*runner:\s*\S/.test(line);
				hasTask ||= /^\s*task:\s*\S/.test(line);
				hasCwd ||= /^\s*cwd:\s*\S/.test(line);
				const runIdMatch = /^\s*runId:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
				if (runIdMatch?.[1] && FABRIC_RUN_ID.test(runIdMatch[1])) {
					runId = runIdMatch[1];
					hasExplicitRunId = true;
				}
			}
			if (lineIndent === indent && /^\s*usage:\s*$/.test(line)) {
				inUsage = true;
				hasUsage = true;
				continue;
			}
			if (inUsage && lineIndent <= indent) inUsage = false;
			if (inUsage) {
				const costMatch = /^\s*cost:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i.exec(line);
				if (costMatch) cost = finiteNonNegative(Number(costMatch[1]));
			}
		}
		const isRunRecord = isFabricRunRecord({
			hasExplicitRunId,
			hasUsage,
			hasName,
			hasStatus,
			hasRunner,
			hasTask,
			hasCwd,
		});
		if (isRunRecord) mergeFabricRun(found, runId, cost === undefined ? {} : { cost });
	}
}

function collectFabricContributions(
	rootFile: string,
	runs: Map<string, FabricRunReference>,
): Map<string, number> {
	const contributions = new Map<string, number>();
	const sessionsRoot = path.dirname(path.dirname(rootFile));
	const exportRoot = path.join(sessionsRoot, ".fabric");
	for (const [runId, reference] of runs) {
		let cost = reference.cost;
		if (cost === undefined) {
			const exportFile = findFileBySuffix(exportRoot, `_${runId}.jsonl`);
			if (exportFile) cost = sumAssistantCost(readJsonLines(exportFile));
		}
		if (cost !== undefined) contributions.set(`fabric:${runId}`, cost);
	}
	return contributions;
}

function findFileBySuffix(rootDir: string, suffix: string): string | null {
	if (!fs.existsSync(rootDir)) return null;
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile() && entry.name.endsWith(suffix)) return fullPath;
		}
	}
	return null;
}

function isFabricRunRecord(shape: FabricRunShape): boolean {
	return (shape.hasExplicitRunId && shape.hasUsage)
		|| (shape.hasName && shape.hasStatus && shape.hasRunner && shape.hasTask && shape.hasCwd);
}
