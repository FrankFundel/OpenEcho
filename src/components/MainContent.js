import React from "react";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Fade from "@mui/material/Fade";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import LoadingButton from "@mui/lab/LoadingButton";
import BackdropFilter from "react-backdrop-filter";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import Spectrogram from "./Spectrogram";
import BarChart from "./BarChart";
import MapContainer from "./MapContainer";
import SpeciesLabelList from "./SpeciesLabelList";

const PREDICTION_GRAPH_LIMIT = 20;

const findClassifierByKey = (classifiers, classifierKey) =>
  classifiers.find((item) => item.key === classifierKey) || null;

const findClassifiersByKeys = (classifiers, classifierKeys) =>
  (classifierKeys || [])
    .map((classifierKey) => findClassifierByKey(classifiers, classifierKey))
    .filter(Boolean);

const renderClassifierLabel = (item) => {
  if (!item) {
    return "";
  }

  return (
    <Box className="classifierOptionLabel">
      <span>{item.name}</span>
      {item.provider_label ? (
        <span className="providerChip">{item.provider_label}</span>
      ) : null}
    </Box>
  );
};

const getPredictionChartData = (classification, fallbackCategories) => {
  if (!classification || !Array.isArray(classification.prediction)) {
    return { values: [], categories: [] };
  }

  const entries = classification.prediction
    .map((value, index) => ({
      category: fallbackCategories[index] || `Class ${index + 1}`,
      value: Number(value),
      index,
    }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => right.value - left.value)
    .slice(0, PREDICTION_GRAPH_LIMIT);

  return {
    values: entries.map((entry) => entry.value),
    categories: entries.map((entry) => entry.category),
  };
};

const MainContent = ({
  specTabValue,
  onSpecTabChange,
  specLoading,
  selectedRecording,
  specData,
  waveData,
  recordingData,
  specStart,
  specViewStart,
  specViewEnd,
  playbackCursor,
  onVisibleWindowChange,
  playPause,
  onPlayPause,
  expansionRate,
  onExpansionRateChange,
  tabValue,
  onTabChange,
  classifyLoading,
  onClassify,
  onEditSpecies,
  recordingLocation,
  classification,
  classifiers,
  classifierKeys,
  predictionClassifierKey,
  predictionClassifiers,
  processingMode,
  onClassifierChange,
  onPredictionClassifierChange,
  onProcessingModeChange,
  classifyAllLoading,
  classifyAllProgress,
  onClassifyAll,
}) => {
  const hasRecording = selectedRecording != null;
  const hasLocation =
    recordingLocation &&
    (Math.abs(recordingLocation.lat) > 0.000001 ||
      Math.abs(recordingLocation.lng) > 0.000001);
  const selectedClassifiers = findClassifiersByKeys(classifiers, classifierKeys);
  const selectedClassifier =
    findClassifierByKey(classifiers, predictionClassifierKey) ||
    selectedClassifiers[0] ||
    null;
  const hasClassificationCategories =
    Array.isArray(classification?.classes_short) &&
    Array.isArray(classification?.prediction) &&
    classification.classes_short.length === classification.prediction.length &&
    classification.classes_short.length > 0;
  const hasClassifierCategories =
    Array.isArray(selectedClassifier?.classes_short) &&
    selectedClassifier.classes_short.length > 0;
  const predictionCategories =
    hasClassificationCategories
      ? classification.classes_short
      : hasClassifierCategories
        ? selectedClassifier.classes_short
        : [];
  const predictionChartData = getPredictionChartData(
    classification,
    predictionCategories
  );
  const hasVisibleWindow = hasRecording && specData.length > 0;
  const showSpectrogramLoader = specLoading && specData.length === 0;
  const classificationDisabled =
    selectedClassifiers.length === 0 ||
    (processingMode === "window" && !hasVisibleWindow);

  return (
    <Box className="paneInner">
      <Tabs value={specTabValue} onChange={onSpecTabChange}>
        <Tab label="Spectrogram" />
      </Tabs>
      <Box className="spectrogramSection">
        <Fade
          in={showSpectrogramLoader}
          style={{ position: "absolute", zIndex: 100 }}
        >
          <div className="loadingOverlay">
            <BackdropFilter
              filter={"blur(10px)"}
              canvasFallback={true}
              className="bluredForm"
            >
              <CircularProgress className="loadingSpinner" />
            </BackdropFilter>
          </div>
        </Fade>

        <Box className="chartSurface">
          {hasRecording ? (
            specData.length > 0 ? (
              <Spectrogram
                id="spectrogram"
                data={specData}
                waveData={waveData}
                maxF={
                  recordingData.samplerate
                    ? (257 / recordingData.samplerate) * 2000
                    : (257 / 220500) * 2000
                }
                maxS={
                  recordingData.samplerate
                    ? recordingData.samplerate / 128 + 1
                    : 220500 / 128 + 1
                }
                offset={specStart}
                visibleStart={specViewStart}
                visibleEnd={specViewEnd}
                playbackCursor={playbackCursor}
                duration={recordingData.duration}
                samplerate={recordingData.samplerate}
                sampleCount={recordingData.sampleCount}
                onVisibleWindowChange={onVisibleWindowChange}
              />
            ) : (
              <Box className="emptyPanel">
                <Typography variant="body2" color="text.secondary">
                  No spectrogram data available for this recording.
                </Typography>
              </Box>
            )
          ) : (
            <Box className="emptyPanel featurePlaceholder">
              <Typography variant="body2" color="text.secondary">
                Select a recording to inspect its spectrogram and playback.
              </Typography>
            </Box>
          )}
        </Box>

        <Box className="spectrogramControls">
          <Select
            size="small"
            value={expansionRate}
            onChange={onExpansionRateChange}
            className="expansionSelect"
            disabled={!hasRecording}
          >
            <MenuItem value={1.0}>1.0</MenuItem>
            <MenuItem value={5.0}>5.0</MenuItem>
            <MenuItem value={10.0}>10.0</MenuItem>
            <MenuItem value={20.0}>20.0</MenuItem>
          </Select>
          <IconButton
            color="primary"
            onClick={onPlayPause}
            className="playButton"
            disabled={!hasRecording}
          >
            {playPause ? <PauseIcon /> : <PlayArrowIcon />}
          </IconButton>
        </Box>
      </Box>
      <Divider flexItem />
      <Tabs value={tabValue} onChange={onTabChange}>
        <Tab label="Recording" />
        <Tab label="Project" />
      </Tabs>
      <Box className="detailsSection">
        <Box
          className="detailsBody"
          sx={{ display: tabValue === 0 ? "block" : "none" }}
        >
          {hasRecording ? (
            <Box className="recordingDetails">
              <Box>
                <Typography variant="h6" gutterBottom>
                  Metadata
                </Typography>
                <Typography variant="subtitle2" color="text.secondary" noWrap>
                  Title: {recordingData.title}
                </Typography>
                <Typography variant="subtitle2" color="text.secondary" noWrap>
                  Date:{" "}
                  {recordingData.date
                    ? new Date(recordingData.date).toLocaleString("en-GB")
                    : "-"}
                </Typography>
                <Typography variant="subtitle2" color="text.secondary" noWrap>
                  Temperature: {recordingData.temperature || "-"} °C
                </Typography>
                <Typography variant="subtitle2" color="text.secondary" noWrap>
                  Duration:{" "}
                  {recordingData.duration ? recordingData.duration.toFixed(2) : "-"} s
                </Typography>
                <Typography variant="subtitle2" color="text.secondary" noWrap>
                  Sample rate: {recordingData.samplerate || "-"} Hz
                </Typography>
                <Box className="metadataSpeciesRow">
                  <SpeciesLabelList
                    speciesText={recordingData.species}
                    prefix="Species:"
                    onOpenSpecies={onEditSpecies}
                  />
                </Box>
                <LoadingButton
                  onClick={onClassify}
                  variant="contained"
                  loading={classifyLoading}
                  disabled={classificationDisabled}
                  style={{ marginTop: 16 }}
                >
                  Classify
                </LoadingButton>
              </Box>

              <Box>
                <Typography variant="h6">Location</Typography>
                <Box className="mapCard">
                  {hasLocation ? (
                    <MapContainer
                      key={`${recordingLocation.lat}-${recordingLocation.lng}`}
                      center={recordingLocation}
                    />
                  ) : (
                    <Box className="emptyPanel mapPlaceholder">
                      <Typography variant="body2" color="text.secondary">
                        No location metadata available.
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>

              <Box>
                <Typography variant="h6">
                  Classification
                </Typography>
                <Box className="classificationPanel">
                  {predictionClassifiers.length > 0 ? (
                    <Box className="predictionTagList">
                      {predictionClassifiers.map((item) => (
                        <Chip
                          key={item.key}
                          label={item.name}
                          size="small"
                          clickable={item.hasPrediction}
                          disabled={!item.hasPrediction}
                          color={
                            item.key === predictionClassifierKey
                              ? "primary"
                              : "default"
                          }
                          variant={
                            item.key === predictionClassifierKey
                              ? "filled"
                              : "outlined"
                          }
                          className="predictionTagChip"
                          onClick={() => onPredictionClassifierChange(item.key)}
                        />
                      ))}
                    </Box>
                  ) : null}
                  <Box className="classificationPanelBody">
                    {classification ? (
                      <BarChart
                        id="predictionChart"
                        values={predictionChartData.values}
                        categories={predictionChartData.categories}
                      />
                    ) : (
                      <Box className="emptyPanel">
                        <Typography variant="body2" color="text.secondary">
                          {selectedClassifiers.length === 0
                            ? "Select one or more models to see prediction scores."
                            : "Run classification to see prediction scores for the selected model."}
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Box>
            </Box>
          ) : (
            <Box className="emptyPanel featurePlaceholder">
              <Typography variant="body2" color="text.secondary">
                Select a recording to view metadata, location, and prediction.
              </Typography>
            </Box>
          )}
        </Box>

        <Box
          className="detailsBody"
          sx={{ display: tabValue === 1 ? "block" : "none" }}
        >
          <Box className="projectControls">
            <Autocomplete
              multiple
              disableCloseOnSelect
              options={classifiers}
              value={selectedClassifiers}
              onChange={onClassifierChange}
              getOptionLabel={(option) => option?.name || option?.key || ""}
              isOptionEqualToValue={(option, value) => option.key === value.key}
              renderOption={(props, option, { selected }) => (
                <li {...props}>
                  <Checkbox
                    size="small"
                    checked={selected}
                    sx={{ mr: 1 }}
                  />
                  {renderClassifierLabel(option)}
                </li>
              )}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    {...getTagProps({ index })}
                    key={option.key}
                    size="small"
                    label={
                      option.provider_label
                        ? `${option.name} · ${option.provider_label}`
                        : option.name
                    }
                    className="classifierSelectionChip"
                  />
                ))
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Models"
                  placeholder={
                    selectedClassifiers.length === 0 ? "Search models" : ""
                  }
                />
              )}
              className="classifierAutocomplete"
            />
            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="prediction-range-label">
                Prediction range
              </InputLabel>
              <Select
                labelId="prediction-range-label"
                value={processingMode}
                label="Prediction range"
                onChange={onProcessingModeChange}
              >
                <MenuItem value="full">Full</MenuItem>
                <MenuItem value="window">Window</MenuItem>
              </Select>
            </FormControl>
            <Button
              onClick={onClassifyAll}
              variant="contained"
              disabled={classifyAllLoading || classificationDisabled}
            >
              {classifyAllLoading ? (
                <CircularProgress
                  color="inherit"
                  variant={
                    classifyAllLoading && classifyAllProgress === 0
                      ? "indeterminate"
                      : "determinate"
                  }
                  size={16}
                  value={classifyAllProgress}
                />
              ) : (
                "Classify all"
              )}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default MainContent;
