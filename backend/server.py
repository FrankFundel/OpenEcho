from contextlib import asynccontextmanager
from datetime import datetime
import asyncio
import csv
import os
import platform
import subprocess
import tempfile
import threading
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import simpleaudio as sa
import soundfile as sf

from backend.audio_processing import (
  FRAME_STEP,
  prepare_playback_audio,
  load_recording_preview,
  load_spectrogram_chunk,
)
from backend.classifier_service import ClassifierService
from backend.inference.bacpipe_provider import get_bacpipe_classifiers
from backend.metadata_loader import apply_metadata_file, auto_apply_metadata
from backend.project_store import (
  DEFAULT_CLASSIFIER_KEY,
  load_projects as load_project_data,
  load_recording_classification as load_recording_classification_data,
  save_projects as save_project_data,
)


class EventBroker:
  def __init__(self):
    self._connections = set()
    self._lock = threading.Lock()
    self._loop = None

  def attach_loop(self, loop):
    self._loop = loop

  async def connect(self, websocket):
    await websocket.accept()
    with self._lock:
      self._connections.add(websocket)

  def disconnect(self, websocket):
    with self._lock:
      self._connections.discard(websocket)

  async def _broadcast(self, message):
    with self._lock:
      connections = list(self._connections)

    stale_connections = []
    for websocket in connections:
      try:
        await websocket.send_json(message)
      except Exception:
        stale_connections.append(websocket)

    if stale_connections:
      with self._lock:
        for websocket in stale_connections:
          self._connections.discard(websocket)

  def emit(self, event, *args):
    if self._loop is None:
      return

    asyncio.run_coroutine_threadsafe(
      self._broadcast({"event": event, "args": list(args)}),
      self._loop,
    )


state_lock = threading.RLock()
event_broker = EventBroker()
classifiers = []
projects = []
classifier_service = ClassifierService()
playback = None
playback_token = 0
playback_lock = threading.Lock()
play_request_id = 0
playback_wave_object = None
playback_process = None
playback_temp_path = None


class ProjectPayload(BaseModel):
  title: str
  description: str


class PathsPayload(BaseModel):
  paths: list[str]


class IndicesPayload(BaseModel):
  indices: list[int]


class SpeciesPayload(BaseModel):
  species: str


class ClassifierPayload(BaseModel):
  classifierKey: str


class ProcessingModePayload(BaseModel):
  value: str


class ClassificationPayload(BaseModel):
  start: int | None = None
  end: int | None = None


class ClassifyAllPayload(BaseModel):
  indices: list[int] | None = None
  start: int | None = None
  end: int | None = None


class ExportPayload(BaseModel):
  path: str


class PlaybackPayload(BaseModel):
  projectIndex: int
  recordingIndex: int
  start: int
  end: int
  expansionRate: float = 10.0


def build_recording_entry(path):
  return {
    "title": os.path.basename(path),
    "path": path,
    "date": os.path.getctime(path) * 1000,
    "location": {
      "latitude": 0,
      "longitude": 0,
    },
    "size": os.path.getsize(path),
  }


def save_projects():
  with state_lock:
    save_project_data(projects)


def load_projects():
  global projects
  with state_lock:
    projects = load_project_data()


def find_classifier(classifier_key):
  if not classifier_key:
    return None

  for classifier_config in classifiers:
    if classifier_config.get("key") == classifier_key:
      return classifier_config

  return None


def public_recording_payload(recording):
  public_recording = dict(recording)
  public_recording.pop("_classification_path", None)
  if not isinstance(public_recording.get("classification"), dict):
    public_recording.pop("classification", None)
  return public_recording


def public_project_payload(project):
  public_project = dict(project)
  public_project["recordings"] = [
    public_recording_payload(recording)
    for recording in project.get("recordings") or []
  ]
  return public_project


def compact_classification_payload(classification):
  if not isinstance(classification, dict):
    return {}
  prediction = classification.get("prediction")
  if not isinstance(prediction, list):
    return {}

  return {
    "prediction": list(prediction),
    "labels": [
      int(label)
      for label in classification.get("labels", [])
      if isinstance(label, (int, float))
    ],
    "classifier_key": classification.get("classifier_key") or DEFAULT_CLASSIFIER_KEY,
  }


