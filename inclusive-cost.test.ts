import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectBetter } from "./collectors/better.js";
import { collectDynamicWorkflows } from "./collectors/dynamic-workflows.js";
import inclusiveCost from "./inclusive-cost.js";

test("/cost includes @gotgenes task sessions stored as tasks/*.jsonl", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const taskFile = path.join(sessionDir, "root", "tasks", "child.jsonl");
	writeSession(rootFile, { id: "root-id", cost: 1.25, cwd: sessionDir });
	writeSession(taskFile, { id: "child-id", parentSession: "root-id", cost: 0.75, cwd: sessionDir });

	const notification = await invokeCost(rootFile);
	assert.equal(notification, [
		"Direct (this thread): $1.25",
		"Inclusive (+ subagents & delegated work): $2.00",
		"Subagent/delegated contributions folded in: 1",
	].join("\n"));
});

test("j0k3r tool results use greatest per-attempt cost and keep continuations distinct", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const ignoredFallback = path.join(sessionDir, "external", "child.jsonl");
	const taskId = "subtask_review_1000_a1b2c3d4";
	writeSession(ignoredFallback, { id: "child-id", cost: 99, cwd: sessionDir });
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("subagent_run", "started", { tasks: [j0k3rTask(taskId, 1, 0.2, ignoredFallback)] }),
			toolResult("subagent_status", "running", { task: j0k3rTask(taskId, 1, 0.35, ignoredFallback) }),
			toolResult("subagent_result", "done", { task: j0k3rTask(taskId, 1, 0.3, ignoredFallback) }),
			toolResult("subagent_continue", "continued", { results: [j0k3rTask(taskId, 2, 0.4, ignoredFallback)] }),
			toolResult("unrelated", "ignored", { tasks: [j0k3rTask("subtask_fake_1_deadbeef", 1, 50)] }),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.75, 2);
});

test("j0k3r falls back only to an explicitly referenced standard Pi session", async (t) => {
	const root = temporaryDirectory(t);
	const rootFile = path.join(root, "root.jsonl");
	const referencedSession = path.join(root, "external", "referenced.jsonl");
	const unrelatedSession = path.join(root, "external", "unrelated.jsonl");
	const invalidSession = path.join(root, "external", "invalid.jsonl");
	writeSession(referencedSession, { id: "child-id", cost: 0.6, cwd: root });
	writeSession(unrelatedSession, { id: "unrelated-id", cost: 9, cwd: root });
	fs.writeFileSync(invalidSession, `${JSON.stringify({
		type: "message",
		message: { role: "assistant", usage: { cost: { total: 50 } } },
	})}\n`);
	const task = {
		...j0k3rTask("subtask_research_2000_abcdef12", 1),
		nested_session_path: referencedSession,
	};
	const invalidTask = {
		...j0k3rTask("subtask_invalid_2000_12345678", 1),
		nested_session_path: invalidSession,
	};
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: root,
		extra: [
			toolResult("subagent_run", "started", { tasks: [task, invalidTask] }),
			toolResult("subagent_status", "done", { tasks: [task, invalidTask] }),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.60, 1);
});

test("j0k3r does not recollect tasks already reported through parent tool usage", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [toolResult(
			"subagent_run",
			"done",
			{ results: [j0k3rTask("subtask_reported_3000_1234abcd", 1, 0.5)] },
			0.5,
		)],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.00, 0);
});

test("bacnh85 scopes foreground result identities to their parent sessions", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "parallel", bacnh85Details([
				bacnh85Result("reviewer", 0.2),
				bacnh85Result("tester", 0.3),
			]), undefined, "call-1"),
			toolResult("subagent", "repeated", bacnh85Details([
				bacnh85Result("reviewer", 0.25),
				bacnh85Result("tester", 0.3),
			]), undefined, "call-1"),
			toolResult("subagent", "single", bacnh85Details([
				bacnh85Result("reviewer", 0.4),
			]), undefined, "call-2"),
			toolResult("subagent", "reported", bacnh85Details([
				bacnh85Result("reviewer", 0.5),
			]), 0.5, "call-3"),
			toolResult("subagent", "other package", { results: [{ usage: { cost: 50 } }] }, undefined, "call-4"),
		],
	});
	writeSession(nestedFile, {
		id: "nested-id",
		cost: 0,
		cwd: sessionDir,
		extra: [toolResult("subagent", "same tool id in child session", bacnh85Details([
			bacnh85Result("reviewer", 0.1),
		]), undefined, "call-1")],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 2.05, 5);
});

test("bacnh85 deduplicates background task IDs within each parent session", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "launched", bacnh85Details([], "bg-one"), undefined, "call-bg"),
			customMessage("pi-subagent-complete", { task_id: "bg-one", usage: { cost: 0.6 }, background: true }),
			customMessage("pi-subagent-complete", { task_id: "bg-one", usage: { cost: 0.7 }, background: true }),
			customMessage("pi-subagent-complete", { task_id: "bg-no-usage", background: true }),
			customMessage("other-extension", { task_id: "bg-other", usage: { cost: 50 }, background: true }),
		],
	});
	writeSession(nestedFile, {
		id: "nested-id",
		cost: 0,
		cwd: sessionDir,
		extra: [customMessage("pi-subagent-complete", {
			task_id: "bg-one",
			usage: { cost: 0.2 },
			background: true,
		})],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.90, 3);
});

