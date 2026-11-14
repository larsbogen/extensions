import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createFocusServer, focusURL, readConfig, validateConfig } from "./service.mjs";

const config = { accountId: "123456", verificationToken: "this-is-a-synthetic-test-secret-1234", port: 8765 };
const initial = () => ({
  extensionType: "context-menu",
  context: { user: { id: 123456, email: "private@example.test" } },
  action: { actionType: "initial", params: { source: "task", sourceId: "6xAbc123", content: "Private task" } },
});
const servers = [];
const directories = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "todoist-context-test-"));
  directories.push(path);
  return path;
}

async function serve(options = {}) {
  const launched = [];
  const server = await createFocusServer(config, { launch: async (url) => launched.push(url), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (payload = initial(), overrides = {}) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "x-todoist-hmac-sha256": createHmac("sha256", config.verificationToken).update(body).digest("base64"),
      ...overrides.headers,
    };
    const response = await fetch(`${url}/process`, { method: "POST", body, ...overrides, headers });
    return { status: response.status, body: await response.json() };
  };
  return { server, post, launched, url };
}

test("a signed task callback sends only its bound IDs to the existing Raycast command", async () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const service = await serve({ now: () => now });
  const response = await service.post();
  assert.equal(response.status, 200);
  assert.equal(response.body.bridges[0].notification.text, "Sendt til fokuskortet");
  assert.equal(response.body.bridges[0].notification.type, "info");
  assert.equal(response.body.bridges[1].bridgeActionType, "finished");
  assert.equal(service.launched.length, 1);
  const url = new URL(service.launched[0]);
  assert.equal(url.protocol, "raycast:");
  assert.equal(url.hostname, "extensions");
  assert.equal(url.pathname, "/doist/todoist/focus-task");
  assert.equal(url.searchParams.get("launchType"), "background");
  const context = JSON.parse(url.searchParams.get("context"));
  assert.deepEqual(Object.keys(context).sort(), ["accountId", "issuedAt", "requestId", "taskId"]);
  assert.equal(context.taskId, "6xAbc123");
  assert.equal(context.accountId, config.accountId);
  assert.equal(context.issuedAt, new Date(now).toISOString());
  assert.match(context.requestId, /^[0-9a-f-]{36}$/);
  assert.ok(!service.launched[0].includes("Private"));
  assert.ok(!service.launched[0].includes(config.verificationToken));
});

test("signature covers exact raw bytes and rejects missing, malformed or incorrect signatures", async () => {
  const service = await serve();
  for (const signature of ["", "invalid", "A".repeat(43) + "="]) {
    assert.equal((await service.post(initial(), { headers: { "x-todoist-hmac-sha256": signature } })).status, 401);
  }
  const body = JSON.stringify(initial());
  const signature = createHmac("sha256", config.verificationToken).update(body).digest("base64");
  assert.equal((await service.post(`${body}\n`, { headers: { "x-todoist-hmac-sha256": signature } })).status, 401);
  assert.equal(service.launched.length, 0);
});

test("wrong accounts, projects, submissions and malformed task identifiers cannot launch", async () => {
  const service = await serve();
  const wrongAccount = initial();
  wrongAccount.context.user.id = "other";
  assert.equal((await service.post(wrongAccount)).status, 403);
  for (const change of [
    (p) => {
      p.extensionType = "composer";
    },
    (p) => {
      p.action.actionType = "submit";
    },
    (p) => {
      p.action.params.source = "project";
    },
    (p) => {
      p.action.params.sourceId = "x&context=bad";
    },
    (p) => {
      p.action.params.sourceId = 9007199254740992;
    },
    (p) => {
      delete p.action;
    },
  ]) {
    const payload = initial();
    change(payload);
    assert.equal((await service.post(payload)).status, 400);
  }
  assert.equal((await service.post("null")).status, 403);
  assert.equal((await service.post("{")).status, 400);
  assert.equal(service.launched.length, 0);
});

