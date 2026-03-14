import argparse

import uvicorn

from backend.server import app


def parse_args():
  parser = argparse.ArgumentParser(description="Run the OpenEcho backend API.")
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=8420)
  parser.add_argument("--reload", action="store_true")
  return parser.parse_args()


if __name__ == "__main__":
  args = parse_args()
  target = "backend.server:app" if args.reload else app
  uvicorn.run(target, host=args.host, port=args.port, reload=args.reload)
