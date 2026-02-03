/**
 * Salary Cycle Utility
 * 
 * Salary cycle runs from 26th of a month at 7:01 AM to 26th of the next month at 7:00 AM.
 * All timesheet and dashboard data must strictly follow this cycle.
 */

export interface SalaryCycleRange {
  start: Date; // 26th at 7:01 AM
  end: Date;   // 26th of next month at 7:00 AM
  year: number;
  month: number; // The month in which the cycle starts
  cycleLabel: string; // e.g., "26 Jan 2026 - 25 Feb 2026"
}

export class SalaryCycleUtil {
  
// Salary cycle day of month (26th)
  private static readonly CYCLE_DAY = 26;

  
// Cycle start time: 7:01 AM
  private static readonly CYCLE_START_HOUR = 7;
  private static readonly CYCLE_START_MINUTE = 1;

 
// Cycle end time: 7:00 AM
  private static readonly CYCLE_END_HOUR = 7;
  private static readonly CYCLE_END_MINUTE = 0;

  /**
   * Get the current active salary cycle based on the given date
   * @param now - Current date/time (defaults to now)
   * @returns SalaryCycleRange object with start and end dates
   */
  static getCurrentSalaryCycle(now: Date = new Date()): SalaryCycleRange {
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const day = now.getDate();
    const hour = now.getHours();
    const minute = now.getMinutes();

    let cycleStartYear = year;
    let cycleStartMonth = month;

    // If we're before 26th at 7:01 AM, we're still in the previous cycle
    if (day < this.CYCLE_DAY || (day === this.CYCLE_DAY && (hour < this.CYCLE_START_HOUR || (hour === this.CYCLE_START_HOUR && minute < this.CYCLE_START_MINUTE)))) {
      // Go back one month
      if (cycleStartMonth === 0) {
        cycleStartMonth = 11;
        cycleStartYear--;
      } else {
        cycleStartMonth--;
      }
    }

    // Start: 26th at 7:01 AM of cycleStartMonth
    const start = new Date(cycleStartYear, cycleStartMonth, this.CYCLE_DAY, this.CYCLE_START_HOUR, this.CYCLE_START_MINUTE, 0, 0);

    // End: 26th at 7:00 AM of next month
    let cycleEndYear = cycleStartYear;
    let cycleEndMonth = cycleStartMonth + 1;
    if (cycleEndMonth > 11) {
      cycleEndMonth = 0;
      cycleEndYear++;
    }
    const end = new Date(cycleEndYear, cycleEndMonth, this.CYCLE_DAY, this.CYCLE_END_HOUR, this.CYCLE_END_MINUTE, 0, 0);

    const cycleLabel = this.formatCycleLabel(start, end);

    return {
      start,
      end,
      year: cycleStartYear,
      month: cycleStartMonth + 1, // 1-indexed for external use
      cycleLabel,
    };
  }

  /**
   * Get salary cycle for a specific year and month
   * @param year - Year
   * @param month - Month (1-indexed: 1 = January)
   * @returns SalaryCycleRange object
   */
  static getSalaryCycleForMonth(year: number, month: number): SalaryCycleRange {
    // month is 1-indexed
    const cycleStartMonth = month - 1; // Convert to 0-indexed

    // Start: 26th at 7:01 AM
    const start = new Date(year, cycleStartMonth, this.CYCLE_DAY, this.CYCLE_START_HOUR, this.CYCLE_START_MINUTE, 0, 0);

    // End: 26th at 7:00 AM of next month
    let cycleEndYear = year;
    let cycleEndMonth = cycleStartMonth + 1;
    if (cycleEndMonth > 11) {
      cycleEndMonth = 0;
      cycleEndYear++;
    }
    const end = new Date(cycleEndYear, cycleEndMonth, this.CYCLE_DAY, this.CYCLE_END_HOUR, this.CYCLE_END_MINUTE, 0, 0);

    const cycleLabel = this.formatCycleLabel(start, end);

    return {
      start,
      end,
      year,
      month,
      cycleLabel,
    };
  }

  /**
   * Check if a date falls within the current salary cycle
   * @param date - Date to check
   * @param now - Current date/time
   * @returns boolean
   */
  static isDateInCurrentCycle(date: Date, now: Date = new Date()): boolean {
    const cycle = this.getCurrentSalaryCycle(now);
    return date >= cycle.start && date <= cycle.end;
  }

  /**
   * Check if a date is within the given salary cycle range
   * @param date - Date to check
   * @param cycleStart - Cycle start date
   * @param cycleEnd - Cycle end date
   * @returns boolean
   */
  static isDateInCycle(date: Date, cycleStart: Date, cycleEnd: Date): boolean {
    return date >= cycleStart && date <= cycleEnd;
  }

