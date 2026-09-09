#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const webUrl = process.env.CODEX_WEB_HEALTH_URL ?? "http://127.0.0.1:8214/";
const runtimeDir =
  process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
const socketPath =
  process.env.CODEX_UNIX_SOCKET ?? `${runtimeDir}/codex-web/app-server.sock`;
const proxyPath =
  process.env.CODEX_WEB_PROXY_PATH ??
  new URL("./codex_remote_proxy", import.meta.url).pathname;
const timeoutMs = Number(process.env.CODEX_WEB_HEALTH_TIMEOUT_MS ?? "8000");

function fail(message) {
  throw new Error(message);
}

async function checkHttp() {
  const response = await fetch(webUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    fail(`Codex Web returned HTTP ${response.status}`);
  }
  await response.body?.cancel();
}

async function checkSocket() {
  const stat = await fs.stat(socketPath);
  if (!stat.isSocket()) {
    fail(`${socketPath} is not a Unix socket`);
  }
}

async function checkAppServer() {
  await new Promise((resolve, reject) => {
    const child = spawn(proxyPath, ["app-server"], {
      env: { ...process.env, CODEX_UNIX_SOCKET: socketPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let initialized = false;
    let listHealthy = false;
    let configHealthy = false;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      error ? reject(error) : resolve();
    };

    const maybeFinish = () => {
      if (listHealthy && configHealthy) finish();
    };

    const handleMessage = (message) => {
      if (message.id === "health-init") {
        if (message.error) {
          finish(new Error(`app-server initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        initialized = true;
        child.stdin.write(
          `${JSON.stringify({ id: "health-list", method: "thread/list", params: { limit: 1 } })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({
            id: "health-config",
            method: "thread/start",
            params: {
              ephemeral: true,
              config: {
                "mcp_servers.codex_app.enabled_tools": ["read_thread"],
              },
            },
          })}\n`,
        );
        return;
      }

      if (message.id === "health-list") {
        if (message.error) {
          finish(new Error(`thread/list failed: ${JSON.stringify(message.error)}`));
          return;
        }
        listHealthy = true;
        maybeFinish();
        return;
      }

      if (message.id === "health-config") {
        if (message.error) {
          finish(
            new Error(
              `ephemeral thread/start failed: ${JSON.stringify(message.error)}`,
            ),
          );
          return;
        }
        configHealthy = true;
        maybeFinish();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch (error) {
          finish(new Error(`invalid app-server response: ${line}`, { cause: error }));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `app-server proxy exited before health checks completed ` +
              `(initialized=${initialized}, code=${code}, signal=${signal}): ${stderr.trim()}`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`app-server health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdin.write(
      `${JSON.stringify({
        id: "health-init",
        method: "initialize",
        params: {
          clientInfo: { name: "codex-web-health", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}

await checkHttp();
await checkSocket();
await checkAppServer();
console.log("Codex Web health check passed");
