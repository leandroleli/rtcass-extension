const CONFIG = {
  CHUNK_INTERVAL_MS: 3000,
  STT_MODEL: "whisper-large-v3-turbo",
  LLM_MODEL: "llama-3.1-8b-instant",
  GROQ_STT_URL: "https://api.groq.com/openai/v1/audio/transcriptions",
  GROQ_CHAT_URL: "https://api.groq.com/openai/v1/chat/completions",
  INSIGHT_TRIGGER_LENGTH: 280,
};

let state = {
  isCapturing: false,
  mediaRecorder: null,
  audioStream: null,
  audioContext: null,
  segmentTimer: null,
  transcriptionBuffer: "",
  lastInsightAt: 0,
  insightThrottle: 8000,
  processingQueue: Promise.resolve(),
  config: null,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }

  switch (message.type) {
    case "START_RECORDING":
      startRecording(message.streamId, message.config)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          notifyExtension({ type: "ERROR", message: err.message });
          notifyStatus(false);
          sendResponse({ success: false, error: err.message });
        });
      return true;

    case "STOP_RECORDING":
      stopRecording();
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

async function startRecording(streamId, config) {
  if (state.isCapturing) {
    return;
  }

  if (!streamId) {
    throw new Error("Stream ID da aba nao foi gerado.");
  }

  try {
    state.config = config;
    state.transcriptionBuffer = "";
    state.lastInsightAt = 0;
    state.processingQueue = Promise.resolve();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    state.audioStream = stream;

    // Without this, Chrome may stop playing the captured tab audio locally.
    const output = new AudioContext();
    const source = output.createMediaStreamSource(stream);
    source.connect(output.destination);
    state.audioContext = output;

    state.isCapturing = true;
    startSegmentRecorder();
    notifyStatus(true);
  } catch (error) {
    cleanupRecordingState();
    throw error;
  }
}

function stopRecording() {
  cleanupRecordingState();

  notifyStatus(false);
}

function cleanupRecordingState() {
  if (state.segmentTimer) {
    clearTimeout(state.segmentTimer);
  }

  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }

  if (state.audioStream) {
    state.audioStream.getTracks().forEach((track) => track.stop());
  }

  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
  }

  state.isCapturing = false;
  state.mediaRecorder = null;
  state.audioStream = null;
  state.audioContext = null;
  state.segmentTimer = null;
  state.transcriptionBuffer = "";
  state.config = null;
  state.processingQueue = Promise.resolve();
}

function startSegmentRecorder() {
  if (!state.isCapturing || !state.audioStream) {
    return;
  }

  const chunks = [];
  const options = pickRecorderOptions();
  const recorder = new MediaRecorder(state.audioStream, options);
  state.mediaRecorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder.onerror = (event) => {
    notifyExtension({
      type: "ERROR",
      message: event.error?.message || "Erro no recorder de audio.",
    });
  };

  recorder.onstop = () => {
    if (!state.isCapturing) {
      return;
    }

    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    if (blob.size > 4000) {
      state.processingQueue = state.processingQueue
        .then(() => processAudioChunk(blob))
        .catch((error) => {
          notifyExtension({ type: "ERROR", message: error.message });
        });
    }

    startSegmentRecorder();
  };

  recorder.start();
  state.segmentTimer = setTimeout(() => {
    if (recorder.state === "recording") {
      recorder.stop();
    }
  }, CONFIG.CHUNK_INTERVAL_MS);
}

function pickRecorderOptions() {
  const mimeType = "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported(mimeType)) {
    return { mimeType, audioBitsPerSecond: 32000 };
  }
  return { audioBitsPerSecond: 32000 };
}

