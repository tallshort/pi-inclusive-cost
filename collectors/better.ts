import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
	asRecord,
	contentText,
	finiteNonNegative,
	readJsonFile,
	sumContributions,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const RUN_ID = /^sa_[a-z0-9]+_[a-z0-9]+$/i;
const MAX_SESSION_LINE_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_CANDIDATES = 32;
const RUN_STATUSES = new Set(["running", "completed", "failed", "killed", "orphaned", "lost"]);

interface ParentIdentity {
	sessionId: string;
	cwd: string;
}

interface RunReference {
	runId: string;
	parent: ParentIdentity;
}

interface SessionScan {
	cost?: number;
	nested: RunReference[];
}

export function collectBetter(
	toolResults: AttributedToolResult[],
	registryRoot = defaultRegistryRoot(),
): CollectorSummary {
	const queue: RunReference[] = [];
	const parentCache = new Map<string, ParentIdentity | null>();
	for (const result of toolResults) {
		const parent = sessionIdentity(result.sessionFile, parentCache);
		if (!parent) continue;
		for (const runId of extractRunIds(result.toolName, result.content)) queue.push({ runId, parent });
	}

	const contributions = new Map<string, number>();
	const processed = new Set<string>();
	const attempted = new Set<string>();
	while (queue.length > 0) {
		const reference = queue.shift()!;
		const attemptKey = `${reference.runId}\0${reference.parent.sessionId}\0${reference.parent.cwd}`;
		if (attempted.has(attemptKey) || processed.has(reference.runId)) continue;
		attempted.add(attemptKey);
		if (!validRunMeta(registryRoot, reference)) continue;
		const sessionFile = findRunSessionFile(registryRoot, reference.runId);
		if (!sessionFile) continue;
		const scan = scanRunSession(sessionFile, reference.runId);
		if (!scan) continue;
		processed.add(reference.runId);
		if (scan.cost !== undefined) contributions.set(`better:${reference.runId}`, scan.cost);
		queue.push(...scan.nested);
	}

	return { cost: sumContributions(contributions), count: contributions.size };
}

function defaultRegistryRoot(): string {
	let temporaryRoot = os.tmpdir();
	try {
		temporaryRoot = fs.realpathSync(temporaryRoot);
	} catch {
		// An unavailable temp root simply produces no attributable runs.
	}
	return path.join(temporaryRoot, "pi-better-subagents");
}

function sessionIdentity(
	sessionFile: string,
	cache: Map<string, ParentIdentity | null>,
): ParentIdentity | null {
	if (cache.has(sessionFile)) return cache.get(sessionFile) ?? null;
	const identity = readSessionHeader(sessionFile);
	cache.set(sessionFile, identity);
	return identity;
}

function extractRunIds(toolName: string, content: unknown): string[] {
	const text = contentText(content);
	const found = new Set<string>();
	const referencedIds = new Set([...text.matchAll(/\bsa_[a-z0-9]+_[a-z0-9]+\b/gi)].map((match) => match[0]!));
	if (toolName === "subagent_spawn") {
		const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
		const match = /^Subagent launched: .*\bid=(sa_[a-z0-9]+_[a-z0-9]+) \(pid \d+\)\.$/i.exec(firstLine);
		const runId = match?.[1];
		return runId && referencedIds.size === 1 && referencedIds.has(runId) ? [runId] : [];
	}
	if (toolName === "subagent_spawn_batch") {
		const lines = text.split(/\r?\n/);
		const header = /^Batch .+ launched ([1-9]\d*) subagent\(s\):$/.exec(lines[0] ?? "");
		const expected = Number(header?.[1]);
		if (!header || !Number.isSafeInteger(expected) || lines.length < expected + 1) return [];
		for (let index = 1; index <= expected; index += 1) {
			const match = /^• .* → (sa_[a-z0-9]+_[a-z0-9]+)(?: · .*|\s*)$/i.exec(lines[index] ?? "");
			if (!match?.[1] || !RUN_ID.test(match[1])) return [];
			found.add(match[1]);
		}
		const remainder = lines.slice(expected + 1);
		if (remainder.some((line) => !/^Failed \(\d+\): .+$/.test(line) && !/^Skipped \(capacity\): .+$/.test(line))) return [];
		if (found.size !== expected || referencedIds.size !== found.size
			|| [...referencedIds].some((runId) => !found.has(runId))) return [];
	}
	return [...found];
}

function validRunMeta(registryRoot: string, reference: RunReference): boolean {
	const runDirectory = containedRunDirectory(registryRoot, reference.runId);
	if (!runDirectory) return false;
	const metaPath = path.join(runDirectory, "meta.json");
	try {
		if (fs.lstatSync(metaPath).isSymbolicLink()) return false;
		const resolvedMeta = fs.realpathSync(metaPath);
		if (!resolvedMeta.startsWith(`${runDirectory}${path.sep}`)) return false;
	} catch {
		return false;
	}
	const meta = asRecord(readJsonFile(metaPath));
	if (!meta || meta.id !== reference.runId || meta.sessionId !== reference.runId) return false;
	if (typeof meta.status !== "string" || !RUN_STATUSES.has(meta.status)) return false;
	const origin = asRecord(meta.callbackOrigin);
	return origin?.sessionId === reference.parent.sessionId && origin.cwd === reference.parent.cwd;
}

