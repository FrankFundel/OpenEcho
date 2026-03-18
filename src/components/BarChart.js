import React from "react";

const formatValue = (value) => {
  if (!Number.isFinite(value)) {
    return "0.00";
  }
  return value.toFixed(2);
};

const BarChart = ({ values = [], categories = [] }) => {
  const entries = categories
    .map((category, index) => ({
      category,
      value: Number(values[index]) || 0,
    }))
    .filter((entry) => entry.category)
    .sort((left, right) => right.value - left.value);

  const maxValue = Math.max(
    1,
    ...entries.map((entry) => (entry.value > 0 ? entry.value : 0))
  );

  return (
    <div className="predictionBars">
      {entries.map((entry) => {
        const width = `${(Math.max(entry.value, 0) / maxValue) * 100}%`;
        return (
          <div
            key={entry.category}
            className="predictionBarRow"
            title={`${entry.category}: ${formatValue(entry.value)}`}
          >
            <div className="predictionBarLabel">{entry.category}</div>
            <div className="predictionBarTrack">
              <div
                className="predictionBarFill"
                style={{ width }}
              />
            </div>
            <div className="predictionBarValue">{formatValue(entry.value)}</div>
          </div>
        );
      })}
    </div>
  );
};

export default BarChart;