test("Henry direct sessions are collected only from attributed delegate results", async (t) => {
	const root = temporaryDirectory(t);
	const rootFile = path.join(root, "root.jsonl");
	const firstChild = path.join(root, "henry", "first.jsonl");
	const secondChild = path.join(root, "henry", "second.jsonl");
	const missingUsageChild = path.join(root, "henry", "missing-usage.jsonl");
	const symlinkChild = path.join(root, "henry", "symlink.jsonl");
	const invalidChild = path.join(root, "henry", "invalid.jsonl");
	const unrelatedChild = path.join(root, "henry", "unrelated.jsonl");
	writeSession(firstChild, { id: "henry-first", cost: 0.2, cwd: root });
	writeSession(secondChild, { id: "henry-second", cost: 0, cwd: root });
	writeJsonLines(missingUsageChild, [
		{ type: "session", version: 3, id: "henry-missing", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
		{ type: "message", message: { role: "assistant", usage: {} } },
	]);
	fs.symlinkSync(unrelatedChild, symlinkChild);
	writeJsonLines(invalidChild, [{ type: "message", message: { role: "assistant", usage: { cost: { total: 50 } } } }]);
	writeSession(unrelatedChild, { id: "henry-unrelated", cost: 50, cwd: root });
	const launch = {
		taskId: "direct-task-1",
		mode: "parallel",
		tabId: "tab-1",
		sessionFile: firstChild,
		entries: [
			{ id: "entry-1", index: 0, name: "scout", role: "scout" },
			{ id: "entry-2", index: 1, name: "reviewer", role: "reviewer" },
			{ id: "entry-3", index: 2, name: "tester", role: "tester" },
			{ id: "entry-4", index: 3, name: "symlink", role: "scout" },
			{ id: "entry-5", index: 4, name: "invalid", role: "scout" },
		],
	};
	const completion = {
		taskId: "direct-task-1",
		outcome: "completed",
		tabs: [
			{ taskId: "direct-task-1", entryId: "entry-1", name: "scout", tabId: "tab-1", paneId: "pane-1", sessionFile: firstChild },
			{ taskId: "direct-task-1", entryId: "entry-2", name: "reviewer", tabId: "tab-2", paneId: "pane-2", sessionFile: secondChild },
			{ taskId: "direct-task-1", entryId: "entry-3", name: "tester", tabId: "tab-3", paneId: "pane-3", sessionFile: missingUsageChild },
			{ taskId: "direct-task-1", entryId: "entry-4", name: "symlink", tabId: "tab-4", paneId: "pane-4", sessionFile: symlinkChild },
			{ taskId: "direct-task-1", entryId: "entry-5", name: "invalid", tabId: "tab-5", paneId: "pane-5", sessionFile: invalidChild },
		],
	};
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: root,
		extra: [
			toolResult("delegate_task", "Direct delegation started", launch, undefined, "henry-call"),
			customMessage("subagent-direct-result", completion),
			customMessage("subagent-direct-result", completion),
			customMessage("subagent-direct-result", {
				taskId: "direct-task-1",
				outcome: "completed",
				tabs: [{ taskId: "direct-task-1", entryId: "forged", name: "fake", tabId: "fake", paneId: "fake", sessionFile: unrelatedChild }],
			}),
			customMessage("subagent-direct-result", {
				taskId: "direct-task-1",
				outcome: "completed",
				tabs: [{ taskId: "direct-task-1", entryId: "entry-1", name: "scout", tabId: "wrong-tab", paneId: "fake", sessionFile: unrelatedChild }],
			}),
			customMessage("subagent-direct-result", {
				taskId: "unattributed-task",
				outcome: "completed",
				tabs: [{ taskId: "unattributed-task", entryId: "fake", name: "fake", tabId: "fake", paneId: "fake", sessionFile: unrelatedChild }],
			}),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.20, 2);
});

test("pi-herdr-agents excludes forked parent history from referenced child Sessions", async (t) => {
	const root = temporaryDirectory(t);
	const rootFile = path.join(root, "root.jsonl");
	const childFile = path.join(root, "herdr-external", "child.jsonl");
	const unrelatedChild = path.join(root, "herdr-external", "unrelated.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: root,
		assistantId: "root-assistant",
		extra: [
			toolResult("subagent", "Sub-agent launched", {
				id: "herdr-1",
				name: "reviewer",
				task: "Review",
				launchScriptFile: path.join(root, "herdr-launch.sh"),
				sessionFile: childFile,
				status: "started",
			}, undefined, "herdr-call"),
			toolResult("subagent", "Repeated launch receipt", {
				id: "herdr-1",
				name: "reviewer",
				task: "Review",
				launchScriptFile: path.join(root, "herdr-launch.sh"),
				sessionFile: childFile,
				status: "started",
			}, undefined, "herdr-call"),
			toolResult("subagent", "Foreign parent launch", {
				id: "herdr-foreign",
				name: "foreign",
				task: "Ignore",
				launchScriptFile: path.join(root, "foreign-launch.sh"),
				sessionFile: unrelatedChild,
				status: "started",
			}, undefined, "herdr-foreign-call"),
			customMessage("subagent_result", { name: "fake", sessionFile: unrelatedChild, exitCode: 0, elapsed: 1 }),
		],
	});
	writeJsonLines(childFile, [
		{ type: "session", version: 3, id: "herdr-child", timestamp: "2026-01-01T00:00:00.000Z", cwd: root, parentSession: rootFile },
		assistantEntry("root-assistant", 1),
		assistantEntry("herdr-assistant", 0.4),
	]);
	writeSession(unrelatedChild, {
		id: "unrelated",
		cost: 50,
		cwd: root,
		parentSession: path.join(root, "another-parent.jsonl"),
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.40, 1);
});

test("referenced Herdr Sessions already found by standard discovery are not double-counted", async (t) => {
	const root = temporaryDirectory(t);
	const rootFile = path.join(root, "root.jsonl");
	const childFile = path.join(root, "herdr-child.jsonl");
	const clonedCompletion = {
		id: "cloned-completion",
		...(customMessage("pi-subagent-complete", { task_id: "bg-cloned", usage: { cost: 0.2 }, background: true }) as Record<string, unknown>),
	};
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: root,
		assistantId: "root-assistant",
		extra: [toolResult("subagent", "Sub-agent launched", {
			id: "herdr-2",
			name: "scout",
			task: "Research",
			launchScriptFile: path.join(root, "herdr-launch-2.sh"),
			sessionFile: childFile,
			status: "started",
		}, undefined, "herdr-call-2"), clonedCompletion],
	});
	writeJsonLines(childFile, [
		{ type: "session", version: 3, id: "herdr-child", timestamp: "2026-01-01T00:00:00.000Z", cwd: root, parentSession: rootFile },
		assistantEntry("root-assistant", 1),
		assistantEntry("herdr-assistant", 0.4),
		clonedCompletion,
	]);

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.60, 2);
});

test("Ferris results use run identity, greatest cost, and parent-session scope", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "parallel launch", ferrisDetails([
				ferrisResult(1, 0, { exitCode: -1 }),
				ferrisResult(2, 0, { exitCode: -1 }),
			]), undefined, "ferris-call-1"),
			toolResult("subagent_status", "settled", ferrisStatusDetails([
				ferrisStatusRun(1, 0.2),
				ferrisStatusRun(2, 0.3),
			]), undefined, "ferris-status-1"),
			toolResult("subagent_status", "repeated", ferrisStatusDetails([
				ferrisStatusRun(1, 0.25),
			]), undefined, "ferris-status-2"),
			toolResult("subagent", "parent reported launch", ferrisDetails([
				ferrisResult(3, 0, { exitCode: -1 }),
			]), 0.5, "ferris-call-3"),
			toolResult("subagent_status", "already parent reported", ferrisStatusDetails([
				ferrisStatusRun(3, 0.5),
			]), undefined, "ferris-status-3"),
			toolResult("subagent", "pending only", ferrisDetails([
				ferrisResult(4, 0, { exitCode: -1 }),
			]), undefined, "ferris-call-4"),
			toolResult("subagent", "other package", {
				mode: "single",
				background: true,
				results: [{
					agent: "other",
					task: "Work",
					exitCode: -1,
					messages: [],
					stderr: "",
					runId: 99,
					usage: { cost: 0 },
				}],
			}, undefined, "other-call"),
			toolResult("subagent_status", "other package status", ferrisStatusDetails([
				ferrisStatusRun(99, 50),
			]), undefined, "other-status"),
		],
	});
	writeSession(nestedFile, {
		id: "nested-id",
		cost: 0,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "same run id launch in child session", ferrisDetails([
				ferrisResult(1, 0, { exitCode: -1 }),
			]), undefined, "ferris-call-1"),
			toolResult("subagent_status", "child settled", ferrisStatusDetails([
				ferrisStatusRun(1, 0.4),
			]), undefined, "ferris-status-1"),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.95, 4);
});

