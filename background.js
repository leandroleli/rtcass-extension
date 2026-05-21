/**
 * RTCaaS - background.js (Manifest V3 service worker)
 *
 * The service worker cannot use chrome.tabCapture.capture() because that
 * method is foreground-only. In MV3 the durable path is:
 * 1. get a stream id with chrome.tabCapture.getMediaStreamId()
 * 2. pass it to an offscreen document
 * 3. let the offscreen document call getUserMedia() and MediaRecorder
 */

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

let creatingOffscreenDocument;
let state = {
  isCapturing: false,
  tabId: null,
};

chrome.action.onClicked.addListener((tab) => {
  if (state.isCapturing) {
    openSidePanel(tab.id);
    return;
  }

  if (!tab.id || !isCapturableUrl(tab.url)) {
    openSidePanel(tab.id);
    notifySidePanel({
      type: "ERROR",
      message: "Abra uma aba HTTPS normal, como Meet, Zoom ou Teams, antes de iniciar.",
    });
    return;
  }

  if (!chrome.tabCapture?.getMediaStreamId) {
    notifySidePanel({
      type: "ERROR",
      message: "chrome.tabCapture.getMediaStreamId nao esta disponivel neste Chrome.",
    });
    return;
  }

  const streamIdPromise = chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });
  const offscreenReadyPromise = setupOffscreenDocument();
  streamIdPromise.catch(() => {});
  offscreenReadyPromise.catch(() => {});
  openSidePanel(tab.id);

  startAudioCapture(tab.id, streamIdPromise, offscreenReadyPromise).catch((err) => {
    state.isCapturing = false;
    state.tabId = null;
    notifySidePanel({ type: "STATUS", isCapturing: false });
    notifySidePanel({ type: "ERROR", message: err.message });
  });
});

function openSidePanel(tabId) {
  if (!tabId) {
    return;
  }

  chrome.sidePanel.open({ tabId }).catch(() => {
    notifySidePanel({
      type: "ERROR",
      message: "Nao foi possivel abrir o painel lateral nesta aba.",
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "START_CAPTURE":
      sendResponse({
        success: false,
        error: "Para iniciar a captura, clique no icone da extensao na aba da chamada.",
      });
      return false;

    case "STOP_CAPTURE":
      stopAudioCapture()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case "GET_STATUS":
      sendResponse({
        isCapturing: state.isCapturing,
      });
      return false;

    case "SET_API_KEY":
      chrome.storage.local.set({ groqApiKey: message.apiKey });
      sendResponse({ success: true });
      return false;

    case "OFFSCREEN_STATUS":
      state.isCapturing = Boolean(message.isCapturing);
      if (!state.isCapturing) state.tabId = null;
      notifySidePanel({ type: "STATUS", isCapturing: state.isCapturing });
      return false;

    case "OFFSCREEN_EVENT":
      notifySidePanel(message.payload);
      return false;

    case "SAVE_TRANSCRIPT":
      saveTranscriptFile(message.payload)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          notifySidePanel({ type: "ERROR", message: err.message });
          sendResponse({ success: false, error: err.message });
        });
      return true;

    default:
      return false;
  }
});

async function startAudioCapture(tabId, streamIdOrPromise, offscreenReadyPromise) {
  if (state.isCapturing) {
    return;
  }

  if (!tabId) {
    throw new Error("Nenhuma aba ativa encontrada.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!isCapturableUrl(tab.url)) {
    throw new Error(
      "Esta aba nao pode ser capturada. Abra uma pagina HTTPS normal, como Meet, Zoom ou Teams, e clique no icone da extensao nessa aba."
    );
  }

  const config = await chrome.storage.local.get([
    "groqApiKey",
    "transcriptFolder",
    "userNiche",
    "userContext",
  ]);

  if (!config.groqApiKey) {
    throw new Error("Groq API Key nao configurada. Insira a chave no painel.");
  }

  let streamId = await streamIdOrPromise;
  if (!streamId) {
    if (!chrome.tabCapture?.getMediaStreamId) {
      throw new Error("chrome.tabCapture.getMediaStreamId nao esta disponivel neste Chrome.");
    }

    try {
      streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tabId,
      });
    } catch (error) {
      throw new Error(formatCapturePermissionError(error));
    }
  }

  if (offscreenReadyPromise) {
    await offscreenReadyPromise;
  } else {
    await setupOffscreenDocument();
  }

  config.meetingTitle = tab.title || "Reuniao";
  config.meetingUrl = tab.url || "";
  config.meetingStartedAt = new Date().toISOString();

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_RECORDING",
    streamId,
    config,
  });

  if (!response?.success) {
    throw new Error(response?.error || "Falha ao iniciar gravacao no offscreen.");
  }

  state.isCapturing = true;
  state.tabId = tabId;
  notifySidePanel({ type: "STATUS", isCapturing: true });
}

async function stopAudioCapture() {
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "STOP_RECORDING",
    });
  }

  state.isCapturing = false;
  state.tabId = null;
  notifySidePanel({ type: "STATUS", isCapturing: false });
}

async function setupOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capturar e processar o audio da aba ativa em segundo plano.",
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }

  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === offscreenUrl);
}

function notifySidePanel(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    // The side panel may be closed.
  });
}

function isCapturableUrl(url) {
  if (!url) {
    return false;
  }

  return /^https?:\/\//i.test(url);
}

function formatCapturePermissionError(error) {
  const message = error?.message || String(error);

  if (message.includes("Extension has not been invoked")) {
    return "A extensao ainda nao tem permissao para capturar esta aba. Va para a aba da chamada, clique no icone da extensao nessa mesma aba e entao clique em Iniciar Captura.";
  }

  if (message.includes("Chrome pages cannot be captured")) {
    return "Paginas internas do Chrome nao podem ser capturadas. Abra uma aba HTTPS normal, como Meet, Zoom ou Teams.";
  }

  return message;
}

async function saveTranscriptFile(payload) {
  if (!payload?.content?.trim()) {
    return;
  }

  const folder = normalizeDownloadFolder(payload.folder || "RTCaaS");
  const filename = `${folder}/${buildTranscriptFilename(payload)}.txt`;
  const url = buildTextDataUrl(payload.content);

  await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });

  notifySidePanel({
    type: "STATUS_TEXT",
    message: `Transcricao salva em Downloads/${filename}`,
  });
}

function buildTranscriptFilename(payload) {
  const startedAt = new Date(payload.startedAt || Date.now());
  const stamp = startedAt
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const title = sanitizePathPart(payload.title || "reuniao").slice(0, 80);

  return `${stamp}_${title}`;
}

function normalizeDownloadFolder(folder) {
  const normalized = String(folder || "RTCaaS")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => sanitizePathPart(part.trim()))
    .filter(Boolean)
    .join("/");

  return normalized || "RTCaaS";
}

function sanitizePathPart(value) {
  return String(value || "reuniao")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "") || "reuniao";
}

function buildTextDataUrl(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return `data:text/plain;charset=utf-8;base64,${btoa(binary)}`;
}
