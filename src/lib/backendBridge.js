const API_BASE =
  process.env.REACT_APP_API_BASE || "http://127.0.0.1:8420";

const WS_BASE = API_BASE.replace(/^http/i, "ws");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTauriRuntime = () =>
  Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

const normalizePaths = (selection) => {
  if (!selection) {
    return [];
  }

  if (Array.isArray(selection)) {
    return selection.filter(Boolean);
  }

  return [selection].filter(Boolean);
};

class BackendBridge {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.wsReconnectTimer = null;
    this.wsReady = false;
    this.healthPromise = null;
    this.connectWebSocket();
  }

  expose(handler, name) {
    this.handlers.set(name, handler);
  }

  emit(event, ...args) {
    const handler = this.handlers.get(event);
    if (typeof handler === "function") {
      handler(...args);
    }
  }

  async ensureBackendReady() {
    if (this.healthPromise) {
      return this.healthPromise;
    }

    this.healthPromise = (async () => {
      let lastError = null;

      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await fetch(`${API_BASE}/health`);
          if (response.ok) {
            return;
          }
          lastError = new Error(`Health check failed with ${response.status}`);
        } catch (error) {
          lastError = error;
        }
        await sleep(250);
      }

      throw lastError || new Error("Backend is unavailable.");
    })();

    try {
      await this.healthPromise;
    } finally {
      this.healthPromise = null;
    }
  }

  connectWebSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ensureBackendReady()
      .then(() => {
        this.ws = new WebSocket(`${WS_BASE}/ws`);
        this.ws.onopen = () => {
          this.wsReady = true;
        };
        this.ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            this.emit(payload.event, ...(payload.args || []));
          } catch (error) {
            console.error("Failed to parse backend event", error);
          }
        };
        this.ws.onclose = () => {
          this.wsReady = false;
          this.ws = null;
          window.clearTimeout(this.wsReconnectTimer);
          this.wsReconnectTimer = window.setTimeout(() => {
            this.connectWebSocket();
          }, 1000);
        };
        this.ws.onerror = () => {
          if (this.ws) {
            this.ws.close();
          }
        };
      })
      .catch((error) => {
        console.error("WebSocket connection failed", error);
        window.clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = window.setTimeout(() => {
          this.connectWebSocket();
        }, 1000);
      });
  }

  async request(path, options = {}) {
    await this.ensureBackendReady();

    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  callbackify(executor) {
    return (callback) =>
      executor().then((result) => {
        if (typeof callback === "function") {
          callback(result);
        }
        return result;
      });
  }

  get_classifiers() {
    return this.callbackify(() => this.request("/api/classifiers"));
  }

  get_projects() {
    return this.callbackify(() => this.request("/api/projects"));
  }

  add_project(title, description) {
    return this.callbackify(() =>
      this.request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ title, description }),
      })
    );
  }

  save_project(index, title, description) {
    return this.callbackify(() =>
      this.request(`/api/projects/${index}`, {
        method: "PUT",
        body: JSON.stringify({ title, description }),
      })
    );
  }

  remove_project(index) {
    return this.callbackify(() =>
      this.request(`/api/projects/${index}`, { method: "DELETE" })
    );
  }

  remove_recordings(projectIndex, indices) {
    return this.callbackify(() =>
      this.request(`/api/projects/${projectIndex}/recordings`, {
        method: "DELETE",
        body: JSON.stringify({ indices }),
      })
    );
  }

  async chooseRecordingPaths() {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return normalizePaths(
        await open({
          multiple: true,
          filters: [
            { name: "WAV files", extensions: ["wav", "WAV"] },
          ],
        })
      );
    }

    const fallback = window.prompt(
      "Enter one or more absolute recording paths, separated by commas."
    );
    return normalizePaths(
      fallback
        ? fallback
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    );
  }

  add_recordings(projectIndex) {
    return this.callbackify(async () => {
      const paths = await this.chooseRecordingPaths();
      if (paths.length === 0) {
        return { recordings_added: 0, metadata_files: 0, matched_recordings: 0 };
      }

      return this.request(`/api/projects/${projectIndex}/recordings`, {
        method: "POST",
        body: JSON.stringify({ paths }),
      });
    });
  }

  get_recording(projectIndex, recordingIndex) {
    return this.callbackify(async () => {
      const result = await this.request(
        `/api/projects/${projectIndex}/recordings/${recordingIndex}`
      );

      if (result === false) {
        return false;
      }

      this.emit("setRecording", result.spectrogram, result.waveData);
      return result.recording;
    });
  }

  classify_all(projectIndex, indices = null, start = null, end = null) {
    const payload = {};
    if (Array.isArray(indices) && indices.length > 0) {
      payload.indices = indices;
    }
    if (Number.isFinite(start) && Number.isFinite(end)) {
      payload.start = start;
      payload.end = end;
    }

    return this.callbackify(() =>
      this.request(`/api/projects/${projectIndex}/classify`, {
        method: "POST",
        ...(Object.keys(payload).length > 0
          ? { body: JSON.stringify(payload) }
          : {}),
      })
    );
  }

  classify(projectIndex, recordingIndex, start = null, end = null) {
    const payload =
      Number.isFinite(start) && Number.isFinite(end)
        ? { start, end }
        : null;

    return this.callbackify(() =>
      this.request(`/api/projects/${projectIndex}/recordings/${recordingIndex}/classify`, {
        method: "POST",
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      })
    );
  }

  async chooseExportPath(defaultName) {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return save({
        defaultPath: defaultName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
    }

    return window.prompt("Enter an absolute export path.", defaultName) || null;
  }

  export_csv(projectIndex, defaultName = "export.csv") {
    return this.callbackify(async () => {
      const path = await this.chooseExportPath(defaultName);
      if (!path) {
        return false;
      }

      return this.request(`/api/projects/${projectIndex}/export`, {
        method: "POST",
        body: JSON.stringify({ path }),
      });
    });
  }

  pause() {
    return this.request("/api/pause", { method: "POST" });
  }

  play(projectIndex, recordingIndex, start, end, expansionRate) {
    return this.request("/api/play", {
      method: "POST",
      body: JSON.stringify({
        projectIndex,
        recordingIndex,
        start,
        end,
        expansionRate,
      }),
    });
  }

  get_chunk(projectIndex, recordingIndex, start, end = 0) {
    const params = new URLSearchParams({
      start: String(start),
      end: String(end),
    });

    return this.callbackify(() =>
      this.request(
        `/api/projects/${projectIndex}/recordings/${recordingIndex}/chunk?${params.toString()}`
      )
    );
  }

  set_classifier(projectIndex, classifierKey) {
    return this.request(`/api/projects/${projectIndex}/classifier`, {
      method: "POST",
      body: JSON.stringify({ classifierKey }),
    });
  }

  set_processing_mode(projectIndex, value) {
    return this.request(`/api/projects/${projectIndex}/processing-mode`, {
      method: "POST",
      body: JSON.stringify({ value }),
    });
  }

  set_species(projectIndex, recordingIndex, species) {
    return this.callbackify(() =>
      this.request(`/api/projects/${projectIndex}/recordings/${recordingIndex}/species`, {
        method: "POST",
        body: JSON.stringify({ species }),
      })
    );
  }
}

export const backend = new BackendBridge();
window.openechoBackend = backend;
