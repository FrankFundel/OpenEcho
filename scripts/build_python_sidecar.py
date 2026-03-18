from pathlib import Path
import os
import shutil


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build-pyinstaller"
DIST_DIR = ROOT / "dist-pyinstaller"
EXCLUDED_MODULES = [
  "botocore",
  "cv2",
  "gevent",
  "IPython",
  "jax",
  "jaxlib",
  "jedi",
  "keras",
  "nltk",
  "onnx",
  "onnxruntime",
  "openpyxl",
  "playwright",
  "plotly",
  "sqlalchemy",
  "tensorboard",
  "tensorflow",
  "tensorflow_estimator",
  "tensorflow_io_gcs_filesystem",
  "yt_dlp",
  "zmq",
]
TF_WORKER_DIR = ROOT / ".venv-tf"
BACKEND_SOURCE_DIR = ROOT / "backend"


def data_arg(path, destination):
  separator = ";" if os.name == "nt" else ":"
  return f"{path}{separator}{destination}"


def add_data_if_exists(pyinstaller_args, path, destination):
  path = Path(path)
  if not path.exists():
    return
  pyinstaller_args.extend(["--add-data", data_arg(path, destination)])


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
