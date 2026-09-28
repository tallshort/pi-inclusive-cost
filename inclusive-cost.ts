import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "00-inclusiveCost";
const FABRIC_RUN_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface CostTotals {
	direct: number;
	subagents: number;
	fabric: number;
	taskflow: number;
	inclusive: number;
	subagentCount: number;
	fabricRunCount: number;
	taskflowRunCount: number;
}

interface SessionHeader {
	id?: string;
	cwd?: string;
	parentSession?: string;
}

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

export default function inclusiveCost(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", (_event, ctx) => updateStatus(ctx));
	pi.on("agent_end", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));

	pi.registerCommand("cost", {
		description: "Show session cost including delegated runs",
		handler: async (_args, ctx) => {
			const totals = computeTotals(ctx);
			if (!totals) {
				ctx.ui.notify("No session file for this chat yet.", "warning");
				return;
			}
			const lines = [
				`Direct (this thread): $${totals.direct.toFixed(2)}`,
				`Pi subagent sessions (${totals.subagentCount}): $${totals.subagents.toFixed(2)}`,
				`Fabric runs (${totals.fabricRunCount}): $${totals.fabric.toFixed(2)}`,
				`Taskflow runs (${totals.taskflowRunCount}): $${totals.taskflow.toFixed(2)}`,
				`Inclusive total: $${totals.inclusive.toFixed(2)}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function updateStatus(ctx: ExtensionContext): void {
	const totals = computeTotals(ctx);
	const delegatedCount = totals
		? totals.subagentCount + totals.fabricRunCount + totals.taskflowRunCount
		: 0;
	if (!totals || delegatedCount === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `$${totals.inclusive.toFixed(2)} (incl) •`));
}

function computeTotals(ctx: ExtensionContext): CostTotals | null {
	let rootFile: string | undefined;
	try {
		rootFile = ctx.sessionManager.getSessionFile();
	} catch {
		return null;
	}
	if (!rootFile) return null;

	const sessionFiles = discoverSessionTree(rootFile);
	const sessionContributions = new Map<string, number>();
	const fabricRuns = new Map<string, FabricRunReference>();
	const taskflowRuns = new Map<string, TaskflowRunReference>();

	for (const file of sessionFiles) {
		const entries = readJsonLines(file);
		sessionContributions.set(`pi-session:${file}`, sumAssistantCost(entries));
		const header = sessionHeaderFromEntries(entries);
		collectOrchestrationReferences(entries, header?.cwd, fabricRuns, taskflowRuns);
	}

	const direct = sessionContributions.get(`pi-session:${rootFile}`) ?? 0;
	let subagents = 0;
	for (const [key, cost] of sessionContributions) {
		if (key !== `pi-session:${rootFile}`) subagents += cost;
	}

	const fabricContributions = collectFabricContributions(rootFile, fabricRuns);
	const taskflowContributions = collectTaskflowContributions(taskflowRuns);
	const fabric = sumContributions(fabricContributions);
	const taskflow = sumContributions(taskflowContributions);

	return {
		direct,
		subagents,
		fabric,
		taskflow,
		inclusive: direct + subagents + fabric + taskflow,
		subagentCount: Math.max(0, sessionFiles.size - 1),
		fabricRunCount: fabricRuns.size,
		taskflowRunCount: taskflowRuns.size,
	};
}

function discoverSessionTree(rootFile: string): Set<string> {
	const visited = new Set<string>([rootFile]);
	const queue: string[] = [rootFile];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		const stem = path.basename(current, ".jsonl");
		const nestedRoot = path.join(path.dirname(current), stem);
		for (const descendant of findNestedSessionFiles(nestedRoot)) {
			if (visited.has(descendant)) continue;
			visited.add(descendant);
			queue.push(descendant);
		}

		for (const file of listTopLevelSessionFiles(path.dirname(current))) {
			if (visited.has(file)) continue;
			if (readParentSession(file) !== current) continue;
			visited.add(file);
			queue.push(file);
		}
	}
	return visited;
}

function collectOrchestrationReferences(
	entries: unknown[],
	cwd: string | undefined,
	fabricRuns: Map<string, FabricRunReference>,
	taskflowRuns: Map<string, TaskflowRunReference>,
): void {
	for (const entry of entries) {
		const record = asRecord(entry);
		const message = asRecord(record?.message);
		if (record?.type !== "message" || message?.role !== "toolResult") continue;
		const toolName = message.toolName;
		if (toolName === "fabric_exec") {
			for (const [runId, reference] of extractFabricRuns(message)) {
				const previous = fabricRuns.get(runId);
				const previousCost = previous?.cost;
				const nextCost = reference.cost;
				fabricRuns.set(runId, {
					cost: previousCost === undefined
						? nextCost
						: nextCost === undefined ? previousCost : Math.max(previousCost, nextCost),
				});
			}
		}
		if (toolName === "taskflow") {
			for (const [runId, reference] of extractTaskflowRuns(message, cwd)) {
				const previous = taskflowRuns.get(runId);
				taskflowRuns.set(runId, previous && reference.fromState === false
					? { cwd: previous.cwd }
					: { cwd: reference.cwd });
			}
		}
	}
}

function extractFabricRuns(message: Record<string, unknown>): Map<string, FabricRunReference> {
	const found = new Map<string, FabricRunReference>();
	const text = contentText(message.content);
	try {
		collectFabricObjects(JSON.parse(text), found);
	} catch {
		collectFabricYaml(text, found);
	}
	const audits = asRecord(message.details)?.audits;
	if (Array.isArray(audits)) {
		for (const value of audits) {
			const audit = asRecord(value);
			if (!audit || audit.ref !== "agents.run" || audit.provider !== "agents" || audit.tool !== "run") continue;
			if (audit.success !== true) continue;
			const run = asRecord(audit.result);
			if (run) collectFabricObject(run, found);
		}
	}
	return found;
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

function extractTaskflowRuns(
	message: Record<string, unknown>,
	fallbackCwd: string | undefined,
): Map<string, { cwd: string; fromState: boolean }> {
	const found = new Map<string, { cwd: string; fromState: boolean }>();
	const details = asRecord(message.details);
	const state = asRecord(details?.state);
	if (typeof state?.runId === "string") {
		const stateCwd = typeof state.cwd === "string" ? state.cwd : fallbackCwd;
		if (stateCwd) found.set(state.runId, { cwd: stateCwd, fromState: true });
	}
	if (fallbackCwd) {
		for (const match of contentText(message.content).matchAll(/\bRun id:\s*([A-Za-z0-9._-]+)/g)) {
			if (match[1] && !found.has(match[1])) found.set(match[1], { cwd: fallbackCwd, fromState: false });
		}
	}
	return found;
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

function listTopLevelSessionFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

function readParentSession(filePath: string): string | null {
	const first = asRecord(readFirstJsonLine(filePath));
	return first?.type === "session" && typeof first.parentSession === "string"
		? first.parentSession
		: null;
}

function readFirstJsonLine(filePath: string): unknown {
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const buffer = Buffer.alloc(8_192);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
		return firstLine ? JSON.parse(firstLine) : null;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

function readJsonLines(filePath: string): unknown[] {
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
			// Ignore incomplete or unrelated lines; persisted sessions are append-only.
		}
	}
	return entries;
}

function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function sessionHeaderFromEntries(entries: unknown[]): SessionHeader | null {
	const first = asRecord(entries[0]);
	if (first?.type !== "session") return null;
	return {
		id: typeof first.id === "string" ? first.id : undefined,
		cwd: typeof first.cwd === "string" ? first.cwd : undefined,
		parentSession: typeof first.parentSession === "string" ? first.parentSession : undefined,
	};
}

function sumAssistantCost(entries: unknown[]): number {
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

function findNestedSessionFiles(rootDir: string): string[] {
	return findFiles(rootDir, (entry, parentDir) => {
		const isNestedSession = entry.name === "session.jsonl";
		const isTaskSession = path.basename(parentDir) === "tasks" && entry.name.endsWith(".jsonl");
		return (isNestedSession || isTaskSession) && isPiSessionFile(path.join(parentDir, entry.name));
	});
}

function isPiSessionFile(filePath: string): boolean {
	return sessionHeaderFromEntries(readJsonLines(filePath)) !== null;
}

function findFileBySuffix(rootDir: string, suffix: string): string | null {
	return findFiles(rootDir, (entry) => entry.name.endsWith(suffix), true)[0] ?? null;
}

function findFiles(
	rootDir: string,
	matches: (entry: fs.Dirent, parentDir: string) => boolean,
	stopAfterFirst = false,
): string[] {
	if (!fs.existsSync(rootDir)) return [];
	const found: string[] = [];
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
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && matches(entry, current)) {
				found.push(fullPath);
				if (stopAfterFirst) return found;
			}
		}
	}
	return found;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function isFabricRunRecord(shape: FabricRunShape): boolean {
	return (shape.hasExplicitRunId && shape.hasUsage)
		|| (shape.hasName && shape.hasStatus && shape.hasRunner && shape.hasTask && shape.hasCwd);
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumContributions(contributions: Map<string, number>): number {
	let total = 0;
	for (const cost of contributions.values()) total += cost;
	return total;
}
