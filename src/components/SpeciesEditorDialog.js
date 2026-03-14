import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ResponsiveVirtualList from "./ResponsiveVirtualList";

const wikipediaSummaryCache = new Map();
const wikidataScientificNameCache = new Map();

const uniqueTitles = (titles) =>
  Array.from(
    new Set(
      titles
        .map((title) => title && title.trim())
        .filter(Boolean)
    )
  );

const normalizeWikipediaSummary = (payload, fallbackTitle) => ({
  title: payload.title || fallbackTitle,
  description: payload.description || "",
  extract: payload.extract || "",
  url: payload.content_urls?.desktop?.page || null,
  thumbnail: payload.thumbnail?.source || null,
  wikibaseItem: payload.wikibase_item || null,
  scientificName: null,
});

const extractScientificNameFromClaims = (payload, entityId) => {
  const claims = payload?.entities?.[entityId]?.claims;
  const value = claims?.P225?.[0]?.mainsnak?.datavalue?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const loadScientificName = async (wikibaseItem) => {
  if (!wikibaseItem) {
    return null;
  }

  if (!wikidataScientificNameCache.has(wikibaseItem)) {
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.searchParams.set("action", "wbgetentities");
    url.searchParams.set("ids", wikibaseItem);
    url.searchParams.set("props", "claims");
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");

    wikidataScientificNameCache.set(
      wikibaseItem,
      fetch(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Wikidata request failed with ${response.status}.`);
          }

          const payload = await response.json();
          return extractScientificNameFromClaims(payload, wikibaseItem);
        })
        .catch((error) => {
          wikidataScientificNameCache.delete(wikibaseItem);
          throw error;
        })
    );
  }

  return wikidataScientificNameCache.get(wikibaseItem);
};

const loadWikipediaSummary = async (title) => {
  const normalizedTitle = title.replace(/\s+/g, "_");

  if (!wikipediaSummaryCache.has(normalizedTitle)) {
    wikipediaSummaryCache.set(
      normalizedTitle,
      fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          normalizedTitle
        )}`,
        {
          headers: {
            Accept: "application/json",
          },
        }
      )
        .then(async (response) => {
          if (response.status === 404) {
            return null;
          }

          if (!response.ok) {
            throw new Error(`Wikipedia request failed with ${response.status}.`);
          }

          const payload = await response.json();
          if (!payload || payload.type === "https://mediawiki.org/wiki/HyperSwitch/errors/not_found") {
            return null;
          }

          return normalizeWikipediaSummary(payload, title);
        })
        .catch((error) => {
          wikipediaSummaryCache.delete(normalizedTitle);
          throw error;
        })
    );
  }

  return wikipediaSummaryCache.get(normalizedTitle);
};

const fetchWikipediaSummary = async (option) => {
  const titles = uniqueTitles([option.fullLabel, option.shortLabel]);
  let lastError = null;

  for (const title of titles) {
    try {
      const summary = await loadWikipediaSummary(title);
      if (summary) {
        const scientificName = await loadScientificName(summary.wikibaseItem);
        return {
          ...summary,
          scientificName,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error("No Wikipedia article was found for this species.");
};

const buildSpeciesAliases = (options) => {
  const exact = new Map();
  const insensitive = new Map();

  options.forEach((option) => {
    uniqueTitles([option.value, option.shortLabel, option.fullLabel]).forEach(
      (title) => {
        exact.set(title, option.value);
        insensitive.set(title.toLowerCase(), option.value);
      }
    );
  });

  return { exact, insensitive };
};

const normalizeSpeciesValue = (value, aliases) => {
  const normalizedValue = value && value.trim();
  if (!normalizedValue) {
    return null;
  }

  return (
    aliases.exact.get(normalizedValue) ||
    aliases.insensitive.get(normalizedValue.toLowerCase()) ||
    normalizedValue
  );
};

const normalizeSpeciesValues = (values, aliases) => {
  const normalizedValues = [];
  const seen = new Set();

  values.forEach((value) => {
    const normalizedValue = normalizeSpeciesValue(value, aliases);
    if (!normalizedValue || seen.has(normalizedValue)) {
      return;
    }

    seen.add(normalizedValue);
    normalizedValues.push(normalizedValue);
  });

  return normalizedValues;
};

const SpeciesOptionRow = ({ index, style, data }) => {
  const option = data.options[index];
  const checked = data.selectedValues.has(option.value);
  const focused = data.focusedValue === option.value;

  return (
    <ListItemButton
      selected={checked}
      style={style}
      className="speciesOptionRow"
      onClick={() => data.onFocusOption(option.value)}
    >
      <Checkbox
        checked={checked}
        color="primary"
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          data.onFocusOption(option.value);
          data.onToggleOption(option.value);
        }}
      />
      <ListItemText
        primary={
          <Box className="speciesOptionPrimary">
            <span className="speciesOptionTitle">
              {option.fullLabel || option.shortLabel}
            </span>
            {focused && !checked ? (
              <span className="speciesOptionFocusHint">preview</span>
            ) : null}
          </Box>
        }
        secondary={
          option.shortLabel && option.shortLabel !== option.fullLabel ? (
            <span className="speciesOptionMeta">{option.shortLabel}</span>
          ) : null
        }
      />
    </ListItemButton>
  );
};

const SpeciesEditorDialog = ({
  open,
  initialSpecies,
  initialFocusSpecies,
  options,
  onCancel,
  onSave,
}) => {
  const [draftSpecies, setDraftSpecies] = React.useState(initialSpecies);
  const [searchText, setSearchText] = React.useState("");
  const [focusedSpecies, setFocusedSpecies] = React.useState(
    initialFocusSpecies
  );
  const [wikiState, setWikiState] = React.useState({
    status: "idle",
    summary: null,
    error: null,
  });

  const deferredSearchText = React.useDeferredValue(searchText);

  const normalizedOptions = React.useMemo(
    () =>
      options.map((option) => ({
        ...option,
        searchText: `${option.shortLabel} ${option.fullLabel}`.toLowerCase(),
      })),
    [options]
  );
  const speciesAliases = React.useMemo(
    () => buildSpeciesAliases(normalizedOptions),
    [normalizedOptions]
  );
  const normalizedInitialSpecies = React.useMemo(
    () => normalizeSpeciesValues(initialSpecies, speciesAliases),
    [initialSpecies, speciesAliases]
  );
  const normalizedInitialFocusSpecies = React.useMemo(
    () => normalizeSpeciesValue(initialFocusSpecies, speciesAliases),
    [initialFocusSpecies, speciesAliases]
  );
  const initialDraftSpecies = React.useMemo(() => {
    if (normalizedInitialSpecies.length > 0) {
      return normalizedInitialSpecies;
    }

    const fallbackValue =
      normalizedInitialFocusSpecies || normalizedOptions[0]?.value || null;
    return fallbackValue ? [fallbackValue] : [];
  }, [
    normalizedInitialFocusSpecies,
    normalizedInitialSpecies,
    normalizedOptions,
  ]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    setDraftSpecies(initialDraftSpecies);
    setSearchText("");
    setFocusedSpecies(
      normalizedInitialFocusSpecies ||
        initialDraftSpecies[0] ||
        normalizedOptions[0]?.value ||
        null
    );
  }, [
    initialDraftSpecies,
    normalizedInitialFocusSpecies,
    normalizedOptions,
    open,
  ]);

  const optionsByValue = React.useMemo(
    () => new Map(normalizedOptions.map((option) => [option.value, option])),
    [normalizedOptions]
  );

  const filteredOptions = React.useMemo(() => {
    const query = deferredSearchText.trim().toLowerCase();
    if (!query) {
      return normalizedOptions;
    }

    return normalizedOptions.filter((option) => option.searchText.includes(query));
  }, [deferredSearchText, normalizedOptions]);

  const selectedValues = React.useMemo(
    () => new Set(draftSpecies),
    [draftSpecies]
  );
  const selectedOptions = React.useMemo(
    () =>
      draftSpecies.map((value) =>
        optionsByValue.get(value) || {
          value,
          shortLabel: value,
          fullLabel: value,
        }
      ),
    [draftSpecies, optionsByValue]
  );

  const focusedOption = React.useMemo(() => {
    if (focusedSpecies && optionsByValue.has(focusedSpecies)) {
      return optionsByValue.get(focusedSpecies);
    }

    const selectedOption = draftSpecies.find((value) => optionsByValue.has(value));
    if (selectedOption) {
      return optionsByValue.get(selectedOption);
    }

    return normalizedOptions[0] || null;
  }, [draftSpecies, focusedSpecies, normalizedOptions, optionsByValue]);
  const wikiDisplayTitle =
    wikiState.status === "success" && wikiState.summary?.title
      ? wikiState.summary.title
      : focusedOption?.fullLabel || focusedOption?.shortLabel || "";
  const scientificDisplayName =
    wikiState.status === "success" && wikiState.summary?.scientificName
      ? wikiState.summary.scientificName
      : focusedOption?.fullLabel &&
          focusedOption.fullLabel !== wikiDisplayTitle &&
          focusedOption.fullLabel !== focusedOption.shortLabel
        ? focusedOption.fullLabel
        : null;
  const showShortLabel =
    focusedOption &&
    focusedOption.shortLabel &&
    focusedOption.shortLabel !== wikiDisplayTitle;
  const showScientificName = scientificDisplayName !== null;
  React.useEffect(() => {
    if (!open || !focusedOption || draftSpecies.length > 0) {
      return;
    }

    setDraftSpecies([focusedOption.value]);
  }, [draftSpecies.length, focusedOption, open]);
  const focusedIndex = React.useMemo(
    () =>
      focusedOption
        ? filteredOptions.findIndex((option) => option.value === focusedOption.value)
        : -1,
    [filteredOptions, focusedOption]
  );

  React.useEffect(() => {
    if (!open) {
      return;
    }

    if (!focusedOption) {
      setWikiState({
        status: "idle",
        summary: null,
        error: null,
      });
      return;
    }

    let cancelled = false;

    setFocusedSpecies(focusedOption.value);
    setWikiState({
      status: "loading",
      summary: null,
      error: null,
    });

    fetchWikipediaSummary(focusedOption)
      .then((summary) => {
        if (cancelled) {
          return;
        }

        setWikiState({
          status: "success",
          summary,
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setWikiState({
          status: "error",
          summary: null,
          error: error.message || "Wikipedia summary unavailable.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [focusedOption, open]);

  const optionData = React.useMemo(
    () => ({
      options: filteredOptions,
      selectedValues,
      focusedValue: focusedOption ? focusedOption.value : null,
      onFocusOption: (value) => {
        setFocusedSpecies(value);
      },
      onToggleOption: (value) => {
        setDraftSpecies((current) =>
          current.includes(value)
            ? current.filter((item) => item !== value)
            : [...current, value]
        );
      },
    }),
    [filteredOptions, focusedOption, selectedValues]
  );

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      fullWidth
      maxWidth="lg"
    >
      <DialogTitle>Edit Species</DialogTitle>
      <DialogContent className="speciesDialogContent">
        <Box className="speciesDialogLayout">
          <Box className="speciesDialogColumn">
            <Box className="speciesDialogToolbar">
              <Box className="speciesDialogSearchRow">
                <TextField
                  autoFocus
                  fullWidth
                  label="Search classes"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
                <Typography
                  variant="body2"
                  color="text.secondary"
                  className="speciesDialogCount"
                >
                  {filteredOptions.length} / {normalizedOptions.length} classes
                </Typography>
              </Box>
              {selectedOptions.length > 0 ? (
                <Box className="speciesSelectedChips">
                  {selectedOptions.map((option) => (
                    <Chip
                      key={option.value}
                      size="small"
                      label={option.shortLabel}
                      color="primary"
                      variant="filled"
                      onClick={() => setFocusedSpecies(option.value)}
                      onDelete={() => {
                        setDraftSpecies((current) =>
                          current.filter((value) => value !== option.value)
                        );
                      }}
                    />
                  ))}
                </Box>
              ) : null}
            </Box>

            {normalizedOptions.length > 0 && filteredOptions.length > 0 ? (
              <ResponsiveVirtualList
                className="speciesOptionsList"
                itemSize={56}
                itemCount={filteredOptions.length}
                overscanCount={8}
                itemData={optionData}
                itemKey={(index) => filteredOptions[index].value}
                scrollToIndex={focusedIndex}
                scrollToAlignment="center"
              >
                {SpeciesOptionRow}
              </ResponsiveVirtualList>
            ) : normalizedOptions.length > 0 ? (
              <Box className="emptyPanel speciesDialogEmptyState">
                <Typography variant="body2" color="text.secondary">
                  No classes match the current search.
                </Typography>
              </Box>
            ) : (
              <Box className="emptyPanel speciesDialogEmptyState">
                <Typography variant="body2" color="text.secondary">
                  No class list is available for this recording yet.
                </Typography>
              </Box>
            )}
          </Box>

          <Box className="speciesDialogColumn">
            <Box className="speciesWikiCard">
              {focusedOption ? (
                <>
                  <Box className="speciesWikiHeader">
                    <Box className="speciesWikiTitleBlock">
                      <Box className="speciesWikiTitleRow">
                        <Typography variant="h6">{wikiDisplayTitle}</Typography>
                        {showShortLabel ? (
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            className="speciesWikiShortName"
                          >
                            {focusedOption.shortLabel}
                          </Typography>
                        ) : null}
                      </Box>
                      {showScientificName ? (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          className="speciesWikiScientificName"
                        >
                          {scientificDisplayName}
                        </Typography>
                      ) : null}
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      {selectedValues.has(focusedOption.value)
                        ? "Selected"
                        : "Not selected"}
                    </Typography>
                  </Box>

                  {wikiState.status === "loading" ? (
                    <Box className="speciesWikiStatus">
                      <CircularProgress size={24} />
                    </Box>
                  ) : wikiState.status === "success" && wikiState.summary ? (
                    <>
                      {wikiState.summary.thumbnail ? (
                        <img
                          src={wikiState.summary.thumbnail}
                          alt={wikiState.summary.title}
                          className="speciesWikiThumbnail"
                        />
                      ) : null}
                      {wikiState.summary.description ? (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          className="speciesWikiCaption"
                        >
                          {wikiState.summary.description}
                        </Typography>
                      ) : null}
                      <Typography variant="body2">
                        {wikiState.summary.extract || "Wikipedia does not provide a summary for this page."}
                      </Typography>
                      {wikiState.summary.url ? (
                        <Link
                          href={wikiState.summary.url}
                          underline="hover"
                          onClick={(event) => {
                            event.preventDefault();
                            window.open(
                              wikiState.summary.url,
                              "_blank",
                              "noopener,noreferrer"
                            );
                          }}
                        >
                          View on Wikipedia
                        </Link>
                      ) : null}
                    </>
                  ) : (
                    <Box className="speciesWikiStatus">
                      <Typography variant="body2" color="text.secondary">
                        {wikiState.error ||
                          "Select a species to load information from Wikipedia."}
                      </Typography>
                    </Box>
                  )}
                </>
              ) : (
                <Box className="speciesWikiStatus">
                  <Typography variant="body2" color="text.secondary">
                    Select a species to inspect and edit it.
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} color="inherit">
          Cancel
        </Button>
        <Button onClick={() => onSave(draftSpecies)} variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SpeciesEditorDialog;