async function processAudioChunk(audioBlob) {
  try {
    if (!state.isCapturing || !state.config?.groqApiKey) {
      return;
    }

    notifyExtension({ type: "STATUS_TEXT", message: "Transcrevendo..." });
    const transcription = await transcribeChunk(audioBlob);

    if (!transcription || transcription.length < 10) {
      return;
    }

    notifyExtension({ type: "TRANSCRIPTION", text: transcription });
    state.transcriptionBuffer += " " + transcription;

    if (state.transcriptionBuffer.length > 800) {
      state.transcriptionBuffer = state.transcriptionBuffer.slice(-800);
    }

    const now = Date.now();
    const bufferReady = state.transcriptionBuffer.length >= CONFIG.INSIGHT_TRIGGER_LENGTH;
    const throttleOk = now - state.lastInsightAt > state.insightThrottle;

    if (bufferReady && throttleOk) {
      state.lastInsightAt = now;
      notifyExtension({ type: "STATUS_TEXT", message: "Gerando insight..." });
      const insight = await generateInsight(state.transcriptionBuffer);

      if (insight && insight !== "AGUARDANDO_CONTEXTO") {
        notifyExtension({
          type: "INSIGHT",
          text: insight,
          timestamp: new Date().toLocaleTimeString("pt-BR"),
        });
        notifyExtension({ type: "STATUS_TEXT", message: "Escutando chamada..." });
      }
    }
  } catch (error) {
    notifyExtension({ type: "ERROR", message: error.message });
  }
}

async function transcribeChunk(audioBlob) {
  const formData = new FormData();
  formData.append("file", audioBlob, "chunk.webm");
  formData.append("model", CONFIG.STT_MODEL);
  formData.append("language", "pt");
  formData.append("response_format", "json");

  const response = await fetch(CONFIG.GROQ_STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.config.groqApiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 400 && isInvalidMediaError(err)) {
      return "";
    }
    throw new Error(`STT API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.text?.trim() || "";
}

async function generateInsight(transcription) {
  const systemPrompt = buildSystemPrompt(
    state.config.userNiche,
    state.config.userContext
  );

  const response = await fetch(CONFIG.GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.config.groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CONFIG.LLM_MODEL,
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `TRANSCRICAO DOS ULTIMOS 30 SEGUNDOS:\n"${transcription}"\n\nGere os insights agora.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function buildSystemPrompt(niche, userContext) {
  const nicheInstructions = {
    vendas: `Voce e um coach de vendas expert. Analise a conversa e identifique:
- Objecoes do cliente nao verbalizadas
- Sinais de interesse ou hesitacao
- Proxima pergunta de qualificacao ideal
- Argumento de fechamento mais adequado`,

    juridico: `Voce e um assistente juridico especializado. Analise a conversa e identifique:
- Conceitos legais relevantes mencionados
- Riscos ou brechas contratuais discutidos
- Precedentes ou jurisprudencias aplicaveis
- Perguntas criticas que o advogado deve fazer`,

    medico: `Voce e um assistente clinico. Analise a conversa e identifique:
- Sintomas mencionados e possiveis correlacoes
- Exames ou protocolos sugeridos pelas diretrizes
- Interacoes medicamentosas a verificar
- Perguntas de anamnese nao realizadas`,

    default: `Voce e um assistente estrategico em tempo real. Analise a conversa e identifique:
- O ponto mais critico sendo discutido agora
- O que esta sendo ignorado ou subestimado
- A melhor proxima acao ou pergunta`,
  };

  const nicheGuide = nicheInstructions[niche] || nicheInstructions.default;

  return `${nicheGuide}

FORMATO DE RESPOSTA OBRIGATORIO - siga exatamente:
* [INSIGHT PRINCIPAL em 1 frase direta]
* [ACAO IMEDIATA recomendada]
* [ALERTA ou ponto de atencao, se houver]

REGRAS:
- Maximo 3 bullet points
- Cada bullet: maximo 15 palavras
- Sem introducoes, sem "baseado na conversa", sem rodeios
- Se nao ha insight relevante, responda apenas: AGUARDANDO_CONTEXTO
${userContext ? `\nCONTEXTO DO PROFISSIONAL:\n${userContext}` : ""}`;
}

function notifyExtension(payload) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_EVENT",
    payload,
  }).catch(() => {});
}

function notifyStatus(isCapturing) {
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_STATUS",
    isCapturing,
  }).catch(() => {});
}

function isInvalidMediaError(errorText) {
  return (
    errorText.includes("invalid_media_file") ||
    errorText.includes("could not process file")
  );
}
