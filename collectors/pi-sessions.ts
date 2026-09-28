import fs from "node:fs";
import path from "node:path";

import {
	asRecord,
	readJsonLines,
	sumAssistantCost,
	type AttributedCustomMessage,
	type AttributedToolResult,
} from "./shared.js";

interface SessionHeader {
	id?: string;
	cwd?: string;
	parentSession?: string;
}

export interface PiSessionCollection {
	directCost: number;
	delegatedCost: number;
	delegatedCount: number;
	toolResults: AttributedToolResult[];
	customMessages: AttributedCustomMessage[];
}

export function collectPiSessions(rootFile: string): PiSessionCollection {
	const sessionFiles = discoverSessionTree(rootFile);
	const sessionContributions = new Map<string, number>();
	const toolResults: AttributedToolResult[] = [];
	const customMessages: AttributedCustomMessage[] = [];

	for (const file of sessionFiles) {
		const entries = readJsonLines(file);
		sessionContributions.set(`pi-session:${file}`, sumAssistantCost(entries));
		const header = sessionHeaderFromEntries(entries);
		collectAttributedRecords(entries, file, header?.cwd, toolResults, customMessages);
	}

	const rootKey = `pi-session:${rootFile}`;
	let delegatedCost = 0;
	for (const [key, cost] of sessionContributions) {
		if (key !== rootKey) delegatedCost += cost;
	}

	return {
		directCost: sessionContributions.get(rootKey) ?? 0,
		delegatedCost,
		delegatedCount: Math.max(0, sessionFiles.size - 1),
		toolResults,
		customMessages,
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

function collectAttributedRecords(
	entries: unknown[],
	sessionFile: string,
	cwd: string | undefined,
	toolResults: AttributedToolResult[],
	customMessages: AttributedCustomMessage[],
): void {
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record?.type === "custom_message" && typeof record.customType === "string") {
			customMessages.push({
				sessionFile,
				customType: record.customType,
				content: record.content,
				details: record.details,
				cwd,
			});
			continue;
		}
		const message = asRecord(record?.message);
		if (record?.type !== "message" || message?.role !== "toolResult") continue;
		if (typeof message.toolName !== "string") continue;
		toolResults.push({
			sessionFile,
			toolName: message.toolName,
			toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
			content: message.content,
			details: message.details,
			usage: message.usage,
			cwd,
		});
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

function sessionHeaderFromEntries(entries: unknown[]): SessionHeader | null {
	const first = asRecord(entries[0]);
	if (first?.type !== "session") return null;
	return {
		id: typeof first.id === "string" ? first.id : undefined,
		cwd: typeof first.cwd === "string" ? first.cwd : undefined,
		parentSession: typeof first.parentSession === "string" ? first.parentSession : undefined,
	};
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

function findFiles(
	rootDir: string,
	matches: (entry: fs.Dirent, parentDir: string) => boolean,
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
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile() && matches(entry, current)) found.push(fullPath);
		}
	}
	return found;
}
