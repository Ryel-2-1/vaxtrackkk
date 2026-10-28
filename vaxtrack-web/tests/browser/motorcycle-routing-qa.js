import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  fetchRoute, optimizeTrip, decodePolyline, formatDistance, formatDuration,
} from "../../src/services/routeService.js";

const start = [14.329, 121.081];
const samples = [
  { orderId: "sample-a", latLng: [14.338, 121.087], label: "Sample stop A" },
  { orderId: "sample-b", latLng: [14.313, 121.111], label: "Sample stop B" },
];
const map = L.map("map");
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const marker = (point, name, badge) => L.marker(point, {
  icon: L.divIcon({ className: "", html: '<span class="point">' + badge + "</span>", iconSize: [32, 28] }),
}).addTo(map).bindTooltip(name);
marker(start, "Sample starting point", "S");
marker(samples[0].latLng, samples[0].label, "A");
marker(samples[1].latLng, samples[1].label, "B");
map.fitBounds(L.latLngBounds([start, ...samples.map(s => s.latLng)]).pad(0.15));

const singleButton = document.getElementById("single");
const tripButton = document.getElementById("trip");
const status = document.getElementById("status");
const metrics = document.getElementById("metrics");
const stops = document.getElementById("stops");
const profile = document.getElementById("profile");
let line = null;
let busy = false;

async function run(kind) {
  if (busy) return;
  busy = true;
  singleButton.disabled = tripButton.disabled = true;
  status.className = "";
  status.textContent = "Requesting a motorcycle route from Valhalla…";
  try {
    const result = kind === "single"
      ? await fetchRoute(start, samples[1].latLng)
      : await optimizeTrip(start, samples.map(({ orderId, latLng }) => ({ orderId, latLng })));
    const points = decodePolyline(result.polyline);
    const nextLine = L.polyline(points, { color: "#176d53", weight: 6 }).addTo(map);
    if (line) map.removeLayer(line);
    line = nextLine;
    map.fitBounds(line.getBounds().pad(0.15));
    metrics.replaceChildren();
    for (const text of [
      "Distance: " + formatDistance(result.distanceMeters),
      "Estimated travel time: " + formatDuration(result.durationSeconds),
      "Decoded route points: " + points.length,
    ]) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      metrics.append(paragraph);
    }
    stops.replaceChildren();
    for (const stop of result.stops || []) {
      const item = document.createElement("li");
      const sample = samples.find(s => s.orderId === stop.orderId);
      item.textContent = sample.label + " — estimated " + formatDuration(stop.etaSeconds) + " from departure";
      stops.append(item);
    }
    profile.textContent = "Provider: " + result.provider + " · Profile: " + result.profile;
    status.textContent = (kind === "single" ? "Single route" : "Two-stop trip") +
      " passed the client’s motorcycle and returned-road restriction checks. Preview only; nothing was saved.";
  } catch (error) {
    status.className = "error";
    status.textContent = error.message + " Any earlier preview is retained.";
  } finally {
    busy = false;
    singleButton.disabled = tripButton.disabled = false;
  }
}
singleButton.addEventListener("click", () => run("single"));
tripButton.addEventListener("click", () => run("trip"));
