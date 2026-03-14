import React from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import SpeciesEditorDialog from "./SpeciesEditorDialog";

const AppDialogs = ({
  createProjectModal,
  onCloseCreateProject,
  projectTitle,
  projectDescription,
  onProjectTitleChange,
  onProjectDescriptionChange,
  onSaveProject,
  editProject,
  fileNotFoundDialog,
  recordingPath,
  onRetryRecording,
  onCloseFileNotFound,
  alertDialog,
  onCloseAlert,
  confirmDeleteDialog,
  onCloseConfirmDelete,
  onConfirmDelete,
  speciesDialog,
  speciesDialogOptions,
  onSaveSpecies,
  onCloseSpecies,
}) => {
  return (
  <>
    <Dialog open={createProjectModal} onClose={onCloseCreateProject}>
      <DialogTitle>Create Project</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Create a new project and add your recordings to analyze and classify
          them.
        </DialogContentText>
        <TextField
          autoFocus
          label="Title"
          fullWidth
          variant="outlined"
          margin="normal"
          value={projectTitle}
          onChange={onProjectTitleChange}
          required
        />
        <TextField
          autoFocus
          label="Description"
          fullWidth
          variant="outlined"
          margin="normal"
          value={projectDescription}
          onChange={onProjectDescriptionChange}
          multiline
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCloseCreateProject}>Cancel</Button>
        <Button onClick={onSaveProject} variant="contained">
          {editProject ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog open={fileNotFoundDialog} onClose={onCloseFileNotFound}>
      <DialogTitle>File was not found</DialogTitle>
      <DialogContent>
        <DialogContentText>
          The file {recordingPath} was not found. If it is on another storage,
          please connect it to your device.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onRetryRecording} autoFocus color="primary">
          Retry
        </Button>
        <Button onClick={onCloseFileNotFound} color="inherit">
          Ok
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog open={alertDialog !== null} onClose={onCloseAlert}>
      <DialogTitle>{alertDialog ? alertDialog.title : ""}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {alertDialog ? alertDialog.text : ""}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCloseAlert} color="inherit">
          Ok
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog
      open={confirmDeleteDialog !== null}
      onClose={onCloseConfirmDelete}
    >
      <DialogTitle>
        {confirmDeleteDialog ? confirmDeleteDialog.title : ""}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {confirmDeleteDialog ? confirmDeleteDialog.text : ""}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCloseConfirmDelete} color="inherit">
          Cancel
        </Button>
        <Button onClick={onConfirmDelete} color="error" variant="contained">
          Delete
        </Button>
      </DialogActions>
    </Dialog>

    <SpeciesEditorDialog
      key={
        speciesDialog
          ? `${speciesDialog.recordingIndex}:${speciesDialog.focusSpecies || ""}:${speciesDialog.species.join("|")}`
          : "species-dialog-closed"
      }
      open={speciesDialog !== null}
      initialSpecies={speciesDialog ? speciesDialog.species : []}
      initialFocusSpecies={speciesDialog ? speciesDialog.focusSpecies : null}
      options={speciesDialogOptions}
      onSave={onSaveSpecies}
      onCancel={onCloseSpecies}
    />
  </>
  );
};

export default AppDialogs;
