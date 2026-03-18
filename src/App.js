import React, { Component } from "react";
import "./App.css";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import CssBaseline from "@mui/material/CssBaseline";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { ThemeProvider, createTheme } from "@mui/material/styles";

import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlineIcon from "@mui/icons-material/EditOutlined";
import ExportOutlineIcon from "@mui/icons-material/FileDownloadOutlined";
import ThinkIcon from "@mui/icons-material/AutoFixHighOutlined";

import AppDialogs from "./components/AppDialogs";
import MainContent from "./components/MainContent";
import ProjectSidebar from "./components/ProjectSidebar";
import RecordingSidebar from "./components/RecordingSidebar";
import { backend } from "./lib/backendBridge";

const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#66C0B7",
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarColor: "#6b6b6b #2b2b2b",
          "&::-webkit-scrollbar, & *::-webkit-scrollbar": {
            backgroundColor: "transparent",
          },
          "&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb": {
            borderRadius: 8,
            backgroundColor: "#6b6b6b",
            minHeight: 24,
            border: "3px solid #2b2b2b",
          },
          "&::-webkit-scrollbar-thumb:focus, & *::-webkit-scrollbar-thumb:focus":
            {
              backgroundColor: "#959595",
            },
          "&::-webkit-scrollbar-thumb:active, & *::-webkit-scrollbar-thumb:active":
            {
              backgroundColor: "#959595",
            },
          "&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover":
            {
              backgroundColor: "#959595",
            },
          "&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner": {
            backgroundColor: "#2b2b2b",
          },
        },
      },
    },
  },
});

const EMPTY_RECORDING = {
  title: "",
  date: 0,
  temperature: 0,
  duration: 0,
  samplerate: 0,
  sampleCount: 0,
  path: "",
  location: {
    latitude: 0,
    longitude: 0,
  },
  class: "",
  species: "",
};

const SPECTROGRAM_PREFETCH_SECONDS = 8;
const SPECTROGRAM_CACHE_TOLERANCE_FRAMES = 2;

const splitSpeciesText = (value) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const findClassifierByKey = (classifiers, classifierKey) =>
  classifiers.find((item) => item.key === classifierKey) || null;

const resolveClassificationMetadata = (classification, classifiers) => {
  if (
    !classification ||
    (
      !Array.isArray(classification.prediction) &&
      !classification.classifier_key
    ) ||
    (
      Array.isArray(classification.prediction) &&
      classification.prediction.length === 0 &&
      !classification.classifier_key
    )
  ) {
    return classification;
  }

  const classifierConfig = findClassifierByKey(
    classifiers,
    classification.classifier_key
  );
  if (!classifierConfig) {
    return classification;
  }

  return {
    ...classification,
    classes: classifierConfig.classes || [],
    classes_short: classifierConfig.classes_short || [],
  };
};

const buildSpeciesOptions = (
  classification,
  classifierConfig,
  selectedSpecies = []
) => {
  const classes =
    classification && Array.isArray(classification.classes)
      ? classification.classes
      : classifierConfig && Array.isArray(classifierConfig.classes)
        ? classifierConfig.classes
        : [];
  const classesShort =
    classification && Array.isArray(classification.classes_short)
      ? classification.classes_short
      : classifierConfig && Array.isArray(classifierConfig.classes_short)
        ? classifierConfig.classes_short
        : [];

  const optionMap = new Map();
  const total = Math.max(classes.length, classesShort.length);

  for (let index = 0; index < total; index += 1) {
    const fullLabel = classes[index] || classesShort[index];
    const shortLabel = classesShort[index] || classes[index];
    const value = shortLabel || fullLabel;

    if (!value || optionMap.has(value)) {
      continue;
    }

    optionMap.set(value, {
      value,
      shortLabel,
      fullLabel,
    });
  }

  selectedSpecies.forEach((value) => {
    if (!value || optionMap.has(value)) {
      return;
    }

    optionMap.set(value, {
      value,
      shortLabel: value,
      fullLabel: value,
    });
  });

  return Array.from(optionMap.values());
};

export class App extends Component {
  classifierLoadRetryTimer = null;

  projectLoadRetryTimer = null;

  playbackCompletionTimer = null;

  playbackRequestId = 0;

  spectrogramRequestId = 0;

  spectrogramChunkCache = [];

  spectrogramPrefetches = new Set();

  spectrogramPrefetchQueue = [];

  spectrogramPrefetchInFlight = null;

  spectrogramCacheToken = 0;

  visibleSpectrogramWindowRef = { start: 0, end: 0 };

  handleDocumentContextMenu = (event) => {
    event.preventDefault();
  };

  constructor() {
    super();
    this.state = {
      projects: [],
      projectsLoaded: false,
      recordings: [],
      classifiers: [],
      classifiersLoaded: false,
      selectedProject: 0,
      selectedRecording: null,
      createProjectModal: false,
      projectTitle: "",
      projectDescription: "",
      projectContext: null,
      projectContextSelection: 0,
      selectedRecordings: [],
      specData: [],
      waveData: [],
      classification: null,
      tabValue: 1,
      specTabValue: 0,
      recordingData: EMPTY_RECORDING,
      recordingLocation: {
        lat: 0,
        lng: 0,
      },
      classifier: "",
      specLoading: false,
      classifyLoading: false,
      editProject: false,
      classifyAllProgress: 0,
      classifyAllLoading: false,
      recordingsMenu: null,
      recordingLoading: null,
      projectFilter: "",
      recordingFilter: "",
      confirmDeleteDialog: null,
      fileNotFoundDialog: false,
      alertDialog: null,
      processingMode: "full",
      speciesDialog: null,
      specStart: 0,
      specEnd: 0,
      specViewStart: 0,
      specViewEnd: 0,
      playPause: false,
      playbackCursor: null,
      expansionRate: 10.0,
    };

    backend.expose(this.classifiedRecording, "classifiedRecording");
    backend.expose(this.setRecordingLoading, "setRecordingLoading");
    backend.expose(this.setRecording, "setRecording");
    backend.expose(this.memoryError, "memoryError");
    backend.expose(this.playEnd, "playEnd");
    backend.expose(this.classificationError, "classificationError");
  }

