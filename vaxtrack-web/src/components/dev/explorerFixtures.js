export const EXPLORER_ENDPOINT = "/__system-explorer";
export const SIM_PROJECT = "demo-vaxtrack-explorer";
export const HUB = { name: "Demo distribution hub", point: [14.59, 121.01] };

export const STOPS = [
  { key: "s01", name: "Northgate Clinic", point: [14.633, 121.016], units: 2 },
  { key: "s02", name: "Westpark Clinic", point: [14.587, 120.958], units: 2 },
  { key: "s03", name: "Lakeside Clinic", point: [14.571, 121.068], units: 3 },
  { key: "s04", name: "Riverbend Clinic", point: [14.615, 120.970], units: 2 },
  { key: "s05", name: "Eastwood Clinic", point: [14.616, 121.071], units: 3 },
  { key: "s06", name: "Southgate Clinic", point: [14.544, 120.987], units: 1 },
  { key: "s07", name: "Hillcrest Clinic", point: [14.647, 121.044], units: 2 },
  { key: "s08", name: "Bayview Clinic", point: [14.557, 120.959], units: 1 },
  { key: "s09", name: "Central Clinic", point: [14.593, 121.033], units: 2 },
  { key: "s10", name: "Southridge Clinic", point: [14.542, 121.044], units: 2 },
];

export const RIDERS = [
  { key: "r1", name: "Rider A", color: "#13ae91", capacity: 24 },
  { key: "r2", name: "Rider B", color: "#f1b34f", capacity: 24 },
  { key: "r3", name: "Rider C", color: "#9e93f5", capacity: 24 },
];

export const SCENARIOS = {
  fleet: { label: "10-stop dispatch", stock: 24 },
  shortage: { label: "Stock shortage", stock: 8 },
  windows: { label: "Conflicting time windows", stock: 24 },
};
