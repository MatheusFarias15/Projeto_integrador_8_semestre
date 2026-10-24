const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIRECTORY = process.env.DATA_DIRECTORY || path.join(__dirname, "data");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
const database = new Database(path.join(DATA_DIRECTORY, "glicsense.sqlite"));
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(fs.readFileSync(path.join(__dirname, "database", "schema.sql"), "utf8"));

const statements = {
  findPatient: database.prepare("SELECT id, participant_code, age_range, sex FROM patients WHERE participant_code = ?"),
  insertPatient: database.prepare("INSERT INTO patients (participant_code, age_range, sex) VALUES (@participantCode, @ageRange, @sex)"),
  updatePatient: database.prepare("UPDATE patients SET age_range = @ageRange, sex = @sex WHERE id = @id"),
  createSession: database.prepare("INSERT INTO sessions (patient_id, notes) VALUES (@patientId, @notes)"),
  getSession: database.prepare(`
    SELECT s.id, s.patient_id AS patientId, p.participant_code AS participantCode,
      s.started_at AS startedAt, s.ended_at AS endedAt, s.status, s.notes
    FROM sessions s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?
  `),
  listSessions: database.prepare(`
    SELECT s.id, p.participant_code AS participantCode, s.started_at AS startedAt,
      s.ended_at AS endedAt, s.status, s.notes, COUNT(m.id) AS measurementCount
    FROM sessions s JOIN patients p ON p.id = s.patient_id
    LEFT JOIN measurements m ON m.session_id = s.id
    GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC LIMIT 100
  `),
  listMeasurements: database.prepare(`
    SELECT id, session_id AS sessionId, reference_mg_dl AS referenceMgDl,
      raw_data AS rawData, processed_data AS processedData, created_at AS createdAt
    FROM measurements WHERE session_id = ? ORDER BY id ASC
  `),
  insertMeasurement: database.prepare(`
    INSERT INTO measurements (session_id, reference_mg_dl, raw_data, processed_data)
    VALUES (@sessionId, @referenceMgDl, @rawData, @processedData)
  `),
  closeSession: database.prepare("UPDATE sessions SET status = 'closed', ended_at = datetime('now') WHERE id = ? AND status = 'open'"),
  counts: database.prepare(`
    SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM patients) AS participants,
      (SELECT COUNT(*) FROM measurements) AS measurements
  `),
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(new Error("O corpo da requisição excede o limite de 16 KB."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("O corpo da requisição deve ser um JSON válido."));
      }
    });
    request.on("error", reject);
  });
}

function validateSession(body) {
  const participantCode = typeof body.participantCode === "string" ? body.participantCode.trim() : "";
  const ageRange = body.ageRange === "" || body.ageRange == null ? null : body.ageRange;
  const sex = body.sex === "" || body.sex == null ? null : body.sex;
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  const validAgeRanges = ["18–29", "30–39", "40–49", "50–59", "60+"];
  const validSexValues = ["F", "M", "other"];
  if (!participantCode || participantCode.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(participantCode)) {
    return "Informe um código de participante válido (até 40 letras, números, pontos, traços ou sublinhados).";
  }
  if (ageRange !== null && !validAgeRanges.includes(ageRange)) return "A faixa etária informada não é válida.";
  if (sex !== null && !validSexValues.includes(sex)) return "A opção de sexo biológico informada não é válida.";
  if (notes.length > 500) return "As observações devem ter no máximo 500 caracteres.";
  return null;
}

function validateMeasurement(body) {
  if (typeof body.referenceMgDl !== "number" || !Number.isFinite(body.referenceMgDl)) {
    return "A medição da glicose precisa ser um número válido.";
  }
  if (body.referenceMgDl < 20 || body.referenceMgDl > 600) return "A glicemia de referência deve estar entre 20 e 600 mg/dL.";
  for (const key of ["optical", "temperatureC", "force"]) {
    if (body[key] != null && body[key] !== "" && (typeof body[key] !== "number" || !Number.isFinite(body[key]))) {
      return `O campo ${key} precisa ser um número válido.`;
    }
  }
  if (body.temperatureC != null && body.temperatureC !== "" && (body.temperatureC < -20 || body.temperatureC > 100)) return "A temperatura deve estar entre -20 °C e 100 °C.";
  if (body.force != null && body.force !== "" && body.force < 0) return "A força não pode ser negativa.";
  return null;
}

