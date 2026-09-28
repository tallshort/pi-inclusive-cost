import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { collectArchimedes } from "./collectors/archimedes.js";
import { collectBacnh85 } from "./collectors/bacnh85.js";
import { collectFabric } from "./collectors/fabric.js";
import { collectFerris } from "./collectors/ferris.js";
import { collectJ0k3r } from "./collectors/j0k3r.js";
import { collectLite } from "./collectors/lite.js";
import { collectPiSessions } from "./collectors/pi-sessions.js";
import { collectTaskflow } from "./collectors/taskflow.js";

const STATUS_KEY = "00-inclusiveCost";

interface CostTotals {
	direct: number;
	inclusive: number;
	foldedCount: number;
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
				`Inclusive (+ subagents): $${totals.inclusive.toFixed(2)}`,
				`Delegated sessions/runs folded in: ${totals.foldedCount}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function updateStatus(ctx: ExtensionContext): void {
	const totals = computeTotals(ctx);
	const delegatedCount = totals?.foldedCount ?? 0;
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
	const archimedes = collectArchimedes(sessions.toolResults);
	const bacnh85 = collectBacnh85(sessions.toolResults, sessions.customMessages);
	const fabric = collectFabric(rootFile, sessions.toolResults);
	const ferris = collectFerris(sessions.toolResults);
	const j0k3r = collectJ0k3r(sessions.toolResults);
	const lite = collectLite(sessions.toolResults, sessions.customMessages);
	const taskflow = collectTaskflow(sessions.toolResults);
	return {
		direct: sessions.directCost,
		inclusive: sessions.directCost + sessions.delegatedCost + archimedes.cost + bacnh85.cost + fabric.cost + ferris.cost + j0k3r.cost + lite.cost + taskflow.cost,
		foldedCount: sessions.delegatedCount + archimedes.count + bacnh85.count + fabric.count + ferris.count + j0k3r.count + lite.count + taskflow.count,
	};
}
