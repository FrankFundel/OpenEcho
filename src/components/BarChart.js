import {
  lightningChart,
  SolidFill,
  SolidLine,
  ColorRGBA,
  emptyLine,
  AxisTickStrategies,
  AutoCursorModes,
  UIOrigins,
  UIElementBuilders,
  Themes,
  ColorCSS,
  customTheme,
} from "@arction/lcjs";
import React, { useRef, useEffect } from "react";

const LIGHTBLUE = "#66C0B7";

let barChart;
barChart = (lc, options) => {
    // flat blue fill style for negative bars
    const flatBlueStyle = new SolidFill().setColor(ColorCSS(LIGHTBLUE));

    let y = 0;
    const figureThickness = 10;
    const figureGap = figureThickness * 0.5;
    const bars = [];

    // Create a XY-Chart and add a RectSeries to it for rendering rectangles.
    const chart = lc
      .ChartXY(options)
      .setTitle("")
      .setAutoCursorMode(AutoCursorModes.onHover)
      // Disable mouse interactions (e.g. zooming and panning) of plotting area
      .setMouseInteractions(false)
      .setPadding({ right: 20 });

    // Bar series represented with rectangles.
    const rectangles = chart.addRectangleSeries();

    // cursor
    //#region
    // Show band using Rectangle series.
    const band = chart
      .addRectangleSeries()
      .setMouseInteractions(false)
      .setCursorEnabled(false)
      .add({ x: 0, y: 0, width: 0, height: 0 })
      .setFillStyle(new SolidFill().setColor(ColorRGBA(255, 255, 255, 50)))
      .setStrokeStyle(emptyLine)
      .dispose();
    // Modify AutoCursor.
    chart.setAutoCursor((cursor) =>
      cursor
        .setResultTableAutoTextStyle(true)
        .disposePointMarker()
        .disposeTickMarkerX()
        .disposeTickMarkerY()
        .setGridStrokeXStyle(emptyLine)
        .setGridStrokeYStyle(emptyLine)
        .setResultTable((table) => {
          table.setOrigin(UIOrigins.CenterBottom);
        })
    );
    // Change how marker displays its information.
    rectangles.setCursorResultTableFormatter((builder, series, figure) => {
      // Find cached entry for the figure.
      const hoveredBar = bars.find((bar) => bar.rect === figure);
      if (!hoveredBar) {
        return builder;
      }

      const entry = hoveredBar.entry;
      // Parse result table content from values of 'entry'.
      return builder
        .addRow("Species: " + entry.category)
        .addRow("Value: " + entry.value.toFixed(2));
    });
    // Apply cursor logic using series.onHover method
    rectangles.onHover((_, point) => {
      if (point) {
        const figure = point.figure;
        const dimensions = figure.getDimensionsPositionAndSize();
        // Show band.
        band
          .setDimensions({
            x: figure.scale.x.getInnerStart(),
            y: dimensions.y - figureGap * 0.5,
            width: figure.scale.x.getInnerInterval(),
            height: dimensions.height + figureGap,
          })
          .restore();
      } else band.dispose();
    });
    //#endregion

    // X-axis of the series
    const axisX = chart
      .getDefaultAxisX()
      .setMouseInteractions(false)
      .setInterval(0, 1);

    // Y-axis of the series
    const axisY = chart
      .getDefaultAxisY()
      .setMouseInteractions(false)
      .setScrollStrategy(undefined)
      // Disable default ticks.
      .setTickStrategy(AxisTickStrategies.Empty);

    //Add middle line
    const constantLine = axisX.addConstantLine();
    constantLine
      .setValue(0)
      .setMouseInteractions(false)
      .setStrokeStyle(
        new SolidLine({
          thickness: 2,
          fillStyle: new SolidFill({ color: ColorRGBA(125, 125, 125) }),
        })
      );

    /**
     * Add multiple bars.
     * @param entries Add multiple bars data.
     */
    const addValues = (entries) => {
      for (const entry of entries) {
        bars.push(add(entry));
      }
    };
    /**
     * Add single bar.
     * @param entry Add a single bar data.
     */
    const addValue = (entry) => {
      bars.push(add(entry));
    };
    /**
     * Construct bar to draw.
     * @param entry Single bar data.
     */
    const add = (entry) => {
      // Create rect dimensions.
      const rectDimensions = {
        x: 0,
        y: y - figureThickness,
        width: entry.value,
        height: figureThickness,
      };
      // Add rect to the series.
      const rect = rectangles.add(rectDimensions);
      // Set individual color for the bar.
      rect.setFillStyle(flatBlueStyle);
      //rect.setStrokeStyle(flatWhiteStyle);

      // Set view manually.
      axisY.setInterval(-(figureThickness + figureGap), y + figureGap);

      // Add custom tick, more like categorical axis.
      axisY
        .addCustomTick(UIElementBuilders.AxisTick)
        .setValue(y - figureGap)
        .setGridStrokeLength(0)
        .setTextFormatter((_) => entry.category)
        .setMarker((marker) =>
          marker.setTextFillStyle(
            new SolidFill({ color: ColorRGBA(170, 170, 170) })
          )
        );
      y += figureThickness + figureGap;
      // Return data-structure with both original 'entry' and the rectangle figure that represents it.
      return {
        entry,
        rect,
      };
    };

    // Return public methods of a bar chart interface.
    return {
      chart,
      addValue,
      addValues,
    };
};

