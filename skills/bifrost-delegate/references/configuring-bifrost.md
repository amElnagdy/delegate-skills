# Configure Bifrost Delegate

This guide is for developers setting up the local Bifrost gateway used by `bifrost-delegate`.

## How it works

`bifrost-delegate` does not connect to model providers directly.

```text
Codex App or another orchestrator
        |
        | runs relay.mjs with a brief and mode
        v
Local Bifrost gateway
        |
        | validates the Virtual Key and routes the request
        v
Allowed provider and model
```

The skill sends OpenAI-compatible requests to Bifrost. Bifrost owns provider authentication, provider/model access, routing, logging, budgets, and rate limits.

## 1. Install and start Bifrost

Bifrost requires Node.js 18+ when started with NPX.

### Windows, Linux, macOS, or WSL

```bash
npx -y @maximhq/bifrost
```

Bifrost uses `http://localhost:8080` by default for both the Web UI and HTTP API.

### Docker

```bash
docker run -p 8080:8080 maximhq/bifrost
```

For persistent Docker configuration, mount a data directory as described in the official setup guide.

Official resources:

- [Bifrost Gateway setup](https://docs.getbifrost.ai/quickstart/gateway/setting-up)
- [Bifrost GitHub repository](https://github.com/maximhq/bifrost)

## 2. Configure providers

Open the Bifrost Web UI:

```text
http://localhost:8080
```

Add each provider that the skill may use and configure its credentials or cloud authentication. For example, AWS Bedrock requires valid AWS authentication and region settings; API-based providers require their provider key.

After adding a provider:

1. Confirm that the provider is enabled.
2. Confirm that its credentials or cloud authentication work.
3. Confirm that the required models are enabled or discoverable.
4. Test the provider from Bifrost before configuring the skill.

Provider configuration reference:

- [Bifrost provider setup](https://docs.getbifrost.ai/deployment-guides/config-json/providers)

## 3. Create a Virtual Key

The skill uses a Bifrost Virtual Key as its `apiKey`.

In the Bifrost Web UI:

1. Open **Virtual Keys**.
2. Click **Add Virtual Key**.
3. Give the key a clear name, such as `bifrost-delegate-local`.
4. Add every provider the skill should be allowed to use.
5. For each provider, allow the required provider key and models.
6. Create the key and copy its `sk-bf-...` value.

Important access rules:

- A provider must first be configured in Bifrost and then explicitly allowed by the Virtual Key.
- The Virtual Key must allow the provider key used for requests.
- The Virtual Key must allow every model configured for `plan`, `advise`, or `review`.
- An empty provider-key or model allowlist denies access.
- Use `"*"` only when intentionally allowing every available key or model.

Virtual Key reference:

- [Bifrost Virtual Keys](https://docs.getbifrost.ai/features/governance/virtual-keys)

## 4. Configure the skill

Edit the skill-local [`config.json`](../config.json):

```json
{
  "apiKey": "sk-bf-your-virtual-key",
  "baseUrl": "http://localhost:8080",
  "models": {
    "plan": "provider/model-id",
    "advise": "provider/model-id",
    "review": "provider/model-id"
  },
  "request": {
    "timeoutSeconds": 180,
    "maxTokens": 6000,
    "temperature": 0.1
  }
}
```

Use exact model IDs returned by your Bifrost gateway. Empty mode entries are allowed, but the requested mode must have a model configured unless `--model` is supplied for that run.

If Bifrost is running on another host or port, update `baseUrl` accordingly.

### API key resolution

The relay resolves the Virtual Key in this order:

1. `BIFROST_API_KEY`
2. `config.apiKey`

The environment variable is useful as a temporary override. The configured key is convenient for a local Codex App skill installation.

### Configuration resolution

The relay resolves the configuration file in this order:

1. `--config <path>`
2. `BIFROST_DELEGATE_CONFIG`
3. the skill-local `config.json`

An explicit `--model` overrides the configured model for the current run only.

## 5. Discover and validate models

List the models visible to the configured Virtual Key:

```bash
node "<skill-dir>/scripts/relay.mjs" --list-models
```

Bifrost only returns providers and models allowed by that Virtual Key. Copy the exact IDs into `config.json`.

Validate the connection and configured modes:

```bash
node "<skill-dir>/scripts/relay.mjs" --check-config
```

Expected output:

```text
Bifrost connection: OK

plan    provider/model-id  available
advise  provider/model-id  available
review  provider/model-id  available
```

A `missing` result usually means one of the following:

- the model ID is incorrect;
- the provider is not configured or enabled;
- the Virtual Key does not allow the provider;
- the Virtual Key does not allow the provider key or model.

## 6. Operational notes

- The delegated model is advisory and never receives direct repository access.
- The relay does not write the API key to `result.json`, `final.txt`, or request logs it creates.
- Do not include provider credentials or unrelated secrets in briefs.
- Keep repository edits, project commands, gates, and commits with the orchestrator.
- Use budgets and rate limits on the Virtual Key when cost control is useful.
