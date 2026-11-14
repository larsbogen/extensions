import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BODY = 64 * 1024;
const DEDUPE_MS = 10_000;
const MAX_RECEIPTS = 128;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && identifier.test(value) ? value : undefined;
}

export function validateConfig(value) {
  const accountId = normalizeId(value?.accountId);
  if (
    !accountId ||
    typeof value?.verificationToken !== "string" ||
    value.verificationToken.length < 16 ||
    value.verificationToken.length > 4096 ||
    /\s|replace|placeholder|verification.token|your.token/i.test(value.verificationToken)
  ) {
    throw new Error("Konfigurasjonen trenger accountId og Todoists verificationToken (minst 16 tegn).");
  }
  const port = value.port ?? 8765;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port må være mellom 1024 og 65535.");
  return { accountId, verificationToken: value.verificationToken, port };
}

export async function readConfig(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BODY || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Konfigurasjonen må være en privat fil (chmod 600), under 64 KiB.");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Konfigurasjonen er ikke gyldig JSON.");
  }
  return validateConfig(value);
}

export function focusURL({ taskId, accountId, requestId, issuedAt }) {
  const url = new URL("raycast://extensions/doist/todoist/focus-task");
  url.searchParams.set("launchType", "background");
  url.searchParams.set("context", JSON.stringify({ taskId, accountId, requestId, issuedAt }));
  return url.toString();
}

export async function launchFocus(url) {
  if (process.platform !== "darwin") throw new Error("Fokuskortet krever macOS.");
  await execFileAsync("/usr/bin/open", ["-g", url], { timeout: 10_000, maxBuffer: 1024 });
}

function delivered() {
  return {
    bridges: [
      { bridgeActionType: "display.notification", notification: { type: "info", text: "Sendt til fokuskortet" } },
      { bridgeActionType: "finished" },
    ],
  };
}

function uncertain() {
  return {
    card: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      todoistCardVersion: "0.6",
      body: [
        { type: "TextBlock", text: "Overføringen er uavklart", weight: "bolder", wrap: true },
        {
          type: "TextBlock",
          text: "Se fokusvinduet eller start oppgaven fra Raycast. Forespørselen blir ikke sendt på nytt automatisk.",
          wrap: true,
        },
      ],
    },
  };
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function rawBody(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
    };
    const error = (cause) => {
      cleanup();
      reject(cause);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        error(new Error("too-large"));
        request.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks));
    };
    request.on("data", data).once("end", end).once("error", error);
  });
}

async function writeJournal(path, receipts) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, receipts: [...receipts.entries()] }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJournal(path, now) {
  if (!path) return new Map();
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0) throw new Error("invalid journal");
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.receipts) || saved.receipts.length > MAX_RECEIPTS)
      throw new Error("invalid journal");
    const receipts = new Map();
    for (const entry of saved.receipts) {
      const [digest, receipt] = entry;
      if (
        !/^[0-9a-f]{64}$/.test(digest) ||
        !Number.isFinite(receipt?.createdAt) ||
        receipt.createdAt > now() ||
        (receipt.completedAt !== undefined &&
          (!Number.isFinite(receipt.completedAt) ||
            receipt.completedAt < receipt.createdAt ||
            receipt.completedAt > now())) ||
        !["pending", "sent", "unknown"].includes(receipt.status)
      )
        throw new Error("invalid journal");
      // An unknown launch must stay blocked: Todoist supplies no request nonce,
      // so a later identical callback cannot prove a deliberate new click.
      if (receipt.status !== "sent" || now() - (receipt.completedAt ?? receipt.createdAt) < DEDUPE_MS)
        receipts.set(digest, { ...receipt, status: receipt.status === "sent" ? "sent" : "unknown" });
    }
    return receipts;
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw new Error("Forespørselsjournalen kunne ikke leses sikkert. Tjenesten er ikke startet.");
  }
}

