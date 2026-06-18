from __future__ import annotations

from contextlib import contextmanager
from functools import lru_cache
import importlib
import importlib.machinery
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import types

import numpy as np
import soundfile as sf

from backend.inference.bat_label_map import canonical_bat_labels
from backend.paths import data_path, resource_root


CLASSIFIER_MODEL_NAMES = {
  "audioprotopnet",
  "bat",
  "batdetect2_dets_avg",
  "birdnet",
  "convnext_birdset",
  "google_whale",
  "perch_bird",
  "perch_v2",
  "surfperch",
  "bat2",
}
BUNDLED_WORKER_MODEL_NAMES = CLASSIFIER_MODEL_NAMES - {"bat2"}
MULTILABEL_MODEL_NAMES = {
  "bat",
  "bat2",
  "batdetect2_dets_avg",
}
TENSORFLOW_MODEL_NAMES = {
  "birdnet",
  "google_whale",
  "hbdet",
  "perch_bird",
  "perch_v2",
  "surfperch",
  "vggish",
}
DISPLAY_NAME_OVERRIDES = {
  "audiomae": "AudioMAE",
  "audioprotopnet": "AudioProtoPNet",
  "avesecho_passt": "AvesEcho PaSST",
  "aves_especies": "AVES eSpecies",
  "bat": "BAT",
  "bat2": "BAT2",
  "batdetect2_dets_avg": "BatDetect2",
  "beats": "BEATs",
  "birdaves_especies": "BirdAVES eSpecies",
  "birdmae": "BirdMAE",
  "birdnet": "BirdNET",
  "convnext_birdset": "ConvNeXT BirdSet",
  "google_whale": "Google Whale",
  "hbdet": "HBDet",
  "mix2": "MIX2",
  "naturebeats": "NatureBEATs",
  "perch_bird": "Perch Bird",
  "perch_v2": "Perch V2",
  "protoclr": "ProtoCLR",
  "rcl_fs_bsed": "RCL FS-BSED",
  "surfperch": "SurfPerch",
  "vggish": "VGGish",
}
MODEL_DESCRIPTION_OVERRIDES = {
  "bat": "A transformer-based acoustic classifier for identifying European bat species from ultrasonic recordings.",
  "bat2": "A compact bat-call classifier tuned for species-level predictions on ultrasonic audio.",
  "batdetect2_dets_avg": "Detects bat calls and combines detection-level features into species predictions.",
  "birdnet": "A broad bird-sound classifier designed for species recognition in environmental recordings.",
  "google_whale": "A bioacoustic classifier for recognizing whale vocalizations.",
}
MODEL_ORDER_PRIORITY = {
  "bat": 0,
  "bat2": 1,
  "batdetect2_dets_avg": 2,
}
MULTILABEL_THRESHOLD = 0.5
CAM_BOX_THRESHOLD = 0.8
CAM_BOX_MIN_AREA = 4
REPO_ROOT = resource_root()
DEFAULT_TF_VENV_PYTHON = REPO_ROOT / ".venv-tf" / "bin" / "python"
WORKER_PROCESS_ENV_VAR = "OPENECHO_BACPIPE_WORKER"
PYTHON_ENV_VARS_TO_CLEAR = {
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONEXECUTABLE",
  "__PYVENV_LAUNCHER__",
  "_MEIPASS2",
  "_PYI_APPLICATION_HOME_DIR",
  "_PYI_ARCHIVE_FILE",
  "_PYI_PARENT_PROCESS_LEVEL",
  "_PYI_SPLASH_IPC",
  "PYI_SAFE_PATH",
}


def classifier_key(model_name):
  return f"bacpipe:{model_name}"


def running_in_frozen_bundle():
  return bool(getattr(sys, "frozen", False) or getattr(sys, "_MEIPASS", None))


def in_bacpipe_worker_process():
  return os.environ.get(WORKER_PROCESS_ENV_VAR) == "1"


def prefer_worker_runtime(model_name):
  return (
    running_in_frozen_bundle() and
    not in_bacpipe_worker_process() and
    model_name in BUNDLED_WORKER_MODEL_NAMES
  )


def parse_worker_payload(stdout):
  text = (stdout or "").strip()
  if not text:
    raise RuntimeError("Bacpipe worker returned no JSON output.")

  candidates = [text]
  candidates.extend(
    line.strip()
    for line in text.splitlines()
    if line.strip()
  )

  for candidate in reversed(candidates):
    try:
      payload = json.loads(candidate)
    except json.JSONDecodeError:
      continue
    if isinstance(payload, dict) and "classification" in payload and "classes" in payload:
      return payload

  raise RuntimeError("Bacpipe worker returned invalid JSON.")


