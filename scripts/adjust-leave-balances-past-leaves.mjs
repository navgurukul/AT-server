import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables
dotenv.config();

const { Pool } = pg;

// Determine SSL configuration
const isLocalhost = process.env.DATABASE_URL.includes('localhost');
const sslConfig = isLocalhost ? false : {
  rejectUnauthorized: false,
  checkServerIdentity: () => undefined
};

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
});

/**
 * CALCULATION LOGIC FOR LEAVE BALANCE ADJUSTMENT:
 * 
 * Current State:
 * - allocatedHours: Set from CSV (total allocation for the year)
 * - balanceHours: Set from CSV (remaining balance)
 * - pendingHours: 0 (not yet calculated)
 * - bookedHours: 0 (not yet calculated)
 * 
 * Target State (after adjustment):
 * - allocatedHours: Remains the same
 * - balanceHours: Current balance - (approved hours + pending hours)
 * - pendingHours: Sum of all pending leave requests (Jan 1 to Feb 20)
 * - bookedHours: Sum of all approved leave requests (Jan 1 to Feb 20)
 * 
 * Formula: allocatedHours = balanceHours + pendingHours + bookedHours
 */

/**
 * Adjust leave balances based on historical leave requests
 * from January 1, 2026 to February 20, 2026
 */