test("Ferris falls back only to an explicitly referenced standard session", async (t) => {
	const root = temporaryDirectory(t);
	const rootFile = path.join(root, "root.jsonl");
	const sessionDir = path.join(root, "external", "referenced");
	const sessionId = "ferris-session-id";
	const referencedFile = path.join(sessionDir, `2026-01-01_${sessionId}.jsonl`);
	const unrelatedFile = path.join(root, "external", "unrelated", "2026-01-01_other.jsonl");
	const mismatchedDir = path.join(root, "external", "mismatched");
	const mismatchedId = "expected-session-id";
	const mismatchedFile = path.join(mismatchedDir, `2026-01-01_${mismatchedId}.jsonl`);
	writeSession(referencedFile, { id: sessionId, cost: 0.6, cwd: root });
	writeSession(unrelatedFile, { id: "other", cost: 9, cwd: root });
	writeSession(mismatchedFile, { id: "different-session-id", cost: 50, cwd: root });
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: root,
		extra: [
			toolResult("subagent", "missing inline usage", ferrisDetails([
				ferrisResult(10, undefined, { sessionDir, sessionId }),
			]), undefined, "ferris-call-1"),
			toolResult("subagent", "repeated result", ferrisDetails([
				ferrisResult(10, undefined, { sessionDir, sessionId }),
			]), undefined, "ferris-call-2"),
			toolResult("subagent", "mismatched session header", ferrisDetails([
				ferrisResult(11, undefined, { sessionDir: mismatchedDir, sessionId: mismatchedId }),
			]), undefined, "ferris-call-3"),
			toolResult("subagent", "missing reference", ferrisDetails([
				ferrisResult(12),
			]), undefined, "ferris-call-4"),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.60, 1);
});

test("Archimedes collects single and parallel results with stable identities", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "single", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000a", 0.2),
			]), undefined, "arch-call-1"),
			toolResult("subagent", "repeated", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000a", 0.25),
			]), undefined, "arch-call-2"),
			toolResult("subagent", "parallel", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000b", 0.3),
				archimedesResult(undefined, 0.4),
			]), undefined, "arch-call-3"),
			toolResult("subagent", "free child", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000f", 0),
			]), undefined, "arch-call-4"),
			toolResult("subagent", "missing usage", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000d"),
			]), undefined, "arch-call-5"),
			toolResult("subagent", "parent reported", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000c", 0.5),
			]), 0.5, "arch-call-6"),
			toolResult("subagent", "other package", archimedesLikeOtherPackage(), undefined, "other-call"),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.95, 4);
});

test("Archimedes fallback identities are parent-session scoped", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "no child session id", archimedesDetails([
				archimedesResult("00000000-0000-4000-8000-00000000000e", 0.2),
			]), undefined, "same-call"),
			toolResult("subagent", "shared child", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000e", 0.4),
			]), undefined, "root-child"),
		],
	});
	writeSession(nestedFile, {
		id: "nested-id",
		cost: 0,
		cwd: sessionDir,
		extra: [
			toolResult("subagent", "same fallback identity fields", archimedesDetails([
				archimedesResult("00000000-0000-4000-8000-00000000000e", 0.3),
			]), undefined, "same-call"),
			toolResult("subagent", "same actual child", archimedesDetails([
				archimedesResult("00000000-0000-7000-8000-00000000000e", 0.5),
			]), undefined, "nested-child"),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 2.00, 4);
});

test("pi-subagents-lite foreground costs are keyed by parent tool call", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("Agent", "done", liteForegroundDetails(0.2), undefined, "lite-call-1"),
			toolResult("Agent", "repeated", liteForegroundDetails(0.25), undefined, "lite-call-1"),
			toolResult("Agent", "another", liteForegroundDetails(0.3, null), undefined, "lite-call-2"),
			toolResult("Agent", "free", liteForegroundDetails(0), undefined, "lite-call-3"),
			toolResult("Agent", "missing cost", liteForegroundDetails(), undefined, "lite-call-4"),
			toolResult("Agent", "parent reported", liteForegroundDetails(0.5), 0.5, "lite-call-5"),
			toolResult("AgentStatus", "ignore", liteForegroundDetails(50), undefined, "lite-status"),
			customMessage("subagent-result", liteCompletionDetails(50), liteCompletionContent("deadbeef")),
		],
	});
	writeSession(nestedFile, {
		id: "nested-id",
		cost: 0,
		cwd: sessionDir,
		extra: [toolResult("Agent", "same call id in child session", liteForegroundDetails(0.4), undefined, "lite-call-1")],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.95, 5);
});

test("pi-subagents-lite background completions require an attributed launch", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	const agentId = "12345678-1234-4ab";
	const launchOnlyId = "87654321-4321-4cd";
	const reportedId = "aaaaaaaa-aaaa-4aa";
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			toolResult("Agent", "launched", liteBackgroundLaunchDetails(agentId), undefined, "lite-bg-1"),
			customMessage("subagent-result", liteCompletionDetails(0.6), liteCompletionContent("12345678")),
			customMessage("subagent-result", liteCompletionDetails(0.7), liteCompletionContent("12345678")),
			toolResult("Agent", "launch only", liteBackgroundLaunchDetails(launchOnlyId), undefined, "lite-bg-2"),
			toolResult("Agent", "reported launch", liteBackgroundLaunchDetails(reportedId), 0.5, "lite-bg-3"),
			customMessage("subagent-result", liteCompletionDetails(0.5), liteCompletionContent("aaaaaaaa")),
			toolResult("Agent", "ambiguous launch one", liteBackgroundLaunchDetails("deadbeef-1111-4aa"), undefined, "lite-bg-4"),
			toolResult("Agent", "ambiguous launch two", liteBackgroundLaunchDetails("deadbeef-2222-4bb"), undefined, "lite-bg-5"),
			customMessage("subagent-result", liteCompletionDetails(50), liteCompletionContent("deadbeef")),
			customMessage("other-extension", liteCompletionDetails(50), liteCompletionContent("12345678")),
		],
	});
	writeSession(nestedFile, {
		id: "nested-id",
		cost: 0,
		cwd: sessionDir,
		extra: [
			toolResult("Agent", "same agent id in child session", liteBackgroundLaunchDetails(agentId), undefined, "lite-bg-1"),
			customMessage("subagent-result", liteCompletionDetails(0.2), liteCompletionContent("12345678")),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.90, 3);
});

