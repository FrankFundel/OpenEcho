from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import uuid


AOEF_VERSION = "1.1.0"
ANNOTATION_CLASSIFIER_KEY = "whombat:annotations"
UUID_NAMESPACE = uuid.UUID("7f5f0b12-7140-4bd6-8221-fc84ac2145e6")


def _now_iso():
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _stable_uuid(*parts):
  text = "::".join(str(part) for part in parts if part is not None)
  return str(uuid.uuid5(UUID_NAMESPACE, text))


def _split_species(value):
  if not isinstance(value, str):
    return []
  return [
    item.strip()
    for item in value.split(",")
    if item.strip()
  ]


def _finite_number(value, default=None):
  try:
    number = float(value)
  except (TypeError, ValueError):
    return default
  return number if math.isfinite(number) else default


def _recording_datetime_parts(recording):
  timestamp = _finite_number(recording.get("date"))
  if timestamp is None or timestamp <= 0:
    return None, None

  date = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc)
  return date.date().isoformat(), date.time().replace(microsecond=0).isoformat()


def _common_audio_root(recordings):
  parent_paths = []
  for recording in recordings:
    path = recording.get("path")
    if not isinstance(path, str) or not path:
      continue
    try:
      parent_paths.append(Path(path).expanduser().resolve().parent)
    except OSError:
      continue

  if not parent_paths:
    return None

  try:
    return Path(os.path.commonpath([str(path) for path in parent_paths]))
  except ValueError:
    return None


def _aoef_recording_path(path, audio_root):
  if not path:
    return ""

  source_path = Path(path).expanduser()
  if audio_root is None:
    return str(source_path)

  try:
    return str(source_path.resolve().relative_to(audio_root))
  except (OSError, ValueError):
    return str(source_path)


def _add_tag(tags, tag_ids_by_key, key, value):
  value = str(value or "").strip()
  if not key or not value:
    return None

  tag_key = (str(key), value)
  existing_id = tag_ids_by_key.get(tag_key)
  if existing_id is not None:
    return existing_id

  tag_id = len(tags)
  tag_ids_by_key[tag_key] = tag_id
  tags.append({
    "id": tag_id,
    "key": str(key),
    "value": value,
  })
  return tag_id


def _recording_uuid(project_index, recording_index, recording):
  return _stable_uuid(
    "recording",
    project_index,
    recording.get("path") or recording_index,
    recording.get("date") or "",
    recording.get("size") or "",
  )


def _recording_duration(recording, boxes=None):
  duration = _finite_number(recording.get("duration"))
  if duration is not None and duration >= 0:
    return duration

  max_box_end = 0
  for box in boxes or []:
    max_box_end = max(max_box_end, _finite_number(box.get("end"), 0) or 0)
  return max_box_end


def _iter_classification_boxes(recording):
  seen_boxes = set()

  def emit(classification, box):
    normalized = _normalize_box(box)
    if normalized is None:
      return None
    key = (
      normalized["start"],
      normalized["end"],
      normalized["low_freq"],
      normalized["high_freq"],
      normalized.get("label") or "",
      classification.get("classifier_key") or "",
    )
    if key in seen_boxes:
      return None
    seen_boxes.add(key)
    return box

  classifications = recording.get("classifications")
  if isinstance(classifications, list):
    for classification in classifications:
      if not isinstance(classification, dict):
        continue
      for box in classification.get("boxes") or []:
        if isinstance(box, dict) and emit(classification, box) is not None:
          yield classification, box

  classification = recording.get("classification")
  if isinstance(classification, dict):
    for box in classification.get("boxes") or []:
      if isinstance(box, dict) and emit(classification, box) is not None:
        yield classification, box


def _normalize_box(box):
  start = _finite_number(box.get("start"))
  end = _finite_number(box.get("end"))
  low_freq = _finite_number(box.get("low_freq"))
  high_freq = _finite_number(box.get("high_freq"))
  if (
    start is None or
    end is None or
    low_freq is None or
    high_freq is None or
    end <= start or
    high_freq <= low_freq
  ):
    return None

  normalized = {
    "start": start,
    "end": end,
    "low_freq": low_freq,
    "high_freq": high_freq,
  }

  for field_name in ("score", "class_score"):
    value = _finite_number(box.get(field_name))
    if value is not None:
      normalized[field_name] = value

  if box.get("label"):
    normalized["label"] = str(box["label"]).strip()

  return normalized