def normalize_project_classifiers():
  if not classifiers:
    return

  available_keys = {item["key"] for item in classifiers}
  default_key = classifiers[0]["key"]
  changed = False
  for project in projects:
    if project.get("classifier") in available_keys:
      continue
    project["classifier"] = default_key
    changed = True

  if changed:
    save_project_data(projects)


def load_classifiers():
  global classifiers
  with state_lock:
    classifiers = list(get_bacpipe_classifiers())
    normalize_project_classifiers()


def get_project_classifier(project_index):
  with state_lock:
    classifier_config = find_classifier(projects[project_index].get("classifier"))
    if classifier_config is None:
      if not classifiers:
        raise RuntimeError("No classifier models are available.")
      classifier_config = classifiers[0]
      projects[project_index]["classifier"] = classifier_config["key"]
      save_project_data(projects)
    return dict(classifier_config)


def _normalize_processing_mode(value):
  if isinstance(value, str):
    normalized = value.strip().lower()
    if normalized in {"full", "window"}:
      return normalized
  return "full"


def _normalize_window_range(start, end):
  if start is None or end is None:
    return None

  try:
    start_index = max(int(start), 0)
    end_index = max(int(end), 0)
  except (TypeError, ValueError):
    return None

  if end_index <= start_index:
    return None

  return start_index, end_index


def _write_windowed_audio(recording_path, window_range):
  info = sf.info(recording_path)
  start_index, end_index = window_range
  start_sample = max(int(start_index * FRAME_STEP), 0)
  end_sample = min(int(end_index * FRAME_STEP), info.frames)
  if end_sample <= start_sample:
    raise ValueError("The selected spectrogram window is empty.")

  if start_sample == 0 and end_sample >= info.frames:
    return None

  samples, sample_rate = sf.read(
    recording_path,
    start=start_sample,
    stop=end_sample,
    dtype="float32",
    always_2d=True,
  )
  if len(samples) == 0:
    raise ValueError("The selected spectrogram window is empty.")

  temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
  temp_file.close()
  sf.write(temp_file.name, samples, sample_rate)
  return temp_file.name


def predict_recording(project_index, recording_path, processing_mode, window_range=None):
  classifier_config = get_project_classifier(project_index)
  processing_mode = _normalize_processing_mode(processing_mode)
  temp_path = None

  try:
    if processing_mode == "window":
      if window_range is None:
        raise ValueError("Window mode needs the currently visible spectrogram window.")
      temp_path = _write_windowed_audio(recording_path, window_range)

    classification, classes = classifier_service.predict(
      classifier_config,
      temp_path or recording_path,
      proclen=0,
    )
    return classification, classes
  finally:
    if temp_path and os.path.exists(temp_path):
      try:
        os.remove(temp_path)
      except OSError:
        pass


def get_recording_or_404(project_index, recording_index):
  with state_lock:
    try:
      recording = projects[project_index]["recordings"][recording_index]
    except IndexError as error:
      raise HTTPException(status_code=404, detail="Recording not found.") from error
    return recording


def set_recording_prediction(project_index, recording_index, classification, classes):
  with state_lock:
    try:
      recording = projects[project_index]["recordings"][recording_index]
    except IndexError:
      return

    recording["classification"] = compact_classification_payload(classification)
    recording["species"] = ", ".join(classes)
    save_project_data(projects)


def set_recording_duration(project_index, recording_index, info):
  with state_lock:
    try:
      recording = projects[project_index]["recordings"][recording_index]
    except IndexError:
      return None

    recording["samplerate"] = info.samplerate
    recording["duration"] = info.duration
    recording["sampleCount"] = int(info.frames)
    save_project_data(projects)
    return dict(recording)


def emit_recording_loading(project_index, recording_index):
  event_broker.emit("setRecordingLoading", project_index, recording_index)


def emit_classified_recording(project_index, recording_index, classification, classes, progress):
  event_broker.emit(
    "classifiedRecording",
    project_index,
    recording_index,
    compact_classification_payload(classification),
    classes,
    progress,
  )


def emit_classification_error(message):
  event_broker.emit("classificationError", message)


def emit_memory_error():
  event_broker.emit("memoryError")


def emit_play_end():
  event_broker.emit("playEnd")


