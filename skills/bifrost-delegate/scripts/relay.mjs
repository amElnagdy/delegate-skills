#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const MODES = new Set(["plan", "advise", "review"]);
const DEFAULT_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config.json");

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    brief: null,
    mode: null,
    model: null,
    config: null,
    outDir: null,
    timeoutSeconds: null,
    maxTokens: null,
    listModels: false,
    checkConfig: false,
  };

  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined) fail(`${flag} requires a value`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "--brief":
        options.brief = nextValue(index, arg);
        index += 1;
        break;
      case "--mode":
        options.mode = nextValue(index, arg);
        index += 1;
        break;
      case "--model":
        options.model = nextValue(index, arg);
        index += 1;
        break;
      case "--config":
        options.config = nextValue(index, arg);
        index += 1;
        break;
      case "--out-dir":
        options.outDir = nextValue(index, arg);
        index += 1;
        break;
      case "--timeout":
        options.timeoutSeconds = Number(nextValue(index, arg));
        index += 1;
        break;
      case "--max-tokens":
        options.maxTokens = Number(nextValue(index, arg));
        index += 1;
        break;
      case "--list-models":
        options.listModels = true;
        break;
      case "--check-config":
        options.checkConfig = true;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`bifrost-delegate relay\n\nUsage:\n  node relay.mjs --mode <plan|advise|review> --brief <file> [options]\n  cat brief.txt | node relay.mjs --mode plan [options]\n  node relay.mjs --list-models [--config <file>]\n  node relay.mjs --check-config [--config <file>]\n\nOptions:\n  --model <id>         Override the configured model for this run\n  --config <file>      Use a custom config file\n  --out-dir <dir>      Write artifacts to this directory\n  --timeout <seconds>  Override request timeout\n  --max-tokens <n>     Override max output tokens\n`);
}

function resolveConfigPath(options) {
  return resolve(options.config || process.env.BIFROST_DELEGATE_CONFIG || DEFAULT_CONFIG);
}

