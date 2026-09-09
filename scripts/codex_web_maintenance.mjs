#!/usr/bin/env node

import { spawn } from "node:child_process";

const args = new Set(process.argv.slice(2));
const restart = args.delete("--restart-backend");
if (args.size > 0) {
  throw new Error(
    `usage: ${process.argv[1]} [--restart-backend]`,
  );
}

const runtimeDir =
  process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
const socketPath =
  process.env.CODEX_UNIX_SOCKET ?? `${runtimeDir}/codex-web/app-server.sock`;
const proxyPath =
  process.env.CODEX_WEB_PROXY_PATH ??
  new URL("./codex_remote_proxy", import.meta.url).pathname;
const systemctlPath =
  process.env.CODEX_WEB_SYSTEMCTL_BIN ?? "/usr/bin/systemctl";
const timeoutMs = Number(process.env.CODEX_WEB_MAINTENANCE_TIMEOUT_MS ?? "10000");

function requestLoadedThreads() {
  return new Promise((resolve, reject) => {
    const child = spawn(proxyPath, ["app-server"], {
      env: { ...process.env, CODEX_UNIX_SOCKET: socketPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pendingReads = new Set();
    const threads = [];
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      error ? reject(error) : resolve(threads);
    };

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handle = (message) => {
      if (message.id === "maintenance-init") {
        if (message.error) {
          finish(new Error(`initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        send({
          id: "maintenance-loaded",
          method: "thread/loaded/list",
          params: {},
        });
        return;
      }

      if (message.id === "maintenance-loaded") {
        if (message.error) {
          finish(
            new Error(`thread/loaded/list failed: ${JSON.stringify(message.error)}`),
          );
          return;
        }
        for (const threadId of message.result?.data ?? []) {
          pendingReads.add(threadId);
          send({
            id: `maintenance-read:${threadId}`,
            method: "thread/read",
            params: { threadId, includeTurns: false },
          });
        }
        if (pendingReads.size === 0) finish();
        return;
      }

      if (typeof message.id === "string" && message.id.startsWith("maintenance-read:")) {
        const threadId = message.id.slice("maintenance-read:".length);
        pendingReads.delete(threadId);
        if (message.error) {
          finish(new Error(`thread/read failed for ${threadId}: ${JSON.stringify(message.error)}`));
          return;
        }
        if (message.result?.thread) threads.push(message.result.thread);
        if (pendingReads.size === 0) finish();
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
          handle(JSON.parse(line));
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
            `app-server proxy exited early (code=${code}, signal=${signal}): ${stderr.trim()}`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`maintenance check timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    send({
      id: "maintenance-init",
      method: "initialize",
      params: {
        clientInfo: { name: "codex-web-maintenance", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

const threads = await requestLoadedThreads();
const active = threads.filter((thread) => thread.status?.type === "active");

if (active.length > 0) {
  console.error(
    `Refusing persistent app-server restart: ${active.length} active task(s):`,
  );
  for (const thread of active) {
    console.error(`  ${thread.id}  ${thread.cwd}`);
  }
  process.exitCode = 75;
} else if (!restart) {
  console.log(
    `No active Codex tasks among ${threads.length} loaded task(s); ` +
      "a persistent app-server restart can proceed",
  );
} else {
  console.log("No active Codex tasks; restarting persistent app-server and browser bridge");
  const child = spawn(systemctlPath, [
    "--user",
    "restart",
    "codex-app-server.service",
    "codex-web.service",
  ], { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      if (signal) reject(new Error(`systemctl terminated by ${signal}`));
      else resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
}
