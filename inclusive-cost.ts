import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { collectFabric } from "./collectors/fabric.js";
import { collectPiSessions } from "./collectors/pi-sessions.js";
import { collectTaskflow } from "./collectors/taskflow.js";

const STATUS_KEY = "00-inclusiveCost";

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

	const sessions = collectPiSessions(rootFile);
	const fabric = collectFabric(rootFile, sessions.toolResults);
	const taskflow = collectTaskflow(sessions.toolResults);
	return {
		direct: sessions.directCost,
		subagents: sessions.delegatedCost,
		fabric: fabric.cost,
		taskflow: taskflow.cost,
		inclusive: sessions.directCost + sessions.delegatedCost + fabric.cost + taskflow.cost,
		subagentCount: sessions.delegatedCount,
		fabricRunCount: fabric.count,
		taskflowRunCount: taskflow.count,
	};
}
