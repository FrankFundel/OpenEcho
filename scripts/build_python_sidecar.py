from pathlib import Path
import os
import shutil


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build-pyinstaller"
DIST_DIR = ROOT / "dist-pyinstaller"
EXCLUDED_MODULES = [
  "bacpipe",
  "bokeh",
  "botocore",
  "cv2",
  "flax",
  "flaxlib",
  "gevent",
  "hf_xet",
  "huggingface_hub",
  "IPython",
  "jax",
  "jaxlib",
  "jedi",
  "keras",
  "matplotlib",
  "nltk",
  "onnx",
  "onnxruntime",
  "openpyxl",
  "pandas",
  "panel",
  "playwright",
  "plotly",
  "pyarrow",
  "sqlalchemy",
  "sentencepiece",
  "sklearn",
  "tensorboard",
  "tensorstore",
  "tensorflow",
  "tensorflow_estimator",
  "tensorflow_io_gcs_filesystem",
  "timm",
  "tokenizers",
  "torchaudio",
  "torchvision",
  "transformers",
  "yt_dlp",
  "zmq",
]
TF_WORKER_DIR = ROOT / ".venv-tf"
BACKEND_SOURCE_DIR = ROOT / "backend"
WORKER_STRIP_PATTERNS = [
  "flax*",
  "jax*",
  "pip*",
  "setuptools*",
  "tensorstore*",
]


def data_arg(path, destination):
  separator = ";" if os.name == "nt" else ":"
  return f"{path}{separator}{destination}"


def add_data_if_exists(pyinstaller_args, path, destination):
  path = Path(path)
  if not path.exists():
    return
  pyinstaller_args.extend(["--add-data", data_arg(path, destination)])


def remove_path(path):
  path = Path(path)
  if not path.exists():
    return False
  if path.is_dir() and not path.is_symlink():
    shutil.rmtree(path)
  else:
    path.unlink()
  return True


def worker_site_packages_dir(venv_root):
  windows_site_packages = Path(venv_root) / "Lib" / "site-packages"
  if windows_site_packages.is_dir():
    return windows_site_packages

  lib_dir = Path(venv_root) / "lib"
  for candidate in sorted(lib_dir.glob("python*/site-packages")):
    if candidate.is_dir():
      return candidate

  return None


def overlay_worker_bat_support(site_packages):
  try:
    import bacpipe
  except ImportError:
    print("Main bacpipe install not found; skipping BAT worker overlay.")
    return

  source_root = Path(bacpipe.__file__).resolve().parent
  overlay_items = [
    (
      source_root / "embedding_generation_pipelines" / "feature_extractors" / "bat.py",
      site_packages / "bacpipe" / "embedding_generation_pipelines" / "feature_extractors" / "bat.py",
    ),
    (
      source_root / "model_specific_utils" / "bat",
      site_packages / "bacpipe" / "model_specific_utils" / "bat",
    ),
  ]

  for source_path, target_path in overlay_items:
    if not source_path.exists():
      print(f"Skipping missing BAT overlay source: {source_path}")
      continue

    target_path.parent.mkdir(parents=True, exist_ok=True)
    remove_path(target_path)
    if source_path.is_dir():
      shutil.copytree(
        source_path,
        target_path,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
      )
    else:
      shutil.copy2(source_path, target_path)


def slim_tf_worker(target_dir):
  for child_name in ("etc", "include", "share"):
    remove_path(Path(target_dir) / child_name)

  site_packages = worker_site_packages_dir(target_dir)
  if site_packages is None:
    print(f"Could not find site-packages inside {target_dir}; skipping worker slimming.")
    return

  remove_path(site_packages / "bacpipe" / "model_checkpoints")

  for pattern in WORKER_STRIP_PATTERNS:
    for path in sorted(site_packages.glob(pattern)):
      remove_path(path)

  overlay_worker_bat_support(site_packages)


def copy_tf_worker_if_present(backend_dir):
  if not TF_WORKER_DIR.exists():
    print(f"TensorFlow worker not found at {TF_WORKER_DIR}; bundled app will use the reduced backend.")
    return

  target_dir = backend_dir / ".venv-tf"
  if target_dir.exists():
    shutil.rmtree(target_dir)

  shutil.copytree(
    TF_WORKER_DIR,
    target_dir,
    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
  )

  slim_tf_worker(target_dir)

  if os.name == "nt":
    worker_python = target_dir / "Scripts" / "python.exe"
  else:
    worker_python = target_dir / "bin" / "python"

  if worker_python.is_file() and os.name != "nt":
    worker_python.chmod(0o755)

  print(f"Bundled TensorFlow worker: {worker_python}")


def copy_worker_source_if_present(backend_dir):
  if not BACKEND_SOURCE_DIR.is_dir():
    return

  target_root = backend_dir / "worker-src"
  target_dir = target_root / "backend"
  if target_root.exists():
    shutil.rmtree(target_root)

  shutil.copytree(
    BACKEND_SOURCE_DIR,
    target_dir,
    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
  )

  print(f"Bundled TensorFlow worker source: {target_root}")


def executable_name():
  return "openecho-backend.exe" if os.name == "nt" else "openecho-backend"


def build_binary():
  try:
    import PyInstaller.__main__
  except ImportError as error:
    raise SystemExit(
      "PyInstaller is required to package the Python backend. Install it with `pip install pyinstaller`."
    ) from error

  BUILD_DIR.mkdir(exist_ok=True)
  DIST_DIR.mkdir(exist_ok=True)

  pyinstaller_args = [
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name",
    "openecho-backend",
    "--additional-hooks-dir",
    str(ROOT / "scripts" / "pyinstaller_hooks"),
    "--distpath",
    str(DIST_DIR),
    "--workpath",
    str(BUILD_DIR),
    "--specpath",
    str(BUILD_DIR),
    "--hidden-import",
    "uvicorn.logging",
    "--hidden-import",
    "uvicorn.loops.auto",
    "--hidden-import",
    "uvicorn.protocols.http.auto",
    "--hidden-import",
    "uvicorn.protocols.websockets.auto",
  ]

  for module_name in EXCLUDED_MODULES:
    pyinstaller_args.extend(["--exclude-module", module_name])

  add_data_if_exists(pyinstaller_args, ROOT / "models" / "BigBAT.pth", "models")
  pyinstaller_args.append(str(ROOT / "main.py"))

  PyInstaller.__main__.run(pyinstaller_args)

  backend_dir = DIST_DIR / "openecho-backend"
  backend_executable = backend_dir / executable_name()
  if os.name != "nt" and backend_executable.is_file():
    backend_executable.chmod(0o755)

  copy_tf_worker_if_present(backend_dir)
  copy_worker_source_if_present(backend_dir)

  print(f"Built backend bundle: {backend_dir}")
  print(f"Backend executable: {backend_executable}")


if __name__ == "__main__":
  build_binary()