def classify_async(project_index, recording_index, window_range=None):
  try:
    with state_lock:
      recording = dict(projects[project_index]["recordings"][recording_index])
      processing_mode = _normalize_processing_mode(projects[project_index].get("processing_mode"))
      classifier_config = get_project_classifier(project_index)

    try:
      classifier_service.validate(classifier_config)
    except Exception as error:
      emit_classification_error(str(error))
      emit_classified_recording(project_index, recording_index, {}, [], 100)
      return

    emit_recording_loading(project_index, recording_index)

    try:
      classification, classes = predict_recording(
        project_index,
        recording["path"],
        processing_mode,
        window_range=window_range,
      )
    except (MemoryError, OSError) as error:
      if isinstance(error, OSError) and "Cannot allocate memory" not in str(error):
        emit_classification_error(str(error))
      else:
        emit_memory_error()
      classification, classes = {}, []
    except Exception as error:
      emit_classification_error(str(error))
      classification, classes = {}, []

    set_recording_prediction(project_index, recording_index, classification, classes)
    emit_classified_recording(project_index, recording_index, classification, classes, 100)
  except Exception as error:
    emit_classification_error(str(error))


def classify_all_async(project_index, indices=None, window_range=None):
  with state_lock:
    recordings = list(enumerate(projects[project_index]["recordings"]))
    active_indices = list(indices) if indices is not None else [index for index, _ in recordings]

  if not active_indices:
    return

  try:
    classifier_service.validate(get_project_classifier(project_index))
  except Exception as error:
    emit_classification_error(str(error))
    return

  for position, index in enumerate(active_indices):
    with state_lock:
      try:
        recording = dict(projects[project_index]["recordings"][index])
        processing_mode = _normalize_processing_mode(projects[project_index].get("processing_mode"))
      except IndexError:
        continue

    emit_recording_loading(project_index, index)

    if os.path.exists(recording["path"]):
      if "duration" not in recording:
        info = sf.info(recording["path"])
        set_recording_duration(project_index, index, info)

      try:
        classification, classes = predict_recording(
          project_index,
          recording["path"],
          processing_mode,
          window_range=window_range,
        )
      except (MemoryError, OSError) as error:
        if isinstance(error, OSError) and "Cannot allocate memory" not in str(error):
          emit_classification_error(str(error))
        else:
          emit_memory_error()
        classification, classes = {}, []
      except Exception as error:
        emit_classification_error(str(error))
        classification, classes = {}, []

      set_recording_prediction(project_index, index, classification, classes)
    else:
      classification, classes = None, []

    progress = ((position + 1) / len(active_indices)) * 100
    emit_classified_recording(project_index, index, classification, classes, progress)


def export_csv_file(project_index, path):
  with state_lock:
    project = dict(projects[project_index])
    recordings = [dict(item) for item in project["recordings"]]

  with open(path, "w", newline="\n") as csvfile:
    writer = csv.writer(csvfile, delimiter=";")
    writer.writerow(
      [
        "filename",
        "duration",
        "date",
        "latitude",
        "longitude",
        "temperature",
        "species",
      ]
    )
    for recording in recordings:
      writer.writerow(
        [
          recording["path"],
          round(recording.get("duration", 0), 2),
          datetime.fromtimestamp(float(recording["date"]) / 1000).strftime(
            "%d/%m/%Y %H:%M:%S"
          ),
          recording["location"]["latitude"],
          recording["location"]["longitude"],
          recording.get("temperature", ""),
          recording.get("species", ""),
        ]
      )


def wait_end(duration, token):
  global playback, playback_token, playback_wave_object, playback_process, playback_temp_path
  target_time = time.time() + max(float(duration), 0.0)

  while True:
    remaining = target_time - time.time()
    if remaining > 0:
      time.sleep(min(remaining, 0.05))
      continue

    should_wait = False
    with playback_lock:
      if token != playback_token:
        return

      process_running = playback_process is not None and playback_process.poll() is None
      playback_running = (
        playback is not None and
        hasattr(playback, "is_playing") and
        playback.is_playing()
      )
      if process_running or playback_running:
        should_wait = True
      else:
        playback = None
        playback_wave_object = None
        playback_process = None
        if playback_temp_path and os.path.exists(playback_temp_path):
          try:
            os.remove(playback_temp_path)
          except OSError:
            pass
        playback_temp_path = None

    if should_wait:
      time.sleep(0.05)
      continue

    emit_play_end()
    return