test("minimal-subagents counts authoritative settled turns once", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const firstTurn = minimalTurnResult("root.reviewer", "root.reviewer:turn-1", 0.2);
	const secondTurn = minimalTurnResult("root.reviewer", "root.reviewer:turn-2", 0.4);
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			minimalRegistryEntry("root-id", "agent-created", {
				agent: minimalRegistryAgent("root.reviewer", { task: "" }),
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.reviewer",
				turn_id: firstTurn.turn_id,
				started_at: "2026-01-01T00:00:01.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: firstTurn,
				timestamp: "not-a-timestamp",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: firstTurn,
				settled_at: "not-a-timestamp",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.reviewer", "root.reviewer:bad\0turn", 50),
			}),
			minimalRegistryEntry("root-id", "turn-settled", { result: firstTurn }),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.reviewer",
				turn_id: firstTurn.turn_id,
				started_at: "2026-01-01T00:00:02.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.reviewer", "root.reviewer:turn-1", 0.3),
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.reviewer",
				turn_id: secondTurn.turn_id,
				started_at: "2026-01-01T00:00:03.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", { result: secondTurn }),
			minimalRegistryEntry("root-id", "agent-created", {
				agent: minimalRegistryAgent("root.legacy"),
			}, 1),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.legacy",
				turn_id: "root.legacy:turn-1",
				started_at: "2026-01-01T00:00:03.500Z",
			}, 1),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.legacy", "root.legacy:turn-1", 50),
			}, 1),
			minimalRegistryEntry("root-id", "checkpoint", {
				snapshot: {
					agents: [minimalRegistryAgent("root.legacy-checkpoint", {
						active_turn_id: "root.legacy-checkpoint:turn-1",
						active_turn_started_at: "2026-01-01T00:00:03.750Z",
					})],
					tombstones: [],
					deliveries: [],
					coordination_deliveries: [],
					wait_claimed_turns: [],
					next_delivery_sequence: 1,
				},
			}, 1),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.legacy-checkpoint", "root.legacy-checkpoint:turn-1", 50),
			}),
			minimalRegistryEntry("root-id", "delivery-pending", {
				delivery: {
					source_agent_id: "root.reviewer",
					source_turn_id: secondTurn.turn_id,
					result: minimalTurnResult("root.reviewer", secondTurn.turn_id as string, 50),
				},
			}),
			minimalRegistryEntry("root-id", "checkpoint", {
				snapshot: {
					agents: [minimalRegistryAgent("root.reviewer", {
						latest_result: minimalTurnResult("root.reviewer", "root.reviewer:turn-3", 50),
					})],
					tombstones: [],
					deliveries: [],
					coordination_deliveries: [],
					wait_claimed_turns: [],
					next_delivery_sequence: 1,
				},
			}),
			minimalRegistryEntry("root-id", "checkpoint", {
				snapshot: {
					agents: [minimalRegistryAgent("root.fork", {
						active_turn_id: "root.fork:turn-1",
						active_turn_started_at: "2026-01-01T00:00:04.000Z",
					})],
					tombstones: [],
					deliveries: [null],
					coordination_deliveries: [],
					wait_claimed_turns: [],
					next_delivery_sequence: 1,
				},
			}),
			minimalRegistryEntry("root-id", "checkpoint", {
				snapshot: {
					agents: [
						minimalRegistryAgent("root.reviewer", {
							active_turn_id: "root.reviewer:checkpoint-turn",
							active_turn_started_at: "2026-01-01T00:00:04.500Z",
							latest_result: minimalTurnResult("root.reviewer", "root.reviewer:prior-turn", 0.1),
						}),
						minimalRegistryAgent("root.reviewer.worker", { parent_id: "root.reviewer" }),
					],
					tombstones: [],
					deliveries: [{
						source_agent_id: "root.reviewer",
						source_turn_id: "root.reviewer:prior-turn",
						destination_agent_id: "root",
						path: "wait",
						settled: false,
						sequence: 1,
						result: minimalTurnResult("root.reviewer", "root.reviewer:prior-turn", 0.1),
					}],
					coordination_deliveries: [{
						delivery_id: "message:coord-1",
						destination_agent_id: "root.reviewer",
						path: "message",
						settled: false,
						sequence: 2,
						message: {
							customType: "minimal-subagents.message",
							content: "coordinate",
							details: {
								source_agent_id: "root",
								source_turn_id: "root:coordination-1",
								message_id: "coord-1",
								delivery_id: "message:coord-1",
								destination_agent_id: "root.reviewer",
							},
						},
					}],
					wait_claimed_turns: ["root.reviewer\0root.reviewer:prior-turn"],
					next_delivery_sequence: 3,
				},
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.reviewer", "root.reviewer:checkpoint-turn", 0.5),
			}),
			minimalRegistryEntry("root-id", "agent-deleted", {
				agent_ids: ["root.reviewer.worker", "root.reviewer"],
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.reviewer",
				turn_id: "root.reviewer:after-delete",
				started_at: "2026-01-01T00:00:04.750Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.reviewer", "root.reviewer:after-delete", 50),
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.fork", "root.fork:turn-1", 50),
			}),
			minimalRegistryEntry("root-id", "agent-created", {
				agent: minimalRegistryAgent("root.bogus", {
					launch_contract: {
						session_context: "omit",
						project_context: "inherit",
						model: "provider/model",
						thinking_level: "bogus",
						ordinary_tools: [],
					},
				}),
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.bogus",
				turn_id: "root.bogus:turn-1",
				started_at: "2026-01-01T00:00:05.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.bogus", "root.bogus:turn-1", 50),
			}),
			minimalRegistryEntry("root-id", "agent-created", {
				agent: minimalRegistryAgent("root"),
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root",
				turn_id: "root:turn-1",
				started_at: "2026-01-01T00:00:06.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root", "root:turn-1", 50),
			}),
			minimalRegistryEntry("other-root", "turn-settled", {
				result: minimalTurnResult("root.reviewer", "root.reviewer:turn-4", 50),
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("other", "unowned-turn", 50),
			}),
			customMessage("minimal-subagents.result", {
				source_agent_id: "root.reviewer",
				source_turn_id: "root.reviewer:turn-2",
				usage: minimalUsage(50),
			}),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 2.20, 3);
});

test("minimal-subagents ignores missing registry usage and child session totals", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const childFile = path.join(sessionDir, "minimal-child.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: sessionDir,
		extra: [
			minimalRegistryEntry("root-id", "agent-created", {
				agent: minimalRegistryAgent("root.worker", {
					session_file: childFile,
					session_id: "child-id",
					session_leaf_id: "child-leaf-id",
				}),
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.worker",
				turn_id: "root.worker:missing",
				started_at: "2026-01-01T00:00:01.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.worker", "root.worker:missing"),
			}),
			minimalRegistryEntry("root-id", "turn-started", {
				agent_id: "root.worker",
				turn_id: "root.worker:free",
				started_at: "2026-01-01T00:00:02.000Z",
			}),
			minimalRegistryEntry("root-id", "turn-settled", {
				result: minimalTurnResult("root.worker", "root.worker:free", 0),
			}),
		],
	});
	writeSession(childFile, {
		id: "child-id",
		cost: 50,
		cwd: sessionDir,
		extra: [customEntry("minimal-subagents.identity", {
			version: 1,
			original_root_session_id: "root-id",
			canonical_agent_id: "root.worker",
			direct_parent_id: "root",
			created_at: "2026-01-01T00:00:00.000Z",
		})],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.00, 1);
});

