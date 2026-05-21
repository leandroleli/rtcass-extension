const els = {
  captureBtn: document.getElementById("captureBtn"),
  clearBtn: document.getElementById("clearBtn"),
  statusPill: document.getElementById("statusPill"),
  statusLabel: document.getElementById("statusLabel"),
  statusBarText: document.getElementById("statusBarText"),
  insightBadge: document.getElementById("insightBadge"),
  insightsEmpty: document.getElementById("insightsEmpty"),
  insightPanel: document.getElementById("panel-insights"),
  transcriptFeed: document.getElementById("transcriptFeed"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  nicheSelect: document.getElementById("nicheSelect"),
  contextInput: document.getElementById("contextInput"),
  saveConfigBtn: document.getElementById("saveConfigBtn"),
};

let appState = {
  isCapturing: false,
  insightCount: 0,
  transcriptLines: 0,
  MAX_TRANSCRIPT_LINES: 60,
  MAX_INSIGHT_CARDS: 30,
};

init();

async function init() {
  await loadSavedConfig();
  await syncStatusWithBackground();
  bindEventListeners();
  listenToBackground();
}

async function loadSavedConfig() {
  const data = await chrome.storage.local.get([
    "groqApiKey",
    "userNiche",
    "userContext",
  ]);

  if (data.groqApiKey) els.apiKeyInput.value = data.groqApiKey;
  if (data.userNiche) els.nicheSelect.value = data.userNiche;
  if (data.userContext) els.contextInput.value = data.userContext;
}

async function syncStatusWithBackground() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    setCapturingState(Boolean(response?.isCapturing));
  } catch {
    setCapturingState(false);
  }
}

function bindEventListeners() {
  els.captureBtn.addEventListener("click", handleCaptureToggle);
  els.clearBtn.addEventListener("click", clearAll);
  els.saveConfigBtn.addEventListener("click", saveConfig);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

async function handleCaptureToggle() {
  const { groqApiKey } = await chrome.storage.local.get("groqApiKey");

  if (!groqApiKey) {
    switchTab("setup");
    showAlert("Configure a API Key da Groq antes de iniciar.", "error");
    return;
  }

  if (appState.isCapturing) {
    await stopCapture();
  } else {
    await startCapture();
  }
}

async function startCapture() {
  showAlert("Para iniciar a captura, clique no icone da extensao na aba da chamada.", "error");
  setStatusText("Aguardando clique no icone da extensao", false);
}

async function stopCapture() {
  els.captureBtn.disabled = true;
  setStatusText("Encerrando captura...", true);

  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    if (!response?.success) {
      throw new Error(response?.error || "Falha ao encerrar captura.");
    }
  } catch (err) {
    showAlert(err.message, "error");
  } finally {
    setCapturingState(false);
    els.captureBtn.disabled = false;
  }
}

async function saveConfig() {
  const apiKey = els.apiKeyInput.value.trim();
  const niche = els.nicheSelect.value;
  const context = els.contextInput.value.trim();

  if (!apiKey) {
    showAlert("Insira uma API Key valida.", "error");
    return;
  }

  await chrome.storage.local.set({
    groqApiKey: apiKey,
    userNiche: niche,
    userContext: context,
  });

  await chrome.runtime.sendMessage({ type: "SET_API_KEY", apiKey });

  els.saveConfigBtn.textContent = "Salvo!";
  setTimeout(() => {
    els.saveConfigBtn.textContent = "Salvar Configuracao";
  }, 1500);
}

function listenToBackground() {
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case "INSIGHT":
        renderInsightCard(message);
        break;

      case "TRANSCRIPTION":
        renderTranscriptionLine(message.text);
        break;

      case "STATUS":
        setCapturingState(message.isCapturing);
        break;

      case "STATUS_TEXT":
        setStatusText(message.message, true);
        break;

      case "ERROR":
        showAlert(message.message, "error");
        setStatusText("Erro no pipeline", false);
        break;
    }
  });
}

