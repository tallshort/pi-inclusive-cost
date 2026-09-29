import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	asRecord,
	finiteNonNegative,
	sumContributions,
	type AttributedToolResult,
	type CollectorSummary,
} from "./shared.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RUN_HEAD_BYTES = 1024 * 1024;

interface RunReference {
	cwd: string;
	parentFile: string;
	parentId: string;
	inlineCost?: number;
}

type LoadedCost =
	| { status: "missing" }
	| { status: "invalid" }
	| { status: "valid"; cost?: number };

export function collectDynamicWorkflows(
	toolResults: AttributedToolResult[],
	workflowHome = path.join(os.homedir(), ".pi", "workflows"),
): CollectorSummary {
	const runs = new Map<string, RunReference | null>();
	for (const result of toolResults) {
		if (result.toolName !== "workflow" || !result.cwd || !result.sessionId) continue;
		const details = asRecord(result.details);
		const runId = typeof details?.runId === "string" ? details.runId : undefined;
		if (!runId || !RUN_ID.test(runId) || typeof details?.background !== "boolean" && details?.background !== undefined) continue;
		const reference: RunReference = {
			cwd: result.cwd,
			parentFile: result.sessionFile,
			parentId: result.sessionId,
			inlineCost: details?.background === true ? undefined : usableCost(details?.tokenUsage),
		};
		const previous = runs.get(runId);
		if (previous === null) continue;
		if (previous && !sameReference(previous, reference)) {
			runs.set(runId, null);
			continue;
		}
		if (previous?.inlineCost !== undefined && reference.inlineCost !== undefined) {
			reference.inlineCost = Math.max(previous.inlineCost, reference.inlineCost);
		} else if (previous?.inlineCost !== undefined) {
			reference.inlineCost = previous.inlineCost;
		}
		runs.set(runId, reference);
	}

	const contributions = new Map<string, number>();
	for (const [runId, reference] of runs) {
		if (!reference) continue;
		const loaded = loadRunCost(workflowHome, runId, reference);
		if (loaded.status === "invalid") continue;
		const cost = loaded.status === "valid" ? loaded.cost : reference.inlineCost;
		if (cost !== undefined) contributions.set(`dynamic-workflow:${runId}`, cost);
	}
	return { cost: sumContributions(contributions), count: contributions.size };
}

function loadRunCost(workflowHome: string, runId: string, reference: RunReference): LoadedCost {
	const modernRuns = path.join(workflowHome, "projects", projectKey(reference.cwd), "runs");
	const legacyRuns = path.join(reference.cwd, ".pi", "workflows", "runs");
	for (const runsRoot of [modernRuns, legacyRuns]) {
		const runFile = path.join(runsRoot, `${runId}.json`);
		if (!pathEntryExists(runFile)) continue;
		const head = readRunHead(runFile, runsRoot);
		if (!validRunHead(head)) return { status: "invalid" };
		const index = asRecord(head.index);
		if (index?.runId !== runId || index.parentSessionId !== reference.parentId) return { status: "invalid" };
		if (typeof index.parentSessionFile !== "string" || !sameFile(index.parentSessionFile, reference.parentFile)) {
			return { status: "invalid" };
		}
		return { status: "valid", cost: usableCost(index.tokenUsage) };
	}
	return { status: "missing" };
}

function readRunHead(file: string, runsRoot: string): Record<string, unknown> | null {
	let descriptor: number | undefined;
	try {
		const resolvedRoot = path.resolve(runsRoot);
		const resolvedFile = path.resolve(file);
		const realRoot = fs.realpathSync(resolvedRoot);
		const realFile = fs.realpathSync(resolvedFile);
		if (realRoot !== resolvedRoot || realFile !== resolvedFile) return null;
		if (!realFile.startsWith(`${realRoot}${path.sep}`)) return null;
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		descriptor = fs.openSync(realFile, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > MAX_RUN_HEAD_BYTES) return null;
		const buffer = Buffer.allocUnsafe(MAX_RUN_HEAD_BYTES + 1);
		const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_RUN_HEAD_BYTES) return null;
		return asRecord(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
	} catch {
		return null;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function validRunHead(head: Record<string, unknown> | null): head is Record<string, unknown> {
	if (!head || head.format !== "pi-workflow-run-v2") return false;
	if (!Number.isSafeInteger(head.bytes) || (head.bytes as number) <= 0) return false;
	if (!Number.isSafeInteger(head.sequence) || (head.sequence as number) <= 0) return false;
	if (typeof head.generation !== "string" || typeof head.hash !== "string") return false;
	if (!asRecord(head.index) || !asRecord(head.summary)) return false;
	return Array.isArray(head.keys) && head.keys.every((key) => typeof key === "string");
}

function pathEntryExists(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch (error) {
		return asRecord(error)?.code !== "ENOENT";
	}
}

function usableCost(value: unknown): number | undefined {
	const usage = asRecord(value);
	const cost = finiteNonNegative(usage?.cost);
	if (cost === undefined || cost === 0 && usage?.estimated === true) return undefined;
	return cost;
}

function projectKey(cwd: string): string {
	const resolved = path.resolve(cwd);
	const slug = path.basename(resolved).toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "project";
	const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
	return `${slug}-${hash}`;
}

function sameReference(left: RunReference, right: RunReference): boolean {
	return path.resolve(left.cwd) === path.resolve(right.cwd)
		&& left.parentId === right.parentId
		&& sameFile(left.parentFile, right.parentFile);
}

function sameFile(left: string, right: string): boolean {
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return false;
	}
}