async function adjustLeaveBalances() {
  const client = await pool.connect();
  
  // Check for dry-run mode
  const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
  
  try {
    // Start transaction (only if not dry-run)
    if (!isDryRun) {
      await client.query('BEGIN');
    }
    
    // Define the date range for past leaves
    const startDate = '2026-01-01';
    const endDate = '2026-02-20';
    
    // Get all leave balances (excluding Compensatory Leave as it works differently)
    const leaveBalancesResult = await client.query(`
      SELECT 
        lb.id,
        lb.user_id,
        lb.leave_type_id,
        lb.allocated_hours,
        lb.balance_hours,
        lb.pending_hours,
        lb.booked_hours,
        u.email,
        u.name,
        lt.name as leave_type_name
      FROM leave_balances lb
      JOIN users u ON lb.user_id = u.id
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lt.name != 'Compensatory Leave'
      ORDER BY u.email, lt.name
    `);
    
    // Pre-calculate all pending and approved hours with a single query
    const leaveHoursResult = await client.query(`
      SELECT 
        user_id,
        leave_type_id,
        state,
        COALESCE(SUM(hours::numeric), 0) as total_hours
      FROM leave_requests
      WHERE start_date >= $1::timestamp
        AND start_date <= $2::timestamp
        AND state IN ('pending', 'approved')
      GROUP BY user_id, leave_type_id, state
    `, [startDate, endDate]);
    
    // Build a map for quick lookup: user_id -> leave_type_id -> state -> hours
    const leaveHoursMap = new Map();
    leaveHoursResult.rows.forEach(row => {
      const key = `${row.user_id}_${row.leave_type_id}`;
      if (!leaveHoursMap.has(key)) {
        leaveHoursMap.set(key, { pending: 0, approved: 0 });
      }
      const hours = parseFloat(row.total_hours);
      if (row.state === 'pending') {
        leaveHoursMap.get(key).pending = hours;
      } else if (row.state === 'approved') {
        leaveHoursMap.get(key).approved = hours;
      }
    });
    
    // Calculate adjustments for each leave balance
    
    let processedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const updates = [];
    const errors = [];
    
    for (const balance of leaveBalancesResult.rows) {
      try {
        // Get pending and approved hours from the pre-calculated map
        const key = `${balance.user_id}_${balance.leave_type_id}`;
        const leaveHours = leaveHoursMap.get(key) || { pending: 0, approved: 0 };
        const totalPendingHours = leaveHours.pending;
        const totalApprovedHours = leaveHours.approved;
        
        // Calculate new values
        const currentBalanceHours = parseFloat(balance.balance_hours);
        const currentPendingHours = parseFloat(balance.pending_hours);
        const currentBookedHours = parseFloat(balance.booked_hours);
        const allocatedHours = parseFloat(balance.allocated_hours);
        
        // New values
        const newPendingHours = currentPendingHours + totalPendingHours;
        const newBookedHours = currentBookedHours + totalApprovedHours;
        const newBalanceHours = currentBalanceHours - (totalPendingHours + totalApprovedHours);
        
        // Skip if no changes needed
        if (totalPendingHours === 0 && totalApprovedHours === 0) {
          skippedCount++;
          processedCount++;
          continue;
        }
        
        // Validate that the formula still holds
        const totalAfterUpdate = newBalanceHours + newPendingHours + newBookedHours;
        const difference = Math.abs(totalAfterUpdate - allocatedHours);
        
        // Allow small floating point differences (less than 0.01 hours)
        if (difference > 0.01) {
          errors.push({
            user: balance.email,
            leaveType: balance.leave_type_name,
            error: `Formula mismatch: allocated (${allocatedHours}) != balance + pending + booked (${totalAfterUpdate.toFixed(2)})`,
            allocatedHours,
            newBalanceHours,
            newPendingHours,
            newBookedHours,
          });
          skippedCount++;
          processedCount++;
          continue;
        }
        
        // Check if balance would go negative
        if (newBalanceHours < -0.01) {
          errors.push({
            user: balance.email,
            leaveType: balance.leave_type_name,
            error: `Negative balance: ${newBalanceHours.toFixed(2)} hours (pending: ${totalPendingHours}, approved: ${totalApprovedHours})`,
            currentBalance: currentBalanceHours,
            totalDeduction: totalPendingHours + totalApprovedHours,
          });
          skippedCount++;
          processedCount++;
          continue;
        }
        
        // Record update
        updates.push({
          id: balance.id,
          userEmail: balance.email,
          userName: balance.name,
          leaveType: balance.leave_type_name,
          before: {
            balanceHours: currentBalanceHours,
            pendingHours: currentPendingHours,
            bookedHours: currentBookedHours,
            allocatedHours: allocatedHours,
          },
          after: {
            balanceHours: newBalanceHours,
            pendingHours: newPendingHours,
            bookedHours: newBookedHours,
            allocatedHours: allocatedHours,
          },
          changes: {
            pendingHours: totalPendingHours,
            approvedHours: totalApprovedHours,
          }
        });
        
        // Execute update if not dry-run
        if (!isDryRun) {
          await client.query(`
            UPDATE leave_balances
            SET 
              balance_hours = $1,
              pending_hours = $2,
              booked_hours = $3,
              updated_at = NOW()
            WHERE id = $4
          `, [newBalanceHours.toFixed(2), newPendingHours.toFixed(2), newBookedHours.toFixed(2), balance.id]);
        }
        
        updatedCount++;
        processedCount++;
        
      } catch (error) {
        errors.push({
          user: balance.email,
          leaveType: balance.leave_type_name,
          error: error.message
        });
        skippedCount++;
        processedCount++;
      }
    }
    
    // Commit transaction if not dry-run
    if (!isDryRun) {
      await client.query('COMMIT');
    }
    
    // Return results for further processing
    return { errors, isDryRun };
    
  } catch (error) {
    // Rollback on error
    if (!isDryRun) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

// Main execution

adjustLeaveBalances()
  .then(({ errors, isDryRun }) => {
    // Save errors to CSV file for manual review
    if (errors.length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const errorFile = `leave-balance-adjustment-errors-${timestamp}.csv`;
      
      const csvHeader = 'User Email,Leave Type,Error,Current Balance,Allocated Hours,New Balance,New Pending,New Booked,Total Deduction\n';
      const csvRows = errors.map(err => {
        return [
          err.user || '',
          err.leaveType || '',
          (err.error || '').replace(/,/g, ';'),
          err.currentBalance !== undefined ? err.currentBalance : '',
          err.allocatedHours !== undefined ? err.allocatedHours : '',
          err.newBalanceHours !== undefined ? err.newBalanceHours.toFixed(2) : '',
          err.newPendingHours !== undefined ? err.newPendingHours.toFixed(2) : '',
          err.newBookedHours !== undefined ? err.newBookedHours.toFixed(2) : '',
          err.totalDeduction !== undefined ? err.totalDeduction : '',
        ].join(',');
      }).join('\n');
      
      fs.writeFileSync(errorFile, csvHeader + csvRows);
    }
    process.exit(0);
  })
  .catch((error) => {
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