def configure_bacpipe_storage(bacpipe):
  storage_root = data_path("bacpipe")
  storage_root.mkdir(parents=True, exist_ok=True)

  for setting_name in (
    "model_base_path",
    "embed_parent_dir",
    "dim_reduc_parent_dir",
    "evaluations_dir",
    "main_results_dir",
  ):
    current_value = getattr(bacpipe.settings, setting_name, None)
    leaf_name = Path(str(current_value)).name if current_value else setting_name
    target_path = storage_root / leaf_name
    target_path.mkdir(parents=True, exist_ok=True)
    setattr(bacpipe.settings, setting_name, str(target_path))


@lru_cache(maxsize=1)
def load_bacpipe():
  if os.environ.get("OPENECHO_DISABLE_BACPIPE") == "1":
    return None

  try:
    import bacpipe
  except ImportError:  # pragma: no cover - optional dependency
    return None

  configure_bacpipe_storage(bacpipe)
  return bacpipe



def display_name(model_name):
  if model_name in DISPLAY_NAME_OVERRIDES:
    return DISPLAY_NAME_OVERRIDES[model_name]
  return " ".join(part.capitalize() for part in model_name.split("_"))


def provider_label(model_name):
  if model_name == "bat2":
    return None
  return "bacpipe"


def make_short_label(label):
  clean = re.sub(r"[^A-Za-z0-9]+", "", str(label))
  return clean if len(clean) <= 10 else clean[:10]


def format_class_metadata(model_name, classes):
  classes = [str(label) for label in classes or []]
  if model_name in {"bat", "bat2", "batdetect2_dets_avg"}:
    classes_short = canonical_bat_labels(classes)
  else:
    classes_short = [make_short_label(label) for label in classes]
  return {
    "classes": classes,
    "classes_short": classes_short,
  }


def normalize_cam_map(cam_map):
  cam_map = np.asarray(cam_map, dtype=np.float32)
  if cam_map.size == 0:
    return cam_map
  minimum = np.nanmin(cam_map)
  maximum = np.nanmax(cam_map)
  if not np.isfinite(minimum) or not np.isfinite(maximum) or maximum <= minimum:
    return np.zeros_like(cam_map, dtype=np.float32)
  return (cam_map - minimum) / (maximum - minimum)


def bat_layercam_target_layers(model):
  encoder = getattr(model, "transformer_encoder", None)
  layers = getattr(encoder, "layers", None)
  if not layers or len(layers) < 2:
    return []

  target_layers = []
  for layer_index, block_index in ((1, 0), (0, 0), (1, 1), (0, 1)):
    try:
      target_layers.append(layers[layer_index][block_index].norm)
    except (AttributeError, IndexError, TypeError):
      continue
  return target_layers


def bat_layercam_reshape(tensor):
  if tensor.ndim == 3 and tensor.shape[1] > 1:
    batch_size, token_count, width = tensor.shape
    token_count -= 1
    return (
      tensor[:, 1:]
      .reshape(batch_size, token_count, 1, width)
      .permute(0, 3, 1, 2)
    )
  if tensor.ndim == 4:
    return tensor
  return None


def layercam_maps(model, input_tensor, class_indexes):
  import torch
  import torch.nn.functional as functional

  class_indexes = [int(index) for index in class_indexes]
  if not class_indexes:
    with torch.no_grad():
      return torch.sigmoid(model(input_tensor)).detach().cpu().numpy(), {}

  target_layers = bat_layercam_target_layers(model)
  if not target_layers:
    with torch.no_grad():
      return torch.sigmoid(model(input_tensor)).detach().cpu().numpy(), {}

  activations = {}
  gradients = {}
  handles = []

  def make_forward_hook(layer_index):
    def forward_hook(_module, _inputs, output):
      reshaped = bat_layercam_reshape(output)
      if reshaped is None or not reshaped.requires_grad:
        return
      activations[layer_index] = reshaped

      def gradient_hook(gradient):
        reshaped_gradient = bat_layercam_reshape(gradient)
        if reshaped_gradient is not None:
          gradients[layer_index] = reshaped_gradient

      output.register_hook(gradient_hook)
    return forward_hook

  for layer_index, layer in enumerate(target_layers):
    handles.append(layer.register_forward_hook(make_forward_hook(layer_index)))

  try:
    model.zero_grad(set_to_none=True)
    logits = model(input_tensor)
    probabilities = torch.sigmoid(logits).detach().cpu().numpy()
    cam_by_class = {}
    output_size = tuple(input_tensor.shape[-2:])

    for class_index in class_indexes:
      gradients.clear()
      model.zero_grad(set_to_none=True)
      logits[:, class_index].sum().backward(retain_graph=True)

      layer_cams = []
      for layer_index, activation in activations.items():
        gradient = gradients.get(layer_index)
        if gradient is None:
          continue
        cam = (torch.relu(gradient) * torch.relu(activation)).sum(dim=1, keepdim=True)
        cam = functional.interpolate(
          cam,
          size=output_size,
          mode="bilinear",
          align_corners=False,
        )
        layer_cams.append(cam.squeeze(1).detach().cpu().numpy())

      if layer_cams:
        cam_by_class[class_index] = normalize_cam_map(np.mean(layer_cams, axis=0))

    return probabilities, cam_by_class
  finally:
    for handle in handles:
      handle.remove()


