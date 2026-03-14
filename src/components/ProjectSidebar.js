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
import TextField from "@mui/material/TextField";
import FolderIcon from "@mui/icons-material/Folder";

const ProjectSidebar = ({
  projects,
  selectedProject,
  projectFilter,
  onProjectFilterChange,
  onSelectProject,
  onOpenCreateProject,
  onProjectContextMenu,
}) => (
  <Box className="paneInner">
    <Box className="sidebarSearch">
      <TextField
        size="small"
        fullWidth
        placeholder="Search projects"
        value={projectFilter}
        onChange={onProjectFilterChange}
      />
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
      <Button onClick={onOpenCreateProject} variant="contained">
        Create Project
      </Button>
    </Box>
  </Box>
);

export default ProjectSidebar;
