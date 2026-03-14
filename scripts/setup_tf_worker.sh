#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python3 -m venv .venv-tf

./.venv-tf/bin/pip install --upgrade pip setuptools wheel
./.venv-tf/bin/pip install tensorflow
./.venv-tf/bin/pip install 'bacpipe @ git+https://github.com/bioacoustic-ai/bacpipe.git@55248998654fc2376c75615c20f373a4265b00ee'

# The Metal plugin fails to load in this conda-backed Python setup, and pyarrow
# crashes during the pandas path Keras touches on import. CPU TensorFlow works.
./.venv-tf/bin/pip uninstall -y tensorflow-metal pyarrow pyarrow-hotfix || true

./.venv-tf/bin/python - <<'PY'
import tensorflow as tf
import bacpipe
print("TensorFlow worker ready.")
print("tensorflow", tf.__version__)
print("bacpipe models", len(bacpipe.supported_models))
PY