def boxes_from_cam_map(
  cam_map,
  segment_offset,
  segment_duration,
  max_frequency_khz,
  class_index,
  label,
  class_score,
  source,
  clip_end=None,
):
  from scipy import ndimage

  cam_map = normalize_cam_map(cam_map)
  if cam_map.ndim != 2 or cam_map.size == 0:
    return []

  mask = cam_map >= CAM_BOX_THRESHOLD
  if not np.any(mask):
    return []

  component_map, component_count = ndimage.label(mask)
  slices = ndimage.find_objects(component_map)
  time_count, frequency_count = cam_map.shape
  boxes = []

  for component_index in range(1, component_count + 1):
    component_slice = slices[component_index - 1]
    if component_slice is None:
      continue

    time_slice, frequency_slice = component_slice
    component = component_map[component_slice] == component_index
    area = int(component.sum())
    if area < CAM_BOX_MIN_AREA:
      continue

    start = segment_offset + (time_slice.start / time_count) * segment_duration
    end = segment_offset + (time_slice.stop / time_count) * segment_duration
    if clip_end is not None:
      end = min(end, clip_end)
    if end <= start:
      continue
    low_freq = (frequency_slice.start / frequency_count) * max_frequency_khz
    high_freq = (frequency_slice.stop / frequency_count) * max_frequency_khz
    score = float(cam_map[component_slice][component].mean())

    boxes.append({
      "start": float(start),
      "end": float(end),
      "low_freq": float(low_freq),
      "high_freq": float(high_freq),
      "score": score,
      "class_score": float(class_score),
      "class_index": int(class_index),
      "label": label,
      "source": source,
    })

  return boxes


def audio_duration_seconds(recording_path, proclen=0):
  info = sf.info(str(recording_path))
  duration = info.frames / info.samplerate if info.samplerate else 0.0
  if proclen and float(proclen) > 0:
    duration = min(duration, float(proclen))
  return duration


@lru_cache(maxsize=1)
def tensorflow_runtime_status():
  try:
    completed = subprocess.run(
      [
        sys.executable,
        "-c",
        "import tensorflow as tf; print(getattr(tf, '__version__', 'unknown'))",
      ],
      capture_output=True,
      text=True,
      timeout=8,
      check=False,
    )
  except subprocess.TimeoutExpired:
    return False, "TensorFlow import timed out in this Python environment."

  if completed.returncode != 0:
    stderr = completed.stderr.strip()
    return False, stderr or "TensorFlow could not be imported in this Python environment."

  return True, completed.stdout.strip() or "ok"


def resolve_tf_python():
  override = os.environ.get("BACPIPE_TF_PYTHON")
  if override:
    override_path = Path(override).expanduser()
    if override_path.is_file():
      return override_path

  if DEFAULT_TF_VENV_PYTHON.is_file():
    return DEFAULT_TF_VENV_PYTHON

  return None


def resolve_worker_source_root(python_path=None):
  override = os.environ.get("BACPIPE_WORKER_SOURCE_ROOT")
  if override:
    override_path = Path(override).expanduser().resolve()
    if (override_path / "backend" / "inference" / "bacpipe_worker.py").is_file():
      return override_path

  if python_path:
    python_path = Path(python_path).expanduser()
    if not python_path.is_absolute():
      python_path = Path(os.path.abspath(str(python_path)))
    bundle_root = python_path.parents[2]
    worker_source_root = bundle_root / "worker-src"
    if (worker_source_root / "backend" / "inference" / "bacpipe_worker.py").is_file():
      return worker_source_root

  if (REPO_ROOT / "backend" / "inference" / "bacpipe_worker.py").is_file():
    return REPO_ROOT

  return None


def worker_subprocess_env(python_path):
  env = dict(os.environ)
  for key in PYTHON_ENV_VARS_TO_CLEAR:
    env.pop(key, None)

  env[WORKER_PROCESS_ENV_VAR] = "1"
  env.setdefault("OPENECHO_DATA_DIR", str(data_path()))
  env.setdefault("OPENECHO_RESOURCE_DIR", str(REPO_ROOT))

  worker_source_root = resolve_worker_source_root(python_path)
  if worker_source_root is not None:
    env["PYTHONPATH"] = str(worker_source_root)

  return env


def worker_subprocess_cwd(python_path):
  return str(data_path())


