/**
 * Requested / reserved / backordered for one order, worded for a Med Rep.
 *
 * Reads only server-written figures (see services/backorder.js
 * `describeAllocation`). A future order is explained, never promised a date:
 * dispatch waits until every line is fully reserved, and stock is reserved
 * automatically as it arrives, in priority order.
 */
function AllocationSummary({ summary, lines = [] }) {
  if (!summary) return null;
  const full = summary.fullyReserved;
  const showLines = lines.length > 0 && !full;

  return (
    <div className={`alloc-summary${full ? " full" : ""}`} role="status">
      <strong>
        {full
          ? "All stock reserved — ready for dispatch planning"
          : `Future order: ${summary.reserved.toLocaleString()} of ${summary.requested.toLocaleString()} vials reserved`}
      </strong>
      {!full && (
        <span>
          {summary.backordered.toLocaleString()} {summary.backordered === 1 ? "vial is" : "vials are"} waiting
          for stock. Stock is reserved for this order automatically as it arrives, in priority order. The order
          is dispatched only once every item is fully reserved, so no delivery date is guaranteed until then.
        </span>
      )}
      {showLines && (
        <table className="alloc-lines">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Requested</th>
              <th scope="col">Reserved</th>
              <th scope="col">Backordered</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.name}-${index}`}>
                <td>{line.name}</td>
                <td>{line.requested.toLocaleString()}</td>
                <td>{line.reserved.toLocaleString()}</td>
                <td>{line.backordered.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default AllocationSummary;