const BarChart = (props) => {
  const { values, categories, id } = props;
  const chartRef = useRef(undefined);

  useEffect(() => {
    const themeTextFillStyle = new SolidFill({ color: ColorCSS("#fff") });
    const themeDataSeriesFillStyles = [
      new SolidFill({ color: ColorCSS(LIGHTBLUE) }),
      new SolidFill({ color: ColorCSS("#fff") }),
    ];
    const themeAxisFillStyle = new SolidFill({
      color: ColorCSS("rgba(255, 255, 255, 0.12)"),
    });
    const themeMajorTickFillStyle = new SolidFill({
      color: ColorCSS("rgba(255, 255, 255, 0.12)"),
    });
    const themeMinorTickFillStyle = new SolidFill({
      color: ColorCSS("rgba(255, 255, 255, 0.12)"),
    });
    const themeMajorGridlineFillStyle = new SolidFill({
      color: ColorCSS("rgba(255, 255, 255, 0.12)"),
    });
    const themeMinorGridlineFillStyle = new SolidFill({
      color: ColorCSS("#00000014"),
    });
    const themeUiBackgroundFillStyle = new SolidFill({
      color: ColorCSS("#2b2b2b"),
    });
    const themeUiBackgroundBorderFillStyle = new SolidFill({
      color: ColorCSS("#2b2b2b"),
    });
    const themeCursorGridlineFillStyle = new SolidFill({
      color: ColorCSS("rgba(255, 255, 255, 0.12)"),
    });

    const myTheme = customTheme(Themes.lightNew, {
      lcjsBackgroundFillStyle: new SolidFill({ color: ColorCSS("#121212") }),
      panelBackgroundFillStyle: new SolidFill({ color: ColorCSS("#121212") }),
      seriesBackgroundFillStyle: new SolidFill({ color: ColorCSS("#121212") }),
      chartTitleFillStyle: themeTextFillStyle,
      axisTitleFillStyle: themeTextFillStyle,
      axisStyle: new SolidLine({ thickness: 2, fillStyle: themeAxisFillStyle }),
      numericTickStrategy: Themes.lightNew.numericTickStrategy
        .setMajorTickStyle((majorTicks) =>
          majorTicks
            .setLabelFillStyle(themeTextFillStyle)
            .setTickStyle(
              new SolidLine({
                thickness: 1,
                fillStyle: themeMajorTickFillStyle,
              })
            )
            .setGridStrokeStyle(
              new SolidLine({
                thickness: 1,
                fillStyle: themeMajorGridlineFillStyle,
              })
            )
        )
        .setMinorTickStyle((minorTicks) =>
          minorTicks
            .setLabelFillStyle(themeTextFillStyle)
            .setTickStyle(
              new SolidLine({
                thickness: 1,
                fillStyle: themeMinorTickFillStyle,
              })
            )
            .setGridStrokeStyle(
              new SolidLine({
                thickness: 1,
                fillStyle: themeMinorGridlineFillStyle,
              })
            )
        ),
      seriesFillStyle: (i) =>
        themeDataSeriesFillStyles[i % themeDataSeriesFillStyles.length],
      seriesStrokeStyle: (i) =>
        new SolidLine({
          thickness: 2,
          fillStyle:
            themeDataSeriesFillStyles[i % themeDataSeriesFillStyles.length],
        }),
      uiBackgroundFillStyle: themeUiBackgroundFillStyle,
      uiBackgroundStrokeStyle: new SolidLine({
        thickness: 1,
        fillStyle: themeUiBackgroundBorderFillStyle,
      }),
      uiTextFillStyle: themeTextFillStyle,
      resultTableFillStyle: themeUiBackgroundFillStyle,
      resultTableStrokeStyle: new SolidLine({
        thickness: 1,
        fillStyle: themeUiBackgroundBorderFillStyle,
      }),
      resultTableTextFillStyle: themeTextFillStyle,
      customTickGridStrokeStyle: new SolidLine({
        thickness: 1,
        fillStyle: themeCursorGridlineFillStyle,
      }),
      uiPointableTextBoxFillStyle: themeUiBackgroundFillStyle,
      uiPointableTextBoxStrokeStyle: new SolidLine({
        thickness: 1,
        fillStyle: themeUiBackgroundBorderFillStyle,
      }),
      uiPointableTextBoxTextFillStyle: themeTextFillStyle,
      pointMarkerFillStyle: new SolidFill({
        color: ColorCSS("rgba(255, 255, 255, 0.12)"),
      }),
      chartXYZoomingRectangleFillStyle: new SolidFill({
        color: ColorCSS("#00000016"),
      }),
      chartXYZoomingRectangleStrokeStyle: new SolidLine({
        thickness: 1,
        fillStyle: new SolidFill({ color: ColorCSS("#4f4f4f") }),
      }),
      chartXYFittingRectangleFillStyle: new SolidFill({
        color: ColorCSS("#00000016"),
      }),
      chartXYFittingRectangleStrokeStyle: new SolidLine({
        thickness: 1,
        fillStyle: new SolidFill({ color: ColorCSS("#4f4f4f") }),
      }),
    });

    const lc = lightningChart({ license: "" });
    const chart = barChart(lc, {
      theme: myTheme,
      container: id,
    });

    var entries = [];
    for (let i in categories) {
      entries.push({ category: categories[i], value: values[i] });
    }
    chart.addValues(entries);

    chartRef.current = { chart };

    return () => {
      chart.chart.dispose();
      chartRef.current = undefined;
    };
  }, [id, values, categories]);

  return <div id={id} style={{ width: "100%", height: "100%" }}></div>;
};

export default BarChart;
