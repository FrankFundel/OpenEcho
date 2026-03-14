import React, { Component } from "react";
import "./App.css";

import Box from "@mui/material/Box";
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
  path: "",
  location: {
    latitude: 0,
    longitude: 0,
  },
  class: "",
  species: "",
};

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

  handleDocumentContextMenu = (event) => {
    event.preventDefault();
  };

  constructor() {
    super();
    this.state = {
      projects: [],
      recordings: [],
      classifiers: [],
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

  loadClassifiers = () => {
    backend.get_classifiers()((classifiers) => {
      window.clearTimeout(this.classifierLoadRetryTimer);
      this.setState((current) => ({
        classifiers,
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
      this.setState({ projects: nextProjects }, () => {
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
    });
  };

  getEffectivePlaybackRange = () => {
    const { specStart, specEnd, specData } = this.state;
    const start = specStart || 0;
    const fallbackEnd = start + (specData ? specData.length : 0);
    const end = specEnd > start ? specEnd : fallbackEnd;
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
    this.setState({
      specLoading: false,
      specData,
      waveData,
      specStart: 0,
      specEnd: specData.length,
    });
  };

  selectRecording = (recordingIndex) => {
    const recording = this.state.recordings[recordingIndex];
    if (!recording) {
      return;
    }

    this.stopPlayback();

    this.setState({
      specLoading: true,
      specData: [],
      waveData: [],
      specStart: 0,
      specEnd: 0,
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
    this.setState({ playPause: false, playbackCursor: null });
  };

  stopPlayback = () => {
    if (!this.state.playPause) {
      if (this.state.playbackCursor !== null) {
        this.setState({ playbackCursor: null });
      }
      return;
    }

    backend.pause();
    this.setState({ playPause: false, playbackCursor: null });
  };

  playPause = () => {
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

    const samplerate = recordingData.samplerate || 220500;
    const durationMs =
      (((end - start) * 128) / samplerate) * expansionRate * 1000;

    this.setState({
      playPause: true,
      playbackCursor: {
        startFrameIndex: start,
        endFrameIndex: end,
        startedAtMs: performance.now(),
        durationMs,
      },
    });
    backend.play(
      selectedProject,
      selectedRecording,
      start,
      end,
      expansionRate
    );
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
    this.setState({
      specLoading: true,
      specStart: start,
      specEnd: end,
    });

    backend.get_chunk(selectedProject, selectedRecording, start, end)((data) => {
      if (data) {
        this.setState({
          specData: data,
          specLoading: false,
        });
      }
    });
  };

  loadMoreChunks = (offset) => {
    const { selectedProject, selectedRecording, specData } = this.state;
    backend.get_chunk(selectedProject, selectedRecording, offset)((data) => {
      if (data) {
        this.setState({ specData: [...specData, ...data] });
      }
    });
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
                playbackCursor={playbackCursor}
                onLoadData={this.loadChunkRange}
                onLoadMore={this.loadMoreChunks}
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
