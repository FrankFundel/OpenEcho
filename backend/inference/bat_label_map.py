from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
import re


BAT_LABEL_MAP_PATH = Path(__file__).with_name("bat_label_map.csv")


def fallback_canonical_bat_label(label):
  clean = re.sub(r"[^A-Za-z0-9]+", "", str(label))
  return clean if len(clean) <= 10 else clean[:10]


@lru_cache(maxsize=1)
def load_bat_label_rows():
  with BAT_LABEL_MAP_PATH.open(newline="", encoding="utf-8") as file_handle:
    return [
      dict(row)
      for row in csv.DictReader(file_handle)
      if row.get("scientific_label") and row.get("canonical_label")
    ]


@lru_cache(maxsize=1)
def load_bat_label_map():
  return {
    row["scientific_label"]: row["canonical_label"]
    for row in load_bat_label_rows()
  }


def canonical_bat_label(label):
  return load_bat_label_map().get(str(label), fallback_canonical_bat_label(label))


def canonical_bat_labels(labels):
  return [canonical_bat_label(label) for label in labels]


def batdetect2_class_labels():
  rows_with_order = []
  for row in load_bat_label_rows():
    raw_order = (row.get("batdetect2_order") or "").strip()
    if not raw_order:
      continue
    rows_with_order.append((int(raw_order), row["scientific_label"]))
  return [label for _, label in sorted(rows_with_order)]
