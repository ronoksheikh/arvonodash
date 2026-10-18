import { createTheme, type MantineColorsTuple } from "@mantine/core";

const brand: MantineColorsTuple = [
  "#eef0ff", "#dcdeff", "#b6b9fb", "#8e92f6", "#6c70f2", "#575bf0", "#4c4ce0", "#3d3dc8", "#3435b3", "#28299e",
];

export const theme = createTheme({
  primaryColor: "brand",
  colors: { brand },
  primaryShade: { light: 6, dark: 5 },
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontFamilyMonospace: "'JetBrains Mono', ui-monospace, monospace",
  headings: { fontFamily: "Inter, sans-serif", fontWeight: "600" },
  defaultRadius: "md",
  cursorType: "pointer",
  components: {
    Card: { defaultProps: { withBorder: true, radius: "lg", padding: "lg" } },
    Paper: { defaultProps: { radius: "lg" } },
    Badge: { defaultProps: { variant: "light", radius: "sm" }, styles: { root: { textTransform: "none", fontWeight: 600, letterSpacing: 0 } } },
    Button: { defaultProps: { radius: "md" } },
    Drawer: { defaultProps: { overlayProps: { backgroundOpacity: 0.35, blur: 2 } } },
    Modal: { defaultProps: { radius: "lg", overlayProps: { backgroundOpacity: 0.35, blur: 2 } } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 200 } },
  },
});