function containedRunDirectory(registryRoot: string, runId: string): string | null {
	const runsRoot = path.resolve(registryRoot, "runs");
	const candidate = path.join(runsRoot, runId);
	try {
		if (fs.lstatSync(candidate).isSymbolicLink()) return null;
		const resolved = fs.realpathSync(candidate);
		return resolved.startsWith(`${runsRoot}${path.sep}`) && fs.statSync(resolved).isDirectory()
			? resolved
			: null;
	} catch {
		return null;
	}
}

function findRunSessionFile(registryRoot: string, runId: string): string | null {
	const sessionsRoot = path.resolve(registryRoot, "sessions");
	const candidatePaths = new Set<string>();
	collectJsonlFiles(path.join(sessionsRoot, runId), sessionsRoot, candidatePaths, true);
	if (candidatePaths.size > MAX_SESSION_CANDIDATES) return null;
	const matching = [...candidatePaths].filter((file) => readSessionHeader(file)?.sessionId === runId);
	return matching.length === 1 ? matching[0]! : null;
}

function collectJsonlFiles(
	candidate: string,
	root: string,
	found: Set<string>,
	recurse: boolean,
): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(candidate);
	} catch {
		return;
	}
	if (found.size > MAX_SESSION_CANDIDATES) return;
	if (stat.isSymbolicLink()) return;
	if (stat.isFile()) {
		if (!candidate.endsWith(".jsonl")) return;
		let resolved: string;
		try {
			resolved = fs.realpathSync(candidate);
		} catch {
			return;
		}
		if (resolved.startsWith(`${root}${path.sep}`)) found.add(resolved);
		return;
	}
	if (!recurse || !stat.isDirectory()) return;
	let names: string[];
	try {
		names = fs.readdirSync(candidate);
	} catch {
		return;
	}
	for (const name of names) {
		if (found.size > MAX_SESSION_CANDIDATES) break;
		collectJsonlFiles(path.join(candidate, name), root, found, true);
	}
}

function readSessionHeader(file: string): ParentIdentity | null {
	let identity: ParentIdentity | null = null;
	visitJsonLines(file, (value, index) => {
		if (index !== 0) return false;
		identity = identityFromHeader(value);
		return false;
	}, 1);
	return identity;
}

function identityFromHeader(value: unknown): ParentIdentity | null {
	const header = asRecord(value);
	return header?.type === "session" && typeof header.id === "string" && header.id.length > 0
		&& typeof header.cwd === "string" && header.cwd.length > 0
		? { sessionId: header.id, cwd: header.cwd }
		: null;
}

function scanRunSession(file: string, expectedSessionId: string): SessionScan | null {
	let validHeader = false;
	let foundCost = false;
	let cost = 0;
	const nested: RunReference[] = [];
	let parent: ParentIdentity | undefined;
	const complete = visitJsonLines(file, (value, index) => {
		if (index === 0) {
			parent = identityFromHeader(value) ?? undefined;
			if (!parent || parent.sessionId !== expectedSessionId) return false;
			validHeader = true;
			return true;
		}
		const record = asRecord(value);
		if (!validHeader || record?.type !== "message") return true;
		const message = asRecord(record.message);
		if (message?.role === "assistant") {
			const usage = asRecord(message.usage);
			const costRecord = asRecord(usage?.cost);
			const value = finiteNonNegative(costRecord?.total);
			if (value !== undefined) {
				foundCost = true;
				cost += value;
			}
		}
		if (message?.role === "toolResult" && typeof message.toolName === "string" && parent) {
			for (const runId of extractRunIds(message.toolName, message.content)) nested.push({ runId, parent });
		}
		return true;
	});
	if (!complete || !validHeader) return null;
	return { cost: foundCost ? cost : undefined, nested };
}

function visitJsonLines(
	file: string,
	visitor: (value: unknown, index: number) => boolean,
	lineLimit = Number.POSITIVE_INFINITY,
): boolean {
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, "r");
	} catch {
		return false;
	}
	const decoder = new StringDecoder("utf8");
	const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	let pending = "";
	let pendingBytes = 0;
	let searchFrom = 0;
	let index = 0;
	let keepReading = true;
	try {
		while (keepReading && index < lineLimit) {
			const bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null);
			if (bytes === 0) break;
			const piece = decoder.write(chunk.subarray(0, bytes));
			pending += piece;
			pendingBytes += Buffer.byteLength(piece);
			let newline = pending.indexOf("\n", searchFrom);
			if (newline < 0) {
				if (pendingBytes > MAX_SESSION_LINE_BYTES) return false;
				searchFrom = pending.length;
				continue;
			}
			while (newline >= 0 && index < lineLimit) {
				const consumed = pending.slice(0, newline + 1);
				const line = consumed.slice(0, -1).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				pendingBytes -= Buffer.byteLength(consumed);
				searchFrom = 0;
				if (!line.trim()) {
					newline = pending.indexOf("\n");
					continue;
				}
				if (Buffer.byteLength(line) > MAX_SESSION_LINE_BYTES) return false;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					return false;
				}
				keepReading = visitor(value, index++);
				if (!keepReading) break;
				newline = pending.indexOf("\n");
			}
			if (newline < 0) searchFrom = pending.length;
		}
		pending += decoder.end();
		if (keepReading && index < lineLimit && pending.trim()) {
			if (Buffer.byteLength(pending) > MAX_SESSION_LINE_BYTES) return false;
			try {
				keepReading = visitor(JSON.parse(pending), index);
			} catch {
				return false;
			}
		}
		return keepReading || index > 0;
	} finally {
		fs.closeSync(descriptor);
	}
}
