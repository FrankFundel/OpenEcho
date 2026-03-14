from pathlib import Path
import os


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build-pyinstaller"
DIST_DIR = ROOT / "dist-pyinstaller"
EXCLUDED_MODULES = [
  "botocore",
  "bokeh",
  "cv2",
  "gevent",
  "IPython",
  "jax",
  "jaxlib",
  "jedi",
  "jsonschema",
  "jsonschema_specifications",
  "jupyter_client",
  "jupyter_core",
  "keras",
  "matplotlib",
  "nbconvert",
  "nbformat",
  "nltk",
  "onnx",
  "onnxruntime",
  "openpyxl",
  "pandas",
  "panel",
  "playwright",
  "plotly",
  "sklearn",
  "sqlalchemy",
  "tensorboard",
  "tensorflow",
  "tensorflow_estimator",
  "tensorflow_io_gcs_filesystem",
  "timm",
  "torchvision",
  "traitlets",
  "transformers",
  "yt_dlp",
  "zmq",
]


def data_arg(path, destination):
  separator = ";" if os.name == "nt" else ":"
  return f"{path}{separator}{destination}"


def add_data_if_exists(pyinstaller_args, path, destination):
  path = Path(path)
  if not path.exists():
    return
  pyinstaller_args.extend(["--add-data", data_arg(path, destination)])


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

  pyinstaller_args.append(str(ROOT / "main.py"))

  PyInstaller.__main__.run(pyinstaller_args)

  backend_dir = DIST_DIR / "openecho-backend"
  backend_executable = backend_dir / executable_name()
  if os.name != "nt" and backend_executable.is_file():
    backend_executable.chmod(0o755)

  print(f"Built backend bundle: {backend_dir}")
  print(f"Backend executable: {backend_executable}")


if __name__ == "__main__":
  build_binary()
