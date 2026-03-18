import React from "react";

const formatValue = (value) => {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const absoluteValue = Math.abs(value);
  if (absoluteValue === 0) {
    return "0";
  }
  if (absoluteValue >= 0.995) {
    return value.toFixed(4);
  }
  if (absoluteValue >= 0.1) {
    return value.toFixed(3);
  }
  if (absoluteValue >= 0.01) {
    return value.toFixed(4);
  }
  if (absoluteValue >= 0.001) {
    return value.toFixed(5);
  }
  return value.toExponential(2);
};

const BarChart = ({ values = [], categories = [] }) => {
  const entries = categories
    .map((category, index) => ({
      category,
      value: Number(values[index]) || 0,
      index,
    }))
    .filter((entry) => entry.category)
    .sort((left, right) => right.value - left.value);

  const maxValue = Math.max(
    1,
    ...entries.map((entry) => (entry.value > 0 ? entry.value : 0))
  );

  return (
    <div className="predictionBars">
      {entries.map((entry, index) => {
        const width = `${(Math.max(entry.value, 0) / maxValue) * 100}%`;
        return (
          <div
            key={`${entry.category}-${entry.index}-${entry.value.toPrecision(6)}`}
            className="predictionBarRow"
            title={`${entry.category}: ${formatValue(entry.value)}`}
          >
            <div className="predictionBarLabel">{entry.category}</div>
            <div className="predictionBarTrack">
              <div
                className="predictionBarFill"
                style={{
                  width,
                  animationDelay: `${Math.min(index, 8) * 28}ms`,
                }}
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
