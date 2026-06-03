import { Logger, UnauthorizedException } from '@nestjs/common';

const logger = new Logger('UserAccessValidation');

export interface UserAccessCheckData {
  id: number;
  email: string;
  status: string;
  dateOfExit: string | Date | null;
  timezone?: string | null;
}

/**
 * Format a Date object into YYYY-MM-DD UTC representation.
 */
function getYYYYMMDDFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Normalizes input date/string to YYYY-MM-DD.
 */
export function getYYYYMMDD(d: Date | string): string {
  if (d instanceof Date) {
    return getYYYYMMDDFromDate(d);
  }
  if (typeof d === 'string') {
    if (d.includes('T')) {
      return d.split('T')[0];
    }
    const match = d.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) {
      return match[0];
    }
    const parsed = new Date(d);
    if (!isNaN(parsed.getTime())) {
      return getYYYYMMDDFromDate(parsed);
    }
    return d;
  }
  return '';
}

/**
 * Computes the exact UTC Date object representing 23:59:59.999 local time 
 * on the target YYYY-MM-DD date within the specified timezone.
 */
export function getEndOfDayInTimezone(dateStr: string, timeZone: string): Date {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Initial estimate of UTC end of day
  const targetUtcEstimate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  // Determine timezone parts at the estimated date
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    fractionalSecondDigits: 3,
    hour12: false,
  } as any).formatToParts(targetUtcEstimate);

  const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  const localYear = parseInt(partMap.year, 10);
  const localMonth = parseInt(partMap.month, 10);
  const localDay = parseInt(partMap.day, 10);
  const localHour = parseInt(partMap.hour, 10);
  const localMinute = parseInt(partMap.minute, 10);
  const localSecond = parseInt(partMap.second, 10);
  const localMs = partMap.fractionalSecond ? parseInt(partMap.fractionalSecond, 10) : 999;

  // Reconstruct local timestamp as UTC representation for offset calculation
  const localTimestamp = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond, localMs);
  const utcTimestamp = targetUtcEstimate.getTime();

  // Offset = Local - UTC
  const offsetMs = localTimestamp - utcTimestamp;

  // Desired local timestamp is end-of-day on the target date
  const desiredLocalTimestamp = Date.UTC(year, month - 1, day, 23, 59, 59, 999);

  // Target UTC timestamp = Desired Local Timestamp - Timezone Offset
  return new Date(desiredLocalTimestamp - offsetMs);
}

/**
 * Reusable backend validator for enforcing user access control.
 * Throws UnauthorizedException if user access has expired or is suspended.
 */
export function validateUserAccess(user: UserAccessCheckData): void {
  const now = new Date();

  // 1. Check suspended status
  if (user.status === 'suspended') {
    logger.warn(
      `Blocked access attempt: userId=${user.id}, email=${user.email}, reason=suspended, dateOfExit=N/A, timestamp=${now.toISOString()}`
    );
    throw new UnauthorizedException('Account suspended. Reach out to HR.');
  }

  // 2. Check exit date status
  if (user.dateOfExit) {
    const tz = user.timezone || 'Asia/Kolkata';
    const dateStr = getYYYYMMDD(user.dateOfExit);

    if (dateStr) {
      const endOfExitDay = getEndOfDayInTimezone(dateStr, tz);
      if (now > endOfExitDay) {
        logger.warn(
          `Blocked access attempt: userId=${user.id}, email=${user.email}, reason=exit date passed, dateOfExit=${dateStr}, timestamp=${now.toISOString()}`
        );
        throw new UnauthorizedException('Access denied. Employment exit date has passed.');
      }
    }
  }
}