def stop_playback_locked():
  global playback, playback_wave_object, playback_process, playback_temp_path

  if playback_process is not None:
    try:
      playback_process.terminate()
      playback_process.wait(timeout=1)
    except Exception:
      try:
        playback_process.kill()
      except Exception:
        pass
    playback_process = None

  if playback is not None:
    try:
      playback.stop()
    except Exception:
      pass
    playback = None

  playback_wave_object = None

  if playback_temp_path and os.path.exists(playback_temp_path):
    try:
      os.remove(playback_temp_path)
    except OSError:
      pass
  playback_temp_path = None


@asynccontextmanager
async def lifespan(app):
  event_broker.attach_loop(asyncio.get_running_loop())
  load_projects()
  load_classifiers()
  yield
  with playback_lock:
    stop_playback_locked()


app = FastAPI(title="OpenEcho API", lifespan=lifespan)
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_methods=["*"],
  allow_headers=["*"],
)


@app.get("/health")
def health():
  return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
  await event_broker.connect(websocket)
  try:
    while True:
      await websocket.receive_text()
  except WebSocketDisconnect:
    event_broker.disconnect(websocket)
  except Exception:
    event_broker.disconnect(websocket)


@app.get("/api/classifiers")
def get_classifiers():
  load_classifiers()
  with state_lock:
    return list(classifiers)


@app.get("/api/projects")
def get_projects():
  load_projects()
  with state_lock:
    return [public_project_payload(project) for project in projects]


@app.post("/api/projects")
def add_project(payload: ProjectPayload):
  with state_lock:
    default_classifier = classifiers[0]["key"] if classifiers else DEFAULT_CLASSIFIER_KEY
    projects.append(
      {
        "title": payload.title,
        "description": payload.description,
        "creation_date": time.time(),
        "recordings": [],
        "classifier": default_classifier,
        "processing_mode": "full",
      }
    )
    save_project_data(projects)
  return True


@app.put("/api/projects/{project_index}")
def save_project(project_index: int, payload: ProjectPayload):
  with state_lock:
    projects[project_index]["title"] = payload.title
    projects[project_index]["description"] = payload.description
    save_project_data(projects)
  return True


@app.delete("/api/projects/{project_index}")
def remove_project(project_index: int):
  with state_lock:
    del projects[project_index]
    save_project_data(projects)
  return True


@app.delete("/api/projects/{project_index}/recordings")
def remove_recordings(project_index: int, payload: IndicesPayload):
  with state_lock:
    for index in sorted(payload.indices, reverse=True):
      del projects[project_index]["recordings"][index]
    save_project_data(projects)
  return True


@app.post("/api/projects/{project_index}/recordings")
def add_recordings(project_index: int, payload: PathsPayload):
  filenames = [path for path in payload.paths if path]
  if not filenames:
    return {"recordings_added": 0, "metadata_files": 0, "matched_recordings": 0}

  with state_lock:
    recordings = projects[project_index]["recordings"]
    recordings.extend(build_recording_entry(path) for path in filenames)
    metadata_summary = auto_apply_metadata(recordings, filenames)
    save_project_data(projects)

  return {
    "recordings_added": len(filenames),
    "metadata_files": metadata_summary["metadata_files"],
    "matched_recordings": metadata_summary["matched_recordings"],
  }


@app.post("/api/projects/{project_index}/metadata")
def add_metadata(project_index: int, payload: ExportPayload):
  if not payload.path:
    return False

  with state_lock:
    matched_recordings = apply_metadata_file(
      projects[project_index]["recordings"], payload.path
    )
    if matched_recordings == 0:
      return False
    save_project_data(projects)

  return True


@app.get("/api/projects/{project_index}/recordings/{recording_index}/chunk")
def get_chunk(project_index: int, recording_index: int, start: int, end: int = 0):
  recording = get_recording_or_404(project_index, recording_index)
  if not os.path.exists(recording["path"]):
    return False

  return load_spectrogram_chunk(recording["path"], start, end)


@app.get("/api/projects/{project_index}/recordings/{recording_index}")
def get_recording(project_index: int, recording_index: int):
  recording = get_recording_or_404(project_index, recording_index)
  if not os.path.exists(recording["path"]):
    return False

  info = sf.info(recording["path"])
  spectrogram, wave_data, _ = load_recording_preview(recording["path"])
  updated_recording = set_recording_duration(project_index, recording_index, info)
  full_classification = load_recording_classification_data(project_index, recording_index)
  if full_classification is not None:
    updated_recording["classification"] = full_classification
  return {
    "recording": public_recording_payload(updated_recording),
    "spectrogram": spectrogram,
    "waveData": wave_data,
  }


