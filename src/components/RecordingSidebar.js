import React from "react";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ResponsiveVirtualList from "./ResponsiveVirtualList";
import SpeciesLabelList from "./SpeciesLabelList";

const recordingDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const formatRecordingDate = (value) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return recordingDateFormatter.format(date);
};

const RecordingRow = ({ index, style, data }) => {
  const {
    recordings,
    selectedRecording,
    selectedRecordings,
    recordingLoading,
    onSelectRecording,
    onToggleRecording,
    onOpenContextMenu,
    onEditSpecies,
  } = data;
  const { recording, index: recordingIndex } = recordings[index];

  return (
    <ListItemButton
      alignItems="flex-start"
      selected={recordingIndex === selectedRecording}
      style={{ ...style, padding: 0 }}
      onContextMenu={(event) => onOpenContextMenu(event, recordingIndex)}
    >
      <Checkbox
        checked={selectedRecordings.includes(recordingIndex)}
        onChange={() => onToggleRecording(recordingIndex)}
      />
      <ListItemText
        primary={recording.title}
        onClick={() => onSelectRecording(recordingIndex)}
        className="recordingListItemText"
        secondaryTypographyProps={{ component: "div" }}
        secondary={
          <Box className="recordingMetaLine">
            <Typography
              className="recordingDateText"
              component="span"
              sx={{
                fontSize: "12px",
                lineHeight: 1.1,
                color: "rgba(255, 255, 255, 0.7)",
              }}
            >
              {formatRecordingDate(recording.date)}
            </Typography>
            {recordingIndex === recordingLoading ? (
              <CircularProgress
                size={8}
                style={{ marginLeft: 4 }}
                color="primary"
              />
            ) : (
              recording.species && (
                <SpeciesLabelList
                  speciesText={recording.species}
                  compact
                  className="recordingSpeciesPreview"
                  onOpenSpecies={(label) =>
                    onEditSpecies(recordingIndex, label)
                  }
                />
              )
            )}
          </Box>
        }
        primaryTypographyProps={{ fontSize: 12, noWrap: true, lineHeight: 1.2 }}
      />
    </ListItemButton>
  );
};

const RecordingSidebar = ({
  recordings,
  selectedRecording,
  selectedRecordings,
  recordingLoading,
  recordingFilter,
  onRecordingFilterChange,
  onToggleAll,
  onOpenMenu,
  onOpenContextMenu,
  onAddRecordings,
  onSelectRecording,
  onToggleRecording,
  onEditSpecies,
}) => {
  const itemData = {
    recordings,
    selectedRecording,
    selectedRecordings,
    recordingLoading,
    onSelectRecording,
    onToggleRecording,
    onOpenContextMenu,
    onEditSpecies,
  };

  return (
    <Box className="paneInner">
      <Box className="sidebarSearch">
        <TextField
          size="small"
          fullWidth
          placeholder="Search recordings"
          value={recordingFilter}
          onChange={onRecordingFilterChange}
        />
      </Box>
      <Box className="sidebarToolbar">
        <FormControlLabel
          style={{ marginRight: 0, marginLeft: 0 }}
          control={
            <Checkbox
              checked={
                selectedRecordings.length > 0 &&
                selectedRecordings.length === recordings.length
              }
              onChange={onToggleAll}
            />
          }
          label="Select all"
        />
        <IconButton onClick={onOpenMenu}>
          <MoreVertIcon />
        </IconButton>
      </Box>

      <ResponsiveVirtualList
        className="recordingsList"
        itemSize={48}
        itemCount={recordings.length}
        overscanCount={5}
        itemData={itemData}
        itemKey={(index) => recordings[index].index.toString()}
      >
        {RecordingRow}
      </ResponsiveVirtualList>

      <Box className="sidebarActions" textAlign="center">
        <Button onClick={onAddRecordings} variant="outlined">
          Add Recordings
        </Button>
      </Box>
    </Box>
  );
};

export default RecordingSidebar;
