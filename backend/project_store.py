from __future__ import annotations

from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile

import numpy as np

from backend.paths import data_path


PROJECTS_DB_PATH = data_path("projects.sqlite3")
PROJECTS_JSON_PATH = data_path("projects.json")
CLASSIFICATIONS_PATH = data_path("classifications")
DEFAULT_CLASSIFIER_KEY = "bacpipe:bat"
CLASSIFIER_KEY_ALIASES = {
  "local:bat_original": "bacpipe:bat2",
}
PROJECTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS {table_name} (
  project_index INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  creation_date REAL NOT NULL,
  classifier TEXT NOT NULL,
  processing_mode TEXT NOT NULL DEFAULT 'full'
)
"""
RECORDINGS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS recordings (
  project_index INTEGER NOT NULL,
  recording_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  date REAL NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  size INTEGER NOT NULL,
  samplerate INTEGER,
  duration REAL,
  temperature REAL,
  species TEXT NOT NULL,
  classification_key TEXT,
  classification_labels BLOB,
  classification_prediction BLOB,
  classification_path TEXT,
  PRIMARY KEY (project_index, recording_index),
  FOREIGN KEY (project_index) REFERENCES projects(project_index) ON DELETE CASCADE
)
"""
RECORDING_CLASSIFICATIONS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS recording_classifications (
  project_index INTEGER NOT NULL,
  recording_index INTEGER NOT NULL,
  classifier_key TEXT NOT NULL,
  classification_labels BLOB,
  classification_path TEXT,
  PRIMARY KEY (project_index, recording_index, classifier_key),
  FOREIGN KEY (project_index, recording_index)
    REFERENCES recordings(project_index, recording_index)
    ON DELETE CASCADE
)
"""


def _connect():
  PROJECTS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  connection = sqlite3.connect(PROJECTS_DB_PATH)
  connection.row_factory = sqlite3.Row
  connection.execute("PRAGMA foreign_keys = ON")
  _create_projects_table(connection)
  connection.execute(RECORDINGS_TABLE_SQL)
  connection.execute(RECORDING_CLASSIFICATIONS_TABLE_SQL)
  connection.commit()
  _ensure_project_columns(connection)
  _ensure_recording_columns(connection)
  return connection


def _create_projects_table(connection, table_name="projects"):
  connection.execute(PROJECTS_TABLE_SQL.format(table_name=table_name))


def _project_column_info(connection):
  return {
    row["name"]: row
    for row in connection.execute("PRAGMA table_info(projects)").fetchall()
  }


def _ensure_project_columns(connection):
  columns = _project_column_info(connection)
  if not columns:
    return

  processing_mode = columns.get("processing_mode")
  default_value = str(processing_mode["dflt_value"] or "").strip("'\"").lower() if processing_mode else ""
  needs_rebuild = (
    "maxproclen" in columns or
    processing_mode is None or
    int(processing_mode["notnull"] or 0) != 1 or
    default_value != "full"
  )

  if needs_rebuild:
    processing_mode_source = (
      """
      CASE
        WHEN LOWER(TRIM(processing_mode)) IN ('full', 'window') THEN LOWER(TRIM(processing_mode))
        ELSE 'full'
      END
      """
      if processing_mode is not None
      else "'full'"
    )

    connection.commit()
    connection.execute("PRAGMA foreign_keys = OFF")
    try:
      _create_projects_table(connection, table_name="projects_new")
      connection.execute(
        f"""
        INSERT INTO projects_new (
          project_index,
          title,
          description,
          creation_date,
          classifier,
          processing_mode
        )
        SELECT
          project_index,
          title,
          description,
          creation_date,
          classifier,
          {processing_mode_source}
        FROM projects
        """
      )
      connection.execute("DROP TABLE projects")
      connection.execute("ALTER TABLE projects_new RENAME TO projects")
      connection.commit()
    finally:
      connection.execute("PRAGMA foreign_keys = ON")

  connection.execute(
    """
    UPDATE projects
    SET processing_mode = 'full'
    WHERE processing_mode IS NULL
      OR TRIM(processing_mode) = ''
      OR LOWER(TRIM(processing_mode)) NOT IN ('full', 'window')
    """
  )
  connection.commit()


def _recording_columns(connection):
  return {
    row["name"]
    for row in connection.execute("PRAGMA table_info(recordings)").fetchall()
  }


def _ensure_recording_columns(connection):
  columns = _recording_columns(connection)
  if "classification_path" not in columns:
    connection.execute("ALTER TABLE recordings ADD COLUMN classification_path TEXT")


def _normalize_classifier_key(value):
  if not isinstance(value, str):
    return None

  key = value.strip()
  if not key:
    return None

  return CLASSIFIER_KEY_ALIASES.get(key, key)


def _parse_classifier_key_list(value):
  if isinstance(value, list):
    return value

  if not isinstance(value, str):
    return None

  text = value.strip()
  if not text.startswith("["):
    return None

  try:
    parsed = json.loads(text)
  except json.JSONDecodeError:
    return None

  return parsed if isinstance(parsed, list) else None


def _load_classifier_catalog(classifier_only):
  try:
    from backend.inference.bacpipe_provider import (
      classifier_key,
      get_bacpipe_classifiers,
      get_bacpipe_model_names,
    )
  except Exception:
    if classifier_only:
      return [{"key": DEFAULT_CLASSIFIER_KEY}]
    return [DEFAULT_CLASSIFIER_KEY]

  if classifier_only:
    return list(get_bacpipe_classifiers())

  model_names = list(get_bacpipe_model_names(classifier_only=False))
  if "bat2" in model_names:
    model_names = [name for name in model_names if name != "bat2"] + ["bat2"]

  return [classifier_key(model_name) for model_name in model_names]


def _available_classifier_keys():
  return {
    item["key"]
    for item in _load_classifier_catalog(classifier_only=True)
    if isinstance(item, dict) and item.get("key")
  } or {DEFAULT_CLASSIFIER_KEY}


def _stored_index_classifier_keys():
  keys = [
    key
    for key in _load_classifier_catalog(classifier_only=False)
    if isinstance(key, str) and key
  ]
  return keys or [DEFAULT_CLASSIFIER_KEY]


def _normalize_classifier_keys(values):
  available_keys = _available_classifier_keys()
  normalized = []
  for raw_value in values or []:
    key = _normalize_classifier_key(raw_value)
    if key in available_keys and key not in normalized:
      normalized.append(key)
  return normalized


def _classifier_keys_from_project(project):
  for raw_value in (
    project.get("classifier_keys"),
    project.get("classifiers"),
    _parse_classifier_key_list(project.get("classifier")),
  ):
    if isinstance(raw_value, list):
      return _normalize_classifier_keys(raw_value)

  available_keys = _available_classifier_keys()

  for raw_value in (
    project.get("classifier_key"),
    project.get("classifier"),
  ):
    key = _normalize_classifier_key(raw_value)
    if key in available_keys:
      return [key]

  raw_index = project.get("classifier")
  try:
    index = int(raw_index or 0)
  except (TypeError, ValueError):
    return [DEFAULT_CLASSIFIER_KEY]

  stored_keys = _stored_index_classifier_keys()
  if 0 <= index < len(stored_keys) and stored_keys[index] in available_keys:
    return [stored_keys[index]]

  return [DEFAULT_CLASSIFIER_KEY]


def _project_primary_classifier_key(classifier_keys):
  return classifier_keys[0] if classifier_keys else ""


def _project_fallback_classifier_key(classifier_keys):
  return classifier_keys[0] if classifier_keys else DEFAULT_CLASSIFIER_KEY


def _classifier_key_from_project(project):
  return _project_fallback_classifier_key(_classifier_keys_from_project(project))


def _round_prediction_value(value):
  try:
    numeric = float(value)
  except (TypeError, ValueError):
    return None

  if not math.isfinite(numeric):
    return None

  return float(f"{numeric:.6g}")


def _classifier_key_from_classification(classification, fallback_key):
  key = _normalize_classifier_key(classification.get("classifier_key"))
  if key:
    return key

  recorded_classes = classification.get("classes")
  recorded_classes_short = classification.get("classes_short")

  for classifier in _load_classifier_catalog(classifier_only=True):
    if not isinstance(classifier, dict):
      continue
    if recorded_classes and classifier.get("classes") == recorded_classes:
      return classifier["key"]
    if recorded_classes_short and classifier.get("classes_short") == recorded_classes_short:
      return classifier["key"]

  return fallback_key


def _normalize_labels(labels):
  return [
    int(label)
    for label in labels or []
    if isinstance(label, (int, float))
  ]


def _normalize_text_list(values):
  if not isinstance(values, list):
    return []

  normalized = []
  for value in values:
    if value is None:
      continue
    text = str(value).strip()
    if text:
      normalized.append(text)
  return normalized


def _normalize_classification_summary(classification, fallback_key):
  if not isinstance(classification, dict):
    return None

  classifier_key = _classifier_key_from_classification(classification, fallback_key)
  labels = _normalize_labels(classification.get("labels"))
  if not classifier_key and not labels:
    return None

  summary = {
    "classifier_key": classifier_key or fallback_key,
    "labels": labels,
  }

  classes = _normalize_text_list(classification.get("classes"))
  if classes:
    summary["classes"] = classes

  classes_short = _normalize_text_list(classification.get("classes_short"))
  if classes_short:
    summary["classes_short"] = classes_short

  return summary


def _normalize_classification(classification, fallback_key):
  summary = _normalize_classification_summary(classification, fallback_key)
  if summary is None:
    return None

  prediction = classification.get("prediction")
  if not isinstance(prediction, list):
    return None

  normalized_prediction = []
  for value in prediction:
    rounded = _round_prediction_value(value)
    if rounded is None:
      return None
    normalized_prediction.append(rounded)

  summary["prediction"] = normalized_prediction
  return summary


def _normalize_classification_entry(classification, fallback_key):
  if not isinstance(classification, dict):
    return None

  normalized = _normalize_classification(classification, fallback_key)
  if normalized is None:
    normalized = _normalize_classification_summary(classification, fallback_key)
  if normalized is None:
    return None

  classification_path = classification.get("_classification_path")
  if isinstance(classification_path, str) and classification_path:
    normalized["_classification_path"] = classification_path

  return normalized


def _merge_classification_entries(existing, incoming):
  if existing is None:
    return dict(incoming)

  merged = dict(existing)
  for field_name in (
    "classifier_key",
    "labels",
    "prediction",
    "classes",
    "classes_short",
    "_classification_path",
  ):
    if field_name not in incoming:
      continue

    if field_name == "prediction":
      if isinstance(incoming.get(field_name), list):
        merged[field_name] = incoming[field_name]
      continue

    if field_name in {"classes", "classes_short"}:
      if incoming.get(field_name):
        merged[field_name] = incoming[field_name]
      continue

    merged[field_name] = incoming[field_name]

  return merged


def _iter_recording_classifications(recording):
  raw_classifications = recording.get("classifications")
  if isinstance(raw_classifications, dict):
    for classifier_key, value in raw_classifications.items():
      if not isinstance(value, dict):
        continue
      item = dict(value)
      item.setdefault("classifier_key", classifier_key)
      yield item
  elif isinstance(raw_classifications, list):
    for item in raw_classifications:
      if isinstance(item, dict):
        yield item

  classification = recording.get("classification")
  if isinstance(classification, dict):
    item = dict(classification)
    classification_path = recording.get("_classification_path")
    if (
      isinstance(classification_path, str) and
      classification_path and
      "_classification_path" not in item
    ):
      item["_classification_path"] = classification_path
    yield item


def _sort_classifications(classifications, classifier_keys):
  if not classifications:
    return []

  order_by_key = {key: index for index, key in enumerate(classifier_keys)}
  return sorted(
    classifications,
    key=lambda item: (
      order_by_key.get(item["classifier_key"], len(order_by_key)),
      item["classifier_key"],
    ),
  )


def _normalize_recording_classifications(recording, classifier_keys):
  fallback_key = _project_fallback_classifier_key(classifier_keys)
  entries_by_key = {}
  for raw_classification in _iter_recording_classifications(recording):
    entry = _normalize_classification_entry(raw_classification, fallback_key)
    if entry is None:
      continue
    key = entry["classifier_key"]
    entries_by_key[key] = _merge_classification_entries(entries_by_key.get(key), entry)

  return _sort_classifications(list(entries_by_key.values()), classifier_keys)


def _select_primary_classification(classifications, classifier_keys):
  if not classifications:
    return None

  classifications_by_key = {
    item["classifier_key"]: item
    for item in classifications
    if isinstance(item, dict) and item.get("classifier_key")
  }

  for classifier_key in classifier_keys:
    classification = classifications_by_key.get(classifier_key)
    if classification is not None:
      return dict(classification)

  return dict(classifications[0])


def _normalize_recording(recording, classifier_keys):
  location = recording.get("location") or {}
  normalized = {
    "title": str(recording.get("title") or ""),
    "path": str(recording.get("path") or ""),
    "date": float(recording.get("date", 0) or 0),
    "location": {
      "latitude": float(location.get("latitude", 0) or 0),
      "longitude": float(location.get("longitude", 0) or 0),
    },
    "size": int(recording.get("size", 0) or 0),
    "species": str(recording.get("species") or ""),
  }

  for field_name, caster in (
    ("samplerate", int),
    ("duration", float),
    ("temperature", float),
  ):
    value = recording.get(field_name)
    if value is None:
      continue
    try:
      normalized[field_name] = caster(value)
    except (TypeError, ValueError):
      continue

  classifications = _normalize_recording_classifications(recording, classifier_keys)
  if classifications:
    normalized["classifications"] = classifications

  primary_classification = _select_primary_classification(classifications, classifier_keys)
  if primary_classification is not None:
    normalized["classification"] = primary_classification

  return normalized


def _normalize_project(project):
  classifier_keys = _classifier_keys_from_project(project)
  return {
    "title": str(project.get("title") or ""),
    "description": str(project.get("description") or ""),
    "creation_date": float(project.get("creation_date", 0) or 0),
    "classifier": _project_primary_classifier_key(classifier_keys),
    "classifiers": classifier_keys,
    "processing_mode": _normalize_processing_mode(
      project.get("processing_mode"),
      project.get("maxproclen"),
    ),
    "recordings": [
      _normalize_recording(recording, classifier_keys)
      for recording in project.get("recordings") or []
    ],
  }


def _normalize_projects(projects):
  return [_normalize_project(project) for project in (projects or [])]


def _pack_int_array(values):
  payload = array("I")
  payload.extend(int(value) for value in values)
  return sqlite3.Binary(payload.tobytes())


def _unpack_int_array(blob):
  if blob is None:
    return []

  payload = array("I")
  payload.frombytes(blob)
  return [int(value) for value in payload]


def _unpack_float_array(blob):
  if blob is None:
    return []

  payload = array("d")
  payload.frombytes(blob)
  return [float(value) for value in payload]


def _normalize_processing_mode(*values):
  for value in values:
    if isinstance(value, str):
      normalized = value.strip().lower()
      if normalized in {"full", "window"}:
        return normalized

  return "full"


def _database_has_projects(connection):
  row = connection.execute("SELECT 1 FROM projects LIMIT 1").fetchone()
  return row is not None


def _archive_json_store():
  if not PROJECTS_JSON_PATH.is_file():
    return

  backup_path = PROJECTS_JSON_PATH.with_suffix(".json.migrated")
  suffix = 1
  while backup_path.exists():
    backup_path = PROJECTS_JSON_PATH.with_suffix(f".json.migrated.{suffix}")
    suffix += 1

  PROJECTS_JSON_PATH.replace(backup_path)


def _write_classification_file(classification):
  CLASSIFICATIONS_PATH.mkdir(parents=True, exist_ok=True)

  prediction = np.asarray(classification["prediction"], dtype=np.float32)
  labels = np.asarray(classification["labels"], dtype=np.uint32)
  classes = _normalize_text_list(classification.get("classes"))
  classes_short = _normalize_text_list(classification.get("classes_short"))
  digest = hashlib.sha256()
  digest.update(classification["classifier_key"].encode("utf-8"))
  digest.update(prediction.tobytes())
  digest.update(labels.tobytes())
  digest.update("\0".join(classes).encode("utf-8"))
  digest.update("\0".join(classes_short).encode("utf-8"))
  relative_path = f"{digest.hexdigest()}.npz"
  target_path = CLASSIFICATIONS_PATH / relative_path
  if target_path.is_file():
    return relative_path

  temp_file = tempfile.NamedTemporaryFile(
    suffix=".npz",
    prefix=".classification.",
    dir=CLASSIFICATIONS_PATH,
    delete=False,
  )
  temp_path = Path(temp_file.name)
  temp_file.close()

  try:
    np.savez_compressed(
      temp_path,
      classifier_key=classification["classifier_key"],
      prediction=prediction,
      labels=labels,
      classes=np.asarray(classes, dtype=np.str_),
      classes_short=np.asarray(classes_short, dtype=np.str_),
    )
    os.replace(temp_path, target_path)
  finally:
    if temp_path.exists():
      try:
        temp_path.unlink()
      except OSError:
        pass

  return relative_path


def _load_classification_file(relative_path, fallback_key, fallback_labels):
  path = CLASSIFICATIONS_PATH / relative_path
  if not path.is_file():
    return {
      "classifier_key": fallback_key,
      "labels": list(fallback_labels),
    }

  with np.load(path, allow_pickle=False) as payload:
    classifier_key = str(payload["classifier_key"].tolist() or fallback_key)
    prediction = payload["prediction"].astype(np.float32, copy=False).tolist()
    labels = payload["labels"].astype(np.uint32, copy=False).tolist()
    classes = payload["classes"].astype(np.str_, copy=False).tolist() if "classes" in payload.files else []
    classes_short = (
      payload["classes_short"].astype(np.str_, copy=False).tolist()
      if "classes_short" in payload.files
      else []
    )

  classification = {
    "classifier_key": classifier_key,
    "prediction": [float(value) for value in prediction],
    "labels": [int(value) for value in labels],
  }

  if classes:
    classification["classes"] = [str(value) for value in classes]
  if classes_short:
    classification["classes_short"] = [str(value) for value in classes_short]

  return classification


def _legacy_classification_from_row(row):
  if row["classification_prediction"] is None:
    return None

  return {
    "classifier_key": row["classification_key"] or DEFAULT_CLASSIFIER_KEY,
    "prediction": _unpack_float_array(row["classification_prediction"]),
    "labels": _unpack_int_array(row["classification_labels"]),
  }


def _classification_summary_from_row(row):
  if (
    row["classification_key"] is None and
    row["classification_path"] is None and
    row["classification_labels"] is None and
    row["classification_prediction"] is None
  ):
    return None

  return {
    "classifier_key": row["classification_key"] or DEFAULT_CLASSIFIER_KEY,
    "labels": _unpack_int_array(row["classification_labels"]),
  }


def _classification_entry_from_row(
  classifier_key,
  labels_blob,
  classification_path,
  include_predictions,
):
  labels = _unpack_int_array(labels_blob)
  summary = {
    "classifier_key": classifier_key or DEFAULT_CLASSIFIER_KEY,
    "labels": labels,
  }

  if classification_path:
    if include_predictions:
      return _load_classification_file(
        classification_path,
        summary["classifier_key"],
        summary["labels"],
      )
    summary["_classification_path"] = classification_path

  return summary


def _full_classification_from_row(row):
  summary = _classification_summary_from_row(row)
  if summary is None:
    return None

  if row["classification_path"]:
    return _load_classification_file(
      row["classification_path"],
      summary["classifier_key"],
      summary["labels"],
    )

  legacy = _legacy_classification_from_row(row)
  if legacy is not None:
    return legacy

  return summary


def _recording_from_row(row, include_predictions, classifications, classifier_keys):
  recording = {
    "title": row["title"],
    "path": row["path"],
    "date": row["date"],
    "location": {
      "latitude": row["latitude"],
      "longitude": row["longitude"],
    },
    "size": row["size"],
    "species": row["species"],
  }

  if row["samplerate"] is not None:
    recording["samplerate"] = row["samplerate"]
  if row["duration"] is not None:
    recording["duration"] = row["duration"]
  if row["temperature"] is not None:
    recording["temperature"] = row["temperature"]

  if classifications:
    recording["classifications"] = _sort_classifications(classifications, classifier_keys)

  classification = _select_primary_classification(classifications, classifier_keys)
  if classification is None:
    classification = (
      _full_classification_from_row(row)
      if include_predictions
      else _classification_summary_from_row(row)
    )
  if classification is not None:
    if (
      not include_predictions and
      row["classification_path"] and
      "_classification_path" not in classification
    ):
      classification = dict(classification)
      classification["_classification_path"] = row["classification_path"]
    recording["classification"] = classification

  return recording


def _cleanup_classification_files(referenced_paths):
  if not CLASSIFICATIONS_PATH.is_dir():
    return

  for path in CLASSIFICATIONS_PATH.glob("*.npz"):
    if path.name in referenced_paths:
      continue
    try:
      path.unlink()
    except OSError:
      pass


def _migrate_json_store_if_needed(connection):
  if _database_has_projects(connection) or not PROJECTS_JSON_PATH.is_file():
    return

  with PROJECTS_JSON_PATH.open("r", encoding="utf-8") as file:
    stored_projects = json.load(file)

  save_projects(_normalize_projects(stored_projects))
  _archive_json_store()


def _migrate_prediction_storage_if_needed(connection):
  columns = _recording_columns(connection)
  if "classification_prediction" not in columns:
    return

  rows = connection.execute(
    """
    SELECT
      project_index,
      recording_index,
      classification_key,
      classification_labels,
      classification_prediction,
      classification_path
    FROM recordings
    WHERE classification_prediction IS NOT NULL
      AND (classification_path IS NULL OR classification_path = '')
    """
  ).fetchall()

  for row in rows:
    classification = _legacy_classification_from_row(row)
    if classification is None:
      continue

    relative_path = _write_classification_file(classification)
    connection.execute(
      """
      UPDATE recordings
      SET classification_path = ?, classification_prediction = NULL
      WHERE project_index = ? AND recording_index = ?
      """,
      (
        relative_path,
        row["project_index"],
        row["recording_index"],
      ),
    )


def load_projects(include_predictions=False):
  with _connect() as connection:
    _migrate_json_store_if_needed(connection)
    with connection:
      _migrate_prediction_storage_if_needed(connection)

    project_rows = connection.execute(
      """
      SELECT
        project_index,
        title,
        description,
        creation_date,
        classifier,
        processing_mode
      FROM projects
      ORDER BY project_index
      """
    ).fetchall()

    recording_rows = connection.execute(
      """
      SELECT
        project_index,
        recording_index,
        title,
        path,
        date,
        latitude,
        longitude,
        size,
        samplerate,
        duration,
        temperature,
        species,
        classification_key,
        classification_labels,
        classification_path,
        classification_prediction
      FROM recordings
      ORDER BY project_index, recording_index
      """
    ).fetchall()

    recording_classification_rows = connection.execute(
      """
      SELECT
        project_index,
        recording_index,
        classifier_key,
        classification_labels,
        classification_path
      FROM recording_classifications
      ORDER BY project_index, recording_index, classifier_key
      """
    ).fetchall()

  classifier_keys_by_project = {
    row["project_index"]: _classifier_keys_from_project({"classifier": row["classifier"]})
    for row in project_rows
  }
  classifications_by_recording = {}
  for row in recording_classification_rows:
    recording_key = (row["project_index"], row["recording_index"])
    classifications_by_recording.setdefault(recording_key, []).append(
      _classification_entry_from_row(
        row["classifier_key"],
        row["classification_labels"],
        row["classification_path"],
        include_predictions=include_predictions,
      )
    )

  recordings_by_project = {}
  for row in recording_rows:
    recordings_by_project.setdefault(row["project_index"], []).append(
      _recording_from_row(
        row,
        include_predictions=include_predictions,
        classifications=classifications_by_recording.get(
          (row["project_index"], row["recording_index"]),
          [],
        ),
        classifier_keys=classifier_keys_by_project.get(row["project_index"], []),
      )
    )

  return [
    {
      "title": row["title"],
      "description": row["description"],
      "creation_date": row["creation_date"],
      "classifier": _project_primary_classifier_key(
        classifier_keys_by_project.get(row["project_index"], [])
      ),
      "classifiers": classifier_keys_by_project.get(row["project_index"], []),
      "processing_mode": _normalize_processing_mode(row["processing_mode"]),
      "recordings": recordings_by_project.get(row["project_index"], []),
    }
    for row in project_rows
  ]


def load_recording_classification(project_index, recording_index):
  with _connect() as connection:
    _migrate_json_store_if_needed(connection)
    with connection:
      _migrate_prediction_storage_if_needed(connection)

    row = connection.execute(
      """
      SELECT
        classification_key,
        classification_labels,
        classification_path,
        classification_prediction
      FROM recordings
      WHERE project_index = ? AND recording_index = ?
      """,
      (project_index, recording_index),
    ).fetchone()

    project_row = connection.execute(
      """
      SELECT classifier
      FROM projects
      WHERE project_index = ?
      """,
      (project_index,),
    ).fetchone()

    classification_rows = connection.execute(
      """
      SELECT
        classifier_key,
        classification_labels,
        classification_path
      FROM recording_classifications
      WHERE project_index = ? AND recording_index = ?
      ORDER BY classifier_key
      """,
      (project_index, recording_index),
    ).fetchall()

  if row is None:
    return None

  classifier_keys = _classifier_keys_from_project(
    {"classifier": project_row["classifier"] if project_row is not None else DEFAULT_CLASSIFIER_KEY}
  )
  classifications = [
    _classification_entry_from_row(
      classification_row["classifier_key"],
      classification_row["classification_labels"],
      classification_row["classification_path"],
      include_predictions=True,
    )
    for classification_row in classification_rows
  ]
  if classifications:
    ordered_classifications = _sort_classifications(classifications, classifier_keys)
    return {
      "classification": _select_primary_classification(
        ordered_classifications,
        classifier_keys,
      ),
      "classifications": ordered_classifications,
    }

  classification = _full_classification_from_row(row)
  if classification is None:
    return None

  return {
    "classification": classification,
    "classifications": [classification],
  }


def save_projects(projects):
  normalized_projects = _normalize_projects(projects)
  referenced_paths = set()

  with _connect() as connection:
    with connection:
      connection.execute("DELETE FROM recording_classifications")
      connection.execute("DELETE FROM recordings")
      connection.execute("DELETE FROM projects")

      for project_index, project in enumerate(normalized_projects):
        connection.execute(
          """
          INSERT INTO projects (
            project_index,
            title,
            description,
            creation_date,
            classifier,
            processing_mode
          )
          VALUES (?, ?, ?, ?, ?, ?)
          """,
          (
            project_index,
            project["title"],
            project["description"],
            project["creation_date"],
            json.dumps(project["classifiers"]),
            project["processing_mode"],
          ),
        )

        for recording_index, recording in enumerate(project["recordings"]):
          classifications = _sort_classifications(
            [
              dict(classification)
              for classification in recording.get("classifications") or []
              if isinstance(classification, dict)
            ],
            project["classifiers"],
          )
          primary_classification = _select_primary_classification(
            classifications,
            project["classifiers"],
          )
          primary_classification_key = None
          primary_classification_labels = None
          primary_classification_path = None

          if primary_classification is not None:
            primary_classification_key = primary_classification["classifier_key"]
            primary_classification_labels = _pack_int_array(primary_classification["labels"])
            if isinstance(primary_classification.get("prediction"), list):
              primary_classification_path = _write_classification_file(primary_classification)
            else:
              primary_classification_path = primary_classification.get("_classification_path")

          if primary_classification_path:
            referenced_paths.add(primary_classification_path)

          connection.execute(
            """
            INSERT INTO recordings (
              project_index,
              recording_index,
              title,
              path,
              date,
              latitude,
              longitude,
              size,
              samplerate,
              duration,
              temperature,
              species,
              classification_key,
              classification_labels,
              classification_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
              project_index,
              recording_index,
              recording["title"],
              recording["path"],
              recording["date"],
              recording["location"]["latitude"],
              recording["location"]["longitude"],
              recording["size"],
              recording.get("samplerate"),
              recording.get("duration"),
              recording.get("temperature"),
              recording.get("species", ""),
              primary_classification_key,
              primary_classification_labels,
              primary_classification_path,
            ),
          )

          for classification in classifications:
            classification_path = None
            if isinstance(classification.get("prediction"), list):
              classification_path = _write_classification_file(classification)
            else:
              classification_path = classification.get("_classification_path")

            if classification_path:
              referenced_paths.add(classification_path)

            connection.execute(
              """
              INSERT INTO recording_classifications (
                project_index,
                recording_index,
                classifier_key,
                classification_labels,
                classification_path
              )
              VALUES (?, ?, ?, ?, ?)
              """,
              (
                project_index,
                recording_index,
                classification["classifier_key"],
                _pack_int_array(classification["labels"]),
                classification_path,
              ),
            )

  _cleanup_classification_files(referenced_paths)
