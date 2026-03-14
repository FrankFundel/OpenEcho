import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export const splitSpeciesText = (value) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const SpeciesLabelList = ({
  speciesText,
  prefix = null,
  compact = false,
  emptyLabel = "-",
  className = "",
  onOpenSpecies,
}) => {
  const labels = splitSpeciesText(speciesText);

  return (
    <Box className={`speciesLabelList ${className}`.trim()}>
      {prefix ? (
        <Typography
          variant={compact ? "caption" : "subtitle2"}
          color="text.secondary"
          component="span"
        >
          {prefix}
        </Typography>
      ) : null}
      {labels.length > 0 ? (
        labels.map((label, index) => (
          <React.Fragment key={`${label}-${index}`}>
            <Box
              component="button"
              type="button"
              className={`speciesLabelButton${
                compact ? " speciesLabelButtonCompact" : ""
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenSpecies(label);
              }}
            >
              {label}
            </Box>
            {index < labels.length - 1 ? (
              <span className="speciesLabelSeparator">,</span>
            ) : null}
          </React.Fragment>
        ))
      ) : (
        <Box
          component="button"
          type="button"
          className={`speciesLabelButton speciesLabelButtonEmpty${
            compact ? " speciesLabelButtonCompact" : ""
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenSpecies(null);
          }}
        >
          {emptyLabel}
        </Box>
      )}
    </Box>
  );
};

export default SpeciesLabelList;
