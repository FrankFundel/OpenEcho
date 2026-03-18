# OpenEcho

OpenEcho is a [Code4Conservation](https://www.code4conservation.de/) project.

It is a desktop app for reviewing, organizing, and classifying long-duration bioacoustic recordings. The app combines a React frontend, a Python backend, and a Tauri desktop shell.

## ✨ Highlights

- Organize recordings in local projects
- Browse spectrograms and waveform previews
- Play selected windows at different expansion rates
- Run BacPipe classifier models, including `BAT`
- Export project results as CSV

## 🧱 Stack

- Frontend: React 18, Material UI, custom WebGL2 charts
- Backend: FastAPI, Librosa, SoundFile, PyTorch
- Desktop shell: Tauri 2
- Packaging: PyInstaller for the Python sidecar

## 🚀 Quick Start

Requirements:

- Python 3.11+
- Node.js 18+
- Rust toolchain with `cargo`
- macOS: Xcode Command Line Tools (`xcode-select --install`)

Install dependencies:

```bash
pip install -r requirements.txt
npm install --legacy-peer-deps
```

Run the full desktop app in development:

```bash
npm run tauri:dev
```

If you only want the backend:

```bash
python main.py --reload --port 8420
```

## 📦 Build

Create the packaged desktop app:

```bash
npm run tauri:build
```

This will:

1. build the React frontend
2. package the Python backend with PyInstaller
3. bundle everything into the Tauri desktop app

## 🦇 Model Support

OpenEcho uses [`bacpipe`](https://pypi.org/project/bacpipe/) for classifier models.

- `BAT` uses BacPipe's built-in BAT model
- `BAT2` is included as an additional local model adapter
- some TensorFlow-based BacPipe models run in a separate worker environment

If you want the TensorFlow worker models, create the optional `.venv-tf/` environment:

```bash
bash scripts/setup_tf_worker.sh
```

## 💾 Local Data

OpenEcho stores local app data in:

```text
.openecho/
```

Important files:

- `.openecho/projects.sqlite3` for projects and metadata
- `.openecho/classifications/` for compressed prediction vectors

If an older `.openecho/projects.json` exists, OpenEcho migrates it automatically on first launch and keeps a `.migrated` backup.

## 📚 Citation

If you use OpenEcho in research, please cite the underlying tooling and models:

- BacPipe: V. S. Kather, B. Ghani, and D. Stowell, *Clustering and novel class recognition: evaluating bioacoustic deep learning feature extractors* (2025). https://arxiv.org/abs/2504.06710
- BAT: F. Fundel, D. A. Braun, and S. Gottwald, *Automatic Bat Call Classification using Transformer Networks* (2023). https://arxiv.org/abs/2309.11218

## 🧹 Notes

- The optional `.venv-tf/` worker is only needed for BacPipe models that require TensorFlow.
- Local project data stays in `.openecho/`, so your recordings and absolute paths are not meant to be committed to Git.
