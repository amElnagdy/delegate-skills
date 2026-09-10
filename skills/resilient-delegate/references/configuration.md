# Configuration

Without `--config`, `routine` starts locally with Aider using
`openai/qwen3-coder:30b` at Ollama's `http://127.0.0.1:11434/v1` endpoint and
whole-file edits. Its cloud fallbacks are Agy, Copilot, then Codex. `complex`
and `critical` lead with Codex, then use Agy and Copilot before the bounded
local Aider recovery attempt. The critical Codex candidate is GPT-6 Astra at
`medium` effort.

A configuration file is strict JSON:

```json
{
  "schema": "resilient-delegate.config.v1",
  "profiles": {
    "routine": {
      "candidates": [
        { "implementer": "aider", "model": "openai/qwen3-coder:30b", "apiBase": "http://127.0.0.1:11434/v1", "editFormat": "whole" },
        { "implementer": "agy", "model": "gemini-3.8-flash-medium", "effort": "medium" }
      ]
    }
  }
}
```

Candidates may name `implementer`, `model`, `effort`, and the Aider-specific
`apiBase` and `editFormat` fields. Only Aider, Agy, Copilot, and Codex are
accepted. Codex effort is always `low` or `medium`; this includes GPT-6 Astra.

The aggregate `<out-dir>/result.json` records every attempt, the chosen
implementer when one completed, the terminal reason, and the final Git
porcelain touched-file set. Only rate/quota limits, 429/503/529, missing or
unauthenticated implementers, connection failures, and watchdog timeouts can
advance. Permission, argument/configuration, malformed-result, project-gate,
and implementation failures stop the chain.