@lru_cache(maxsize=None)
def worker_runtime_status(python_path):
  try:
    completed = subprocess.run(
      [
        str(python_path),
        "-c",
        "import tensorflow as tf; import bacpipe; print(tf.__version__)",
      ],
      capture_output=True,
      text=True,
      timeout=60,
      check=False,
      cwd=worker_subprocess_cwd(python_path),
      env=worker_subprocess_env(python_path),
    )
  except subprocess.TimeoutExpired:
    return False, "Dedicated TensorFlow environment timed out while importing TensorFlow."

  if completed.returncode != 0:
    stderr = completed.stderr.strip()
    return (
      False,
      stderr or "Dedicated TensorFlow environment could not import TensorFlow and bacpipe.",
    )

  return True, completed.stdout.strip() or "ok"


@lru_cache(maxsize=1)
def prime_bacpipe_non_tf_compat():
  tensorflow_ready, _ = tensorflow_runtime_status()
  compat_modules = (
    "bacpipe.embedding_generation_pipelines.utils",
    "bacpipe.model_pipelines.model_utils",
  )
  if tensorflow_ready or any(module_name in sys.modules for module_name in compat_modules):
    return

  # Force torch-only transformer code paths in the main process when the local
  # TensorFlow runtime is broken. TensorFlow-backed models already run through
  # a dedicated worker environment.
  os.environ.setdefault("USE_TF", "0")
  os.environ.setdefault("USE_TORCH", "1")
  os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

  tensorflow_stub = types.ModuleType("tensorflow")
  tensorflow_stub.__spec__ = importlib.machinery.ModuleSpec("tensorflow", loader=None)

  class Tensor:
    pass

  class Variable:
    pass

  tensorflow_stub.Tensor = Tensor
  tensorflow_stub.Variable = Variable

  previous_tensorflow = sys.modules.get("tensorflow")
  sys.modules["tensorflow"] = tensorflow_stub
  try:
    for module_name in compat_modules:
      try:
        importlib.import_module(module_name)
        break
      except ModuleNotFoundError:
        continue
  finally:
    if previous_tensorflow is None:
      sys.modules.pop("tensorflow", None)
    else:
      sys.modules["tensorflow"] = previous_tensorflow


def get_bacpipe_model_names(classifier_only=True):
  model_names = set()

  if running_in_frozen_bundle() and not in_bacpipe_worker_process():
    model_names.update(CLASSIFIER_MODEL_NAMES)
    model_names.discard("bat2")
  else:
    bacpipe = load_bacpipe()
    if bacpipe is not None:
      if classifier_only:
        # `bacpipe.supported_models` can hide TensorFlow-backed classifiers when the
        # current Python runtime does not import TensorFlow, even if we can run
        # them through a dedicated worker environment.
        model_names.update(CLASSIFIER_MODEL_NAMES)
        model_names.discard("bat2")
      else:
        model_names.update(bacpipe.supported_models)

  try:
    from backend.inference.bacpipe_bat_adapter import BAT2_CHECKPOINT_PATH
  except Exception:
    BAT2_CHECKPOINT_PATH = None

  if BAT2_CHECKPOINT_PATH and BAT2_CHECKPOINT_PATH.is_file():
    model_names.add("bat2")

  return sorted(
    model_names,
    key=lambda model_name: (
      MODEL_ORDER_PRIORITY.get(model_name, 100),
      display_name(model_name),
      model_name,
    ),
  )


@lru_cache(maxsize=None)
def model_runtime_available(model_name):
  if model_name == "bat2":
    try:
      from backend.inference.bacpipe_bat_adapter import BAT2_CHECKPOINT_PATH
    except Exception:
      return False
    return bool(BAT2_CHECKPOINT_PATH and BAT2_CHECKPOINT_PATH.is_file())

  if prefer_worker_runtime(model_name):
    try:
      resolve_runtime(model_name)
    except RuntimeError:
      return False
    return True

  bacpipe = load_bacpipe()
  if bacpipe is None:
    return False

  if (
    model_name not in TENSORFLOW_MODEL_NAMES and
    model_name not in set(getattr(bacpipe, "supported_models", []))
  ):
    return False

  try:
    resolve_runtime(model_name)
  except RuntimeError:
    return False

  return True


def get_bacpipe_classifiers():
  classifiers = []
  for model_name in get_bacpipe_model_names(classifier_only=True):
    if not model_runtime_available(model_name):
      continue

    if model_name == "bat2":
      from backend.inference.bacpipe_bat_adapter import get_bat_class_labels

      class_metadata = format_class_metadata(model_name, get_bat_class_labels())
    else:
      class_metadata = {"classes": [], "classes_short": []}

    classifiers.append(
      {
        "key": classifier_key(model_name),
        "name": display_name(model_name),
        "provider": "bacpipe",
        "provider_label": provider_label(model_name),
        "model_name": model_name,
        "task_type": "multi-label" if model_name in MULTILABEL_MODEL_NAMES else "single-label",
        "tags": [
          provider_label(model_name),
          "multi-label" if model_name in MULTILABEL_MODEL_NAMES else "single-label",
        ],
        "description": MODEL_DESCRIPTION_OVERRIDES.get(
          model_name,
          f"{display_name(model_name)} is an acoustic classification model provided through BacPipe.",
        ),
        **class_metadata,
      }
    )
  return classifiers