test("pi-better-subagents counts only attributed child Sessions and follows nested launches", (t) => {
	const cwd = temporaryDirectory(t);
	const registryRoot = path.join(cwd, "pi-better-subagents");
	const rootFile = path.join(cwd, "root.jsonl");
	const directId = "sa_direct_1";
	const nestedId = "sa_nested_2";
	const foreignId = "sa_foreign_3";
	const logOnlyId = "sa_logonly_4";
	const zeroId = "sa_zero_5";
	const diagnosticId = "sa_diagnostic_6";
	const wrongCwdId = "sa_wrongcwd_7";
	writeSession(rootFile, { id: "root-id", cost: 1, cwd });
	writeBetterRun(registryRoot, {
		id: nestedId,
		parentId: directId,
		parentCwd: cwd,
		cost: 0.3,
	});
	writeBetterRun(registryRoot, {
		id: directId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 0.4,
		extra: [toolResult("subagent_spawn", `Subagent launched: nested id=${nestedId} (pid 12).`)],
	});
	writeBetterRun(registryRoot, {
		id: foreignId,
		parentId: "other-root",
		parentCwd: cwd,
		cost: 50,
	});
	writeBetterRun(registryRoot, {
		id: logOnlyId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 50,
		writeSessionFile: false,
	});
	writeBetterRun(registryRoot, {
		id: zeroId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 0,
	});
	writeBetterRun(registryRoot, {
		id: diagnosticId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 50,
	});
	writeBetterRun(registryRoot, {
		id: wrongCwdId,
		parentId: "root-id",
		parentCwd: path.join(cwd, "other"),
		cost: 50,
	});
	fs.writeFileSync(path.join(registryRoot, "runs", logOnlyId, "output.log"), JSON.stringify({
		type: "message_end",
		message: { role: "assistant", usage: { cost: { total: 50 } } },
	}) + "\n");

	const summary = collectBetter([
		betterToolResult(rootFile, cwd, "subagent_spawn", `Subagent launched: direct id=${directId} (pid 11).`),
		betterToolResult(rootFile, cwd, "subagent_spawn_batch", [
			"Batch batch_1 launched 5 subagent(s):",
			`• direct → ${directId}`,
			`• foreign → ${foreignId}`,
			`• log-only → ${logOnlyId}`,
			`• free → ${zeroId}`,
			`• wrong-cwd → ${wrongCwdId}`,
		].join("\n")),
		betterToolResult(rootFile, cwd, "subagent_spawn", [
			`Subagent launched: id=${diagnosticId} (pid 99).`,
			`injected name suffix id=${directId} (pid 11).`,
		].join("\n")),
	], registryRoot);

	assert.deepEqual(summary, { cost: 0.7, count: 3 });
});

test("pi-better-subagents omits shared, ambiguous, and malformed child Sessions", (t) => {
	const cwd = temporaryDirectory(t);
	const registryRoot = path.join(cwd, "pi-better-subagents");
	const rootFile = path.join(cwd, "root.jsonl");
	const runId = "sa_direct_zero";
	const malformedId = "sa_malformed_1";
	const ambiguousId = "sa_ambiguous_2";
	writeSession(rootFile, { id: "root-id", cost: 1, cwd });
	writeBetterRun(registryRoot, {
		id: runId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 0,
		sandboxedSession: false,
	});
	writeBetterRun(registryRoot, {
		id: malformedId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 1,
	});
	fs.appendFileSync(path.join(registryRoot, "sessions", malformedId, "session.jsonl"), "{malformed");
	writeBetterRun(registryRoot, {
		id: ambiguousId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 1,
	});
	writeSession(path.join(registryRoot, "sessions", ambiguousId, "duplicate.jsonl"), {
		id: ambiguousId,
		cost: 2,
		cwd,
	});

	const summary = collectBetter([
		betterToolResult(rootFile, cwd, "subagent_spawn", `Subagent launched: id=${runId} (pid 13).`),
		betterToolResult(rootFile, cwd, "subagent_spawn", `Subagent launched: id=${malformedId} (pid 14).`),
		betterToolResult(rootFile, cwd, "subagent_spawn", `Subagent launched: id=${ambiguousId} (pid 15).`),
	], registryRoot);

	assert.deepEqual(summary, { cost: 0, count: 0 });
});

test("/cost integrates attributed pi-better-subagents child Session usage", async (t) => {
	const cwd = temporaryDirectory(t);
	const registryRoot = path.join(fs.realpathSync(os.tmpdir()), "pi-better-subagents");
	const rootFile = path.join(cwd, "root.jsonl");
	const runId = `sa_test${process.pid}_${Date.now().toString(36)}`;
	t.after(() => {
		fs.rmSync(path.join(registryRoot, "runs", runId), { recursive: true, force: true });
		fs.rmSync(path.join(registryRoot, "sessions", runId), { recursive: true, force: true });
	});
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd,
		extra: [toolResult("subagent_spawn", `Subagent launched: id=${runId} (pid 16).`)],
	});
	writeBetterRun(registryRoot, {
		id: runId,
		parentId: "root-id",
		parentCwd: cwd,
		cost: 0.25,
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.25, 1);
});

test("session discovery follows nested and flat parent links to a fixed point", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const nestedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	const flatGrandchild = path.join(path.dirname(nestedFile), "consult.jsonl");
	writeSession(rootFile, { id: "root-id", cost: 1, cwd: sessionDir });
	writeSession(nestedFile, { id: "nested-id", cost: 0.5, cwd: sessionDir });
	writeSession(flatGrandchild, {
		id: "flat-id",
		parentSession: nestedFile,
		cost: 0.25,
		cwd: sessionDir,
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.75, 2);
});

test("nested session.jsonl files must have a Pi session header", async (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	const unrelatedFile = path.join(sessionDir, "root", "worker", "session.jsonl");
	writeSession(rootFile, { id: "root-id", cost: 1, cwd: sessionDir });
	fs.mkdirSync(path.dirname(unrelatedFile), { recursive: true });
	fs.writeFileSync(unrelatedFile, `${JSON.stringify({
		type: "message",
		message: { role: "assistant", usage: { cost: { total: 99 } } },
	})}\n`);

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.00, 0);
});

test("inclusive status sorts first and renders dim with a trailing separator", (t) => {
	const sessionDir = temporaryDirectory(t);
	const rootFile = path.join(sessionDir, "root.jsonl");
	writeSession(rootFile, { id: "root-id", cost: 1.25, cwd: sessionDir });
	writeSession(path.join(sessionDir, "root", "tasks", "child.jsonl"), {
		id: "child-id",
		parentSession: "root-id",
		cost: 0.75,
		cwd: sessionDir,
	});

	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	inclusiveCost({
		on: (event: string, handler: typeof sessionStart) => {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand: () => {},
	} as never);
	assert.ok(sessionStart);

	let status: { key: string; text: string | undefined } | undefined;
	sessionStart({}, {
		sessionManager: { getSessionFile: () => rootFile },
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setStatus: (key: string, text: string | undefined) => { status = { key, text }; },
		},
	});
	assert.deepEqual(status, {
		key: "00-inclusiveCost",
		text: "<dim>$2.00 (incl) •</dim>",
	});
});

test("Fabric run results are attributed by run ID and repeated cumulative results use the greatest cost", async (t) => {
	const cwd = temporaryDirectory(t);
	const rootFile = path.join(cwd, "root.jsonl");
	const firstRun = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const secondRun = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const thirdRun = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd,
		extra: [
			toolResult("fabric_exec", `- id: ${firstRun}\n  name: reviewer\n  task: review\n  status: running\n  runner: pi\n  cwd: /project\n  usage:\n    cost: 0.20`),
			toolResult("fabric_exec", `review:\n  id: ${firstRun}\n  name: reviewer\n  task: review\n  status: completed\n  runner: pi\n  cwd: /project\n  usage:\n    cost: 0.35`),
			toolResult("fabric_exec", JSON.stringify({ other: {
				id: secondRun,
				name: "reviewer",
				task: "review",
				status: "completed",
				runner: "pi",
				cwd: "/project",
				usage: { cost: 0.4 },
			} })),
			toolResult("fabric_exec", JSON.stringify({ uuidRun: {
				id: "12345678-1234-1234-1234-123456789abc",
				runId: thirdRun,
				usage: { cost: 0.25 },
			}, ignoredBusinessObject: { id: "ffffffffffffffffffffffffffffffff", usage: { cost: 50 } } })),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 2.00, 3);
});