function renderInsightCard({ text, timestamp }) {
  if (els.insightsEmpty) {
    els.insightsEmpty.style.display = "none";
  }

  appState.insightCount += 1;
  els.insightBadge.textContent = appState.insightCount;

  const card = document.createElement("div");
  card.className = "insight-card new";

  const header = document.createElement("div");
  header.className = "card-header";

  const label = document.createElement("span");
  label.className = "card-label";
  label.textContent = `Insight #${appState.insightCount}`;

  const time = document.createElement("span");
  time.className = "card-time";
  time.textContent = timestamp || "";

  header.append(label, time);

  const body = document.createElement("div");
  body.className = "card-body";
  body.appendChild(formatInsightText(text));

  card.append(header, body);

  const firstCard = els.insightPanel.querySelector(".insight-card");
  if (firstCard) {
    els.insightPanel.insertBefore(card, firstCard);
  } else {
    els.insightPanel.appendChild(card);
  }

  setTimeout(() => card.classList.remove("new"), 2000);

  const cards = els.insightPanel.querySelectorAll(".insight-card");
  if (cards.length > appState.MAX_INSIGHT_CARDS) {
    cards[cards.length - 1].remove();
  }

  setStatusText(`Ultimo insight: ${timestamp || "agora"}`, false);
}

function formatInsightText(rawText) {
  const fragment = document.createDocumentFragment();

  rawText.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const lineEl = document.createElement("div");
    lineEl.className = "bullet-line";

    if (/^[-*]\s*/.test(trimmed)) {
      const marker = document.createElement("span");
      marker.className = "bullet-marker";
      marker.textContent = "*";

      const content = document.createElement("span");
      content.textContent = trimmed.replace(/^[-*]\s*/, "");

      lineEl.append(marker, content);
    } else {
      lineEl.textContent = trimmed;
    }

    fragment.appendChild(lineEl);
  });

  return fragment;
}

function renderTranscriptionLine(text) {
  const emptyState = els.transcriptFeed.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const line = document.createElement("div");
  line.className = "transcript-line";
  line.textContent = text;

  els.transcriptFeed.insertBefore(line, els.transcriptFeed.firstChild);

  appState.transcriptLines += 1;
  if (appState.transcriptLines > appState.MAX_TRANSCRIPT_LINES) {
    els.transcriptFeed.lastChild?.remove();
    appState.transcriptLines -= 1;
  }
}

function setCapturingState(isCapturing) {
  appState.isCapturing = Boolean(isCapturing);

  if (appState.isCapturing) {
    els.statusPill.classList.add("active");
    els.statusLabel.textContent = "Ao Vivo";
    els.captureBtn.textContent = "Parar";
    els.captureBtn.classList.add("active");
    setStatusText("Escutando chamada...", false);
  } else {
    els.statusPill.classList.remove("active");
    els.statusLabel.textContent = "Inativo";
    els.captureBtn.textContent = "Iniciar Captura";
    els.captureBtn.classList.remove("active");
    setStatusText("Captura encerrada", false);
  }
}

function setStatusText(text, isProcessing = false) {
  els.statusBarText.textContent = text;
  els.statusBarText.className = "status-text" + (isProcessing ? " processing" : "");
}

function showAlert(message, type = "error") {
  const alert = document.createElement("div");
  alert.className = `alert alert-${type}`;
  alert.textContent = message;

  els.insightPanel.insertBefore(alert, els.insightPanel.firstChild);
  setTimeout(() => alert.remove(), 5000);
}

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tabName}`);
  });
}

function clearAll() {
  const cards = els.insightPanel.querySelectorAll(".insight-card, .alert");
  cards.forEach((card) => card.remove());

  if (els.insightsEmpty) {
    els.insightsEmpty.style.display = "";
  }

  els.transcriptFeed.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">...</div>
      <div class="empty-text">Aguardando audio...</div>
    </div>
  `;

  appState.insightCount = 0;
  appState.transcriptLines = 0;
  els.insightBadge.textContent = "0";
}
