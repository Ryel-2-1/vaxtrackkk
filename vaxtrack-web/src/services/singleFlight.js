// One request per action, however many times it is triggered.
//
// A disabled button is a courtesy, not a guard: a double-click, Enter held
// down or a second tap before React re-renders all reach the handler. The
// guard has to be synchronous and live outside render — that is this.
//
// While a run is in flight, further calls return the SAME promise and do not
// call the action again. When it settles (either way) the next call runs.

export function createSingleFlight() {
  let inFlight = null;
  return {
    run(action) {
      if (inFlight) return inFlight;
      let settled;
      try {
        settled = Promise.resolve(action());
      } catch (error) {
        settled = Promise.reject(error);
      }
      inFlight = settled.finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get busy() {
      return inFlight !== null;
    },
  };
}