test("Fabric agent audit details contribute costs when the rendered output omits run IDs", async (t) => {
	const cwd = temporaryDirectory(t);
	const rootFile = path.join(cwd, "root.jsonl");
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd,
		extra: [toolResult("fabric_exec", [
			"- axis: standards-reviewer",
			"  status: completed",
			"  model: openai-codex/gpt-6-sol",
		].join("\n"), {
			success: true,
			kernel: "typescript",
			audits: [
				fabricAgentAudit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0.0985588),
				fabricAgentAudit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 0.0632424),
				fabricAgentAudit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0.01),
				fabricNestedBusinessAudit("cccccccccccccccccccccccccccccccc", 50),
				{ ...fabricAgentAudit("dddddddddddddddddddddddddddddddd", 50), success: false },
				{ ...fabricAgentAudit("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", 50), provider: "business" },
			],
		}),
		],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.16, 2);
});

test("Fabric session export is only a fallback for a run ID returned to this chat", async (t) => {
	const root = temporaryDirectory(t);
	const sessionsRoot = path.join(root, "agent", "sessions");
	const sessionDir = path.join(sessionsRoot, "--project--");
	const rootFile = path.join(sessionDir, "root.jsonl");
	const attributedRun = "cccccccccccccccccccccccccccccccc";
	const unrelatedRun = "dddddddddddddddddddddddddddddddd";
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: "/project",
		extra: [toolResult("fabric_exec", `run:\n  id: ${attributedRun}\n  name: reviewer\n  task: review\n  status: completed\n  runner: pi\n  cwd: /project`)],
	});
	writeSession(path.join(sessionsRoot, ".fabric", "--project--", `stamp_${attributedRun}.jsonl`), {
		id: "fabric-attributed",
		cost: 0.6,
		cwd: "/project",
	});
	writeSession(path.join(sessionsRoot, ".fabric", "--project--", `stamp_${unrelatedRun}.jsonl`), {
		id: "fabric-unrelated",
		cost: 9,
		cwd: "/project",
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.60, 1);
});

test("dynamic workflow run heads provide cumulative cost with strict parent attribution", (t) => {
	const cwd = temporaryDirectory(t);
	const workflowHome = path.join(temporaryDirectory(t), "workflows");
	const rootFile = path.join(cwd, "root.jsonl");
	writeSession(rootFile, { id: "root-id", cost: 1, cwd });
	const otherRootFile = path.join(cwd, "other-root.jsonl");
	writeSession(otherRootFile, { id: "other-root", cost: 1, cwd });
	writeDynamicWorkflowHead(workflowHome, cwd, "audit-run-1", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 0.6, estimated: false },
	});
	writeDynamicWorkflowHead(workflowHome, cwd, "zero-run-2", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 0, estimated: false },
	});
	writeDynamicWorkflowHead(workflowHome, cwd, "unknown-run-3", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 0, estimated: true },
	});
	writeDynamicWorkflowHead(workflowHome, cwd, "partial-run-4", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 0.1, estimated: true },
	});
	writeDynamicWorkflowHead(workflowHome, cwd, "foreign-run-4", {
		parentSessionId: "other-session",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 50, estimated: false },
	});
	const symlinkHead = writeDynamicWorkflowHead(workflowHome, cwd, "symlink-run-6", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 50, estimated: false },
	});
	const symlinkTarget = `${symlinkHead}.target`;
	fs.renameSync(symlinkHead, symlinkTarget);
	fs.symlinkSync(symlinkTarget, symlinkHead);
	const brokenHead = writeDynamicWorkflowHead(workflowHome, cwd, "broken-run-9", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 50, estimated: false },
	});
	fs.rmSync(brokenHead);
	fs.symlinkSync(`${brokenHead}.missing`, brokenHead);
	const malformedHead = writeDynamicWorkflowHead(workflowHome, cwd, "malformed-run-7", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 50, estimated: false },
	});
	fs.writeFileSync(malformedHead, "{malformed");
	const invalidStructureHead = writeDynamicWorkflowHead(workflowHome, cwd, "invalid-structure-10", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 50, estimated: false },
	});
	const invalidStructure = JSON.parse(fs.readFileSync(invalidStructureHead, "utf8"));
	invalidStructure.bytes = 0;
	fs.writeFileSync(invalidStructureHead, JSON.stringify(invalidStructure));
	const oversizedHead = writeDynamicWorkflowHead(workflowHome, cwd, "oversized-run-11", {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 50, estimated: false },
	});
	fs.appendFileSync(oversizedHead, " ".repeat(1024 * 1024));
	const result = (runId: string, details: Record<string, unknown> = {}) => ({
		sessionFile: rootFile,
		sessionId: "root-id",
		cwd,
		toolName: "workflow",
		toolCallId: `call-${runId}`,
		content: [{ type: "text", text: `Run ID: ${runId}` }],
		details: { runId, background: true, ...details },
	});

	const summary = collectDynamicWorkflows([
		result("audit-run-1", { tokenUsage: { cost: 99 } }),
		result("audit-run-1"),
		result("zero-run-2"),
		result("unknown-run-3"),
		result("partial-run-4"),
		result("foreign-run-4", { background: false, tokenUsage: { cost: 50, estimated: false } }),
		result("inline-run-5", { background: false, tokenUsage: { cost: 0.2, estimated: false } }),
		result("symlink-run-6"),
		result("broken-run-9", { background: false, tokenUsage: { cost: 50, estimated: false } }),
		result("malformed-run-7", { background: false, tokenUsage: { cost: 50, estimated: false } }),
		result("invalid-structure-10", { background: false, tokenUsage: { cost: 50, estimated: false } }),
		result("oversized-run-11"),
		result("../escape", { background: false, tokenUsage: { cost: 50, estimated: false } }),
		result("conflict-run-8", { background: false, tokenUsage: { cost: 50, estimated: false } }),
		{
			...result("conflict-run-8", { background: false, tokenUsage: { cost: 50, estimated: false } }),
			sessionFile: otherRootFile,
			sessionId: "other-root",
		},
	], workflowHome);

	assert.ok(Math.abs(summary.cost - 0.9) < 1e-12);
	assert.equal(summary.count, 4);
});

test("/cost includes attributed dynamic workflow cumulative run cost", async (t) => {
	const cwd = temporaryDirectory(t);
	const rootFile = path.join(cwd, "root.jsonl");
	const runId = "review-run-legacy";
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd,
		extra: [toolResult("workflow", "Workflow started", { runId, background: true })],
	});
	writeDynamicWorkflowHead(path.join(cwd, ".pi", "workflows"), cwd, runId, {
		parentSessionId: "root-id",
		parentSessionFile: rootFile,
		tokenUsage: { input: 10, output: 5, total: 15, cost: 0.4, estimated: false },
	}, true);

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.40, 1);
});