/** The caller binds this server to loopback; CLI below always uses 127.0.0.1. */
export async function createFocusServer(config, { launch = launchFocus, now = Date.now, journalPath } = {}) {
  config = validateConfig(config);
  const receipts = await readJournal(journalPath, now);
  const inFlight = new Map();
  // Serialize reservation, dispatch and journal writes across simultaneous callbacks.
  let previous = Promise.resolve();
  const dispatch = (digest, taskId) => {
    if (inFlight.has(digest)) return inFlight.get(digest);
    const operation = previous.then(async () => {
      for (const [key, receipt] of receipts)
        if (receipt.status === "sent" && now() - (receipt.completedAt ?? receipt.createdAt) >= DEDUPE_MS)
          receipts.delete(key);
      const existing = receipts.get(digest);
      if (existing) return existing.status === "sent" ? delivered() : uncertain();
      if (receipts.size >= MAX_RECEIPTS) throw new Error("request-capacity");
      const receipt = { createdAt: now(), requestId: randomUUID(), status: "pending" };
      receipts.set(digest, receipt);
      // A durable intent prevents replay after a process death between open and its result.
      await writeJournal(journalPath, receipts);
      try {
        await launch(
          focusURL({
            taskId,
            accountId: config.accountId,
            requestId: receipt.requestId,
            issuedAt: new Date(receipt.createdAt).toISOString(),
          }),
        );
        receipt.status = "sent";
        receipt.completedAt = now();
        await writeJournal(journalPath, receipts);
        return delivered();
      } catch {
        receipt.status = "unknown";
        receipt.completedAt = now();
        await writeJournal(journalPath, receipts).catch(() => undefined);
        return uncertain();
      }
    });
    inFlight.set(digest, operation);
    operation.finally(() => inFlight.delete(digest)).catch(() => undefined);
    previous = operation.catch(() => undefined);
    return operation;
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true });
    if (request.url !== "/process") return send(response, 404, { error: "not-found" });
    if (request.method !== "POST") return send(response, 405, { error: "method-not-allowed" });
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      request.resume();
      return send(response, 415, { error: "json-required" });
    }
    let body;
    try {
      body = await rawBody(request);
    } catch (error) {
      return send(response, error.message === "too-large" ? 413 : 400, { error: "invalid-body" });
    }
    const header = request.headers["x-todoist-hmac-sha256"];
    if (typeof header !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(header))
      return send(response, 401, { error: "invalid-signature" });
    const expected = createHmac("sha256", config.verificationToken).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(header, "base64")))
      return send(response, 401, { error: "invalid-signature" });
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return send(response, 400, { error: "invalid-json" });
    }
    if (normalizeId(payload?.context?.user?.id) !== config.accountId)
      return send(response, 403, { error: "account-not-allowed" });
    const taskId = normalizeId(payload?.action?.params?.sourceId);
    if (
      payload.extensionType !== "context-menu" ||
      payload.action?.actionType !== "initial" ||
      payload.action.params?.source !== "task" ||
      !taskId
    )
      return send(response, 400, { error: "task-context-required" });
    try {
      send(response, 200, await dispatch(createHash("sha256").update(body).digest("hex"), taskId));
    } catch {
      send(response, 503, { error: "bridge-unavailable" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (
    configIndex < 0 ||
    !args[configIndex + 1] ||
    args.some((arg, index) => index !== configIndex && index !== configIndex + 1 && arg !== "--check-config")
  ) {
    throw new Error("Bruk: node service.mjs --config /absolutt/privat/config.json [--check-config]");
  }
  const configPath = resolve(args[configIndex + 1]);
  const config = await readConfig(configPath);
  if (args.includes("--check-config")) {
    process.stdout.write("Konfigurasjonen er gyldig. Ingen tjeneste er startet.\n");
    return;
  }
  const server = await createFocusServer(config, { journalPath: `${configPath}.state.json` });
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolveListening);
  });
  process.stdout.write(`Fokus-koblingen lytter på 127.0.0.1:${config.port}.\n`);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not print configuration, incoming bodies, URLs or parser error excerpts.
    process.stderr.write(
      "Fokus-koblingen kunne ikke starte. Kontroller privat konfigurasjon, filrettigheter og port.\n",
    );
    process.exitCode = 1;
  });
}
