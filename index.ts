/**
 * pi-omniroute — connect pi to a local OmniRoute router.
 * https://github.com/diegosouzapw/OmniRoute
 *
 * Writes fetched models into pi's native ~/.pi/agent/models.json under an
 * "omniroute" provider entry. Runs once at startup (if configured) and on
 * every /omni sync.
 *
 * Commands:
 *   /omni setup   — set the base URL and API key (persisted)
 *   /omni sync    — fetch models from the server and update models.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "omniroute";
const DEFAULT_URL = "http://localhost:20128/v1";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-omniroute.json");
const MODELS_JSON_PATH = join(AGENT_DIR, "models.json");

interface Config {
	url?: string;
	apiKey?: string;
}

function loadConfig(): Config {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
	} catch {
		return {};
	}
}

function saveConfig(cfg: Config): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, "\t"));
}

async function fetchModels(url: string, apiKey?: string): Promise<string[]> {
	const res = await fetch(`${url}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(15000),
	});
	if (!res.ok) throw new Error(`GET ${url}/models → ${res.status}`);
	const json = (await res.json()) as { data?: { id: string }[] };
	return (json.data ?? []).map((m) => m.id).sort();
}

/** Merge an omniroute provider entry into ~/.pi/agent/models.json. */
function writeModelsJson(url: string, apiKey: string | undefined, ids: string[]): void {
	let doc: { providers?: Record<string, unknown> } = {};
	try {
		doc = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
	} catch {
		/* fresh file */
	}
	doc.providers ??= {};
	doc.providers[PROVIDER] = {
		baseUrl: url,
		api: "openai-completions",
		apiKey: apiKey ?? "omniroute",
		models: ids.map((id) => ({ id, reasoning: true })),
	};
	writeFileSync(MODELS_JSON_PATH, JSON.stringify(doc, null, "\t"));
}

async function sync(pi: ExtensionAPI, ctx?: { ui: { notify(msg: string, level?: string): void } }): Promise<void> {
	const cfg = loadConfig();
	if (!cfg.url) return;
	try {
		const ids = await fetchModels(cfg.url, cfg.apiKey);
		writeModelsJson(cfg.url, cfg.apiKey, ids);
		ctx?.ui.notify(`OmniRoute: ${ids.length} models written to ${MODELS_JSON_PATH}`, "info");
	} catch (e) {
		ctx?.ui.notify(`OmniRoute sync failed — ${e}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	// Sync at startup if configured (fire-and-forget).
	void sync(pi);

	pi.registerCommand("omni", {
		description: "OmniRoute setup/sync",
		getArgumentCompletions: (prefix: string) =>
			["setup", "sync"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			if (sub === "setup") {
				const url = await ctx.ui.input("OmniRoute base URL:", DEFAULT_URL);
				if (!url) return;
				const apiKey = await ctx.ui.input("OmniRoute API key:", "");
				saveConfig({ url: url.replace(/\/+$/, ""), apiKey: apiKey || undefined });
				await sync(pi, ctx);
			} else if (sub === "sync") {
				await sync(pi, ctx);
			} else {
				ctx.ui.notify("Usage: /omni setup | /omni sync", "warning");
			}
		},
	});
}
