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

async function fetchModels(url: string, apiKey?: string): Promise<CatalogModel[]> {
	const res = await fetch(`${url}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(15000),
	});
	if (!res.ok) throw new Error(`GET ${url}/models → ${res.status}`);
	const json = (await res.json()) as { data?: CatalogModel[] };
	return (json.data ?? []).sort((a, b) => a.id.localeCompare(b.id));
}

interface CatalogModel {
	id: string;
	name?: string;
	context_length?: number;
	max_output_tokens?: number;
	capabilities?: {
		reasoning?: boolean;
		thinking?: boolean;
		effort_tiers?: string[];
	};
	input_modalities?: string[];
}

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Derive a pi model definition from an OmniRoute /v1/models entry. */
function toModelDef(m: CatalogModel): Record<string, unknown> {
	const def: Record<string, unknown> = {
		id: m.id,
		name: m.name ?? m.id,
		reasoning: !!(m.capabilities?.reasoning || m.capabilities?.thinking),
	};
	if (m.context_length) def.contextWindow = m.context_length;
	if (m.max_output_tokens) def.maxTokens = m.max_output_tokens;
	if (m.input_modalities?.includes("image")) def.input = ["text", "image"];
	// effort_tiers uses "none" where pi uses "off"; unsupported levels get null.
	const tiers = m.capabilities?.effort_tiers;
	if (Array.isArray(tiers)) {
		const supported = new Set(tiers.map((t) => (t === "none" ? "off" : t)));
		const map: Partial<Record<(typeof PI_LEVELS)[number], null>> = {};
		for (const level of PI_LEVELS) {
			if (!supported.has(level)) map[level] = null;
		}
		if (Object.keys(map).length > 0) def.thinkingLevelMap = map;
	}
	return def;
}

/** Upsert an omniroute provider entry into ~/.pi/agent/models.json.
 *  Per-model merge: existing entries are never touched (hand-tuned params win),
 *  only models not already present are added. */
function writeModelsJson(url: string, apiKey: string | undefined, catalog: CatalogModel[]): void {
	let doc: { providers?: Record<string, unknown> } = {};
	try {
		doc = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
	} catch {
		/* fresh file */
	}
	doc.providers ??= {};
	const prev = doc.providers[PROVIDER] as { models?: { id: string }[] } | undefined;
	const known = new Set((prev?.models ?? []).map((m) => m.id));
	const added = catalog.filter((m) => !known.has(m.id)).map(toModelDef);
	doc.providers[PROVIDER] = {
		...prev,
		baseUrl: url,
		api: "openai-completions",
		apiKey: apiKey ?? "omniroute",
		models: [...(prev?.models ?? []), ...added].sort(
			(a, b) => a.id.localeCompare(b.id),
		),
	};
	writeFileSync(MODELS_JSON_PATH, JSON.stringify(doc, null, "\t"));
	return added.length;
}

/** Probe which thinking levels a model accepts by sending tiny chat completions
 *  with each reasoning_effort value. Returns a thinkingLevelMap, or undefined if
 *  the probe was inconclusive (the baseline request itself failed). */
async function probeLevels(
	url: string,
	apiKey: string | undefined,
	modelId: string,
): Promise<Record<string, string | null> | undefined> {
	const base = { model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
	const post = async (body: Record<string, unknown>): Promise<boolean> => {
		try {
			const res = await fetch(`${url}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(20_000),
			});
			return res.ok;
		} catch {
			return false;
		}
	};
	// Baseline without the parameter: if this fails the probe says nothing.
	if (!(await post(base))) return undefined;
	const map: Record<string, string | null> = {};
	for (const level of PI_LEVELS) {
		if (level === "off") continue; // off = omit the parameter, always supported
		if (await post({ ...base, reasoning_effort: level })) {
			// xhigh/max are opt-in in pi: they need explicit non-null entries
			if (level === "xhigh" || level === "max") map[level] = level;
		} else {
			map[level] = null;
		}
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/** Save the probed map into models.json (only if the entry has no map yet)
 *  and hot-apply the provider so no /reload is needed. */
function applyProbe(
	pi: ExtensionAPI,
	modelId: string,
	map: Record<string, string | null>,
): boolean {
	let doc: { providers?: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Record<string, unknown>[] }> };
	try {
		doc = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
	} catch {
		return false;
	}
	const entry = doc.providers?.[PROVIDER];
	const model = entry?.models?.find((m) => m.id === modelId);
	if (!entry || !model || model.thinkingLevelMap !== undefined) return false;
	model.thinkingLevelMap = map;
	writeFileSync(MODELS_JSON_PATH, JSON.stringify(doc, null, "\t"));
	pi.registerProvider(PROVIDER, {
		baseUrl: entry.baseUrl!,
		apiKey: entry.apiKey!,
		api: (entry.api ?? "openai-completions") as "openai-completions",
		models: entry.models as never,
	});
	return true;
}

let probing = false;

/** Auto-probe the selected model if it's an omniroute model without a thinkingLevelMap. */
async function autoProbe(
	pi: ExtensionAPI,
	ctx: { getModel(): { provider: string; id: string; thinkingLevelMap?: unknown } | undefined; ui: { notify(msg: string, level?: string): void } },
): Promise<void> {
	const cfg = loadConfig();
	if (!cfg.url || probing) return;
	const model = ctx.getModel();
	if (!model || model.provider !== PROVIDER || model.thinkingLevelMap) return;
	probing = true;
	try {
		ctx.ui.notify(`OmniRoute: probing thinking levels for ${model.id}…`, "info");
		const map = await probeLevels(cfg.url, cfg.apiKey, model.id);
		if (map && applyProbe(pi, model.id, map)) {
			ctx.ui.notify(`OmniRoute: thinking map saved for ${model.id}`, "info");
		} else if (!map) {
			ctx.ui.notify(`OmniRoute: probe inconclusive for ${model.id} (baseline request failed)`, "warning");
		}
	} finally {
		probing = false;
	}
}

async function sync(pi: ExtensionAPI, ctx?: { ui: { notify(msg: string, level?: string): void } }): Promise<void> {
	const cfg = loadConfig();
	if (!cfg.url) return;
	try {
		const catalog = await fetchModels(cfg.url, cfg.apiKey);
		const added = writeModelsJson(cfg.url, cfg.apiKey, catalog);
		ctx?.ui.notify(
			`OmniRoute: ${catalog.length} models on server, ${added} new added to ${MODELS_JSON_PATH} (existing entries untouched)`,
			"info",
		);
	} catch (e) {
		ctx?.ui.notify(`OmniRoute sync failed — ${e}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	// Sync at startup if configured (fire-and-forget).
	void sync(pi);

	// Probe thinking levels whenever an omniroute model without a map is selected.
	pi.on("model_select", async (_event, ctx) => {
		void autoProbe(pi, ctx);
	});

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