def project_to_whombat_aoef(project, project_index=0):
  created_on = _now_iso()
  project_uuid = _stable_uuid(
    "annotation_project",
    project_index,
    project.get("title") or "",
    project.get("creation_date") or "",
  )
  recordings = list(project.get("recordings") or [])
  audio_root = _common_audio_root(recordings)

  tags = []
  tag_ids_by_key = {}
  aoef_recordings = []
  sound_events = []
  sound_event_annotations = []
  clips = []
  clip_annotations = []
  tasks = []
  project_tag_ids = set()
  recording_uuids = {}
  boxes_by_recording = {}

  for recording_index, recording in enumerate(recordings):
    rec_uuid = _recording_uuid(project_index, recording_index, recording)
    recording_uuids[recording_index] = rec_uuid

    recording_tag_ids = []
    for species in _split_species(recording.get("species")):
      tag_id = _add_tag(tags, tag_ids_by_key, "species", species)
      if tag_id is not None:
        recording_tag_ids.append(tag_id)
        project_tag_ids.add(tag_id)

    temperature = _finite_number(recording.get("temperature"))
    features = {}
    if temperature is not None:
      features["temperature"] = temperature

    date, time = _recording_datetime_parts(recording)
    boxes = []
    for classification, raw_box in _iter_classification_boxes(recording):
      box = _normalize_box(raw_box)
      if box is None:
        continue
      if not box.get("label"):
        labels = classification.get("labels")
        classes_short = classification.get("classes_short")
        if isinstance(labels, list) and labels:
          label_index = int(labels[0])
          if isinstance(classes_short, list) and 0 <= label_index < len(classes_short):
            box["label"] = str(classes_short[label_index])
      boxes.append(box)
    boxes_by_recording[recording_index] = boxes

    samplerate = _finite_number(recording.get("samplerate"), 0) or 0

    aoef_recordings.append({
      "uuid": rec_uuid,
      "path": _aoef_recording_path(recording.get("path"), audio_root),
      "duration": _recording_duration(recording, boxes),
      "channels": 1,
      "samplerate": int(samplerate),
      "time_expansion": None,
      "hash": None,
      "date": date,
      "time": time,
      "latitude": recording.get("location", {}).get("latitude"),
      "longitude": recording.get("location", {}).get("longitude"),
      "tags": recording_tag_ids or None,
      "features": features or None,
      "notes": None,
      "owners": [],
      "rights": None,
    })

  for recording_index, recording in enumerate(recordings):
    rec_uuid = recording_uuids[recording_index]
    duration = _recording_duration(recording, boxes_by_recording.get(recording_index))
    clip_uuid = _stable_uuid("clip", rec_uuid, 0, duration)
    clip_annotation_uuid = _stable_uuid("clip_annotation", clip_uuid)
    annotation_uuids = []

    if duration > 0:
      clips.append({
        "uuid": clip_uuid,
        "recording": rec_uuid,
        "start_time": 0,
        "end_time": duration,
        "features": None,
      })

    for box_index, box in enumerate(boxes_by_recording.get(recording_index) or []):
      sound_event_uuid = _stable_uuid("sound_event", rec_uuid, box_index, box)
      annotation_uuid = _stable_uuid("sound_event_annotation", sound_event_uuid)
      features = {
        "low_freq": box["low_freq"],
        "high_freq": box["high_freq"],
        "bandwidth": box["high_freq"] - box["low_freq"],
        "duration": box["end"] - box["start"],
      }
      if "score" in box:
        features["score"] = box["score"]
      if "class_score" in box:
        features["class_score"] = box["class_score"]

      annotation_tag_ids = []
      if box.get("label"):
        tag_id = _add_tag(tags, tag_ids_by_key, "species", box["label"])
        if tag_id is not None:
          annotation_tag_ids.append(tag_id)
          project_tag_ids.add(tag_id)

      sound_events.append({
        "uuid": sound_event_uuid,
        "recording": rec_uuid,
        "geometry": {
          "type": "BoundingBox",
          "coordinates": [
            box["start"],
            box["low_freq"],
            box["end"],
            box["high_freq"],
          ],
        },
        "features": features,
      })
      sound_event_annotations.append({
        "uuid": annotation_uuid,
        "sound_event": sound_event_uuid,
        "notes": None,
        "tags": annotation_tag_ids or None,
        "created_by": None,
        "created_on": created_on,
      })
      annotation_uuids.append(annotation_uuid)

    if duration > 0:
      clip_annotations.append({
        "uuid": clip_annotation_uuid,
        "clip": clip_uuid,
        "tags": None,
        "sound_events": annotation_uuids or None,
        "sequences": None,
        "notes": None,
        "created_on": created_on,
      })
      tasks.append({
        "uuid": _stable_uuid("annotation_task", clip_uuid),
        "clip": clip_uuid,
        "status_badges": [],
        "created_on": created_on,
      })

  return {
    "version": AOEF_VERSION,
    "created_on": created_on,
    "data": {
      "uuid": project_uuid,
      "collection_type": "annotation_project",
      "users": [],
      "tags": tags,
      "recordings": aoef_recordings,
      "sound_events": sound_events,
      "sequences": None,
      "clips": clips,
      "sound_event_annotations": sound_event_annotations,
      "sequence_annotations": None,
      "clip_annotations": clip_annotations,
      "created_on": created_on,
      "name": project.get("title") or "OpenEcho Project",
      "description": project.get("description") or "",
      "instructions": (
        "Imported from OpenEcho. Bounding boxes represent OpenEcho "
        "classification or annotation regions."
      ),
      "project_tags": sorted(project_tag_ids) or None,
      "tasks": tasks,
    },
  }