def resolve_runtime(model_name):
  if in_bacpipe_worker_process():
    return "in_process", None

  if prefer_worker_runtime(model_name):
    worker_python = resolve_tf_python()
    worker_status = None
    if worker_python:
      worker_ready, worker_status = worker_runtime_status(str(worker_python))
      if worker_ready:
        return "worker", worker_python

    model_display_name = display_name(model_name)
    if worker_python:
      raise RuntimeError(
        f"{model_display_name} is unavailable in the bundled app because the dedicated bacpipe worker at {worker_python} is not ready: {worker_status}"
      )

    raise RuntimeError(
      f"{model_display_name} is unavailable in the bundled app because the dedicated bacpipe worker was not found. "
      f"Expected {DEFAULT_TF_VENV_PYTHON} or set BACPIPE_TF_PYTHON."
    )

  if model_name not in TENSORFLOW_MODEL_NAMES:
    return "in_process", None

  worker_python = resolve_tf_python()
  worker_status = None
  if worker_python:
    worker_ready, worker_status = worker_runtime_status(str(worker_python))
    if worker_ready:
      return "worker", worker_python

  tensorflow_ready, _ = tensorflow_runtime_status()
  if tensorflow_ready:
    return "in_process", None

  model_display_name = display_name(model_name)
  if worker_python:
    raise RuntimeError(
      f"{model_display_name} is unavailable in the current Python environment because TensorFlow does not import cleanly. "
      f"The dedicated TensorFlow environment at {worker_python} is also not ready: {worker_status}"
    )

  raise RuntimeError(
    f"{model_display_name} needs TensorFlow, but TensorFlow does not import cleanly in the current Python environment. "
    f"Create a dedicated environment at {DEFAULT_TF_VENV_PYTHON} or set BACPIPE_TF_PYTHON."
  )


@contextmanager
def trimmed_audio(recording_path, proclen):
  recording_path = Path(recording_path)
  if not proclen or float(proclen) <= 0:
    yield recording_path
    return

  info = sf.info(str(recording_path))
  if info.frames <= 0:
    raise ValueError(f"Audio file {recording_path} is empty.")

  target_frames = min(int(float(proclen) * info.samplerate), info.frames)
  if target_frames <= 0 or target_frames >= info.frames:
    yield recording_path
    return

  samples, sample_rate = sf.read(
    str(recording_path),
    frames=target_frames,
    dtype="float32",
    always_2d=True,
  )
  if len(samples) == 0:
    raise ValueError(f"Audio file {recording_path} is empty.")

  file_descriptor, temp_name = tempfile.mkstemp(suffix=".wav")
  os.close(file_descriptor)
  temp_path = Path(temp_name)

  try:
    sf.write(str(temp_path), samples, sample_rate)
    yield temp_path
  finally:
    try:
      temp_path.unlink()
    except OSError:
      pass


