from datetime import datetime
import platform
import sys
import eel
import json
import time
import os
import csv
import tkinter as tk
from tkinter.filedialog import askopenfilename, askopenfilenames, asksaveasfilename
import numpy as np

import torch
from tools import preprocess
import soundfile as sf
from bat import Model
import simpleaudio as sa

root = tk.Tk()
root.withdraw()
root.wm_attributes('-topmost', 1)

classifiers = []
projects = []
model = None
classifier = None

@eel.expose
def get_classifiers():
  global classifiers
  if os.path.isfile('classifiers.json'):
    with open('classifiers.json', 'r') as f:
      classifiers = json.load(f)
  else:
    classifiers = []
  return classifiers

def save_projects():
  global projects
  with open('projects.json', 'w') as f:
    json.dump(projects, f)

def load_projects():
  global projects
  if os.path.isfile('projects.json'):
    with open('projects.json', 'r') as f:
      projects = json.load(f)
  else:
    projects = []

@eel.expose
def get_projects():
  load_projects()
  return projects

@eel.expose
def add_project(title, description):
  projects.append({
    "title": title,
    "description": description,
    "creation_date": time.time(),
    "recordings": [],
    "classifier": 0,
    "maxproclen": 0,
  })
  save_projects()

@eel.expose
def save_project(index, title, description):
  projects[index]["title"] = title
  projects[index]["description"] = description
  save_projects()

@eel.expose
def remove_project(index):
  del projects[index]
  save_projects()

@eel.expose
def remove_recordings(projectIndex, indices):
  for index in sorted(indices, reverse=True):
    del projects[projectIndex]["recordings"][index]
  save_projects()

@eel.expose
def add_recordings(projectIndex):
  filenames = askopenfilenames(filetypes=[("WAV-File", "*.wav", "*.WAV")])
  for path in filenames:
    projects[projectIndex]["recordings"].append({
      "title": os.path.basename(path),
      "path": path,
      "date": os.path.getctime(path) * 1000,
      "location": {
        "latitude": 0,
        "longitude": 0,
      },
      "size": os.path.getsize(path),
    })
  save_projects()

@eel.expose
def add_metadata(projectIndex):
  filename = askopenfilename(filetypes=[("CSV-File", "*.csv")])
  if filename == '':
    return False
  
  try:
    metadata = {}
    with open(filename) as csvfile:
      reader = csv.reader(csvfile, delimiter=',')
      next(reader)
      for row in reader:
        title = row[2]
        species = row[24]
        time = row[5] # hh:mm:ss
        date = row[4] # yyyy-mm-dd
        temp = float(row[12])
        loc = [float(row[10]), float(row[11])]
        timestamp = datetime.strptime(date + ' ' + time, '%Y-%m-%d %H:%M:%S').timestamp() * 1000
        metadata[title] = {
          "species": species, "timestamp": timestamp, "temp": temp, "loc": loc
        }
    recs = projects[projectIndex]["recordings"]
    for r in range(len(recs)):
      if recs[r]["title"] in metadata:
        recdat = metadata[recs[r]["title"]]
        recs[r]["temperature"] = recdat["temp"]
        recs[r]["date"] = recdat["timestamp"]
        recs[r]["location"]["latitude"] = recdat["loc"][0]
        recs[r]["location"]["longitude"] = recdat["loc"][1]
    save_projects()
    return True
  except:
    return False

@eel.expose
def get_chunk(projectIndex, recordingIndex, start, end=0):
  rec = projects[projectIndex]["recordings"][recordingIndex]
  if not os.path.exists(rec["path"]):
    return False
  info = sf.info(rec["path"])
  samples = int(info.duration * info.samplerate)
  chunk_len = 2 * info.samplerate # 2 seconds
  start = int(start * 128)
  if end == 0:
    end = start + chunk_len
  else:
    end = int(end * 128)
  if start < samples:
    y, _ = sf.read(rec["path"], dtype='int16', start=start, stop=end)
    x = preprocess(torch.Tensor(y).unsqueeze(0)).squeeze(0) * 255 # save data
    S = x.to(torch.uint8).tolist()
    print("Sending chunk...")
    return S
  else:
    return None

def get_recording_async(rec, sr, resolution=1000):
  chunk_len = 2 * sr # 2 seconds
  y, _ = sf.read(rec["path"], dtype='int16')
  idx = np.round(np.linspace(0, len(y) - 1, resolution)).astype(int)
  y_dense = y[idx].tolist()
  x = preprocess(torch.Tensor(y[:chunk_len]).unsqueeze(0)).squeeze(0) * 255 # save data
  S = x.to(torch.uint8).tolist()
  print("Sending chunk...")
  eel.setRecording(S, y_dense)

@eel.expose
def get_recording(projectIndex, recordingIndex):
  rec = projects[projectIndex]["recordings"][recordingIndex]
  if not os.path.exists(rec["path"]):
    return False
  
  info = sf.info(rec["path"])
  eel.spawn(get_recording_async, rec, info.samplerate)
  rec["samplerate"] = info.samplerate
  rec["duration"] = info.duration
  save_projects()
  return rec