  componentDidMount() {
    document.addEventListener("contextmenu", this.handleDocumentContextMenu);

    this.loadProjects();
    this.loadClassifiers();
  }

  componentWillUnmount() {
    document.removeEventListener("contextmenu", this.handleDocumentContextMenu);
    window.clearTimeout(this.classifierLoadRetryTimer);
    window.clearTimeout(this.projectLoadRetryTimer);
    window.clearTimeout(this.playbackCompletionTimer);
  }

  openAlert = (title, text) => {
    this.setState({ alertDialog: { title, text } });
  };

  retryLoadClassifiers = () => {
    window.clearTimeout(this.classifierLoadRetryTimer);
    this.classifierLoadRetryTimer = window.setTimeout(() => {
      this.loadClassifiers();
    }, 1500);
  };

  retryLoadProjects = () => {
    window.clearTimeout(this.projectLoadRetryTimer);
    this.projectLoadRetryTimer = window.setTimeout(() => {
      this.loadProjects();
    }, 1500);
  };

  clearSpectrogramCache = () => {
    this.spectrogramCacheToken += 1;
    this.spectrogramChunkCache = [];
    this.spectrogramPrefetches = new Set();
    this.spectrogramPrefetchQueue = [];
    this.spectrogramPrefetchInFlight = null;
  };

  setVisibleSpectrogramWindowRef = (start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      this.visibleSpectrogramWindowRef = { start: 0, end: 0 };
      return this.visibleSpectrogramWindowRef;
    }

