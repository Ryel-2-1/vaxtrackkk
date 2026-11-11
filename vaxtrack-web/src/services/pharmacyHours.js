import demo from "../../functions/src/pharmacyHoursDemo.json" with { type: "json" };

// Pharmacy operating times, every day, in Asia/Manila wall-clock minutes.
export const PHARMACY_HOURS = Object.freeze({ open: 7 * 60, close: 16 * 60 });
export const PHARMACY_OPEN = "07:00";
export const PHARMACY_CLOSE = "16:00";
export const HOURS_MESSAGE = "Requested delivery times must be within pharmacy operating hours, 7:00 AM to 4:00 PM (PHT).";

export function pharmacyHoursFor(projectId) {
  return demo.relaxedProjectIds.includes(projectId) ? null : PHARMACY_HOURS;
}

export const ACTIVE_PHARMACY_HOURS = pharmacyHoursFor(import.meta.env?.VITE_FIREBASE_PROJECT_ID);

export function hubReturnOf(plan, travelMinutes, hours = PHARMACY_HOURS) {
  const last = plan?.stops?.at(-1);
  if (!Number.isInteger(plan?.evaluatedDeparture) || !Number.isInteger(last?.leave)
    || !Number.isInteger(travelMinutes) || travelMinutes < 0) {
    const warning = "Hub return time is unknown. Check the return route and final stop service time";
    return { minute: null, durationMinutes: null, status: "unknown", warning: hours ? `${warning}; the Rider should be back by 4:00 PM (PHT).` : `${warning}.` };
  }
  const minute = last.leave + travelMinutes;
  const late = hours && minute > hours.close;
  return {
    minute, durationMinutes: minute - plan.evaluatedDeparture,
    status: hours ? (late ? "late" : "on_time") : "estimated",
    warning: late ? "This plan returns to the hub after 4:00 PM (PHT). Review the stops or departure time before proceeding." : null,
  };
}

/** Advisory at actual dispatch time; never blocks recording real operations. */
export function dispatchHoursWarning(returnPlan, now, hours = PHARMACY_HOURS) {
  if (!hours) return null;
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  if (minute < hours.open || minute >= hours.close) {
    return "It is outside pharmacy operating hours (7:00 AM–4:00 PM PHT). The Rider should be back at the hub by 4:00 PM. You may proceed after reviewing this exception.";
  }
  if (!Number.isInteger(returnPlan?.durationMinutes)) return hubReturnOf(null, null, hours).warning;
  const departure = Math.max(minute, returnPlan.plannedDeparture ?? minute);
  if (departure + returnPlan.durationMinutes > hours.close) {
    return "Using the current departure time, the trip is estimated to return after 4:00 PM (PHT). You may proceed after reviewing this exception.";
  }
  return null;
}
