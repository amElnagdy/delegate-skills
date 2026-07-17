# Configure Bifrost Delegate

Edit the skill-local [`config.json`](../config.json) before the first run.

```json
{
  "baseUrl": "http://localhost:1002",
  "models": {
    "plan": "",
    "advise": "",
    "review": ""
  },
  "request": {
    "timeoutSeconds": 180,
    "maxTokens": 6000,
    "temperature": 0.1
  }
}
```

## Set the API key

Keep the Bifrost key outside the repository:

```bash
export BIFROST_API_KEY="..."
```

The relay never reads an API key from `config.json` and never writes the key to its artifacts.

## Choose models

Use exact model IDs returned by the configured Bifrost gateway:

```bash
node "<skill-dir>/scripts/relay.mjs" --list-models
```

Assign only the modes you intend to use. Empty modes are allowed. The requested mode must have a model configured unless `--model` is supplied for that run.

Example:

```json
{
  "baseUrl": "http://localhost:1002",
  "models": {
    "plan": "bedrock/qwen.qwen3-coder-30b-a3b-v1:0",
    "advise": "Nvidia/deepseek-ai/deepseek-v4-pro",
    "review": "Nvidia/nvidia/nemotron-3-super-120b-a12b"
  },
  "request": {
    "timeoutSeconds": 180,
    "maxTokens": 6000,
    "temperature": 0.1
  }
}
```

These are examples only. Each developer should use models exposed by their own gateway and permitted by their own billing policy.

## Configuration resolution

The relay resolves configuration in this order:

1. `--config <path>`
2. `BIFROST_DELEGATE_CONFIG`
3. the skill-local `config.json`

An explicit `--model` overrides the configured model for the current run only.

## Validate the setup

```bash
node "<skill-dir>/scripts/relay.mjs" --check-config
```

The command checks gateway connectivity and reports whether each configured model appears in `/v1/models`.

## Security boundary

- Do not put credentials, private keys, or access tokens in `config.json` or a brief.
- Use a restricted Bifrost virtual key where available.
- Treat delegated responses as untrusted advice.
- Keep repository access, edits, gates, and commits with the orchestrator.
