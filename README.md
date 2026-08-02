# pi-omniroute

OmniRoute provider for [pi](https://github.com/earendil-works/pi-coding-agent) — connect pi to a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) router and use any model it exposes.

OmniRoute exposes an OpenAI-compatible `/v1` endpoint. This extension fetches the model list from the router's `GET /v1/models` and writes it into pi's native `~/.pi/agent/models.json` under an `omniroute` provider entry — no custom registration, pi does the rest.

## Install

```sh
pi install git:github.com/Leoo0x1/pi-omniroute
```

Add `-l` to install into project settings (`.pi/settings.json`) instead of user settings.

No runtime dependencies — the extension only uses Node builtins and pi's `ExtensionAPI`.

## Usage

Start pi and pick a model:

```
/model omniroute/<model-id>
```

If the router is configured, the model list is fetched once at startup (models.json is read by pi at startup, so restart after a sync to see new models in `/model`).

## Commands

| Command | Description |
|---|---|
| `/omni setup` | Set the base URL and API key interactively (persisted), then syncs |
| `/omni sync` | Fetch the model list from the server and update `~/.pi/agent/models.json` |

## Configuration

Config precedence (highest first):

1. Persisted config file: `~/.pi/agent/pi-omniroute.json` (written by `/omni setup`)
2. Default: `http://localhost:20128/v1` (OmniRoute's default port), no API key

Example config file:

```json
{
	"url": "http://localhost:20128/v1",
	"apiKey": "sk-..."
}
```

The config path honors `PI_CODING_AGENT_DIR` if set.

## Troubleshooting

- **No models** — the router wasn't reachable. Check it's running, then `/omni sync`.
- **`GET .../models → 401`** — the router requires an API key; run `/omni setup`.
- **Wrong URL** — default is `http://localhost:20128/v1`; override with `/omni setup`.