  /**
   * Get the date range for working days in a salary cycle (excluding cycle start/end times)
   * Returns normalized UTC dates for timesheet queries
   */
  static getSalaryCycleDateRange(year: number, month: number): { start: Date; end: Date } {
    const cycle = this.getSalaryCycleForMonth(year, month);
    
    // Normalize to UTC dates for database queries
    // Start: 26th of the cycle start month (inclusive)
    const start = new Date(Date.UTC(cycle.start.getFullYear(), cycle.start.getMonth(), this.CYCLE_DAY));
    
    // End: 25th of the next month (inclusive) - one day before the cycle end day
    const endYear = cycle.end.getFullYear();
    const endMonth = cycle.end.getMonth();
    const end = new Date(Date.UTC(endYear, endMonth, this.CYCLE_DAY - 1));

    return { start, end };
  }

 
// Get UTC date range for queries (start inclusive, end exclusive for < comparison)
  static getSalaryCycleDateRangeForQuery(year: number, month: number): { start: Date; endExclusive: Date } {
    const { start, end } = this.getSalaryCycleDateRange(year, month);
    
    // endExclusive is one day after the last day of the cycle (for < comparison)
    const endExclusive = new Date(end);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

    return { start, endExclusive };
  }

  /**
   * Format cycle label for display
   * @param start - Cycle start date
   * @param end - Cycle end date (we'll show day before)
   * @returns Formatted string like "26 Jan 2026 - 25 Feb 2026"
   */
  private static formatCycleLabel(start: Date, end: Date): string {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const startDay = start.getDate();
    const startMonth = monthNames[start.getMonth()];
    const startYear = start.getFullYear();

    // End display is one day before the cycle end (since cycle ends at 7:00 AM on 26th)
    const displayEnd = new Date(end);
    displayEnd.setDate(displayEnd.getDate() - 1);
    
    const endDay = displayEnd.getDate();
    const endMonth = monthNames[displayEnd.getMonth()];
    const endYear = displayEnd.getFullYear();

    return `${startDay} ${startMonth} ${startYear} - ${endDay} ${endMonth} ${endYear}`;
  }

  /**
   * Check if current time is past the lifeline cutoff (26th at 7:01 AM)
   * When this time passes, lifelines should be reset for the new cycle
   */
  static shouldResetLifelines(now: Date = new Date()): boolean {
    const day = now.getDate();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Check if we're exactly at or past 26th 7:01 AM
    return day === this.CYCLE_DAY && 
           (hour > this.CYCLE_START_HOUR || 
            (hour === this.CYCLE_START_HOUR && minute >= this.CYCLE_START_MINUTE));
  }

  /**
   * Determine which calendar months are involved in calculating off-Saturdays
   * for a given salary cycle
   * @param year - Salary cycle year
   * @param month - Salary cycle month (1-indexed)
   * @returns Array of {year, month} objects for calendar months to check
   */
  static getCalendarMonthsForCycle(year: number, month: number): Array<{ year: number; month: number }> {
    const result: Array<{ year: number; month: number }> = [];
    
    // The salary cycle spans from 26th of month to 25th of next month
    // So we need to check Saturdays in both calendar months
    
    // First calendar month (where cycle starts)
    result.push({ year, month });
    
    // Second calendar month (where cycle ends)
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear++;
    }
    result.push({ year: nextYear, month: nextMonth });
    
    return result;
  }

  /**
   * Check if a Saturday is an off-Saturday (2nd or 4th) in its calendar month
   * Off-Saturdays are calculated based on calendar month, not salary cycle
   * @param date - Date to check (should be a Saturday)
   * @returns boolean - true if it's an off-Saturday (2nd or 4th)
   */
  static isOffSaturday(date: Date): boolean {
    const dayOfWeek = date.getDay();
    if (dayOfWeek !== 6) {
      return false; // Not a Saturday
    }

    // Calculate which Saturday of the month this is (1st, 2nd, 3rd, 4th, or 5th)
    const dayOfMonth = date.getDate();
    const saturdayOccurrence = Math.ceil(dayOfMonth / 7);

    // 2nd and 4th Saturdays are off
    return saturdayOccurrence === 2 || saturdayOccurrence === 4;
  }

  /**
   * Get all working Saturdays in a calendar month
   * (1st, 3rd, and 5th Saturdays)
   */
  static getWorkingSaturdaysInMonth(year: number, month: number): Date[] {
    const workingSaturdays: Date[] = [];
    
    // month is 1-indexed, convert to 0-indexed for Date constructor
    const monthIndex = month - 1;
    
    // Get first day of month
    const firstDay = new Date(year, monthIndex, 1);
    
    // Get last day of month
    const lastDay = new Date(year, monthIndex + 1, 0);
    
    // Find all Saturdays in the month
    const cursor = new Date(firstDay);
    while (cursor <= lastDay) {
      if (cursor.getDay() === 6) { // Saturday
        if (!this.isOffSaturday(cursor)) {
          workingSaturdays.push(new Date(cursor));
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    
    return workingSaturdays;
  }
}
