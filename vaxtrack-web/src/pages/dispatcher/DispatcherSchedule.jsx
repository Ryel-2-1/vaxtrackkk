import DeliveryCalendar from "../../components/schedule/DeliveryCalendar";

/**
 * Dispatcher view of the shared Delivery Calendar: read-only scheduling.
 * Dispatchers see every order on its scheduled day, with the same status and
 * priority filters as Admin, but no "Change date & time" control — only an
 * Admin may reschedule, and only through the server callable.
 */
function DispatcherSchedule() {
  return <DeliveryCalendar role="dispatcher" />;
}

export default DispatcherSchedule;