function mapMeasurement(row) {
  const raw = JSON.parse(row.rawData);
  const processed = JSON.parse(row.processedData);
  return {
    id: row.id,
    sessionId: row.sessionId,
    referenceMgDl: row.referenceMgDl,
    optical: processed.optical,
    temperatureC: processed.temperatureC,
    force: processed.force,
    raw,
    processed,
    createdAt: row.createdAt,
  };
}

const createSession = database.transaction((body) => {
  let patient = statements.findPatient.get(body.participantCode);
  if (patient) {
    statements.updatePatient.run({
      id: patient.id,
      ageRange: body.ageRange ?? patient.age_range,
      sex: body.sex ?? patient.sex,
    });
    patient = statements.findPatient.get(body.participantCode);
  } else {
    const result = statements.insertPatient.run({
      participantCode: body.participantCode,
      ageRange: body.ageRange,
      sex: body.sex,
    });
    patient = { id: Number(result.lastInsertRowid), participant_code: body.participantCode };
  }
  const result = statements.createSession.run({ patientId: patient.id, notes: body.notes || null });
  return statements.getSession.get(Number(result.lastInsertRowid));
});

function serveStatic(urlPath, response) {
  const file = STATIC_FILES.get(urlPath);
  if (!file) return false;
  const [filename, contentType] = file;
  fs.readFile(path.join(__dirname, filename), (error, data) => {
    if (error) {
      json(response, 500, { error: "Não foi possível carregar a interface." });
      return;
    }
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    response.end(data);
  });
  return true;
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const { pathname } = url;
  if (request.method === "GET" && serveStatic(pathname, response)) return;
  if (pathname.startsWith("/api/")) {
    try {
      if (request.method === "GET" && pathname === "/api/summary") {
        json(response, 200, statements.counts.get());
        return;
      }
      if (request.method === "GET" && pathname === "/api/sessions") {
        json(response, 200, statements.listSessions.all());
        return;
      }
      if (request.method === "POST" && pathname === "/api/sessions") {
        const body = await readBody(request);
        const validationError = validateSession(body);
        if (validationError) return json(response, 400, { error: validationError });
        json(response, 201, createSession(body));
        return;
      }
      const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)$/);
      if (sessionMatch) {
        const sessionId = Number(sessionMatch[1]);
        const session = statements.getSession.get(sessionId);
        if (!session) return json(response, 404, { error: "Sessão não encontrada." });
        if (request.method === "GET") {
          json(response, 200, session);
          return;
        }
        if (request.method === "PATCH") {
          if (session.status === "open") statements.closeSession.run(sessionId);
          json(response, 200, statements.getSession.get(sessionId));
          return;
        }
      }
      const measurementsMatch = pathname.match(/^\/api\/sessions\/(\d+)\/measurements$/);
      if (measurementsMatch) {
        const sessionId = Number(measurementsMatch[1]);
        const session = statements.getSession.get(sessionId);
        if (!session) return json(response, 404, { error: "Sessão não encontrada." });
        if (request.method === "GET") {
          json(response, 200, statements.listMeasurements.all(sessionId).map(mapMeasurement));
          return;
        }
        if (request.method === "POST") {
          if (session.status !== "open") return json(response, 409, { error: "Não é possível adicionar medições a uma sessão encerrada." });
          const body = await readBody(request);
          const validationError = validateMeasurement(body);
          if (validationError) return json(response, 400, { error: validationError });
          const raw = Object.fromEntries(
            ["referenceMgDl", "optical", "temperatureC", "force"]
              .filter((key) => body[key] !== undefined && body[key] !== null && body[key] !== "")
              .map((key) => [key, body[key]]),
          );
          const processed = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value.toFixed(4))]));
          const result = statements.insertMeasurement.run({
            sessionId,
            referenceMgDl: processed.referenceMgDl,
            rawData: JSON.stringify(raw),
            processedData: JSON.stringify(processed),
          });
          json(response, 201, { id: Number(result.lastInsertRowid), sessionId });
          return;
        }
      }
      json(response, 404, { error: "Rota da API não encontrada." });
      return;
    } catch (error) {
      if (error instanceof SyntaxError || error.message.includes("corpo da requisição")) {
        json(response, 400, { error: error.message });
        return;
      }
      console.error("Falha ao processar requisição:", error);
      json(response, 500, { error: "Erro interno ao processar os dados." });
      return;
    }
  }
  json(response, 404, { error: "Página não encontrada." });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error("Falha inesperada no servidor:", error);
    if (!response.headersSent) json(response, 500, { error: "Erro interno do servidor." });
    else response.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`GlicSense disponível em http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
