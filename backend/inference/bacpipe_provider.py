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

from backend.paths import resource_root


CLASSIFIER_MODEL_NAMES = {
  "audioprotopnet",
  "bat",
  "birdnet",
  "convnext_birdset",
  "google_whale",
  "perch_bird",
  "perch_v2",
  "surfperch",
  "bat2",
}
MULTILABEL_MODEL_NAMES = {
  "bat",
  "bat2",
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
MODEL_ORDER_PRIORITY = {
  "bat": 0,
  "bat2": 1,
}
MULTILABEL_THRESHOLD = 0.5
REPO_ROOT = resource_root()
DEFAULT_TF_VENV_PYTHON = REPO_ROOT / ".venv-tf" / "bin" / "python"
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


@lru_cache(maxsize=1)
def load_bacpipe():
  if os.environ.get("OPENECHO_DISABLE_BACPIPE") == "1":
    return None

  try:
    import bacpipe
  except ImportError:  # pragma: no cover - optional dependency
    return None

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

  worker_source_root = resolve_worker_source_root(python_path)
  if worker_source_root is not None:
    env["PYTHONPATH"] = str(worker_source_root)

  return env


def worker_subprocess_cwd(python_path):
  worker_source_root = resolve_worker_source_root(python_path)
  return str(worker_source_root or REPO_ROOT)


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
  if tensorflow_ready or "bacpipe.embedding_generation_pipelines.utils" in sys.modules:
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
    importlib.import_module("bacpipe.embedding_generation_pipelines.utils")
  finally:
    if previous_tensorflow is None:
      sys.modules.pop("tensorflow", None)
    else:
      sys.modules["tensorflow"] = previous_tensorflow


def get_bacpipe_model_names(classifier_only=True):
  bacpipe = load_bacpipe()
  model_names = set()

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

  if load_bacpipe() is None:
    return False

  if model_name in TENSORFLOW_MODEL_NAMES:
    worker_python = resolve_tf_python()
    if worker_python and worker_python.is_file():
      return True
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

    classes = []
    classes_short = []

    if model_name in {"bat", "bat2"}:
      from backend.inference.bacpipe_bat_adapter import (
        get_bat_class_labels,
        get_bat_class_short_labels,
      )

      classes = get_bat_class_labels()
      classes_short = get_bat_class_short_labels()

    classifiers.append(
      {
        "key": classifier_key(model_name),
        "name": display_name(model_name),
        "provider": "bacpipe",
        "provider_label": provider_label(model_name),
        "model_name": model_name,
        "classes": classes,
        "classes_short": classes_short,
      }
    )
  return classifiers


def resolve_runtime(model_name):
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

  def predict(self, classifier_config, recording_path, proclen=0):
    model_name = classifier_config["model_name"]
    runtime, worker_python = resolve_runtime(model_name)
    if runtime == "worker":
      return self.predict_with_worker(worker_python, model_name, recording_path, proclen)
    return self.predict_in_process(model_name, recording_path, proclen=proclen)

  def predict_in_process(self, model_name, recording_path, proclen=0):
    if model_name == "bat2":
      from backend.inference.bacpipe_bat_adapter import get_bat_class_labels

      segment_probabilities = self.get_bat2_model().predict(recording_path, proclen=proclen)
      return self.build_classification("bat2", segment_probabilities, get_bat_class_labels())

    return self.predict_embedder(model_name, recording_path, proclen=proclen)

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

    mean_probabilities = segment_probabilities.mean(axis=0)
    if model_name in MULTILABEL_MODEL_NAMES:
      labels = np.flatnonzero(mean_probabilities > MULTILABEL_THRESHOLD).tolist()
      labels.sort(key=lambda index: mean_probabilities[index], reverse=True)
      labels = [int(index) for index in labels]
    else:
      labels = [int(np.argmax(mean_probabilities))]

    if model_name in {"bat", "bat2"}:
      from backend.inference.bacpipe_bat_adapter import (
        get_bat_class_labels,
        get_bat_class_short_labels,
      )

      short_label_by_class = dict(zip(get_bat_class_labels(), get_bat_class_short_labels()))
      classes_short = [short_label_by_class.get(label, make_short_label(label)) for label in classes]
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
