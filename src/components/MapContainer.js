import React from "react";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";

const clampLatitude = (value) => Math.max(-85, Math.min(85, value));
const clampLongitude = (value) => Math.max(-180, Math.min(180, value));

const buildBounds = (lat, lng) => {
  const latitude = clampLatitude(lat);
  const longitude = clampLongitude(lng);
  const delta = 0.02;
  const left = clampLongitude(longitude - delta);
  const right = clampLongitude(longitude + delta);
  const bottom = clampLatitude(latitude - delta);
  const top = clampLatitude(latitude + delta);
  return { left, right, bottom, top };
};

const MapContainer = ({ center, style }) => {
  const latitude = Number(center?.lat) || 0;
  const longitude = Number(center?.lng) || 0;
  const bounds = buildBounds(latitude, longitude);
  const embedUrl =
    "https://www.openstreetmap.org/export/embed.html" +
    `?bbox=${bounds.left}%2C${bounds.bottom}%2C${bounds.right}%2C${bounds.top}` +
    `&layer=mapnik&marker=${latitude}%2C${longitude}`;
  const openStreetMapUrl =
    `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}` +
    `#map=14/${latitude}/${longitude}`;

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%", ...style }}>
      <iframe
        title="Recording location"
        src={embedUrl}
        style={{
          border: 0,
          width: "100%",
          height: "100%",
          borderRadius: 16,
        }}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
      <Link
        href={openStreetMapUrl}
        target="_blank"
        rel="noreferrer"
        underline="hover"
        sx={{
          position: "absolute",
          right: 12,
          bottom: 12,
          px: 1,
          py: 0.5,
          borderRadius: 999,
          fontSize: 12,
          color: "common.white",
          bgcolor: "rgba(12, 16, 20, 0.72)",
          backdropFilter: "blur(8px)",
        }}
      >
        OpenStreetMap
      </Link>
    </Box>
  );
};

export default MapContainer;