class BacpipeClassifierService:
  def __init__(self):
    self.embedders = {}
    self.bat2_model = None

  def validate(self, classifier_config):
    resolve_runtime(classifier_config["model_name"])

  def get_classes(self, classifier_config):
    model_name = classifier_config["model_name"]
    if model_name == "bat2":
      from backend.inference.bacpipe_bat_adapter import get_bat_class_labels

      return format_class_metadata(model_name, get_bat_class_labels())

    runtime, worker_python = resolve_runtime(model_name)
    if runtime == "worker":
      return self.get_classes_with_worker(worker_python, model_name)

    model = self.get_embedder(model_name).model
    classes = getattr(model, "classes", None)
    if classes is None:
      raise RuntimeError(
        f"{display_name(model_name)} does not expose class metadata."
      )
    return format_class_metadata(model_name, classes)

  def predict(self, classifier_config, recording_path, proclen=0):
    model_name = classifier_config["model_name"]
    runtime, worker_python = resolve_runtime(model_name)
    if runtime == "worker":
      return self.predict_with_worker(worker_python, model_name, recording_path, proclen)
    return self.predict_in_process(model_name, recording_path, proclen=proclen)

  def predict_in_process(self, model_name, recording_path, proclen=0):
    if model_name == "bat2":
      from backend.inference.bacpipe_bat_adapter import get_bat_class_labels

      segment_probabilities, boxes = self.predict_bat2_with_layercam_boxes(recording_path, proclen=proclen)
      classification, predicted_classes = self.build_classification(
        "bat2",
        segment_probabilities,
        get_bat_class_labels(),
      )
      classification["boxes"] = boxes
      return classification, predicted_classes

    if model_name == "bat":
      return self.predict_bat_with_layercam_boxes(recording_path, proclen=proclen)

    if model_name == "batdetect2_dets_avg":
      return self.predict_batdetect2_dets_avg(recording_path, proclen=proclen)

    return self.predict_embedder(model_name, recording_path, proclen=proclen)

  def predict_bat2_with_layercam_boxes(self, recording_path, proclen=0):
    import torch
    from torch.utils.data import DataLoader
    import librosa
    from scipy import signal
    from backend.inference.bacpipe_bat_adapter import (
      BAT2_FILTER_A,
      BAT2_FILTER_B,
      BAT2_SAMPLE_RATE,
      get_bat_class_labels,
      pad_and_slide_window,
      preprocess_bat2,
    )

    bat2_model = self.get_bat2_model()
    duration = None if not proclen else proclen
    waveform, _ = librosa.load(
      str(recording_path),
      sr=BAT2_SAMPLE_RATE,
      duration=duration,
      mono=True,
    )
    waveform = signal.lfilter(BAT2_FILTER_B, BAT2_FILTER_A, waveform)
    samples_per_step = 22 * (512 // 4)
    segment_stride_seconds = (60 * samples_per_step) / BAT2_SAMPLE_RATE
    segment_duration = ((60 + 1) * samples_per_step) / BAT2_SAMPLE_RATE
    audio_duration = len(waveform) / BAT2_SAMPLE_RATE if BAT2_SAMPLE_RATE else None
    windows = pad_and_slide_window(
      torch.tensor(waveform, dtype=torch.float32, device=bat2_model.device),
      (60 + 1) * samples_per_step,
      60 * samples_per_step,
    )
    features = preprocess_bat2(windows, 512)
    classes_short = canonical_bat_labels(get_bat_class_labels())
    segment_probabilities = []
    boxes = []
    segment_index = 0

    for batch in DataLoader(features, batch_size=1, shuffle=False):
      batch = batch.to(bat2_model.device)
      with torch.no_grad():
        logits = bat2_model.model(batch)
        preliminary_probabilities = torch.sigmoid(logits).detach().cpu().numpy()
      class_indexes = np.flatnonzero(preliminary_probabilities[0] > MULTILABEL_THRESHOLD).tolist()
      probabilities, cam_by_class = layercam_maps(
        bat2_model.model,
        batch,
        class_indexes,
      )
      segment_probabilities.append(probabilities)

      for class_index, cam_batch in cam_by_class.items():
        if class_index >= len(classes_short):
          continue
        boxes.extend(
          boxes_from_cam_map(
            cam_batch[0],
            segment_offset=segment_index * segment_stride_seconds,
            segment_duration=segment_duration,
            max_frequency_khz=BAT2_SAMPLE_RATE / 2000.0,
            class_index=class_index,
            label=classes_short[class_index],
            class_score=probabilities[0, class_index],
            source="bat2_layercam",
            clip_end=audio_duration,
          )
        )

      segment_index += len(batch)

    if not segment_probabilities:
      raise RuntimeError("BAT2 returned no classifier outputs.")

    return np.concatenate(segment_probabilities, axis=0), boxes

  def predict_bat_with_layercam_boxes(self, recording_path, proclen=0):
    import torch

    embedder = self.get_embedder("bat")
    if not getattr(embedder.model, "bool_classifier", False):
      raise ValueError("bat does not provide pretrained class predictions.")

    classes = list(embedder.model.classes)
    classes_short = canonical_bat_labels(classes)
    segment_duration = embedder.model.segment_length / embedder.model.sr
    audio_duration = audio_duration_seconds(recording_path, proclen)
    segment_probabilities = []
    boxes = []
    segment_index = 0

    with trimmed_audio(recording_path, proclen) as inference_path:
      samples = embedder.prepare_audio(inference_path)
      for batch in embedder.init_dataloader(samples):
        if embedder.model.device == "cuda" and hasattr(batch, "cuda"):
          batch = batch.cuda()

        with torch.no_grad():
          logits = embedder.model.model(batch)
          preliminary_probabilities = torch.sigmoid(logits).detach().cpu().numpy()
        active_class_indexes = sorted(
          {
            int(index)
            for row in preliminary_probabilities
            for index in np.flatnonzero(row > MULTILABEL_THRESHOLD)
          }
        )
        probabilities, cam_by_class = layercam_maps(
          embedder.model.model,
          batch,
          active_class_indexes,
        )
        segment_probabilities.append(probabilities)

        for batch_index in range(probabilities.shape[0]):
          for class_index, cam_batch in cam_by_class.items():
            if class_index >= len(classes_short):
              continue
            if probabilities[batch_index, class_index] <= MULTILABEL_THRESHOLD:
              continue
            boxes.extend(
              boxes_from_cam_map(
                cam_batch[batch_index],
                segment_offset=(segment_index + batch_index) * segment_duration,
                segment_duration=segment_duration,
                max_frequency_khz=embedder.model.sr / 2000.0,
                class_index=class_index,
                label=classes_short[class_index],
                class_score=probabilities[batch_index, class_index],
                source="bat_layercam",
                clip_end=audio_duration,
              )
            )

        segment_index += probabilities.shape[0]

    if not segment_probabilities:
      raise RuntimeError("BAT returned no classifier outputs.")

    classification, predicted_classes = self.build_classification(
      "bat",
      np.concatenate(segment_probabilities, axis=0),
      classes,
    )
    classification["boxes"] = boxes
    return classification, predicted_classes

  def predict_batdetect2_dets_avg(self, recording_path, proclen=0):
    import torch

    embedder = self.get_embedder("batdetect2_dets_avg")
    batdetect2_module = importlib.import_module(
      "bacpipe.model_pipelines.feature_extractors.batdetect2_dets_avg"
    )
    class_scores = []
    boxes = []
    segment_seconds = embedder.model.segment_length / embedder.model.sr
    with trimmed_audio(recording_path, proclen) as inference_path:
      samples = embedder.prepare_audio(inference_path)
      if isinstance(samples, torch.Tensor) and samples.ndim == 2:
        samples = samples.unsqueeze(0)

      segment_index = 0
      for batch in embedder.init_dataloader(samples):
        if embedder.model.device == "cuda" and hasattr(batch, "cuda"):
          batch = batch.cuda()
        with torch.no_grad():
          output = embedder.model.model(batch.unsqueeze(1))
          results, features = embedder.model.non_max_suppression(
            output,
            sampling_rate=np.array([embedder.model.sr] * batch.shape[0]),
          )

        batch_class_scores = []
        for result, feature in zip(results, features):
          _, segment_class_scores = batdetect2_module.get_mean_detection_features(
            result,
            feature,
            top_k=embedder.model.top_k_detections,
          )
          if not isinstance(segment_class_scores, torch.Tensor):
            segment_class_scores = torch.as_tensor(segment_class_scores)
          batch_class_scores.append(segment_class_scores.detach().cpu())

          segment_offset = segment_index * segment_seconds
          class_probabilities = np.asarray(result.get("class_probs", []), dtype=np.float32)
          if class_probabilities.ndim == 2 and class_probabilities.shape[0] > len(embedder.model.classes):
            class_probabilities = class_probabilities[:-1]

          for detection_index, detection_score in enumerate(result.get("det_probs", [])):
            if (
              class_probabilities.ndim != 2 or
              detection_index >= class_probabilities.shape[1]
            ):
              class_index = None
              class_score = None
              label = None
            else:
              class_index = int(np.argmax(class_probabilities[:, detection_index]))
              class_score = float(class_probabilities[class_index, detection_index])
              label = canonical_bat_labels([embedder.model.classes[class_index]])[0]

            boxes.append({
              "start": float(segment_offset + result["start_times"][detection_index]),
              "end": float(segment_offset + result["end_times"][detection_index]),
              "low_freq": float(result["low_freqs"][detection_index] / 1000.0),
              "high_freq": float(result["high_freqs"][detection_index] / 1000.0),
              "score": float(detection_score),
              "class_score": class_score,
              "class_index": class_index,
              "label": label,
            })

          segment_index += 1

        if batch_class_scores:
          class_scores.append(torch.stack(batch_class_scores))

    if not class_scores:
      raise RuntimeError("batdetect2_dets_avg returned no classifier outputs.")

    segment_probabilities = torch.cat(class_scores, dim=0).numpy()
    classification, predicted_classes = self.build_classification(
      "batdetect2_dets_avg",
      segment_probabilities,
      list(embedder.model.classes),
    )
    classification["boxes"] = boxes
    return classification, predicted_classes

  def predict_embedder(self, model_name, recording_path, proclen=0):
    import torch

    embedder = self.get_embedder(model_name)
    if not getattr(embedder.model, "bool_classifier", False):
      raise ValueError(f"{model_name} does not provide pretrained class predictions.")

    embedder.model.classifier_outputs = torch.tensor([])
    with trimmed_audio(recording_path, proclen) as inference_path:
      embedder.get_embeddings_from_model(inference_path)

    probabilities = embedder.model.classifier_outputs
    classes = list(embedder.model.classes)
    if not isinstance(probabilities, torch.Tensor):
      probabilities = torch.as_tensor(probabilities)
    if probabilities.numel() == 0:
      raise RuntimeError(f"{model_name} returned no classifier outputs.")
    if probabilities.ndim == 1:
      probabilities = probabilities.unsqueeze(0)

    if probabilities.shape[-1] == len(classes):
      segment_probabilities = probabilities
    elif probabilities.shape[0] == len(classes):
      segment_probabilities = probabilities.swapaxes(0, 1)
    else:
      raise RuntimeError(f"{model_name} returned classifier outputs with unexpected shape.")

    return self.build_classification(
      model_name,
      segment_probabilities.cpu().numpy(),
      classes,
    )

  def build_classification(self, model_name, segment_probabilities, classes):
    classes = list(classes)
    segment_probabilities = np.asarray(segment_probabilities)
    if segment_probabilities.ndim == 1:
      segment_probabilities = segment_probabilities.reshape(1, -1)

    if model_name == "batdetect2_dets_avg":
      mean_probabilities = segment_probabilities.max(axis=0)
    else:
      mean_probabilities = segment_probabilities.mean(axis=0)
    if model_name in MULTILABEL_MODEL_NAMES:
      labels = np.flatnonzero(mean_probabilities > MULTILABEL_THRESHOLD).tolist()
      labels.sort(key=lambda index: mean_probabilities[index], reverse=True)
      labels = [int(index) for index in labels]
    else:
      labels = [int(np.argmax(mean_probabilities))]

    if model_name in {"bat", "bat2"}:
      classes_short = canonical_bat_labels(classes)
    elif model_name == "batdetect2_dets_avg":
      classes_short = canonical_bat_labels(classes)
    else:
      classes_short = [make_short_label(label) for label in classes]

    classification = {
      "prediction": mean_probabilities.tolist(),
      "labels": labels,
      "classifier_key": classifier_key(model_name),
      "classes": classes,
      "classes_short": classes_short,
    }
    predicted_classes = [classes_short[index] for index in labels if 0 <= index < len(classes_short)]
    return classification, predicted_classes

  def get_embedder(self, model_name):
    if model_name not in TENSORFLOW_MODEL_NAMES:
      prime_bacpipe_non_tf_compat()

    bacpipe = load_bacpipe()
    if bacpipe is None:
      raise RuntimeError("bacpipe is not installed.")

    resolve_runtime(model_name)

    if model_name not in self.embedders:
      bacpipe.settings.run_pretrained_classifier = True
      bacpipe.settings.device = "cpu"
      bacpipe.ensure_models_exist(bacpipe.settings.model_base_path, [model_name])
      embedder_settings = {
        key: value
        for key, value in vars(bacpipe.settings).items()
        if key != "classifier_threshold"
      }
      self.embedders[model_name] = bacpipe.Embedder(
        model_name,
        classifier_threshold=bacpipe.settings.classifier_threshold,
        **embedder_settings,
      )

    return self.embedders[model_name]

  def get_bat2_model(self):
    if self.bat2_model is None:
      from backend.inference.bacpipe_bat_adapter import (
        BAT2_CHECKPOINT_PATH,
        BacpipeBat2Classifier,
        get_bat_class_labels,
      )

      if not BAT2_CHECKPOINT_PATH.is_file():
        raise RuntimeError(f"BAT2 checkpoint not found: {BAT2_CHECKPOINT_PATH}")

      self.bat2_model = BacpipeBat2Classifier(
        checkpoint_path=BAT2_CHECKPOINT_PATH,
        class_count=len(get_bat_class_labels()),
      )

    return self.bat2_model

  def predict_with_worker(self, python_path, model_name, recording_path, proclen=0):
    completed = subprocess.run(
      [
        str(python_path),
        "-m",
        "backend.inference.bacpipe_worker",
        model_name,
        recording_path,
        str(proclen),
      ],
      capture_output=True,
      text=True,
      cwd=worker_subprocess_cwd(python_path),
      env=worker_subprocess_env(python_path),
      check=False,
    )
    if completed.returncode != 0:
      stderr = completed.stderr.strip()
      stdout = completed.stdout.strip()
      raise RuntimeError(stderr or stdout or "Bacpipe worker process failed.")

    payload = parse_worker_payload(completed.stdout)
    return payload["classification"], payload["classes"]

  def get_classes_with_worker(self, python_path, model_name):
    completed = subprocess.run(
      [
        str(python_path),
        "-m",
        "backend.inference.bacpipe_worker",
        "--classes",
        model_name,
      ],
      capture_output=True,
      text=True,
      cwd=worker_subprocess_cwd(python_path),
      env=worker_subprocess_env(python_path),
      check=False,
    )
    if completed.returncode != 0:
      stderr = completed.stderr.strip()
      stdout = completed.stdout.strip()
      raise RuntimeError(stderr or stdout or "Bacpipe worker process failed.")

    try:
      payload = json.loads(completed.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
      raise RuntimeError("Bacpipe worker returned invalid class metadata.") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("classes"), list):
      raise RuntimeError("Bacpipe worker returned invalid class metadata.")
    return payload