@eel.expose
def set_species(projectIndex, recordingIndex, species):
  projects[projectIndex]["recordings"][recordingIndex]["species"] = species
  save_projects()

@eel.expose
def set_classifier(projectIndex, classifierIndex):
  projects[projectIndex]["classifier"] = classifierIndex
  save_projects()

def setup_classifier(projectIndex):
  global classifier, model
  c = projects[projectIndex]["classifier"]
  classifier = classifiers[c]
  model = Model(classifier["classes"], classifier["path"])
  print("Done setting up", classifier["name"])

def predict(rec, proclen):
  try:
    prediction, labels = model.predict(rec["path"], proclen=proclen)
    classification = {"prediction": prediction, "labels": labels}
    rec["classification"] = classification
    classes = []
    for l in labels:
      classes.append(classifier["classes_short"][l])
    rec["species"] = ", ".join(classes)
    return classification, classes
  except:
    print("Memory error")
    eel.memoryError()
    return {}, []

def classify_async(projectIndex, recordingIndex):
  setup_classifier(projectIndex)
  rec = projects[projectIndex]["recordings"][recordingIndex]
  eel.setRecordingLoading(projectIndex, recordingIndex)
  classification, classes = predict(rec, projects[projectIndex]["maxproclen"])
  eel.classifiedRecording(projectIndex, recordingIndex, classification, classes, 100)
  save_projects()

@eel.expose
def classify(projectIndex, recordingIndex):
  eel.spawn(classify_async, projectIndex, recordingIndex)

def classify_all_async(projectIndex, indices=None):
  setup_classifier(projectIndex)
  recs = projects[projectIndex]["recordings"]
  if indices is None:
    indices = range(len(recs))

  for p, i in enumerate(indices):
    eel.setRecordingLoading(projectIndex, i)
    if os.path.exists(recs[i]["path"]):
      if "duration" not in recs[i]:
        info = sf.info(recs[i]["path"])
        recs[i]["samplerate"] = info.samplerate
        recs[i]["duration"] = info.duration
      classification, classes = predict(recs[i], projects[projectIndex]["maxproclen"])
      save_projects()
    else:
      classification, classes = None, ""
    eel.classifiedRecording(projectIndex, i, classification, classes, ((p+1) / len(indices)) * 100)

@eel.expose
def classify_all(projectIndex, indices=None):
  eel.spawn(classify_all_async, projectIndex, indices)

@eel.expose
def export_csv(projectIndex):  
  project = projects[projectIndex]
  try:
    path = asksaveasfilename(initialfile=project["title"] + ".csv", defaultextension=".csv", filetypes=[("CSV-File", "*.csv")])
    if path == '':
      return False
    with open(path, 'w', newline='\n') as csvfile:
      writer = csv.writer(csvfile, delimiter=';')
      writer.writerow(["filename", "duration", "date", "latitude", "longitude", "temperature", "species"]) # header
      for rec in project["recordings"]:
        filename = rec["path"]
        duration = round(rec.get("duration", 0), 2)
        date = datetime.fromtimestamp(float(rec["date"]) / 1000).strftime('%d/%m/%Y %H:%M:%S') 
        latitude = rec["location"]["latitude"]
        longitude = rec["location"]["longitude"]
        temperature = rec.get("temperature", "")
        species = rec.get("species", "")
        writer.writerow([filename, duration, date, latitude, longitude, temperature, species])
    return True
  except Exception as e:
    print(e)
    return False

@eel.expose
def set_maxproclen(projectIndex, val):
  projects[projectIndex]["maxproclen"] = val
  save_projects()

def wait_end(duration):
  eel.sleep(duration)
  eel.playEnd()

@eel.expose
def play(projectIndex, recordingIndex, start, end):
  global playback
  rec = projects[projectIndex]["recordings"][recordingIndex]
  y, sr = sf.read(rec["path"], dtype='int16', start=int(start*128), stop=int(end*128))
  playback = sa.play_buffer(
    y,
    num_channels=1,
    bytes_per_sample=2,
    sample_rate=22050
  )
  duration = ((end-start)*128)/22050
  eel.spawn(wait_end, duration)

@eel.expose
def pause():
  global playback
  playback.stop()

def start_eel(develop):
  """Start Eel with either production or development configuration."""
  try:
    if develop:
        directory = 'src'
        mode = None
        page = {'port': 3000}
    else:
        directory = 'build'
        mode = 'chrome'
        page = 'index.html'

    eel.init(directory, ['.tsx', '.ts', '.jsx', '.js', '.html'])

    eel_kwargs = dict(
        host='localhost',
        port=8080,
        size=(1280, 800),
        block=False,
    )
    try:
        eel.start(page, **eel_kwargs)
    except EnvironmentError:
        if sys.platform in ['win32', 'win64'] and int(platform.release()) >= 10:
            eel.start(page, mode='edge', **eel_kwargs)
        else:
            raise
    print("Eel started.")
    while True:
      eel.sleep(1.0)

  except (SystemExit, MemoryError, KeyboardInterrupt) as e:
    print("Error", e)
    #start_eel(develop)

if __name__ == '__main__':
  start_eel(develop=len(sys.argv) == 2)
