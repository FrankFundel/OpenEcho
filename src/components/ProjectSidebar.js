import React from "react";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemAvatar from "@mui/material/ListItemAvatar";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Avatar from "@mui/material/Avatar";
import Badge from "@mui/material/Badge";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import FolderIcon from "@mui/icons-material/Folder";
import ImportOutlineIcon from "@mui/icons-material/FileUploadOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";

const ProjectSidebar = ({
  projects,
  selectedProject,
  projectFilter,
  projectActionsMenu,
  onProjectFilterChange,
  onSelectProject,
  onOpenCreateProject,
  onImportWhombat,
  onOpenProjectActionsMenu,
  onCloseProjectActionsMenu,
  onProjectContextMenu,
}) => (
  <Box className="paneInner">
    <Box className="sidebarSearch projectSearchBar">
      <TextField
        size="small"
        fullWidth
        placeholder="Search projects"
        value={projectFilter}
        onChange={onProjectFilterChange}
      />
      <IconButton
        aria-label="Project actions"
        onClick={onOpenProjectActionsMenu}
      >
        <MoreVertIcon />
      </IconButton>
      <Menu
        anchorEl={projectActionsMenu}
        open={Boolean(projectActionsMenu)}
        onClose={onCloseProjectActionsMenu}
      >
        <MenuItem onClick={onImportWhombat}>
          <ListItemIcon>
            <ImportOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Import Whombat JSON</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
    <List className="sidebarScroll">
      {projects.map(({ project, index }) => (
        <React.Fragment key={index.toString()}>
          <ListItemButton
            alignItems="flex-start"
            selected={index === selectedProject}
            onClick={() => onSelectProject(index)}
            onContextMenu={(event) => onProjectContextMenu(event, index)}
          >
            <ListItemAvatar>
              <Badge badgeContent={project.recordings.length} color="primary">
                <Avatar>
                  <FolderIcon />
                </Avatar>
              </Badge>
            </ListItemAvatar>
            <ListItemText
              primary={project.title}
              secondary={project.description}
              primaryTypographyProps={{ noWrap: true }}
              secondaryTypographyProps={{ noWrap: true }}
            />
          </ListItemButton>
          <Divider variant="inset" component="li" />
        </React.Fragment>
      ))}
    </List>
    <Box className="sidebarActions" textAlign="center">
      <Button onClick={onOpenCreateProject} variant="contained" fullWidth>
        Create Project
      </Button>
    </Box>
  </Box>
);

export default ProjectSidebar;
