import csv
import os
from datetime import datetime


def parse_metadata_file(path):
  metadata = {}

  try:
    with open(path, newline="", encoding="utf-8-sig") as csvfile:
      reader = csv.reader(csvfile, delimiter=",")
      next(reader, None)

      for row in reader:
        if len(row) <= 24:
          continue

        try:
          title = row[2].strip()
          species = row[24].strip()
          timestamp = datetime.strptime(
            f"{row[4]} {row[5]}", "%Y-%m-%d %H:%M:%S"
          ).timestamp() * 1000
          temperature = float(row[12])
          latitude = float(row[10])
          longitude = float(row[11])
        except (TypeError, ValueError):
          continue

        metadata[title] = {
          "species": species,
          "timestamp": timestamp,
          "temp": temperature,
          "loc": [latitude, longitude],
        }
  except OSError:
    return {}

  return metadata


def apply_metadata_to_recordings(recordings, metadata):
  matched_recordings = 0

  for recording in recordings:
    recording_metadata = metadata.get(recording.get("title"))
    if not recording_metadata:
      continue

    recording["temperature"] = recording_metadata["temp"]
    recording["date"] = recording_metadata["timestamp"]
    recording["location"]["latitude"] = recording_metadata["loc"][0]
    recording["location"]["longitude"] = recording_metadata["loc"][1]
    if recording_metadata["species"]:
      recording["species"] = recording_metadata["species"]
    matched_recordings += 1

  return matched_recordings


def apply_metadata_file(recordings, path):
  metadata = parse_metadata_file(path)
  if not metadata:
    return 0
  return apply_metadata_to_recordings(recordings, metadata)


def find_metadata_files_for_paths(paths):
  directories = sorted({os.path.dirname(path) for path in paths if path})
  metadata_files = []

  for directory in directories:
    if not os.path.isdir(directory):
      continue

    for filename in sorted(os.listdir(directory)):
      if filename.lower().endswith(".csv"):
        metadata_files.append(os.path.join(directory, filename))

  return metadata_files


def auto_apply_metadata(recordings, paths):
  merged_metadata = {}
  used_files = []

  for path in find_metadata_files_for_paths(paths):
    metadata = parse_metadata_file(path)
    if not metadata:
      continue
    merged_metadata.update(metadata)
    used_files.append(path)

  matched_recordings = apply_metadata_to_recordings(recordings, merged_metadata)
  return {
    "metadata_files": len(used_files),
    "matched_recordings": matched_recordings,
    "metadata_paths": used_files,
  }
