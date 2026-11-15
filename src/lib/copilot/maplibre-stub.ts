// Stub for `@copilotkit/react-core`'s optional `maplibre-gl` peer dep so
// Turbopack bundles `standardUI` without requiring `maplibre-gl`; `MapView`
// catches the rejected dynamic import and falls back to its list view.
export {};
throw new Error("maplibre-gl is not installed");