def export_project(project, project_index, path):
  aoef_object = project_to_whombat_aoef(project, project_index=project_index)
  target_path = Path(path).expanduser()
  target_path.parent.mkdir(parents=True, exist_ok=True)
  with target_path.open("w", encoding="utf-8") as file:
    json.dump(aoef_object, file, separators=(",", ":"))
  return True


def _load_aoef(path):
  source_path = Path(path).expanduser()
  with source_path.open("r", encoding="utf-8") as file:
    payload = json.load(file)
  data = payload.get("data") if isinstance(payload, dict) else None
  if not isinstance(data, dict):
    raise ValueError("The file is not a Whombat AOEF JSON object.")
  return source_path, data


def _resolve_import_path(path, source_dir):
  if not path:
    return ""

  recording_path = Path(str(path)).expanduser()
  if recording_path.is_absolute():
    return str(recording_path)

  candidate = (source_dir / recording_path).resolve()
  if candidate.exists():
    return str(candidate)

  return str(recording_path)


def _tag_lookup(data):
  lookup = {}
  for tag in data.get("tags") or []:
    if not isinstance(tag, dict):
      continue
    tag_id = tag.get("id")
    key = tag.get("key")
    value = tag.get("value")
    if tag_id is not None and key and value is not None:
      lookup[tag_id] = {"key": str(key), "value": str(value)}
  return lookup


def _species_from_tag_ids(tag_ids, tags):
  species = []
  for tag_id in tag_ids or []:
    tag = tags.get(tag_id)
    if not tag:
      continue
    if tag["key"] == "species" and tag["value"] not in species:
      species.append(tag["value"])
  return species


def _box_from_sound_event(sound_event):
  geometry = sound_event.get("geometry")
  if not isinstance(geometry, dict):
    return None
  if str(geometry.get("type") or "").lower() != "boundingbox":
    return None

  coordinates = geometry.get("coordinates")
  if not isinstance(coordinates, list) or len(coordinates) != 4:
    return None

  box = _normalize_box({
    "start": coordinates[0],
    "low_freq": coordinates[1],
    "end": coordinates[2],
    "high_freq": coordinates[3],
  })
  if box is None:
    return None

  features = sound_event.get("features")
  if isinstance(features, dict):
    for field_name in ("score", "class_score"):
      value = _finite_number(features.get(field_name))
      if value is not None:
        box[field_name] = value
  return box


