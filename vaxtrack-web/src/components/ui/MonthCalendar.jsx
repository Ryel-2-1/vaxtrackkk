import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  WEEKDAY_LABELS,
  buildMonthGrid,
  monthLabel,
} from "../../services/deliveryCalendar";
import "./MonthCalendar.css";

/**
 * A month grid, shared by the Sales Rep planner and the Dispatcher day-view.
 *
 * Presentation only: it owns no month state and does no data work. The parent
 * says which month to show and supplies per-day counts; every day is a real
 * button so keyboard and screen-reader users select a date the same way. The
 * month maths lives in deliveryCalendar.js so it can be tested without a DOM.
 *
 * @param {object} props
 * @param {number} props.year
 * @param {number} props.month             0-based
 * @param {string} [props.today]           ISO 'YYYY-MM-DD'; highlights that cell
 * @param {Object<string, number>} [props.counts]  iso -> marker count
 * @param {string|null} [props.selectedDate]       iso of the chosen day
 * @param {string|null} [props.minDate]    iso; days before it are not selectable
 * @param {(iso: string) => void} props.onSelectDate
 * @param {() => void} props.onPrevMonth
 * @param {() => void} props.onNextMonth
 * @param {string} [props.caption]         small line under the header
 * @param {string} [props.ariaLabel]
 */
function MonthCalendar({
  year,
  month,
  today,
  counts = {},
  selectedDate = null,
  minDate = null,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
  caption,
  ariaLabel = "Delivery calendar",
}) {
  const weeks = buildMonthGrid(year, month, today ? { today } : undefined);
  const heading = monthLabel(year, month);

  return (
    <div className="mcal" role="group" aria-label={ariaLabel}>
      <div className="mcal-head">
        <button
          type="button"
          className="mcal-nav"
          onClick={onPrevMonth}
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="mcal-heading">
          <strong>{heading}</strong>
          {caption ? <span className="mcal-caption">{caption}</span> : null}
        </div>
        <button
          type="button"
          className="mcal-nav"
          onClick={onNextMonth}
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="mcal-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div className="mcal-grid">
        {weeks.flat().map((cell) => {
          const count = counts[cell.iso] || 0;
          const disabled = minDate ? cell.iso < minDate : false;
          const isSelected = selectedDate === cell.iso;
          const classes = [
            "mcal-day",
            cell.inMonth ? "" : "mcal-day-out",
            cell.isToday ? "mcal-day-today" : "",
            isSelected ? "mcal-day-selected" : "",
            count > 0 ? "mcal-day-has" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const label = `${cell.iso}${count > 0 ? `, ${count} order${count === 1 ? "" : "s"}` : ""}`;

          return (
            <button
              key={cell.iso}
              type="button"
              className={classes}
              disabled={disabled}
              aria-pressed={isSelected}
              aria-label={label}
              title={count > 0 ? `${count} order${count === 1 ? "" : "s"}` : undefined}
              onClick={() => onSelectDate && onSelectDate(cell.iso)}
            >
              <span className="mcal-day-num">{cell.day}</span>
              {count > 0 ? (
                <span className="mcal-day-count tnum">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default MonthCalendar;
