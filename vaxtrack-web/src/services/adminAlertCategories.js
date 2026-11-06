/** Category counts and list filters use stored alert types, not display text. */
export function activeAlertCountOfType(alerts, typeKey) {
  return alerts.filter((alert) => alert.status !== "resolved" && alert.typeKey === typeKey).length;
}

export function filterAdminAlerts(alerts, { searchTerm = "", severityFilter = "all", typeFilter = null } = {}) {
  const search = searchTerm.toLowerCase();
  return alerts.filter((alert) => {
    const searchable = `${alert.type} ${alert.searchText} ${alert.severity} ${alert.status}`.toLowerCase();
    const matchesSeverity = severityFilter === "all"
      || (severityFilter === "resolved" && alert.status === "resolved")
      || (severityFilter !== "resolved" && alert.status !== "resolved" && alert.severity === severityFilter);
    const matchesType = !typeFilter || (alert.typeKey === typeFilter && alert.status !== "resolved");
    return searchable.includes(search) && matchesSeverity && matchesType;
  });
}