test("Taskflow trace counts attempts and recomputes once while repeated run results are deduplicated", async (t) => {
	const cwd = temporaryDirectory(t);
	const rootFile = path.join(cwd, "root.jsonl");
	const rootRun = "flow-mtroot-111111";
	const resumeRun = "flow-mtchild-222222";
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: path.join(cwd, "session-cwd-does-not-own-run"),
		extra: [
			toolResult("taskflow", `Taskflow completed. Run id: ${rootRun}`, { state: { runId: rootRun, cwd } }),
			toolResult("taskflow", `Trace queried. Run id: ${rootRun}`, { state: { runId: rootRun, cwd } }),
			toolResult("taskflow", `Resumed taskflow as run ${resumeRun}. Run id: ${resumeRun}`, { state: { runId: resumeRun, cwd } }),
		],
	});
	writeTaskflowRun(cwd, rootRun, "flow", {
		createdAt: 100,
		phases: { phase: { status: "done", usage: { cost: 99 } } },
		trace: [
			traceCall(rootRun, "phase", 0, 0.2),
			traceCall(rootRun, "phase", 1, 0.3),
			{ ts: 3, runId: rootRun, phaseId: "phase", kind: "decision", decision: { type: "cache-hit" } },
			traceCall(rootRun, "phase", 0, 0.1),
		],
	});
	writeTaskflowRun(cwd, resumeRun, "flow", {
		parentRunId: rootRun,
		createdAt: 1_000,
		phases: { copied: { status: "done", endedAt: 500, usage: { cost: 99 } } },
		trace: [traceCall(resumeRun, "new", 0, 0.4)],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 2.00, 2);
});

test("Taskflow snapshot fallback excludes inherited and cached phases", async (t) => {
	const cwd = temporaryDirectory(t);
	const rootFile = path.join(cwd, "root.jsonl");
	const runId = "flow-mtfallback-333333";
	writeSession(rootFile, {
		id: "root-id",
		cost: 1,
		cwd: path.join(cwd, "session-cwd-does-not-own-run"),
		extra: [toolResult("taskflow", `Resumed. Run id: ${runId}`, { state: { runId, cwd } })],
	});
	writeTaskflowRun(cwd, runId, "flow", {
		parentRunId: "older-run",
		createdAt: 1_000,
		phases: {
			inherited: { status: "done", startedAt: 100, endedAt: 500, usage: { cost: 8 } },
			cached: { status: "done", startedAt: 1_100, endedAt: 1_200, cacheHit: "cross-run", usage: { cost: 7 } },
			fresh: { status: "done", startedAt: 1_100, endedAt: 1_200, model: "model", usage: { cost: 0.25 } },
		},
		trace: [{ ts: 1, runId, phaseId: "fresh", kind: "subagent-call", output: { usage: {} } }],
	});

	const notification = await invokeCost(rootFile);
	assertCostSummary(notification, 1.25, 1);
});

function temporaryDirectory(t: { after: (callback: () => void) => void }): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inclusive-cost-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

async function invokeCost(rootFile: string): Promise<string> {
	let costCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	inclusiveCost({
		on: () => {},
		registerCommand: (name: string, command: { handler: typeof costCommand }) => {
			if (name === "cost") costCommand = command.handler;
		},
	} as never);
	assert.ok(costCommand);
	let notification = "";
	await costCommand("", {
		sessionManager: { getSessionFile: () => rootFile },
		ui: {
			notify: (message: string) => { notification = message; },
			setStatus: () => {},
		},
	});
	return notification;
}

function assertCostSummary(notification: string, inclusive: number, foldedCount: number): void {
	const lines = notification.split("\n");
	assert.equal(lines.length, 3);
	const inclusiveMatch = /\$(\d+\.\d{2})$/.exec(lines[1] ?? "");
	const foldedMatch = /(\d+)$/.exec(lines[2] ?? "");
	assert.ok(inclusiveMatch);
	assert.ok(foldedMatch);
	assert.equal(Number(inclusiveMatch[1]), inclusive);
	assert.equal(Number(foldedMatch[1]), foldedCount);
}

function writeSession(file: string, options: {
	id: string;
	cwd: string;
	cost: number;
	parentSession?: string;
	assistantId?: string;
	extra?: unknown[];
}): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: options.cwd,
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	const assistant = {
		...(options.assistantId ? { id: options.assistantId } : {}),
		type: "message",
		message: { role: "assistant", usage: { cost: { total: options.cost } } },
	};
	const entries = [header, assistant, ...(options.extra ?? [])];
	fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function writeJsonLines(file: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function assistantEntry(id: string, cost: number): unknown {
	return { id, type: "message", message: { role: "assistant", usage: { cost: { total: cost } } } };
}

function j0k3rTask(
	id: string,
	attempt: number,
	cost?: number,
	nestedSessionPath?: string,
): Record<string, unknown> {
	return {
		id,
		agent: "reviewer",
		mode: "task",
		status: "completed",
		task: "Review",
		created_at: "2026-01-01T00:00:00.000Z",
		attempt,
		...(cost === undefined ? {} : { usage: { cost } }),
		...(nestedSessionPath === undefined ? {} : { nested_session_path: nestedSessionPath }),
	};
}

function bacnh85Result(agent: string, cost: number): Record<string, unknown> {
	return {
		agent,
		task: "Work",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 2, turns: 1 },
		status: "completed",
	};
}

function bacnh85Details(results: unknown[], backgroundTaskId?: string): Record<string, unknown> {
	return {
		mode: results.length > 1 ? "parallel" : "single",
		agentScope: "user",
		projectAgentsDir: null,
		results,
		...(backgroundTaskId === undefined ? {} : { backgroundTaskId }),
	};
}

function ferrisResult(
	runId: number,
	cost?: number,
	options: { exitCode?: number; sessionDir?: string; sessionId?: string } = {},
): Record<string, unknown> {
	return {
		agent: "scout",
		task: "Investigate",
		exitCode: options.exitCode ?? 0,
		messages: [],
		stderr: "",
		runId,
		projectCwd: "/project",
		isolation: "shared",
		...(cost === undefined ? {} : {
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 2, turns: 1 },
		}),
		...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
	};
}

function ferrisDetails(results: unknown[]): Record<string, unknown> {
	return {
		mode: results.length > 1 ? "parallel" : "single",
		results,
		background: true,
	};
}

function ferrisStatusRun(id: number, cost: number): Record<string, unknown> {
	return {
		id,
		agent: "scout",
		state: "completed",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 2, turns: 1 },
		exitCode: 0,
	};
}

function ferrisStatusDetails(runs: unknown[]): Record<string, unknown> {
	return { runs };
}

function archimedesResult(childSessionId?: string, cost?: number): Record<string, unknown> {
	const progress = {
		agent: "reviewer",
		status: "completed",
		task: "Review",
		toolCount: 1,
		inputTokens: 1,
		outputTokens: 1,
		tokens: 2,
		cost: cost ?? 0,
		durationMs: 10,
		model: "provider/model",
		output: "done",
		recentOutput: ["done"],
		toolCalls: [],
	};
	return {
		agent: "reviewer",
		task: "Review",
		...(childSessionId === undefined ? {} : { childSessionId }),
		exitCode: 0,
		...(cost === undefined ? {} : {
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 },
		}),
		model: "provider/model",
		finalOutput: "done",
		progress,
		progressSummary: { toolCount: 1, tokens: 2, durationMs: 10 },
	};
}

function archimedesDetails(results: Record<string, unknown>[]): Record<string, unknown> {
	return {
		mode: results.length > 1 ? "parallel" : "single",
		results,
		progress: results.map((result) => result.progress),
	};
}

function archimedesLikeOtherPackage(): Record<string, unknown> {
	const result = archimedesResult("00000000-0000-7000-8000-000000000099", 50);
	return {
		mode: "single",
		results: [result],
		progress: [{ ...(result.progress as Record<string, unknown>), inputTokens: 999 }],
	};
}

