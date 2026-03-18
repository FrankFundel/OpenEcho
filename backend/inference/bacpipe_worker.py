from contextlib import redirect_stdout
import json
import sys

from backend.inference.bacpipe_provider import BacpipeClassifierService


def main():
  if len(sys.argv) not in {3, 4}:
    raise SystemExit(
      "Usage: python -m backend.inference.bacpipe_worker <model-name> <recording-path> [proclen]"
    )

  model_name = sys.argv[1]
  recording_path = sys.argv[2]
  proclen = float(sys.argv[3]) if len(sys.argv) == 4 else 0

  service = BacpipeClassifierService()
  with redirect_stdout(sys.stderr):
    classification, classes = service.predict_in_process(
      model_name,
      recording_path,
      proclen=proclen,
    )
  sys.stdout.write(json.dumps({"classification": classification, "classes": classes}))
  sys.stdout.write("\n")
  sys.stdout.flush()


if __name__ == "__main__":
  main()