def import_project(path):
  source_path, data = _load_aoef(path)
  tags = _tag_lookup(data)
  recording_entries = data.get("recordings") or []
  recordings = []
  recording_index_by_uuid = {}

  for recording_index, recording in enumerate(recording_entries):
    if not isinstance(recording, dict):
      continue
    rec_uuid = recording.get("uuid")
    if rec_uuid:
      recording_index_by_uuid[str(rec_uuid)] = len(recordings)

    species = _species_from_tag_ids(recording.get("tags"), tags)
    date = recording.get("date")
    time = recording.get("time")
    timestamp = 0
    if date:
      try:
        timestamp = datetime.fromisoformat(
          f"{date}T{time or '00:00:00'}"
        ).replace(tzinfo=timezone.utc).timestamp() * 1000
      except ValueError:
        timestamp = 0

    recording_path = _resolve_import_path(recording.get("path"), source_path.parent)
    size = 0
    if recording_path and Path(recording_path).is_file():
      try:
        size = Path(recording_path).stat().st_size
      except OSError:
        size = 0

    imported = {
      "title": Path(recording_path).name or f"Recording {recording_index + 1}",
      "path": recording_path,
      "date": timestamp,
      "location": {
        "latitude": _finite_number(recording.get("latitude"), 0) or 0,
        "longitude": _finite_number(recording.get("longitude"), 0) or 0,
      },
      "size": size,
      "species": ", ".join(species),
    }

    if _finite_number(recording.get("samplerate")) is not None:
      imported["samplerate"] = int(recording["samplerate"])
    if _finite_number(recording.get("duration")) is not None:
      imported["duration"] = float(recording["duration"])
    features = recording.get("features")
    if isinstance(features, dict) and _finite_number(features.get("temperature")) is not None:
      imported["temperature"] = float(features["temperature"])

    recordings.append(imported)

  boxes_by_recording = {index: [] for index in range(len(recordings))}
  sound_events_by_uuid = {
    str(sound_event.get("uuid")): sound_event
    for sound_event in data.get("sound_events") or []
    if isinstance(sound_event, dict) and sound_event.get("uuid")
  }

  annotation_tags_by_sound_event = {}
  for annotation in data.get("sound_event_annotations") or []:
    if not isinstance(annotation, dict):
      continue
    sound_event_uuid = str(annotation.get("sound_event") or "")
    annotation_tags_by_sound_event.setdefault(sound_event_uuid, []).extend(
      annotation.get("tags") or []
    )

  for prediction in data.get("sound_event_predictions") or []:
    if not isinstance(prediction, dict):
      continue
    sound_event_uuid = str(prediction.get("sound_event") or "")
    for tag_score in prediction.get("tags") or []:
      if isinstance(tag_score, list) and tag_score:
        annotation_tags_by_sound_event.setdefault(sound_event_uuid, []).append(tag_score[0])

  for sound_event_uuid, sound_event in sound_events_by_uuid.items():
    rec_index = recording_index_by_uuid.get(str(sound_event.get("recording") or ""))
    if rec_index is None:
      continue
    box = _box_from_sound_event(sound_event)
    if box is None:
      continue
    label_species = _species_from_tag_ids(
      annotation_tags_by_sound_event.get(sound_event_uuid),
      tags,
    )
    if label_species:
      box["label"] = label_species[0]
    boxes_by_recording.setdefault(rec_index, []).append(box)

  for rec_index, boxes in boxes_by_recording.items():
    if not boxes:
      continue
    recordings[rec_index]["classification"] = {
      "classifier_key": ANNOTATION_CLASSIFIER_KEY,
      "prediction": [],
      "labels": [],
      "boxes": boxes,
    }
    recordings[rec_index]["classifications"] = [
      recordings[rec_index]["classification"]
    ]

  return {
    "title": data.get("name") or "Whombat Import",
    "description": data.get("description") or "",
    "creation_date": datetime.now(timezone.utc).timestamp(),
    "classifier": ANNOTATION_CLASSIFIER_KEY,
    "classifiers": [ANNOTATION_CLASSIFIER_KEY],
    "processing_mode": "full",
    "recordings": recordings,
  }
