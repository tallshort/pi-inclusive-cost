import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "inclusiveCost";

export default function inclusiveCost(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", (_event, ctx) => updateStatus(ctx));
	pi.on("agent_end", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));

	pi.registerCommand("cost", {
		description: "Show session cost including subagent sessions",
		handler: async (_args, ctx) => {
			const totals = computeTotals(ctx);
			if (!totals) {
				ctx.ui.notify("No session file for this chat yet.", "warning");
				return;
			}
			const lines = [
				`Direct (this thread): $${totals.direct.toFixed(2)}`,
				`Inclusive (+ subagents): $${totals.inclusive.toFixed(2)}`,
				`Subagent sessions folded in: ${totals.subagentCount}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

interface CostTotals {
	direct: number;
	inclusive: number;
	subagentCount: number;
}

function updateStatus(ctx: ExtensionContext): void {
	const totals = computeTotals(ctx);
	if (!totals || totals.subagentCount === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, `incl $${totals.inclusive.toFixed(2)}`);
}

/**
 * Subagent sessions are linked back to their parent one of two ways: nested
 * under <rootFile-without-ext>/**\/session.jsonl (fan-out workers), or as a flat
 * sibling *.jsonl in the same directory whose header carries a `parentSession`
 * pointer (e.g. single-shot consult-style subagents). Both must be walked to a
 * fixed point, since either kind can itself be a parent of the other kind.
 */
function computeTotals(ctx: ExtensionContext): CostTotals | null {
	let rootFile: string | undefined;
	try {
		rootFile = ctx.sessionManager.getSessionFile();
	} catch {
		return null;
	}
	if (!rootFile) return null;

	const projectDir = path.dirname(rootFile);
	const topLevelFiles = listTopLevelSessionFiles(projectDir);
	const parentByFile = new Map<string, string | null>();
	for (const file of topLevelFiles) {
		parentByFile.set(file, readParentSession(file));
	}

	const visited = new Set<string>([rootFile]);
	const queue: string[] = [rootFile];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		const stem = path.basename(current, ".jsonl");
		const nestedRoot = path.join(path.dirname(current), stem);
		for (const descendant of findNestedSessionFiles(nestedRoot)) {
			if (!visited.has(descendant)) {
				visited.add(descendant);
				queue.push(descendant);
			}
		}

		for (const file of topLevelFiles) {
			if (visited.has(file)) continue;
			const parent = parentByFile.get(file);
			if (parent && parent === current) {
				visited.add(file);
				queue.push(file);
			}
		}
	}

	let inclusive = 0;
	for (const file of visited) {
		inclusive += sumCostFromSessionFile(file);
	}
	const direct = sumCostFromSessionFile(rootFile);

	return { direct, inclusive, subagentCount: visited.size - 1 };
}

function listTopLevelSessionFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => path.join(dir, entry.name));
}

function readParentSession(filePath: string): string | null {
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const buffer = Buffer.alloc(4096);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
		if (!firstLine) return null;
		const entry = JSON.parse(firstLine);
		return typeof entry?.parentSession === "string" ? entry.parentSession : null;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

function sumCostFromSessionFile(filePath: string): number {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return 0;
	}

	let total = 0;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let entry: any;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
		const cost = entry.message?.usage?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
			total += cost;
		}
	}
	return total;
}

function findNestedSessionFiles(rootDir: string): string[] {
	if (!fs.existsSync(rootDir)) return [];

	const out: string[] = [];
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
			} else if (entry.isFile() && entry.name === "session.jsonl") {
				out.push(fullPath);
			}
		}
	}

	return out;
}
