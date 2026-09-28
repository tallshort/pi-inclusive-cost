import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
		"Inclusive (+ subagents): $2.00",
		"Delegated sessions/runs folded in: 1",
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.75/);
	assert.match(notification, /Delegated sessions\/runs folded in: 2/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.60/);
	assert.match(notification, /Delegated sessions\/runs folded in: 1/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.00/);
	assert.match(notification, /Delegated sessions\/runs folded in: 0/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$2\.05/);
	assert.match(notification, /Delegated sessions\/runs folded in: 5/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.90/);
	assert.match(notification, /Delegated sessions\/runs folded in: 3/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.95/);
	assert.match(notification, /Delegated sessions\/runs folded in: 4/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.60/);
	assert.match(notification, /Delegated sessions\/runs folded in: 1/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.95/);
	assert.match(notification, /Delegated sessions\/runs folded in: 4/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$2\.00/);
	assert.match(notification, /Delegated sessions\/runs folded in: 4/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.95/);
	assert.match(notification, /Delegated sessions\/runs folded in: 5/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.90/);
	assert.match(notification, /Delegated sessions\/runs folded in: 3/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.75/);
	assert.match(notification, /Delegated sessions\/runs folded in: 2/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.00/);
	assert.match(notification, /Delegated sessions\/runs folded in: 0/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$2\.00/);
	assert.match(notification, /Delegated sessions\/runs folded in: 3/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.16/);
	assert.match(notification, /Delegated sessions\/runs folded in: 2/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.60/);
	assert.match(notification, /Delegated sessions\/runs folded in: 1/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$2\.00/);
	assert.match(notification, /Delegated sessions\/runs folded in: 2/);
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
	assert.match(notification, /Inclusive \(\+ subagents\): \$1\.25/);
	assert.match(notification, /Delegated sessions\/runs folded in: 1/);
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

function writeSession(file: string, options: {
	id: string;
	cwd: string;
	cost: number;
	parentSession?: string;
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
		type: "message",
		message: { role: "assistant", usage: { cost: { total: options.cost } } },
	};
	const entries = [header, assistant, ...(options.extra ?? [])];
	fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
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