@app.post("/api/projects/{project_index}/recordings/{recording_index}/species")
def set_species(project_index: int, recording_index: int, payload: SpeciesPayload):
  with state_lock:
    projects[project_index]["recordings"][recording_index]["species"] = payload.species
    save_project_data(projects)
  return True


@app.post("/api/projects/{project_index}/classifier")
def set_classifier(project_index: int, payload: ClassifierPayload):
  with state_lock:
    if classifiers and find_classifier(payload.classifierKey) is None:
      raise HTTPException(status_code=400, detail="Unknown classifier.")
    projects[project_index]["classifier"] = payload.classifierKey
    save_project_data(projects)
  return True


@app.post("/api/projects/{project_index}/processing-mode")
def set_processing_mode(project_index: int, payload: ProcessingModePayload):
  with state_lock:
    projects[project_index]["processing_mode"] = _normalize_processing_mode(payload.value)
    save_project_data(projects)
  return True


@app.post("/api/projects/{project_index}/recordings/{recording_index}/classify")
def classify(
  project_index: int,
  recording_index: int,
  payload: ClassificationPayload | None = None,
):
  window_range = None
  if payload is not None:
    window_range = _normalize_window_range(payload.start, payload.end)

  thread = threading.Thread(
    target=classify_async,
    args=(project_index, recording_index, window_range),
    daemon=True,
  )
  thread.start()
  return True


@app.post("/api/projects/{project_index}/classify")
def classify_all(project_index: int, payload: ClassifyAllPayload | None = None):
  indices = payload.indices if payload is not None else None
  window_range = None
  if payload is not None:
    window_range = _normalize_window_range(payload.start, payload.end)

  thread = threading.Thread(
    target=classify_all_async,
    args=(project_index, indices, window_range),
    daemon=True,
  )
  thread.start()
  return True


@app.post("/api/projects/{project_index}/export")
def export_csv(project_index: int, payload: ExportPayload):
  try:
    export_csv_file(project_index, payload.path)
    return True
  except Exception:
    return False


@app.post("/api/play")
def play(payload: PlaybackPayload):
  global playback, playback_token, playback_wave_object, playback_process, playback_temp_path, play_request_id

  recording = get_recording_or_404(payload.projectIndex, payload.recordingIndex)

  with playback_lock:
    play_request_id += 1
    request_id = play_request_id

  (
    waveform,
    sample_rate,
    duration,
    actual_start_frame,
    actual_end_frame,
  ) = prepare_playback_audio(
    recording["path"],
    payload.start,
    payload.end,
    payload.expansionRate,
  )

  with playback_lock:
    if request_id != play_request_id:
      return {
        "started": False,
        "durationMs": 0,
      }

    stop_playback_locked()
    if len(waveform) == 0:
      playback_token += 1
      emit_play_end()
      return {
        "started": False,
        "durationMs": 0,
      }

    playback_token += 1
    token = playback_token

    playback_engine = "simpleaudio"
    try:
      audio_bytes = waveform.tobytes()
      playback_wave_object = sa.WaveObject(
        audio_bytes,
        num_channels=1,
        bytes_per_sample=2,
        sample_rate=sample_rate,
      )
      playback = playback_wave_object.play()
      playback_process = None
      playback_temp_path = None
    except Exception:
      if platform.system() != "Darwin":
        raise

      playback_engine = "afplay"
      playback = None
      playback_wave_object = None
      temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
      temp_file.close()
      sf.write(temp_file.name, waveform, sample_rate, subtype="PCM_16")
      playback_temp_path = temp_file.name
      playback_process = subprocess.Popen(
        ["/usr/bin/afplay", playback_temp_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
      )
    playback_started_at_ms = time.time() * 1000.0

  thread = threading.Thread(target=wait_end, args=(duration, token), daemon=True)
  thread.start()
  return {
    "started": True,
    "durationMs": duration * 1000.0,
    "playbackEngine": playback_engine,
    "startedAtMs": playback_started_at_ms,
    "startFrameIndex": actual_start_frame,
    "endFrameIndex": actual_end_frame,
  }


@app.post("/api/pause")
def pause():
  global playback_token, play_request_id
  with playback_lock:
    play_request_id += 1
    playback_token += 1
    stop_playback_locked()
  emit_play_end()
  return True
