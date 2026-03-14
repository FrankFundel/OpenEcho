import React from "react";
import Box from "@mui/material/Box";
import { FixedSizeList } from "react-window";

const ResponsiveVirtualList = ({
  className,
  itemCount,
  itemData,
  itemSize,
  overscanCount,
  children,
  itemKey,
  listRef,
  scrollToIndex,
  scrollToAlignment = "auto",
}) => {
  const containerRef = React.useRef(null);
  const internalListRef = React.useRef(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return undefined;
    }

    const updateSize = () => {
      const nextSize = {
        width: Math.floor(element.clientWidth),
        height: Math.floor(element.clientHeight),
      };
      setSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize
      );
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (
      !internalListRef.current ||
      size.width <= 0 ||
      size.height <= 0 ||
      !Number.isInteger(scrollToIndex) ||
      scrollToIndex < 0 ||
      scrollToIndex >= itemCount
    ) {
      return;
    }

    internalListRef.current.scrollToItem(scrollToIndex, scrollToAlignment);
  }, [itemCount, scrollToAlignment, scrollToIndex, size.height, size.width]);

  const assignListRef = (value) => {
    internalListRef.current = value;

    if (!listRef) {
      return;
    }

    if (typeof listRef === "function") {
      listRef(value);
      return;
    }

    listRef.current = value;
  };

  return (
    <Box ref={containerRef} className={className}>
      {size.width > 0 && size.height > 0 ? (
        <FixedSizeList
          ref={assignListRef}
          height={size.height}
          width={size.width}
          itemSize={itemSize}
          itemCount={itemCount}
          overscanCount={overscanCount}
          itemData={itemData}
          itemKey={itemKey}
        >
          {children}
        </FixedSizeList>
      ) : null}
    </Box>
  );
};

export default ResponsiveVirtualList;
