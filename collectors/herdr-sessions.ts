import fs from "node:fs";
import path from "node:path";

import {
	asRecord,
	assistantCostSummary,
	readJsonLines,
	sessionEntryIds,
	sumContributions,
	type AttributedCustomMessage,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const HENRY_TOOL_NAME = "delegate_task";
const HENRY_RESULT_TYPE = "subagent-direct-result";
const HERDR_TOOL_NAME = "subagent";

interface SessionReference {
	childFile: string;
	parentFile: string;
}

interface HenryLaunch {
	sessionFile: string;
	tabId: string;
	entries: Map<string, { index: number; name: string }>;
}

export function collectHerdrSessions(
	toolResults: AttributedToolResult[],
	customMessages: AttributedCustomMessage[],
	alreadyCollectedFiles: ReadonlySet<string>,
): CollectorSummary {
	const references = new Map<string, SessionReference>();
	const henryLaunches = new Map<string, HenryLaunch>();

	for (const result of toolResults) {
		const details = asRecord(result.details);
		if (result.toolName === HENRY_TOOL_NAME && isHenryLaunch(details)) {
			const launch = parseHenryLaunch(details);
			if (!launch) continue;
			henryLaunches.set(henryLaunchKey(result.sessionFile, details.taskId), launch);
			addReference(references, details.sessionFile, result.sessionFile);
			continue;
		}
		if (result.toolName === HERDR_TOOL_NAME && isHerdrLaunch(details)) {
			addReference(references, details.sessionFile, result.sessionFile);
		}
	}

	for (const message of customMessages) {
		if (message.customType !== HENRY_RESULT_TYPE) continue;
		const details = asRecord(message.details);
		if (!isHenryResult(details)) continue;
		const launch = henryLaunches.get(henryLaunchKey(message.sessionFile, details.taskId));
		if (!launch) continue;
		const tabs = validateHenryTabs(details.tabs, details.taskId, launch);
		if (!tabs) continue;
		for (const tab of tabs) addReference(references, tab.sessionFile, message.sessionFile);
	}

	const knownFiles = new Set([...alreadyCollectedFiles].map(canonicalFile).filter((file): file is string => file !== null));
	const parentIds = new Map<string, Set<string>>();
	const contributions = new Map<string, number>();
	for (const reference of references.values()) {
		const childFile = canonicalFile(reference.childFile);
		if (!childFile || knownFiles.has(childFile)) continue;
		const entries = readJsonLines(childFile);
		const header = asRecord(entries[0]);
		if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") continue;

		let inheritedIds: ReadonlySet<string> | undefined;
		if (typeof header.parentSession === "string") {
			if (!sameFile(header.parentSession, reference.parentFile)) continue;
			const parentFile = canonicalFile(reference.parentFile);
			if (!parentFile) continue;
			let ids = parentIds.get(parentFile);
			if (!ids) {
				ids = sessionEntryIds(readJsonLines(parentFile));
				parentIds.set(parentFile, ids);
			}
			inheritedIds = ids;
		}
		const summary = assistantCostSummary(entries, inheritedIds);
		if (summary.pricedMessages === 0) continue;
		contributions.set(`herdr-session:${childFile}`, summary.cost);
	}

	return { cost: sumContributions(contributions), count: contributions.size };
}

function addReference(references: Map<string, SessionReference>, childFile: string, parentFile: string): void {
	const key = path.resolve(childFile);
	if (!references.has(key)) references.set(key, { childFile, parentFile });
}

function isHenryLaunch(details: Record<string, unknown> | null): details is Record<string, unknown> & {
	taskId: string;
	tabId: string;
	sessionFile: string;
	entries: unknown[];
} {
	return details !== null
		&& typeof details.taskId === "string"
		&& (details.mode === "single" || details.mode === "parallel" || details.mode === "chain")
		&& typeof details.tabId === "string"
		&& typeof details.sessionFile === "string"
		&& path.isAbsolute(details.sessionFile)
		&& Array.isArray(details.entries)
		&& details.entries.length > 0
		&& details.entries.every(isHenryLaunchEntry);
}

function isHenryLaunchEntry(value: unknown): boolean {
	const entry = asRecord(value);
	return entry !== null
		&& typeof entry.id === "string"
		&& typeof entry.index === "number"
		&& Number.isInteger(entry.index)
		&& typeof entry.name === "string"
		&& typeof entry.role === "string";
}

function parseHenryLaunch(details: Record<string, unknown> & {
	tabId: string;
	sessionFile: string;
	entries: unknown[];
}): HenryLaunch | null {
	const entries = new Map<string, { index: number; name: string }>();
	const indexes = new Set<number>();
	for (const value of details.entries) {
		const entry = asRecord(value)!;
		const id = entry.id as string;
		const index = entry.index as number;
		if (entries.has(id) || indexes.has(index)) return null;
		entries.set(id, { index, name: entry.name as string });
		indexes.add(index);
	}
	if (![...entries.values()].some((entry) => entry.index === 0)) return null;
	return { sessionFile: details.sessionFile, tabId: details.tabId, entries };
}

function isHenryResult(details: Record<string, unknown> | null): details is Record<string, unknown> & {
	taskId: string;
	tabs: unknown[];
} {
	return details !== null
		&& typeof details.taskId === "string"
		&& (details.outcome === "completed" || details.outcome === "failed")
		&& Array.isArray(details.tabs);
}

function isHenryTab(tab: Record<string, unknown> | null, taskId: string): tab is Record<string, unknown> & { sessionFile: string } {
	return tab !== null
		&& tab.taskId === taskId
		&& typeof tab.entryId === "string"
		&& typeof tab.name === "string"
		&& typeof tab.tabId === "string"
		&& typeof tab.paneId === "string"
		&& typeof tab.sessionFile === "string"
		&& path.isAbsolute(tab.sessionFile);
}

function validateHenryTabs(
	values: unknown[],
	taskId: string,
	launch: HenryLaunch,
): Array<Record<string, unknown> & { sessionFile: string }> | null {
	const tabs: Array<Record<string, unknown> & { sessionFile: string }> = [];
	const seenEntries = new Set<string>();
	for (const value of values) {
		const tab = asRecord(value);
		if (!isHenryTab(tab, taskId)) return null;
		const expected = launch.entries.get(tab.entryId as string);
		if (!expected || expected.name !== tab.name || seenEntries.has(tab.entryId as string)) return null;
		if (expected.index === 0 && (tab.tabId !== launch.tabId || path.resolve(tab.sessionFile) !== path.resolve(launch.sessionFile))) return null;
		seenEntries.add(tab.entryId as string);
		tabs.push(tab);
	}
	return tabs;
}

function isHerdrLaunch(details: Record<string, unknown> | null): details is Record<string, unknown> & { sessionFile: string } {
	return details !== null
		&& details.status === "started"
		&& typeof details.id === "string"
		&& typeof details.name === "string"
		&& typeof details.task === "string"
		&& typeof details.launchScriptFile === "string"
		&& typeof details.sessionFile === "string"
		&& path.isAbsolute(details.sessionFile);
}

function henryLaunchKey(parentFile: string, taskId: string): string {
	return `${parentFile}:${taskId}`;
}

function canonicalFile(file: string): string | null {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) return null;
		return fs.realpathSync(file);
	} catch {
		return null;
	}
}

function sameFile(left: string, right: string): boolean {
	const canonicalLeft = canonicalFile(left);
	const canonicalRight = canonicalFile(right);
	return canonicalLeft !== null && canonicalLeft === canonicalRight;
}