test("HTTP bounds reject large bodies and unsupported routes without exposing configuration", async () => {
  const service = await serve();
  assert.equal((await service.post("x".repeat(65537))).status, 413);
  assert.equal((await service.post(initial(), { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await fetch(`${service.url}/process`)).status, 405);
  assert.equal((await fetch(`${service.url}/unknown`)).status, 404);
  assert.deepEqual(await (await fetch(`${service.url}/health`)).json(), { ok: true });
  assert.equal(service.launched.length, 0);
});

test("overlapping callbacks launch once even if dispatch takes longer than the dedupe window", async () => {
  let now = Date.now();
  let resolveLaunch;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  let calls = 0;
  const service = await serve({
    now: () => now,
    launch: async () => {
      calls++;
      entered();
      await waiting;
    },
  });
  const first = service.post();
  await started;
  now += 20_000;
  const duplicate = service.post();
  // Allow the second HTTP request to reach the asynchronous handler.
  await new Promise((resolve) => setTimeout(resolve, 20));
  resolveLaunch();
  assert.deepEqual(await duplicate, await first);
  await service.post();
  assert.equal(calls, 1);
});

test("completed duplicate callbacks are suppressed, while a later deliberate click gets a new request", async () => {
  let now = Date.now();
  const service = await serve({ now: () => now });
  await service.post();
  await service.post();
  assert.equal(service.launched.length, 1);
  now += 10_001;
  await service.post();
  assert.equal(service.launched.length, 2);
  assert.notEqual(service.launched[0], service.launched[1]);
});

test("launcher failures remain uncertain and duplicate delivery never retries them automatically", async () => {
  let now = Date.now();
  let calls = 0;
  const service = await serve({
    now: () => now,
    launch: async () => {
      calls++;
      throw new Error("private output");
    },
  });
  const response = await service.post();
  assert.equal(response.status, 200);
  assert.ok(response.body.card.body[1].text.includes("ikke sendt på nytt automatisk"));
  assert.ok(!JSON.stringify(response.body).includes("private output"));
  assert.deepEqual(await service.post(), response);
  now += 24 * 60 * 60 * 1000;
  assert.deepEqual(await service.post(), response);
  assert.equal(calls, 1);
});

test("journal survives restart without storing task content or dispatching a pending intent twice", async () => {
  let now = Date.now();
  const journalPath = join(await temporary(), "state.json");
  const service = await serve({ journalPath, now: () => now });
  await service.post();
  const savedText = await readFile(journalPath, "utf8");
  assert.ok(!savedText.includes("Private"));
  assert.ok(!savedText.includes("example.test"));
  assert.ok(!savedText.includes(config.verificationToken));
  const saved = JSON.parse(savedText);
  saved.receipts[0][1].status = "pending";
  await writeFile(journalPath, JSON.stringify(saved), { mode: 0o600 });
  now += 24 * 60 * 60 * 1000;
  const restarted = await serve({ journalPath, now: () => now });
  assert.ok((await restarted.post()).body.card);
  assert.equal(restarted.launched.length, 0);
});

test("an unknown launch stays blocked across restart long after the successful-callback window", async () => {
  let now = Date.now();
  const journalPath = join(await temporary(), "unknown.json");
  const service = await serve({
    journalPath,
    now: () => now,
    launch: async () => {
      throw new Error("unknown");
    },
  });
  const before = await service.post();
  now += 24 * 60 * 60 * 1000;
  const restarted = await serve({ journalPath, now: () => now });
  assert.deepEqual(await restarted.post(), before);
  assert.equal(restarted.launched.length, 0);
});

test("invalid journal prevents startup; invalid config is never printed or accepted", async () => {
  const path = join(await temporary(), "private.json");
  await writeFile(path, "{", { mode: 0o600 });
  await assert.rejects(createFocusServer(config, { journalPath: path }), /journalen/);
  await assert.rejects(readConfig(path), /gyldig JSON/);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await readConfig(path), config);
  await chmod(path, 0o644);
  await assert.rejects(readConfig(path), /privat fil/);
  for (const invalid of [
    {},
    { ...config, verificationToken: "REPLACE_WITH_TODOIST_VERIFICATION_TOKEN" },
    { ...config, verificationToken: "short" },
    { ...config, port: 0 },
  ]) {
    assert.throws(() => validateConfig(invalid));
  }
});

test("a journal timestamp from the future fails closed instead of suppressing requests indefinitely", async () => {
  const journalPath = join(await temporary(), "future.json");
  await writeFile(
    journalPath,
    JSON.stringify({ version: 1, receipts: [["a".repeat(64), { createdAt: Date.now() + 60_000, status: "pending" }]] }),
    { mode: 0o600 },
  );
  await assert.rejects(createFocusServer(config, { journalPath }), /journalen/);
});

test("generated URL escapes context rather than treating input as executable shell text", () => {
  const context = { taskId: "a", accountId: "1", requestId: "uuid", issuedAt: "timestamp" };
  assert.deepEqual(JSON.parse(new URL(focusURL(context)).searchParams.get("context")), context);
});
