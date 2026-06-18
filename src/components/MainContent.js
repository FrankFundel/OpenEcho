import React, { useState } from "react";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import Fade from "@mui/material/Fade";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import LoadingButton from "@mui/lab/LoadingButton";
import BackdropFilter from "react-backdrop-filter";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TuneIcon from "@mui/icons-material/Tune";
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

const getPredictionChartData = (
  classification,
  fallbackCategories,
  confidenceThreshold = 0,
  resultLimit = PREDICTION_GRAPH_LIMIT
) => {
  if (!classification || !Array.isArray(classification.prediction)) {
    return { values: [], categories: [] };
  }

  const entries = classification.prediction
    .map((value, index) => ({
      category: fallbackCategories[index] || `Class ${index + 1}`,
      value: Number(value),
      index,
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.value) && entry.value >= confidenceThreshold
    )
    .sort((left, right) => right.value - left.value)
    .slice(0, resultLimit);

  return {
    values: entries.map((entry) => entry.value),
    categories: entries.map((entry) => entry.category),
  };
};

const MainContent = ({
  specTabValue,
  onSpecTabChange,
  showBoundingBoxes,
  onShowBoundingBoxesChange,
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
  onLoadClassifierClasses,
  onProcessingModeChange,
  classifyAllLoading,
  classifyAllProgress,
  onClassifyAll,
}) => {
  const [classesMenu, setClassesMenu] = useState(null);
  const [classesLoadingKey, setClassesLoadingKey] = useState("");
  const [classesError, setClassesError] = useState("");
  const [classesFilter, setClassesFilter] = useState("");
  const [advancedModelKey, setAdvancedModelKey] = useState("");
  const [modelDisplaySettings, setModelDisplaySettings] = useState({});
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
  const activeDisplaySettings =
    modelDisplaySettings[selectedClassifier?.key] || {};
  const confidenceThreshold = activeDisplaySettings.confidenceThreshold ?? 0;
  const resultLimit =
    activeDisplaySettings.resultLimit ?? PREDICTION_GRAPH_LIMIT;
  const predictionChartData = getPredictionChartData(
    classification,
    predictionCategories,
    confidenceThreshold,
    resultLimit
  );
  const boundingBoxes = Array.isArray(classification?.boxes)
    ? classification.boxes
    : [];
  const hasBoundingBoxes = boundingBoxes.length > 0;
  const hasVisibleWindow = hasRecording && specData.length > 0;
  const showSpectrogramLoader = specLoading && specData.length === 0;
  const classificationDisabled =
    selectedClassifiers.length === 0 ||
    (processingMode === "window" && !hasVisibleWindow);
  const classesMenuModel =
    findClassifierByKey(classifiers, classesMenu?.modelKey) || null;
  const availableClasses = Array.isArray(classesMenu?.classes)
    ? classesMenu.classes
    : Array.isArray(classesMenuModel?.classes)
      ? classesMenuModel.classes
    : [];
  const availableClassesShort = Array.isArray(classesMenu?.classes_short)
    ? classesMenu.classes_short
    : classesMenuModel?.classes_short || [];
  const normalizedClassesFilter = classesFilter.trim().toLowerCase();
  const filteredClasses = availableClasses
    .map((className, index) => ({
      className,
      shortName: availableClassesShort[index] || "",
      index,
    }))
    .filter(({ className, shortName }) =>
      normalizedClassesFilter
        ? `${className} ${shortName}`
            .toLowerCase()
            .includes(normalizedClassesFilter)
        : true
    );

  const updateModelDisplaySetting = (modelKey, setting, value) => {
    setModelDisplaySettings((current) => ({
      ...current,
      [modelKey]: {
        ...(current[modelKey] || {}),
        [setting]: value,
      },
    }));
  };

  const openClassesMenu = async (event, model) => {
    const anchorEl = event.currentTarget;
    setClassesError("");
    setClassesFilter("");
    setClassesMenu({
      anchorEl,
      modelKey: model.key,
      classes: model.classes || [],
      classes_short: model.classes_short || [],
    });
    if (Array.isArray(model.classes) && model.classes.length > 0) {
      return;
    }

    setClassesLoadingKey(model.key);
    try {
      const classMetadata = await onLoadClassifierClasses(model.key);
      setClassesMenu((current) =>
        current?.modelKey === model.key
          ? { ...current, ...classMetadata }
          : current
      );
    } catch (error) {
      setClassesError(
        error?.message || "The model classes could not be loaded."
      );
    } finally {
      setClassesLoadingKey("");
    }
  };

  return (
    <Box className="paneInner">
      <Box className="spectrogramHeader">
        <Tabs value={specTabValue} onChange={onSpecTabChange}>
          <Tab label="Spectrogram" />
        </Tabs>
        <FormControlLabel
          className="boundingBoxToggle"
          control={
            <Switch
              size="small"
              checked={Boolean(showBoundingBoxes && hasBoundingBoxes)}
              onChange={onShowBoundingBoxesChange}
              disabled={!hasBoundingBoxes}
            />
          }
          label="Boxes"
        />
      </Box>
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
                boxes={boundingBoxes}
                showBoxes={Boolean(showBoundingBoxes && hasBoundingBoxes)}
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
          <Box className="modelInfoList">
            {selectedClassifiers.length > 0 ? (
              selectedClassifiers.map((model) => {
                const settings = modelDisplaySettings[model.key] || {};
                const modelClasses = Array.isArray(model.classes)
                  ? model.classes
                  : [];
                const modelTags =
                  Array.isArray(model.tags) && model.tags.length > 0
                    ? model.tags
                    : [
                        model.provider === "bacpipe" ||
                        model.provider_label?.toLowerCase() === "bacpipe"
                          ? "bacpipe"
                          : null,
                        model.task_type || "classifier",
                      ];
                const visibleModelTags = modelTags.filter(
                  (tag) =>
                    typeof tag === "string" &&
                    tag.trim() &&
                    (tag.trim().toLowerCase() !==
                      String(model.provider_label || model.provider || "")
                        .trim()
                        .toLowerCase() ||
                      tag.trim().toLowerCase() === "bacpipe")
                );
                const advancedOpen = advancedModelKey === model.key;

                return (
                  <Box className="modelInfoCard" key={model.key}>
                    <Box className="modelInfoHeader">
                      <Box>
                        <Typography variant="h6" className="modelInfoName">
                          {model.name}
                        </Typography>
                        {visibleModelTags.length > 0 ? (
                          <Box className="modelTagList">
                            {visibleModelTags.map((tag) => (
                              <Chip
                                key={`${model.key}-${tag}`}
                                label={tag}
                                size="small"
                                variant="outlined"
                                className="modelInfoTag"
                              />
                            ))}
                          </Box>
                        ) : null}
                      </Box>
                      <Button
                        size="small"
                        variant="outlined"
                        endIcon={<ExpandMoreIcon />}
                        onClick={(event) => openClassesMenu(event, model)}
                      >
                        {modelClasses.length > 0
                          ? `${modelClasses.length} classes`
                          : "View classes"}
                      </Button>
                    </Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      className="modelInfoDescription"
                    >
                      {model.description ||
                        `${model.name} is an acoustic classification model provided by ${
                          model.provider_label || model.provider || "the configured provider"
                        }.`}
                    </Typography>
                    <Box className="advancedSettingsSection">
                      <Button
                        size="small"
                        color="inherit"
                        startIcon={<TuneIcon />}
                        className="advancedSettingsButton"
                        onClick={() =>
                          setAdvancedModelKey(advancedOpen ? "" : model.key)
                        }
                      >
                        Advanced settings
                      </Button>
                      <Collapse in={advancedOpen}>
                        <Box className="advancedSettingsPanel">
                        <Box className="advancedSetting">
                          <Box>
                            <Typography variant="body2">
                              Result threshold
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Hide prediction scores below this confidence.
                            </Typography>
                          </Box>
                          <Box className="advancedSettingControl">
                            <Slider
                              size="small"
                              min={0}
                              max={0.95}
                              step={0.05}
                              value={settings.confidenceThreshold ?? 0}
                              valueLabelDisplay="auto"
                              valueLabelFormat={(value) =>
                                `${Math.round(value * 100)}%`
                              }
                              onChange={(event, value) =>
                                updateModelDisplaySetting(
                                  model.key,
                                  "confidenceThreshold",
                                  value
                                )
                              }
                            />
                            <Typography variant="caption">
                              {Math.round(
                                (settings.confidenceThreshold ?? 0) * 100
                              )}
                              %
                            </Typography>
                          </Box>
                        </Box>
                        <Box className="advancedSetting">
                          <Box>
                            <Typography variant="body2">
                              Classes shown
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Limit the number of scores in the result chart.
                            </Typography>
                          </Box>
                          <Select
                            size="small"
                            value={
                              settings.resultLimit ?? PREDICTION_GRAPH_LIMIT
                            }
                            onChange={(event) =>
                              updateModelDisplaySetting(
                                model.key,
                                "resultLimit",
                                event.target.value
                              )
                            }
                            className="resultLimitSelect"
                          >
                            <MenuItem value={10}>10</MenuItem>
                            <MenuItem value={20}>20</MenuItem>
                            <MenuItem value={50}>50</MenuItem>
                          </Select>
                        </Box>
                        </Box>
                      </Collapse>
                    </Box>
                  </Box>
                );
              })
            ) : (
              <Box className="emptyPanel modelInfoEmpty">
                <Typography variant="body2" color="text.secondary">
                  Choose a model to see its details and available classes.
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      <Menu
        anchorEl={classesMenu?.anchorEl || null}
        open={Boolean(classesMenu)}
        onClose={() => {
          setClassesMenu(null);
          setClassesFilter("");
        }}
        PaperProps={{ className: "modelClassesMenu" }}
      >
        <Box className="modelClassesMenuHeader">
          <Typography variant="subtitle2">
            {classesMenuModel?.name} classes
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {classesLoadingKey === classesMenuModel?.key
              ? "Loading…"
              : `${availableClasses.length} available`}
          </Typography>
        </Box>
        <Box className="modelClassesSearch">
          <TextField
            size="small"
            fullWidth
            autoFocus
            placeholder="Search classes"
            value={classesFilter}
            onChange={(event) => setClassesFilter(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </Box>
        <Divider />
        {classesLoadingKey === classesMenuModel?.key ? (
          <Box className="modelClassesStatus">
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              Loading model classes…
            </Typography>
          </Box>
        ) : classesError ? (
          <Box className="modelClassesStatus">
            <Typography variant="body2" color="error">
              {classesError}
            </Typography>
          </Box>
        ) : (
          <List dense disablePadding>
            {filteredClasses.map(({ className, shortName, index }) => (
              <ListItem key={`${className}-${index}`}>
                <ListItemText
                  primary={className}
                  secondary={
                    shortName && shortName !== className
                      ? shortName
                      : null
                  }
                />
              </ListItem>
            ))}
            {filteredClasses.length === 0 ? (
              <ListItem>
                <ListItemText
                  primary="No matching classes"
                  primaryTypographyProps={{
                    color: "text.secondary",
                    textAlign: "center",
                  }}
                />
              </ListItem>
            ) : null}
          </List>
        )}
      </Menu>
    </Box>
  );
};

export default MainContent;
