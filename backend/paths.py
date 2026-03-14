from pathlib import Path
import os
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]


def resource_root():
  override = os.environ.get("OPENECHO_RESOURCE_DIR")
  if override:
    return Path(override).expanduser().resolve()

  bundled_root = getattr(sys, "_MEIPASS", None)
  if bundled_root:
    return Path(bundled_root).resolve()

  return REPO_ROOT


def data_root():
  override = os.environ.get("OPENECHO_DATA_DIR")
  if override:
    root = Path(override).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root

  root = REPO_ROOT / ".openecho"
  root.mkdir(parents=True, exist_ok=True)
  return root


def resource_path(*parts):
  return resource_root().joinpath(*parts)


def data_path(*parts):
  root = data_root()
  root.mkdir(parents=True, exist_ok=True)
  return root.joinpath(*parts)