function loadConfig(path) {
  if (!existsSync(path)) fail(`config file not found: ${path}`);

  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid JSON in config: ${error.message}`);
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("config must be a JSON object");
  }

  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim()) {
    fail("config.baseUrl must be a non-empty string");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(config.baseUrl);
  } catch {
    fail("config.baseUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    fail("config.baseUrl must use http or https");
  }

  if (!config.models || typeof config.models !== "object" || Array.isArray(config.models)) {
    fail("config.models must be an object");
  }

  for (const mode of MODES) {
    const value = config.models[mode];
    if (value !== undefined && typeof value !== "string") {
      fail(`config.models.${mode} must be a string`);
    }
  }

  const request = config.request || {};
  validatePositiveInteger(request.timeoutSeconds, "config.request.timeoutSeconds", true);
  validatePositiveInteger(request.maxTokens, "config.request.maxTokens", true);
  if (request.temperature !== undefined &&
      (typeof request.temperature !== "number" || request.temperature < 0 || request.temperature > 2)) {
    fail("config.request.temperature must be a number between 0 and 2");
  }

  return config;
}

function validatePositiveInteger(value, name, optional = false) {
  if (optional && value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
}

function requireApiKey() {
  const key = process.env.BIFROST_API_KEY;
  if (!key) fail("BIFROST_API_KEY is not set");
  return key;
}

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function bifrostRequest(url, apiKey, init, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 1000) };
      }
    }

    if (!response.ok) {
      const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }

    return { body, headers: response.headers };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`request timed out after ${timeoutSeconds} seconds`);
      timeoutError.type = "timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(config, apiKey, timeoutSeconds) {
  const { body } = await bifrostRequest(
    endpoint(config.baseUrl, "/v1/models"),
    apiKey,
    { method: "GET" },
    timeoutSeconds,
  );

  const ids = Array.isArray(body?.data)
    ? body.data.map((item) => item?.id).filter((id) => typeof id === "string")
    : [];

  return ids.sort((left, right) => left.localeCompare(right));
}

function modeInstruction(mode) {
  const common = "You are an advisory software-engineering delegate. Base your answer only on the supplied brief. Do not claim to have inspected files, executed commands, edited code, or committed changes.";
  const specific = {
    plan: "Produce a focused implementation plan. State assumptions, affected areas, risks, and validation steps. Prefer the simplest sufficient design.",
    advise: "Evaluate the proposed implementation. Focus on correctness, edge cases, trade-offs, and simpler alternatives.",
    review: "Review the supplied requirements, diff, and gate results. Return sections named Blockers, Important issues, Minor improvements, and Recommendation. Do not invent unsupported findings.",
  };
  return `${common}\n\n${specific[mode]}`;
}

function readBrief(path) {
  let brief;
  if (path) {
    if (!existsSync(path)) fail(`brief file not found: ${path}`);
    brief = readFileSync(path, "utf8");
  } else {
    if (process.stdin.isTTY) fail("pass --brief <file> or pipe the brief on stdin");
    brief = readFileSync(0, "utf8");
  }

  if (!brief.trim()) fail("brief must not be empty");
  return brief;
}

function createRunDir(outDir) {
  const resolved = outDir
    ? resolve(outDir)
    : join(tmpdir(), "delegate-relay", `bifrost-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function writeResult(runDir, result) {
  const resultPath = join(runDir, "result.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (result.finalMessage) {
    writeFileSync(join(runDir, "final.txt"), `${result.finalMessage}\n`, "utf8");
  }
  return resultPath;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listModels && options.checkConfig) fail("choose only one of --list-models or --check-config");

  const configPath = resolveConfigPath(options);
  const config = loadConfig(configPath);
  const apiKey = requireApiKey();
  const timeoutSeconds = options.timeoutSeconds ?? config.request?.timeoutSeconds ?? 180;
  validatePositiveInteger(timeoutSeconds, "timeout");

  if (options.listModels) {
    const ids = await listModels(config, apiKey, timeoutSeconds);
    process.stdout.write(`${ids.join("\n")}${ids.length ? "\n" : ""}`);
    return;
  }

  if (options.checkConfig) {
    const ids = new Set(await listModels(config, apiKey, timeoutSeconds));
    process.stdout.write(`Bifrost connection: OK\nConfig: ${configPath}\n\n`);
    for (const mode of MODES) {
      const model = config.models[mode]?.trim();
      const status = !model ? "not configured" : ids.has(model) ? "available" : "missing";
      process.stdout.write(`${mode.padEnd(7)} ${model || "-"}  ${status}\n`);
    }
    return;
  }

  if (!MODES.has(options.mode)) fail("--mode must be one of: plan, advise, review");
  const model = options.model || config.models[options.mode]?.trim();
  if (!model) fail(`no model configured for mode: ${options.mode}; edit config.json or pass --model`);

  const maxTokens = options.maxTokens ?? config.request?.maxTokens ?? 6000;
  validatePositiveInteger(maxTokens, "max tokens");
  const temperature = config.request?.temperature ?? 0.1;
  const brief = readBrief(options.brief);
  const runDir = createRunDir(options.outDir);
  const startedAt = new Date().toISOString();

  try {
    const { body, headers } = await bifrostRequest(
      endpoint(config.baseUrl, "/v1/chat/completions"),
      apiKey,
      {
        method: "POST",
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: modeInstruction(options.mode) },
            { role: "user", content: brief },
          ],
          stream: false,
          temperature,
          max_tokens: maxTokens,
        }),
      },
      timeoutSeconds,
    );

    const finalMessage = body?.choices?.[0]?.message?.content;
    if (typeof finalMessage !== "string" || !finalMessage.trim()) {
      throw new Error("Bifrost response did not contain choices[0].message.content");
    }

    const result = {
      schema: "delegate-relay.result.v1",
      status: "completed",
      exitCode: 0,
      signal: null,
      delegate: "bifrost",
      mode: options.mode,
      model,
      configPath,
      startedAt,
      finishedAt: new Date().toISOString(),
      finalMessage,
      usage: body?.usage || null,
      requestId: headers.get("x-request-id") || headers.get("x-bifrost-trace-id") || null,
      touchedFiles: [],
    };

    const resultPath = writeResult(runDir, result);
    process.stdout.write(`${JSON.stringify({ status: result.status, model, mode: options.mode, resultPath }, null, 2)}\n`);
  } catch (error) {
    const result = {
      schema: "delegate-relay.result.v1",
      status: "failed",
      exitCode: 1,
      signal: null,
      delegate: "bifrost",
      mode: options.mode,
      model,
      configPath,
      startedAt,
      finishedAt: new Date().toISOString(),
      finalMessage: "",
      error: {
        type: error.type || (error.statusCode ? "gateway_error" : "request_error"),
        statusCode: error.statusCode || null,
        message: error.message,
      },
      touchedFiles: [],
    };
    const resultPath = writeResult(runDir, result);
    process.stderr.write(`relay: ${error.message}\nresult: ${resultPath}\n`);
    process.exit(1);
  }
}

run().catch((error) => fail(error.message, 1));
