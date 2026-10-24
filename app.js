const api = {
  async request(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a operação.");
    return payload;
  },
};

const elements = {
  startForm: document.querySelector("#start-session-form"),
  measurementForm: document.querySelector("#measurement-form"),
  activePanel: document.querySelector("#active-session-panel"),
  activeTitle: document.querySelector("#active-session-title"),
  activeSubtitle: document.querySelector("#active-session-subtitle"),
  measurementList: document.querySelector("#measurement-list"),
  sessionsBody: document.querySelector("#sessions-table-body"),
  toast: document.querySelector("#toast"),
  dialog: document.querySelector("#session-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
};

let activeSession = null;
let toastTimer;

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function initials(code) {
  return escapeHtml(code.slice(0, 2).toUpperCase());
}

async function refreshDashboard() {
  const [summary, sessions] = await Promise.all([
    api.request("/summary"),
    api.request("/sessions"),
  ]);
  document.querySelector("#stat-sessions").textContent = summary.sessions;
  document.querySelector("#stat-participants").textContent = summary.participants;
  document.querySelector("#stat-measurements").textContent = summary.measurements;
  document.querySelector("#session-count-label").textContent = `${summary.sessions} ${summary.sessions === 1 ? "sessão" : "sessões"}`;

  if (sessions.length === 0) {
    elements.sessionsBody.innerHTML = '<tr><td class="empty-cell" colspan="5">Nenhuma sessão registrada. Inicie uma coleta para vê-la aqui.</td></tr>';
    return;
  }
  elements.sessionsBody.innerHTML = sessions.map((session) => `
    <tr>
      <td><span class="participant-cell"><span class="participant-avatar">${initials(session.participantCode)}</span>${escapeHtml(session.participantCode)}</span></td>
      <td>${formatDate(session.startedAt)}</td>
      <td>${session.measurementCount} ${session.measurementCount === 1 ? "leitura" : "leituras"}</td>
      <td><span class="status ${session.status === "open" ? "status-open" : "status-closed"}">${session.status === "open" ? "Em andamento" : "Encerrada"}</span></td>
      <td><button class="table-action" type="button" data-session-id="${session.id}">Detalhes</button></td>
    </tr>`).join("");
}

function renderMeasurements(measurements) {
  if (!measurements.length) {
    elements.measurementList.innerHTML = '<p class="table-loading">Nenhuma medição salva nesta sessão ainda.</p>';
    return;
  }
  elements.measurementList.innerHTML = measurements.map((measurement, index) => `
    <div class="measurement-row">
      <strong>Leitura ${index + 1}</strong>
      <span>Glicose: ${escapeHtml(String(measurement.referenceMgDl))} mg/dL</span>
    </div>`).join("");
}

function setActiveSession(session, measurements = []) {
  activeSession = session;
  elements.activeTitle.textContent = `Participante ${session.participantCode}`;
  elements.activeSubtitle.textContent = `Sessão iniciada em ${formatDate(session.startedAt)} · Código ${session.participantCode}`;
  elements.activePanel.classList.remove("hidden");
  elements.measurementForm.classList.toggle("hidden", session.status !== "open");
  document.querySelector("#close-session-button").classList.toggle("hidden", session.status !== "open");
  renderMeasurements(measurements);
  elements.activePanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

elements.startForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.startForm);
  const participantCode = String(form.get("participantCode")).trim();
  if (!participantCode) {
    showToast("Informe um código de participante.", true);
    return;
  }
  try {
    const session = await api.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        participantCode,
        ageRange: form.get("ageRange"),
        sex: form.get("sex"),
        notes: form.get("notes"),
      }),
    });
    setActiveSession(session);
    elements.startForm.reset();
    await refreshDashboard();
    showToast(`Sessão aberta para ${session.participantCode}.`);
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.measurementForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeSession || activeSession.status !== "open") return;
  const form = new FormData(elements.measurementForm);
  const measurement = { referenceMgDl: Number(form.get("referenceMgDl")) };
  try {
    const saved = await api.request(`/sessions/${activeSession.id}/measurements`, {
      method: "POST",
      body: JSON.stringify(measurement),
    });
    const measurements = await api.request(`/sessions/${activeSession.id}/measurements`);
    renderMeasurements(measurements);
    elements.measurementForm.reset();
    await refreshDashboard();
    showToast(`Medição ${saved.id} salva com sucesso.`);
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector("#close-session-button").addEventListener("click", async () => {
  if (!activeSession) return;
  try {
    const closed = await api.request(`/sessions/${activeSession.id}`, { method: "PATCH" });
    activeSession = closed;
    setActiveSession(closed, await api.request(`/sessions/${closed.id}/measurements`));
    await refreshDashboard();
    showToast("Sessão encerrada.");
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.sessionsBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-session-id]");
  if (!button) return;
  try {
    const session = await api.request(`/sessions/${button.dataset.sessionId}`);
    const measurements = await api.request(`/sessions/${session.id}/measurements`);
    elements.dialogContent.innerHTML = `
      <span class="section-kicker">DETALHES DA COLETA</span>
      <h2 class="dialog-title">Participante ${escapeHtml(session.participantCode)}</h2>
      <p class="dialog-meta">${formatDate(session.startedAt)} · ${session.status === "open" ? "Em andamento" : "Encerrada"}${session.notes ? ` · ${escapeHtml(session.notes)}` : ""}</p>
      <div class="dialog-measurements">${measurements.length ? measurements.map((item, index) => `
        <div class="measurement-row">
          <strong>Leitura ${index + 1}</strong>
          <span>Glicose: ${escapeHtml(String(item.referenceMgDl))} mg/dL</span>
        </div>`).join("") : '<p class="table-loading">Esta sessão ainda não tem medições.</p>'}</div>`;
    elements.dialog.showModal();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector(".dialog-close").addEventListener("click", () => elements.dialog.close());

document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

refreshDashboard().catch((error) => {
  elements.sessionsBody.innerHTML = `<tr><td class="empty-cell" colspan="5">${escapeHtml(error.message)}</td></tr>`;
  showToast("Não foi possível carregar os dados. Verifique se o backend está ativo.", true);
});
