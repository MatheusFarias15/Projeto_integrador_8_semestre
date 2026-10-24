const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");

let child;
let baseUrl;
let temporaryDirectory;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glicsense-test-"));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIRECTORY: temporaryDirectory },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error("O servidor de teste encerrou antes de iniciar.");
    try {
      const response = await fetch(`${baseUrl}/api/summary`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("O servidor de teste não iniciou a tempo.");
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (temporaryDirectory && fs.existsSync(temporaryDirectory)) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  const dbPath = path.join(temporaryDirectory, "glicsense.sqlite");
  if (!fs.existsSync(dbPath)) return;
  const Database = require("better-sqlite3");
  const database = new Database(dbPath);
  database.exec("DELETE FROM measurements; DELETE FROM sessions; DELETE FROM patients;");
  database.close();
});

test("serve interface and initial summary", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /GlicSense/);
  assert.deepEqual((await request("/api/summary")).body, { sessions: 0, participants: 0, measurements: 0 });
});

test("create an isolated participant session and persist raw and processed measurements", async () => {
  const created = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ participantCode: "GS-001", ageRange: "30–39", sex: "F", notes: "Teste de bancada" }),
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.id;
  const measurement = await request(`/api/sessions/${sessionId}/measurements`, {
    method: "POST",
    body: JSON.stringify({ referenceMgDl: 94.25, optical: 0.482345, temperatureC: 32.55, force: 1.24 }),
  });
  assert.equal(measurement.status, 201);
  const readings = await request(`/api/sessions/${sessionId}/measurements`);
  assert.equal(readings.body.length, 1);
  assert.deepEqual(readings.body[0].raw, { referenceMgDl: 94.25, optical: 0.482345, temperatureC: 32.55, force: 1.24 });
  assert.deepEqual(readings.body[0].processed, { referenceMgDl: 94.25, optical: 0.4823, temperatureC: 32.55, force: 1.24 });
  assert.equal(readings.body[0].sessionId, sessionId);
  assert.equal((await request("/api/summary")).body.measurements, 1);
});

test("save only the glucose measurement without requiring sensor signals", async () => {
  const created = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ participantCode: "GS-ONLY" }),
  });
  const response = await request(`/api/sessions/${created.body.id}/measurements`, {
    method: "POST",
    body: JSON.stringify({ referenceMgDl: 95 }),
  });
  assert.equal(response.status, 201);
  const readings = await request(`/api/sessions/${created.body.id}/measurements`);
  assert.equal(readings.status, 200);
  assert.equal(readings.body[0].referenceMgDl, 95);
  assert.deepEqual(readings.body[0].raw, { referenceMgDl: 95 });
  assert.deepEqual(readings.body[0].processed, { referenceMgDl: 95 });
});

test("ignore empty sensor values from an older browser form", async () => {
  const created = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ participantCode: "GS-EMPTY-SENSORS" }),
  });
  const response = await request(`/api/sessions/${created.body.id}/measurements`, {
    method: "POST",
    body: JSON.stringify({ referenceMgDl: 100, optical: "", temperatureC: "", force: "" }),
  });
  assert.equal(response.status, 201);
  const readings = await request(`/api/sessions/${created.body.id}/measurements`);
  assert.deepEqual(readings.body[0].raw, { referenceMgDl: 100 });
});

test("reject invalid readings, unknown sessions, and measurements after closing", async () => {
  assert.equal((await request("/api/sessions/999/measurements")).status, 404);
  const created = await request("/api/sessions", { method: "POST", body: JSON.stringify({ participantCode: "GS-002" }) });
  const id = created.body.id;
  const invalid = await request(`/api/sessions/${id}/measurements`, {
    method: "POST",
    body: JSON.stringify({ referenceMgDl: 10, optical: 0.4, temperatureC: 30, force: 1 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await request(`/api/sessions/${id}`, { method: "PATCH" })).body.status, "closed");
  const closed = await request(`/api/sessions/${id}/measurements`, {
    method: "POST",
    body: JSON.stringify({ referenceMgDl: 100, optical: 0.4, temperatureC: 30, force: 1 }),
  });
  assert.equal(closed.status, 409);
});