function liteForegroundDetails(cost?: number, contextPercent: number | null = 1): Record<string, unknown> {
	return {
		type: "general-purpose",
		description: "Delegated work",
		turnCount: 2,
		toolUses: 1,
		input: 10,
		output: 5,
		contextPercent,
		durationMs: 25,
		compactions: 0,
		modelName: "model",
		modelId: "model",
		thinkingLevel: "medium",
		...(cost === undefined ? {} : { cost }),
	};
}

function liteBackgroundLaunchDetails(agentId: string): Record<string, unknown> {
	return {
		type: "general-purpose",
		description: "Delegated work",
		agentId,
		status: "running",
	};
}

function liteCompletionDetails(cost: number): Record<string, unknown> {
	return {
		...liteForegroundDetails(cost),
		status: "completed",
	};
}

function liteCompletionContent(shortId: string): string {
	return `[Subagent "general-purpose" ${shortId} completed]\n\ndone`;
}

function betterToolResult(
	sessionFile: string,
	cwd: string,
	toolName: string,
	text: string,
): {
	sessionFile: string;
	toolName: string;
	content: unknown;
	details: null;
	cwd: string;
} {
	return {
		sessionFile,
		toolName,
		content: [{ type: "text", text }],
		details: null,
		cwd,
	};
}

function writeBetterRun(
	registryRoot: string,
	options: {
		id: string;
		parentId: string;
		parentCwd: string;
		cost: number;
		extra?: unknown[];
		sandboxedSession?: boolean;
		writeSessionFile?: boolean;
	},
): void {
	const runDirectory = path.join(registryRoot, "runs", options.id);
	fs.mkdirSync(runDirectory, { recursive: true });
	fs.writeFileSync(path.join(runDirectory, "meta.json"), JSON.stringify({
		id: options.id,
		status: "completed",
		pid: 101,
		spawnPid: 100,
		cwd: options.parentCwd,
		promptPreview: "delegated work",
		startedAt: 1,
		endedAt: 2,
		logPath: path.join(runDirectory, "output.log"),
		sessionId: options.id,
		callbackOrigin: { cwd: options.parentCwd, sessionId: options.parentId },
	}));
	if (options.writeSessionFile === false) return;
	const sessionFile = options.sandboxedSession === false
		? path.join(registryRoot, "sessions", `${options.id}.jsonl`)
		: path.join(registryRoot, "sessions", options.id, "session.jsonl");
	writeSession(sessionFile, {
		id: options.id,
		cost: options.cost,
		cwd: options.parentCwd,
		extra: options.extra,
	});
}

function minimalRegistryEntry(
	rootSessionId: string,
	event: string,
	payload: Record<string, unknown>,
	version: 1 | 2 = 2,
): unknown {
	return customEntry("minimal-subagents.registry", {
		version,
		root_session_id: rootSessionId,
		timestamp: "2026-01-01T00:00:00.000Z",
		event,
		...payload,
	});
}

function minimalRegistryAgent(
	agentId: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		agent_id: agentId,
		friendly_id: agentId.split(".").at(-1),
		parent_id: "root",
		created_at: "2026-01-01T00:00:00.000Z",
		spawn_entry_id: "spawn-entry",
		launch_contract: {
			session_context: "omit",
			project_context: "inherit",
			model: "provider/model",
			thinking_level: "medium",
			ordinary_tools: [],
		},
		capability_ceiling: [],
		availability: "available",
		missing_dependencies: [],
		recent_messages: [],
		...extra,
	};
}

function minimalTurnResult(agentId: string, turnId: string, cost?: number): Record<string, unknown> {
	return {
		agent_id: agentId,
		turn_id: turnId,
		status: "completed",
		output: "done",
		...(cost === undefined ? {} : { usage: minimalUsage(cost) }),
	};
}

function minimalUsage(cost: number): Record<string, unknown> {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function customEntry(customType: string, data: unknown): unknown {
	return { type: "custom", customType, data };
}

function customMessage(customType: string, details: unknown, content = "completed"): unknown {
	return {
		type: "custom_message",
		customType,
		content,
		display: true,
		details,
	};
}

function toolResult(
	toolName: string,
	text: string,
	details?: unknown,
	reportedUsageCost?: number,
	toolCallId?: string,
): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			...(toolCallId === undefined ? {} : { toolCallId }),
			content: [{ type: "text", text }],
			...(details === undefined ? {} : { details }),
			...(reportedUsageCost === undefined ? {} : { usage: { cost: { total: reportedUsageCost } } }),
		},
	};
}

function fabricAgentAudit(id: string, cost: number): Record<string, unknown> {
	return {
		ref: "agents.run",
		tool: "run",
		provider: "agents",
		success: true,
		result: {
			id,
			name: "reviewer",
			task: "Review the change",
			status: "completed",
			runner: "pi",
			cwd: "/project",
			usage: { input: 10, output: 5, cost },
		},
	};
}

function fabricNestedBusinessAudit(id: string, cost: number): Record<string, unknown> {
	return {
		ref: "agents.run",
		tool: "run",
		provider: "agents",
		success: true,
		result: {
			metadata: {
				id,
				name: "not-an-agent-result",
				task: "business data",
				status: "completed",
				runner: "pi",
				cwd: "/project",
				usage: { cost },
			},
		},
	};
}

function traceCall(runId: string, phaseId: string, attempt: number, cost: number): unknown {
	return {
		ts: attempt + 1,
		runId,
		phaseId,
		kind: "subagent-call",
		input: { attempt },
		output: { usage: { cost } },
	};
}

function writeTaskflowRun(cwd: string, runId: string, flowName: string, options: {
	parentRunId?: string;
	createdAt: number;
	phases: Record<string, unknown>;
	trace: unknown[];
}): void {
	const runsRoot = path.join(cwd, ".pi", "taskflows", "runs");
	const flowDir = path.join(runsRoot, flowName);
	fs.mkdirSync(flowDir, { recursive: true });
	const relPath = `${flowName}/${runId}.json`;
	const indexFile = path.join(runsRoot, "index.json");
	let index: unknown[] = [];
	if (fs.existsSync(indexFile)) index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
	index.push({ runId, flowName, cwd, relPath, ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}) });
	fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
	fs.writeFileSync(path.join(runsRoot, relPath), JSON.stringify({
		runId,
		flowName,
		cwd,
		createdAt: options.createdAt,
		phases: options.phases,
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
	}, null, 2));
	const traceFile = path.join(flowDir, `${runId}.trace.jsonl`);
	fs.writeFileSync(traceFile, options.trace.length > 0
		? `${options.trace.map((entry) => JSON.stringify(entry)).join("\n")}\n`
		: "");
}

function writeDynamicWorkflowHead(
	workflowHome: string,
	cwd: string,
	runId: string,
	index: Record<string, unknown>,
	legacy = false,
): string {
	const slug = path.basename(path.resolve(cwd)).toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
	const key = `${slug}-${createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12)}`;
	const runsRoot = legacy
		? path.join(workflowHome, "runs")
		: path.join(workflowHome, "projects", key, "runs");
	fs.mkdirSync(runsRoot, { recursive: true });
	const file = path.join(runsRoot, `${runId}.json`);
	fs.writeFileSync(file, JSON.stringify({
		format: "pi-workflow-run-v2",
		generation: "test",
		bytes: 1,
		sequence: 1,
		hash: "test",
		keys: [],
		index: { runId, ...index },
		summary: { total: 1, usage: index.tokenUsage },
	}));
	return file;
}