    const totalFrames = this.getSpectrogramTotalFrames();
    const boundedTotal = Number.isFinite(totalFrames) && totalFrames > 0
      ? totalFrames
      : null;
    const maxStart = boundedTotal != null ? Math.max(0, boundedTotal - 1) : Number.POSITIVE_INFINITY;
    const rawStart = Math.floor(start);
    const rawEnd = Math.ceil(end);
    const nextStart = Math.min(Math.max(0, rawStart), maxStart);
    const nextEndRaw = Math.max(nextStart + 1, rawEnd);
    const nextEnd = boundedTotal != null ? Math.min(nextEndRaw, boundedTotal) : nextEndRaw;
    this.visibleSpectrogramWindowRef = {
      start: nextStart,
      end: nextEnd,
    };
    return this.visibleSpectrogramWindowRef;
  };

  getSpectrogramTotalFrames = () => {
    const { recordingData, specStart, specData } = this.state;
    if (
      Number.isFinite(recordingData.sampleCount) &&
      recordingData.sampleCount > 0
    ) {
      return Math.ceil(recordingData.sampleCount / 128);
    }

    if (
      Number.isFinite(recordingData.duration) &&
      recordingData.duration > 0 &&
      Number.isFinite(recordingData.samplerate) &&
      recordingData.samplerate > 0
    ) {
      return Math.ceil((recordingData.duration * recordingData.samplerate) / 128);
    }

    return (specStart || 0) + (specData?.length || 0);
  };

  getSpectrogramBufferFrames = (requestedSpan = 0) => {
    const samplerate = this.state.recordingData.samplerate || 220500;
    const baseFrames = Math.ceil((samplerate * SPECTROGRAM_PREFETCH_SECONDS) / 128);
    return Math.max(2048, baseFrames, Math.ceil(requestedSpan));
  };

  normalizeSpectrogramRange = (start, end) => {
    const safeStart = Number.isFinite(start) ? start : 0;
    const safeEnd = Number.isFinite(end) ? end : safeStart + 1;
    const nextStartRaw = Math.max(0, Math.floor(safeStart));
    const nextEndRaw = Math.max(
      nextStartRaw + 1,
      Math.ceil(safeEnd > nextStartRaw ? safeEnd : nextStartRaw + 1)
    );
    const totalFrames = this.getSpectrogramTotalFrames();
    if (Number.isFinite(totalFrames) && totalFrames > 1) {
      const maxStart = Math.max(0, Math.ceil(totalFrames) - 1);
      const nextStart = Math.min(nextStartRaw, maxStart);
      const maxEnd = Math.max(nextStart + 1, Math.ceil(totalFrames));
      const nextEnd = Math.min(nextEndRaw, maxEnd);
      return { start: nextStart, end: nextEnd };
    }

    const nextStart = nextStartRaw;
    const nextEnd = nextEndRaw;
    return { start: nextStart, end: nextEnd };
  };

  runNextSpectrogramPrefetch = () => {
    if (
      this.spectrogramPrefetchInFlight !== null ||
      this.spectrogramPrefetchQueue.length === 0
    ) {
      return;
    }

    const nextTask = this.spectrogramPrefetchQueue.pop();
    if (!nextTask) {
      return;
    }

    this.spectrogramPrefetchInFlight = nextTask.key;
    backend.get_chunk(
      nextTask.selectedProject,
      nextTask.selectedRecording,
      nextTask.start,
      nextTask.end
    )((data) => {
      this.spectrogramPrefetches.delete(nextTask.key);
      if (this.spectrogramPrefetchInFlight === nextTask.key) {
        this.spectrogramPrefetchInFlight = null;
      }
      if (
        nextTask.cacheToken === this.spectrogramCacheToken &&
        this.state.selectedProject === nextTask.selectedProject &&
        this.state.selectedRecording === nextTask.selectedRecording &&
        Array.isArray(data) &&
        data.length > 0
      ) {
        this.storeSpectrogramChunk(nextTask.start, data);
      }
      this.runNextSpectrogramPrefetch();
    }).catch(() => {
      this.spectrogramPrefetches.delete(nextTask.key);
      if (this.spectrogramPrefetchInFlight === nextTask.key) {
        this.spectrogramPrefetchInFlight = null;
      }
      this.runNextSpectrogramPrefetch();
    });
  };

  storeSpectrogramChunk = (start, data) => {
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    let mergedChunk = {
      start: Math.max(0, Math.floor(start)),
      end: Math.max(0, Math.floor(start)) + data.length,
      data: data.slice(),
    };
    const nextCache = [];

    this.spectrogramChunkCache
      .slice()
      .sort((left, right) => left.start - right.start)
      .forEach((chunk) => {
        if (
          chunk.end < mergedChunk.start ||
          chunk.start > mergedChunk.end
        ) {
          nextCache.push(chunk);
          return;
        }

        const mergedStart = Math.min(chunk.start, mergedChunk.start);
        const mergedEnd = Math.max(chunk.end, mergedChunk.end);
        const mergedData = new Array(mergedEnd - mergedStart);
        const copyIntoMerged = (sourceChunk, overwrite = false) => {
          const offset = sourceChunk.start - mergedStart;
          for (let index = 0; index < sourceChunk.data.length; index += 1) {
            if (overwrite || mergedData[offset + index] === undefined) {
              mergedData[offset + index] = sourceChunk.data[index];
            }
          }
        };

        copyIntoMerged(chunk);
        copyIntoMerged(mergedChunk, true);
        mergedChunk = {
          start: mergedStart,
          end: mergedEnd,
          data: mergedData,
        };
      });

    nextCache.push(mergedChunk);
    this.spectrogramChunkCache = nextCache.sort(
      (left, right) => left.start - right.start
    );
    return mergedChunk;
  };

  findCachedSpectrogramChunk = (start, end) => {
    const range = this.normalizeSpectrogramRange(start, end);
    return (
      this.spectrogramChunkCache.find(
        (chunk) =>
          chunk.start <= range.start + SPECTROGRAM_CACHE_TOLERANCE_FRAMES &&
          chunk.end >= range.end - SPECTROGRAM_CACHE_TOLERANCE_FRAMES
      ) || null
    );
  };

  applySpectrogramChunkState = (chunk, viewStart, viewEnd) => {
    if (!chunk) {
      return false;
    }

    const nextViewStart = Math.max(chunk.start, Math.floor(viewStart));
    const nextViewEnd = Math.min(
      chunk.end,
      Math.max(nextViewStart + 1, Math.ceil(viewEnd > nextViewStart ? viewEnd : nextViewStart + 1))
    );
    const hasVisibleRange =
      Number.isFinite(this.visibleSpectrogramWindowRef.start) &&
      Number.isFinite(this.visibleSpectrogramWindowRef.end) &&
      this.visibleSpectrogramWindowRef.end > this.visibleSpectrogramWindowRef.start;
    const nextState = {
      specData: chunk.data,
      specLoading: false,
      specStart: chunk.start,
      specEnd: chunk.end,
    };

    if (!hasVisibleRange) {
      this.setVisibleSpectrogramWindowRef(nextViewStart, nextViewEnd);
      nextState.specViewStart = nextViewStart;
      nextState.specViewEnd = nextViewEnd;
    }

    this.setState(nextState);
    return true;
  };

  prefetchSpectrogramRange = (start, end) => {
    const { selectedProject, selectedRecording } = this.state;
    if (selectedRecording == null) {
      return;
    }

    const range = this.normalizeSpectrogramRange(start, end);
    if (
      range.end <= range.start ||
      this.findCachedSpectrogramChunk(range.start, range.end)
    ) {
      return;
    }

    const key = `${range.start}:${range.end}`;
    if (this.spectrogramPrefetches.has(key)) {
      return;
    }

    this.spectrogramPrefetches.add(key);
    this.spectrogramPrefetchQueue.push({
      key,
      start: range.start,
      end: range.end,
      selectedProject,
      selectedRecording,
      cacheToken: this.spectrogramCacheToken,
    });
    if (this.spectrogramPrefetchQueue.length > 6) {
      const droppedTask = this.spectrogramPrefetchQueue.shift();
      if (droppedTask) {
        this.spectrogramPrefetches.delete(droppedTask.key);
      }
    }
    this.runNextSpectrogramPrefetch();
  };

  prefetchSpectrogramAround = (viewStart, viewEnd) => {
    const totalFrames = this.getSpectrogramTotalFrames();
    if (totalFrames <= 1) {
      return;
    }

    const range = this.normalizeSpectrogramRange(viewStart, viewEnd);
    const containingChunk = this.findCachedSpectrogramChunk(range.start, range.end);
    const span = this.getSpectrogramBufferFrames(range.end - range.start);
    const leftEdge = containingChunk ? containingChunk.start : range.start;
    const rightEdge = containingChunk ? containingChunk.end : range.end;

    if (rightEdge < totalFrames) {
      this.prefetchSpectrogramRange(
        rightEdge,
        Math.min(totalFrames, rightEdge + span)
      );
    }
    if (leftEdge > 0) {
      this.prefetchSpectrogramRange(
        Math.max(0, leftEdge - span),
        leftEdge
      );
    }
  };

  loadClassifiers = () => {
    backend.get_classifiers()((classifiers) => {
      window.clearTimeout(this.classifierLoadRetryTimer);
      this.setState((current) => ({
        classifiers,
        classifiersLoaded: true,
        classifier:
          current.classifier || classifiers[0]?.key || "",
      }));
    }).catch((error) => {
      console.error("Failed to load classifiers", error);
      this.retryLoadClassifiers();
    });
  };

  loadProjects = () => {
    backend.get_projects()((projects) => {
      window.clearTimeout(this.projectLoadRetryTimer);
      const nextProjects = projects || [];
      this.setState({ projects: nextProjects, projectsLoaded: true }, () => {
        const nextSelectedProject = Math.min(
          this.state.selectedProject,
          Math.max(nextProjects.length - 1, 0)
        );
        this.selectProject(nextSelectedProject);
      });
    }).catch((error) => {
      console.error("Failed to load projects", error);
      this.retryLoadProjects();
    });
  };

  resetRecordingState = () => {
    this.spectrogramRequestId += 1;
    this.clearSpectrogramCache();
    this.setVisibleSpectrogramWindowRef(0, 0);
    this.setState({
      selectedRecordings: [],
      selectedRecording: null,
      recordingData: EMPTY_RECORDING,
      recordingLocation: { lat: 0, lng: 0 },
      classification: null,
      specData: [],
      waveData: [],
      playPause: false,
      playbackCursor: null,
      classifyLoading: false,
      classifyAllProgress: 0,
      classifyAllLoading: false,
      recordingLoading: null,
      speciesDialog: null,
      specStart: 0,
      specEnd: 0,
      specViewStart: 0,
      specViewEnd: 0,
    });
  };

  getEffectivePlaybackRange = () => {
    const { specStart, specData, specViewStart, specViewEnd } = this.state;
    const loadedStart = specStart || 0;
    const fallbackEnd = loadedStart + (specData ? specData.length : 0);
    const totalFrames = Math.max(this.getSpectrogramTotalFrames(), 1);
    const refRange = this.visibleSpectrogramWindowRef;
    const hasRefRange =
      Number.isFinite(refRange.start) &&
      Number.isFinite(refRange.end) &&
      refRange.end > refRange.start;
    const visibleStart = hasRefRange
      ? refRange.start
      : Number.isFinite(specViewStart)
        ? specViewStart
        : loadedStart;
    const visibleEnd = hasRefRange
      ? refRange.end
      : Number.isFinite(specViewEnd) && specViewEnd > visibleStart
        ? specViewEnd
        : fallbackEnd;
    const start = Math.min(
      Math.max(0, Math.floor(visibleStart)),
      Math.max(0, totalFrames - 1),
    );
    const end = Math.min(
      Math.max(start + 1, Math.ceil(visibleEnd)),
      totalFrames,
    );
    return { start, end };
  };

  selectProject = (projectIndex) => {
    const { projects } = this.state;
    const project = projects[projectIndex];

    if (!project) {
      this.setState(
        {
          recordings: [],
          classifier: "",
          processingMode: "full",
        },
        this.resetRecordingState
      );
      return;
    }

    this.setState(
      {
        recordings: project.recordings || [],
        classifier: project.classifier || "",
        processingMode: project.processing_mode || "full",
        selectedProject: projectIndex,
      },
      this.resetRecordingState
    );
  };

  createProject = () => {
    const { projectTitle, projectDescription } = this.state;
    this.setState({ createProjectModal: false });
    backend.add_project(projectTitle, projectDescription)(this.loadProjects);
  };

  saveProject = () => {
    const { projectContextSelection, projectTitle, projectDescription } =
      this.state;
    this.setState({ createProjectModal: false });
    backend.save_project(
      projectContextSelection,
      projectTitle,
      projectDescription
    )(this.loadProjects);
  };

  removeProject = () => {
    this.setState({ projectContext: null });
    backend.remove_project(this.state.projectContextSelection)(this.loadProjects);
  };

  openDeleteProjectDialog = () => {
    const { projects, projectContextSelection } = this.state;
    const project = projects[projectContextSelection];
    this.setState({
      projectContext: null,
      confirmDeleteDialog: {
        title: "Delete project?",
        text: project
          ? `Delete "${project.title}" and all recordings inside it?`
          : "Delete this project?",
        onConfirm: this.removeProject,
      },
    });
  };

  editProject = () => {
    const { projects, projectContextSelection } = this.state;
    const project = projects[projectContextSelection];

    this.setState({
      projectContext: null,
      createProjectModal: true,
      projectTitle: project.title,
      projectDescription: project.description,
      editProject: true,
    });
  };

  addRecordings = () => {
    backend.add_recordings(this.state.selectedProject)((result) => {
      this.loadProjects();
      if (!result) {
        return;
      }
      if (result.metadata_files > 0) {
        this.openAlert(
          "Imported metadata",
          `Loaded ${result.metadata_files} metadata file(s) and matched ${result.matched_recordings} recording(s).`
        );
      }
    });
  };

  removeRecordings = () => {
    const { selectedRecordings, selectedProject } = this.state;
    if (selectedRecordings.length === 0) {
      return;
    }

    this.setState({ recordingsMenu: null });
    backend.remove_recordings(selectedProject, selectedRecordings)(() => {
      this.loadProjects();
      this.setState({ selectedRecordings: [] });
    });
  };

  openDeleteRecordingsDialog = () => {
    const count = this.state.selectedRecordings.length;
    this.setState({
      recordingsMenu: null,
      confirmDeleteDialog: {
        title: "Delete recordings?",
        text:
          count === 1
            ? "Delete the selected recording?"
            : `Delete ${count} selected recordings?`,
        onConfirm: this.removeRecordings,
      },
    });
  };

  openRecordingsMenu = (event, recordingIndex = null) => {
    if (event && event.preventDefault) {
      event.preventDefault();
    }
    const anchorEl = event?.currentTarget || null;
    const mouseX =
      typeof event?.clientX === "number" ? event.clientX + 2 : null;
    const mouseY =
      typeof event?.clientY === "number" ? event.clientY - 6 : null;

    this.setState((current) => {
      const nextSelectedRecordings =
        recordingIndex == null
          ? current.selectedRecordings
          : current.selectedRecordings.includes(recordingIndex)
            ? current.selectedRecordings
            : [recordingIndex];

      return {
        selectedRecordings: nextSelectedRecordings,
        recordingsMenu:
          recordingIndex == null
            ? {
                anchorEl,
                mouseX: null,
                mouseY: null,
              }
            : {
                anchorEl: null,
                mouseX,
                mouseY,
              },
      };
    });
  };

  handleProjectContext = (event, index) => {
    event.preventDefault();
    this.setState({
      projectContext:
        this.state.projectContext === null
          ? {
              mouseX: event.clientX + 2,
              mouseY: event.clientY - 6,
            }
          : null,
      projectContextSelection: index,
    });
  };

  setRecording = (specData, waveData) => {
    this.spectrogramRequestId += 1;
    this.setVisibleSpectrogramWindowRef(0, specData.length);
    this.setState({
      specLoading: false,
      specData,
      waveData,
      specStart: 0,
      specEnd: specData.length,
      specViewStart: 0,
      specViewEnd: specData.length,
    });
  };

  selectRecording = (recordingIndex) => {
    const recording = this.state.recordings[recordingIndex];
    if (!recording) {
      return;
    }

    this.spectrogramRequestId += 1;
    this.setVisibleSpectrogramWindowRef(0, 0);
    this.stopPlayback();

    this.setState({
      specLoading: true,
      specData: [],
      waveData: [],
      specStart: 0,
      specEnd: 0,
      specViewStart: 0,
      specViewEnd: 0,
      recordingData: recording,
      selectedRecording: recordingIndex,
      classification: recording.classification,
      recordingLocation: {
        lat: recording.location.latitude,
        lng: recording.location.longitude,
      },
      tabValue: 0,
    });

    backend.get_recording(this.state.selectedProject, recordingIndex)((result) => {
      if (result === false) {
        this.setState({ fileNotFoundDialog: true });
        return;
      }

      this.setState((current) => {
        const recordings = current.recordings.slice();
        if (recordings[recordingIndex]) {
          recordings[recordingIndex] = {
            ...recordings[recordingIndex],
            classification: result.classification || recordings[recordingIndex].classification,
            species: result.species || recordings[recordingIndex].species,
          };
        }

        return {
          recordings,
          recordingData: result,
          classification: result.classification || current.classification,
          fileNotFoundDialog: false,
        };
      });
    });
  };

  classifyAll = () => {
    const windowRange = this.getClassificationWindowRange();
    if (windowRange === false) {
      return;
    }

    this.setState({
      classifyAllLoading: true,
      classifyAllProgress: 0,
      recordingsMenu: null,
    });
    backend.classify_all(
      this.state.selectedProject,
      null,
      windowRange?.start ?? null,
      windowRange?.end ?? null
    )();
  };

  classifyRecordings = () => {
    const { selectedProject, selectedRecordings } = this.state;
    if (selectedRecordings.length === 0) {
      return;
    }

    const windowRange = this.getClassificationWindowRange();
    if (windowRange === false) {
      return;
    }

    this.setState({
      classifyAllLoading: true,
      classifyAllProgress: 0,
      recordingsMenu: null,
      tabValue: 1,
    });
    backend.classify_all(
      selectedProject,
      selectedRecordings,
      windowRange?.start ?? null,
      windowRange?.end ?? null
    )();
  };

  classify = () => {
    const { selectedProject, selectedRecording } = this.state;
    if (selectedRecording == null) {
      return;
    }

    const windowRange = this.getClassificationWindowRange();
    if (windowRange === false) {
      return;
    }

    this.setState({ classifyLoading: true });
    backend.classify(
      selectedProject,
      selectedRecording,
      windowRange?.start ?? null,
      windowRange?.end ?? null
    )();
  };

  classifiedRecording = (
    projectIndex,
    recordingIndex,
    classification,
    classes,
    progress
  ) => {
    if (projectIndex !== this.state.selectedProject) {
      return;
    }

    const normalizedProgress = Number.isFinite(progress)
      ? Math.max(0, Math.min(progress, 100))
      : 0;

    const newRecordings = this.state.recordings.slice();
    const nextClassification =
      classification && Array.isArray(classification.prediction)
        ? classification
        : null;
    if (newRecordings[recordingIndex]) {
      newRecordings[recordingIndex] = {
        ...newRecordings[recordingIndex],
        species: classes.join(", "),
        classification: nextClassification,
      };
    }

    if (this.state.selectedRecording === recordingIndex) {
      this.setState({
        recordingData: {
          ...this.state.recordingData,
          species: classes.join(", "),
        },
        classification: nextClassification,
        classifyLoading: false,
      });
    }

    this.setState({
      recordings: newRecordings,
      classifyAllProgress: normalizedProgress,
      classifyAllLoading: normalizedProgress < 100,
      recordingLoading: null,
    });
  };

  setRecordingLoading = (projectIndex, recordingIndex) => {
    if (projectIndex === this.state.selectedProject) {
      this.setState({ recordingLoading: recordingIndex });
    }
  };

  memoryError = () => {
    this.openAlert(
      "Memory error",
      "The sound file was too big to be processed by your device. Make sure you have enough RAM or switch the prediction range to Window."
    );
  };

  classificationError = (message) => {
    this.setState({
      classifyLoading: false,
      classifyAllLoading: false,
      classifyAllProgress: 0,
      recordingLoading: null,
    });
    this.openAlert("Classification error", message);
  };

  exportCSV = () => {
    const { projectContextSelection, projects } = this.state;
    this.setState({ projectContext: null });
    const projectTitle = projects[projectContextSelection].title;

    backend.export_csv(projectContextSelection, `${projectTitle}.csv`)((result) => {
      if (result) {
        this.openAlert(
          "Successfully exported",
          `${projectTitle} was successfully exported.`
        );
      } else {
        this.openAlert(
          "Exporting unsuccessful",
          `${projectTitle} could not be exported.`
        );
      }
    });
  };

  playEnd = () => {
    this.playbackRequestId += 1;
    window.clearTimeout(this.playbackCompletionTimer);
    this.playbackCompletionTimer = null;
    this.setState({ playPause: false, playbackCursor: null });
  };

  stopPlayback = () => {
    this.playbackRequestId += 1;
    window.clearTimeout(this.playbackCompletionTimer);
    this.playbackCompletionTimer = null;
    if (!this.state.playPause) {
      if (this.state.playbackCursor !== null) {
        this.setState({ playbackCursor: null });
      }
      return;
    }

    backend.pause();
    this.setState({ playPause: false, playbackCursor: null });
  };

  playPause = async () => {
    const {
      playPause,
      selectedProject,
      selectedRecording,
      recordingData,
      expansionRate,
    } = this.state;

    if (selectedRecording == null) {
      return;
    }

    if (playPause) {
      this.stopPlayback();
      return;
    }

    const { start, end } = this.getEffectivePlaybackRange();
    if (end <= start) {
      return;
    }
    const nextRange = this.setVisibleSpectrogramWindowRef(start, end);

    const samplerate = recordingData.samplerate || 220500;
    const fallbackDurationMs =
      (((nextRange.end - nextRange.start) * 128) / samplerate) * expansionRate * 1000;
    const requestId = this.playbackRequestId + 1;
    this.playbackRequestId = requestId;

    this.setState({
      playPause: true,
      playbackCursor: null,
      specViewStart: nextRange.start,
      specViewEnd: nextRange.end,
    });

    const loaded = await this.loadChunkRange(nextRange.start, nextRange.end);
    if (this.playbackRequestId !== requestId || this.state.playPause !== true) {
      return;
    }
    if (!loaded) {
      this.setState({ playPause: false, playbackCursor: null });
      return;
    }

    backend.play(
      selectedProject,
      selectedRecording,
      nextRange.start,
      nextRange.end,
      expansionRate
    ).then((result) => {
      if (this.playbackRequestId !== requestId || this.state.playPause !== true) {
        return;
      }
      if (result?.started === false) {
        this.setState({ playPause: false, playbackCursor: null });
        return;
      }

      const durationMs =
        Number.isFinite(result?.durationMs) && result.durationMs >= 0
          ? result.durationMs
          : fallbackDurationMs;
      const actualStartFrame =
        Number.isFinite(result?.startFrameIndex)
          ? result.startFrameIndex
          : nextRange.start;
      const actualEndFrameRaw =
        Number.isFinite(result?.endFrameIndex)
          ? result.endFrameIndex
          : nextRange.end;
      const actualEndFrame = Math.max(actualStartFrame + 1, actualEndFrameRaw);
      const startupLagMs = result?.playbackEngine === "afplay" ? 120 : 0;
      const serverStartedAtMs = Number.isFinite(result?.startedAtMs)
        ? result.startedAtMs
        : null;
      const startedAtMs = serverStartedAtMs != null
        ? performance.now() - Math.max(Date.now() - serverStartedAtMs, 0) + startupLagMs
        : performance.now() + startupLagMs;
      this.setState({
        playbackCursor: {
          startFrameIndex: actualStartFrame,
          endFrameIndex: actualEndFrame,
          startedAtMs,
          durationMs,
        },
      });
      window.clearTimeout(this.playbackCompletionTimer);
      this.playbackCompletionTimer = window.setTimeout(() => {
        if (this.playbackRequestId !== requestId) {
          return;
        }
        this.setState({ playPause: false, playbackCursor: null });
        this.playbackCompletionTimer = null;
      }, durationMs + startupLagMs + 50);
    }).catch((error) => {
      if (this.playbackRequestId !== requestId) {
        return;
      }
      console.error("Failed to start playback", error);
      window.clearTimeout(this.playbackCompletionTimer);
      this.playbackCompletionTimer = null;
      this.setState({ playPause: false, playbackCursor: null });
    });
  };

  toggleRecordingSelection = (index) => {
    this.setState((current) => ({
      selectedRecordings: current.selectedRecordings.includes(index)
        ? current.selectedRecordings.filter((item) => item !== index)
        : [...current.selectedRecordings, index],
    }));
  };

  toggleAllRecordings = () => {
    this.setState((current) => ({
      selectedRecordings:
        current.selectedRecordings.length === current.recordings.length ||
        current.recordings.length === 0
          ? []
          : Array.from(Array(current.recordings.length).keys()),
    }));
  };

  loadChunkRange = (start, end) => {
    const { selectedProject, selectedRecording } = this.state;
    if (selectedRecording == null) {
      return Promise.resolve(false);
    }

    const range = this.normalizeSpectrogramRange(start, end);
    if (
      this.state.specStart === range.start &&
      this.state.specEnd === range.end &&
      Array.isArray(this.state.specData) &&
      this.state.specData.length === Math.max(range.end - range.start, 0)
    ) {
      return Promise.resolve(true);
    }

    const requestId = this.spectrogramRequestId + 1;
    this.spectrogramRequestId = requestId;
    this.setState((current) => ({
      specLoading: current.specData.length === 0,
    }));

    return new Promise((resolve) => {
      backend.get_chunk(
        selectedProject,
        selectedRecording,
        range.start,
        range.end
      )((data) => {
        if (requestId !== this.spectrogramRequestId) {
          resolve(false);
          return;
        }
        if (!data) {
          this.setState((current) => {
            const fallbackStart = current.specStart || 0;
            const fallbackEnd = fallbackStart + (current.specData?.length || 0);
            this.setVisibleSpectrogramWindowRef(fallbackStart, fallbackEnd);
            return {
              specLoading: false,
              specViewStart: fallbackStart,
              specViewEnd: fallbackEnd,
            };
          }, () => resolve(false));
          return;
        }

        this.setState({
          specData: data,
          specLoading: false,
          specStart: range.start,
          specEnd: range.start + data.length,
        }, () => resolve(true));
      }).catch((error) => {
        console.error("Failed to load spectrogram chunk", error);
        if (requestId === this.spectrogramRequestId) {
          this.setState({ specLoading: false });
        }
        resolve(false);
      });
    });
  };

  setVisibleSpectrogramWindow = (start, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return;
    }

    const nextRange = this.setVisibleSpectrogramWindowRef(start, end);
    if (this.state.playPause) {
      this.stopPlayback();
    }

    this.setState((current) => {
      if (
        Math.abs((current.specViewStart ?? 0) - nextRange.start) < 0.5 &&
        Math.abs((current.specViewEnd ?? 0) - nextRange.end) < 0.5
      ) {
        return null;
      }

      return {
        specViewStart: nextRange.start,
        specViewEnd: nextRange.end,
      };
    });

    this.loadChunkRange(nextRange.start, nextRange.end);
  };
  handleClassifierChange = (event) => {
    const value = event.target.value;
    this.setState((current) => {
      const projects = current.projects.slice();
      if (projects[current.selectedProject]) {
        projects[current.selectedProject] = {
          ...projects[current.selectedProject],
          classifier: value,
        };
      }

      return {
        classifier: value,
        projects,
      };
    });
    backend.set_classifier(this.state.selectedProject, value);
  };

  handleProcessingModeChange = (event) => {
    const value = event.target.value;
    this.setState((current) => {
      const projects = current.projects.slice();
      if (projects[current.selectedProject]) {
        projects[current.selectedProject] = {
          ...projects[current.selectedProject],
          processing_mode: value,
        };
      }

      return {
        processingMode: value,
        projects,
      };
    });
    backend.set_processing_mode(this.state.selectedProject, value);
  };

  getClassificationWindowRange = () => {
    const { processingMode, selectedRecording } = this.state;
    if (processingMode !== "window") {
      return null;
    }

    if (selectedRecording == null) {
      this.openAlert(
        "No spectrogram window",
        "Select a recording first so Window mode can use the visible spectrogram range."
      );
      return false;
    }

    const { start, end } = this.getEffectivePlaybackRange();
    if (end <= start) {
      this.openAlert(
        "No spectrogram window",
        "Window mode needs a visible spectrogram range to classify."
      );
      return false;
    }

    return { start, end };
  };

  openSpeciesDialog = (recordingIndex = this.state.selectedRecording, focusSpecies = null) => {
    if (recordingIndex == null) {
      return;
    }

    const recording = this.state.recordings[recordingIndex];
    const speciesText =
      recordingIndex === this.state.selectedRecording
        ? this.state.recordingData.species || recording?.species || ""
        : recording?.species || "";

    const species = splitSpeciesText(speciesText);
    const initialSpecies =
      focusSpecies && !species.includes(focusSpecies)
        ? [focusSpecies, ...species]
        : species;

    this.setState({
      speciesDialog: {
        recordingIndex,
        focusSpecies: focusSpecies || initialSpecies[0] || null,
        species: initialSpecies,
      },
    });
  };

  handleSpeciesSave = (species) => {
    const { selectedProject, speciesDialog } = this.state;
    if (!speciesDialog) {
      return;
    }

    const recordingIndex = speciesDialog.recordingIndex;
    const speciesText = species.join(", ");

    backend.set_species(selectedProject, recordingIndex, speciesText)(() => {
      this.setState((current) => {
        const recordings = current.recordings.slice();
        if (recordings[recordingIndex]) {
          recordings[recordingIndex] = {
            ...recordings[recordingIndex],
            species: speciesText,
          };
        }

        return {
          speciesDialog: null,
          recordings,
          recordingData:
            current.selectedRecording === recordingIndex
              ? {
                  ...current.recordingData,
                  species: speciesText,
                }
              : current.recordingData,
        };
      });
    });
  };

  render() {
    const {
      alertDialog,
      classification,
      classifier,
      classifiers,
      classifiersLoaded,
      classifyAllLoading,
      classifyAllProgress,
      classifyLoading,
      createProjectModal,
      editProject,
      fileNotFoundDialog,
      processingMode,
      playPause,
      confirmDeleteDialog,
      projectContext,
      projectDescription,
      projectFilter,
      projectTitle,
      projects,
      projectsLoaded,
      recordingData,
      recordingLoading,
      recordingLocation,
      recordingFilter,
      recordings,
      recordingsMenu,
      selectedProject,
      selectedRecording,
      selectedRecordings,
      specData,
      specLoading,
      specStart,
      specViewEnd,
      specViewStart,
      specTabValue,
      speciesDialog,
      tabValue,
      waveData,
      playbackCursor,
      expansionRate,
    } = this.state;
    const resolvedClassification = resolveClassificationMetadata(
      classification,
      classifiers
    );
    const isStartupLoading = !projectsLoaded || !classifiersLoaded;

    if (isStartupLoading) {
      return (
        <ThemeProvider theme={darkTheme}>
          <CssBaseline />
          <Box className="loadingScreen">
            <Box className="loadingCard">
              <Box
                component="img"
                src={`${process.env.PUBLIC_URL}/icon-192.png`}
                alt="OpenEcho"
                className="loadingIcon"
              />
              <CircularProgress size={34} thickness={4} />
              <Typography variant="body2" className="loadingHint">
                Warming up...
              </Typography>
            </Box>
          </Box>
        </ThemeProvider>
      );
    }

    const normalizedProjectFilter = projectFilter.trim().toLowerCase();
    const filteredProjects = projects
      .map((project, index) => ({ project, index }))
      .filter(({ project }) => {
        if (!normalizedProjectFilter) {
          return true;
        }

        return [project.title, project.description]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalizedProjectFilter);
      });

    const normalizedRecordingFilter = recordingFilter.trim().toLowerCase();
    const filteredRecordings = recordings
      .map((recording, index) => ({ recording, index }))
      .filter(({ recording }) => {
        if (!normalizedRecordingFilter) {
          return true;
        }

        return [
          recording.title,
          recording.species,
          recording.path,
          recording.temperature != null ? String(recording.temperature) : "",
          recording.date ? new Date(recording.date).toLocaleString("en-GB") : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalizedRecordingFilter);
      });
    const selectedClassifier = findClassifierByKey(classifiers, classifier);
    const speciesDialogRecording =
      speciesDialog && recordings[speciesDialog.recordingIndex]
        ? recordings[speciesDialog.recordingIndex]
        : null;
    const speciesDialogClassification = speciesDialogRecording
      ? resolveClassificationMetadata(
          speciesDialogRecording.classification,
          classifiers
        )
      : resolvedClassification;
    const speciesDialogOptions = speciesDialog
      ? buildSpeciesOptions(
          speciesDialogClassification,
          selectedClassifier,
          speciesDialog.species
        )
      : [];

    return (
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <Box className="appRoot">
          <Box className="appLayout">
            <Box className="sidebarPane projectPane">
              <ProjectSidebar
                projects={filteredProjects}
                selectedProject={selectedProject}
                onSelectProject={this.selectProject}
                projectFilter={projectFilter}
                onProjectFilterChange={(event) =>
                  this.setState({ projectFilter: event.target.value })
                }
                onOpenCreateProject={() =>
                  this.setState({
                    createProjectModal: true,
                    editProject: false,
                    projectTitle: "",
                    projectDescription: "",
                  })
                }
                onProjectContextMenu={this.handleProjectContext}
              />
            </Box>

            <Divider orientation="vertical" flexItem className="desktopDivider" />

            <Box className="sidebarPane recordingsPane">
              <RecordingSidebar
                recordings={filteredRecordings}
                selectedRecording={selectedRecording}
                selectedRecordings={selectedRecordings}
                recordingLoading={recordingLoading}
                recordingFilter={recordingFilter}
                onRecordingFilterChange={(event) =>
                  this.setState({ recordingFilter: event.target.value })
                }
                onToggleAll={this.toggleAllRecordings}
                onOpenMenu={this.openRecordingsMenu}
                onOpenContextMenu={this.openRecordingsMenu}
                onAddRecordings={this.addRecordings}
                onSelectRecording={this.selectRecording}
                onToggleRecording={this.toggleRecordingSelection}
                onEditSpecies={this.openSpeciesDialog}
              />
            </Box>

            <Divider orientation="vertical" flexItem className="desktopDivider" />

            <Box className="contentPane mainPane">
              <MainContent
                specTabValue={specTabValue}
                onSpecTabChange={(event, value) =>
                  this.setState({ specTabValue: value })
                }
                specLoading={specLoading}
                selectedRecording={selectedRecording}
                specData={specData}
                waveData={waveData}
                recordingData={recordingData}
                specStart={specStart}
                specViewStart={specViewStart}
                specViewEnd={specViewEnd}
                playbackCursor={playbackCursor}
                onVisibleWindowChange={this.setVisibleSpectrogramWindow}
                playPause={playPause}
                onPlayPause={this.playPause}
                expansionRate={expansionRate}
                onExpansionRateChange={(event) => {
                  this.stopPlayback();
                  this.setState({ expansionRate: event.target.value });
                }}
                tabValue={tabValue}
                onTabChange={(event, value) => this.setState({ tabValue: value })}
                classifyLoading={classifyLoading}
                onClassify={this.classify}
                onEditSpecies={(focusSpecies) =>
                  this.openSpeciesDialog(selectedRecording, focusSpecies)
                }
                recordingLocation={recordingLocation}
                classification={resolvedClassification}
                classifiers={classifiers}
                classifier={classifier}
                processingMode={processingMode}
                onClassifierChange={this.handleClassifierChange}
                onProcessingModeChange={this.handleProcessingModeChange}
                classifyAllLoading={classifyAllLoading}
                classifyAllProgress={classifyAllProgress}
                onClassifyAll={this.classifyAll}
              />
            </Box>
          </Box>
        </Box>

        <AppDialogs
          createProjectModal={createProjectModal}
          onCloseCreateProject={() =>
            this.setState({
              createProjectModal: false,
              projectTitle: "",
              projectDescription: "",
            })
          }
          projectTitle={projectTitle}
          projectDescription={projectDescription}
          onProjectTitleChange={(event) =>
            this.setState({ projectTitle: event.target.value })
          }
          onProjectDescriptionChange={(event) =>
            this.setState({ projectDescription: event.target.value })
          }
          onSaveProject={editProject ? this.saveProject : this.createProject}
          editProject={editProject}
          fileNotFoundDialog={fileNotFoundDialog}
          recordingPath={recordingData.path}
          onRetryRecording={() => this.selectRecording(selectedRecording)}
          onCloseFileNotFound={() => this.setState({ fileNotFoundDialog: false })}
          alertDialog={alertDialog}
          onCloseAlert={() => this.setState({ alertDialog: null })}
          confirmDeleteDialog={confirmDeleteDialog}
          onCloseConfirmDelete={() =>
            this.setState({ confirmDeleteDialog: null })
          }
          onConfirmDelete={() => {
            const dialog = this.state.confirmDeleteDialog;
            this.setState({ confirmDeleteDialog: null }, () => {
              if (dialog && dialog.onConfirm) {
                dialog.onConfirm();
              }
            });
          }}
          speciesDialog={speciesDialog}
          speciesDialogOptions={speciesDialogOptions}
          onSaveSpecies={this.handleSpeciesSave}
          onCloseSpecies={() => this.setState({ speciesDialog: null })}
        />

        <Menu
          open={projectContext !== null}
          onClose={() => this.setState({ projectContext: null })}
          anchorReference="anchorPosition"
          anchorPosition={
            projectContext !== null
              ? {
                  top: projectContext.mouseY,
                  left: projectContext.mouseX,
                }
              : undefined
          }
        >
          <MenuItem onClick={this.editProject}>
            <ListItemIcon>
              <EditOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              <Typography>Edit</Typography>
            </ListItemText>
          </MenuItem>
          <MenuItem onClick={this.exportCSV}>
            <ListItemIcon>
              <ExportOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              <Typography>Export CSV</Typography>
            </ListItemText>
          </MenuItem>
          <MenuItem onClick={this.openDeleteProjectDialog}>
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>
              <Typography color="error">Delete</Typography>
            </ListItemText>
          </MenuItem>
        </Menu>

        <Menu
          open={recordingsMenu !== null}
          onClose={() => this.setState({ recordingsMenu: null })}
          anchorReference={
            recordingsMenu && recordingsMenu.mouseX != null
              ? "anchorPosition"
              : "anchorEl"
          }
          anchorPosition={
            recordingsMenu && recordingsMenu.mouseX != null
              ? {
                  top: recordingsMenu.mouseY,
                  left: recordingsMenu.mouseX,
                }
              : undefined
          }
          anchorEl={recordingsMenu ? recordingsMenu.anchorEl : null}
        >
          <MenuItem onClick={this.classifyRecordings}>
            <ListItemIcon>
              <ThinkIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              <Typography>Classify</Typography>
            </ListItemText>
          </MenuItem>
          <MenuItem onClick={this.openDeleteRecordingsDialog}>
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>
              <Typography color="error">Delete</Typography>
            </ListItemText>
          </MenuItem>
        </Menu>
      </ThemeProvider>
    );
  }
}

export default App;
