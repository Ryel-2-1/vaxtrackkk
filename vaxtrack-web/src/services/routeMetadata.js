import { UserMessageError } from "./userMessageError.js";
export const ROUTE_PROVIDER = "valhalla";
export const ROUTE_PROFILE = "motorcycle-no-expressways-v1";
// Single/trip provenance is separate: refreshing one cannot relabel the other.
export function motorcycleRouteMetadata(route, trip = false) {
  if (route?.provider !== ROUTE_PROVIDER || route?.profile !== ROUTE_PROFILE) {
    throw new UserMessageError("Generate a verified motorcycle route before saving it.");
  }
  return trip ? {
    routeProvider: ROUTE_PROVIDER,
    tripRouteProvider: ROUTE_PROVIDER,
    tripRouteProfile: ROUTE_PROFILE
  } : {
    routeProvider: ROUTE_PROVIDER,
    routeProfile: ROUTE_PROFILE
  };
}
export function savedRouteDescription(order, trip = false) {
  const provider = trip ? order?.tripRouteProvider : order?.routeProvider;
  const profile = trip ? order?.tripRouteProfile : order?.routeProfile;
  return provider === ROUTE_PROVIDER && profile === ROUTE_PROFILE ? "Motorcycle route · checked for highway, toll road and ferry flags" : "Existing route is not verified for this motorcycle fleet. Regenerate it before use.";
}
