import fs from 'fs';
import { parse } from 'csv-parse';
import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Pool } = pg;

// Determine SSL configuration
const isLocalhost = process.env.DATABASE_URL.includes('localhost');
const sslConfig = isLocalhost ? false : {
  rejectUnauthorized: false,
  // Additional options for AWS RDS or other cloud providers
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
 * CALCULATION LOGIC FOR LEAVE BALANCES:
 * 
 * Database Fields:
 * - allocatedHours: Total leave assigned to the user for the entire year
 * - balanceHours: Available leave balance (can be used)
 * - pendingHours: Leave that's been applied but awaiting approval (managed by app code)
 * - bookedHours: Leave that's been approved (managed by app code)
 * 
 * Formula: allocatedHours = balanceHours + pendingHours + bookedHours
 * 
 * State Transitions (handled in leaves.service.ts):
 * 1. When user applies for leave:
 *    - Deduct from balanceHours
 *    - Add to pendingHours
 * 
 * 2. When leave is approved:
 *    - Move from pendingHours to bookedHours
 * 
 * 3. When leave is rejected:
 *    - Move from pendingHours back to balanceHours
 */

/**
 * Convert leave days to hours (assuming 8 hours per day)
 */
function daysToHours(days) {
  return days * 8;
}

/**
 * Process CSV and migrate leave balances for 2026
 * This script only handles the initial data import.
 * All runtime calculations (pending/booked) are handled by the application code.
 */
async function migrateLeaveBalances() {
  const client = await pool.connect();
  
  // Check for dry-run mode
  const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
  
  console.log('='.repeat(80));
  console.log('Leave Balance Migration - 2026');
  console.log('='.repeat(80));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be committed)'}`);
  console.log('');
  
  try {
    // Start transaction (only if not dry-run)
    if (!isDryRun) {
      await client.query('BEGIN');
    }
    
    // Build user email to user id map
    console.log('Building user map...');
    const userResult = await client.query(
      'SELECT id, email, name FROM users WHERE status = $1',
      ['active']
    );
    const userMap = new Map();
    userResult.rows.forEach(row => {
      userMap.set(row.email.toLowerCase().trim(), {
        id: row.id,
        name: row.name
      });
    });
    console.log(`✓ Found ${userMap.size} active users`);
    console.log('');
    
    // Build leave type name to leave type id map
    console.log('Building leave type map...');
    const leaveTypeResult = await client.query(
      'SELECT id, name, code FROM leave_types'
    );
    const leaveTypeMap = new Map();
    leaveTypeResult.rows.forEach(row => {
      leaveTypeMap.set(row.name.trim(), {
        id: row.id,
        code: row.code
      });
    });
    console.log(`✓ Found ${leaveTypeMap.size} leave types`);
    console.log('');
    
    // Read and parse CSV
    const csvFilePath = './Leave-Ballance-2026.csv';
    
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }
    
    console.log(`Reading CSV file: ${csvFilePath}`);
    const records = [];
    const parser = fs
      .createReadStream(csvFilePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }));
    
    for await (const record of parser) {
      records.push(record);
    }
    console.log(`✓ Loaded ${records.length} records from CSV`);
    console.log('');
    
    // Process records
    console.log('Processing records...');
    console.log('-'.repeat(80));
    
    let processedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    let insertedCount = 0;
    const errors = [];
    const successSamples = [];
    
    for (const [index, record] of records.entries()) {
      try {
        const userEmail = record.userEmail?.trim().toLowerCase();
        const leaveType = record.leaveType?.trim();
        const remainingLeaves = record.remainingLeaves?.trim();
        const allotedLeaves = record.allotedLeaves?.trim();
        
        // Validate required fields
        if (!userEmail || !leaveType) {
          skippedCount++;
          errors.push({
            row: index + 2,
            email: userEmail || 'N/A',
            leaveType: leaveType || 'N/A',
            error: 'Missing required fields (userEmail or leaveType)'
          });
          continue;
        }
        
        // Get user
        const user = userMap.get(userEmail);
        if (!user) {
          skippedCount++;
          errors.push({
            row: index + 2,
            email: userEmail,
            leaveType: leaveType,
            error: 'User not found or not active'
          });
          continue;
        }
        
        // Get leave type
        const leaveTypeInfo = leaveTypeMap.get(leaveType);
        if (!leaveTypeInfo) {
          skippedCount++;
          errors.push({
            row: index + 2,
            email: userEmail,
            leaveType: leaveType,
            error: 'Leave type not found'
          });
          continue;
        }
        
        // Parse leave days from CSV
        let balanceDays = parseFloat(remainingLeaves);
        if (isNaN(balanceDays) || balanceDays < 0) {
          balanceDays = 0;
        }
        
        // Parse allotted leaves for allocated_hours
        let allocatedDays = parseFloat(allotedLeaves);
        if (isNaN(allocatedDays) || allocatedDays < 0) {
          allocatedDays = 0;
        }
        
        // Convert to hours (assuming 8 hours per day)
        // allocatedHours = total leave for the year from CSV
        // balanceHours = available balance from CSV
        // pendingHours = 0 (will be calculated when user applies for leave)
        // bookedHours = 0 (will be calculated when leave is approved)
        const balanceHours = daysToHours(balanceDays);
        const allocatedHours = daysToHours(allocatedDays);
        
        // Set as_of_date to start of 2026 (Jan 1, 2026)
        const asOfDate = '2026-01-01';
        
        // Check if leave balance already exists
        const existingBalance = await client.query(
          `SELECT id, balance_hours, allocated_hours, pending_hours, booked_hours
           FROM leave_balances 
           WHERE user_id = $1 AND leave_type_id = $2`,
          [user.id, leaveTypeInfo.id]
        );
        
        if (existingBalance.rows.length > 0) {
          const existing = existingBalance.rows[0];
          
          // Update existing balance
          if (!isDryRun) {
            await client.query(
              `UPDATE leave_balances 
               SET balance_hours = $1,
                   allocated_hours = $2,
                   as_of_date = $3,
                   updated_at = NOW()
               WHERE user_id = $4 AND leave_type_id = $5`,
              [balanceHours, allocatedHours, asOfDate, user.id, leaveTypeInfo.id]
            );
          }
          updatedCount++;
          
          // Collect sample for summary
          if (successSamples.length < 5) {
            successSamples.push({
              action: 'UPDATE',
              user: user.name,
              email: userEmail,
              leaveType: leaveType,
              allocated: allocatedDays,
              balance: balanceDays,
              previous: {
                allocated: parseFloat(existing.allocated_hours) / 8,
                balance: parseFloat(existing.balance_hours) / 8
              }
            });
          }
          
          if ((processedCount + 1) % 100 === 0) {
            console.log(`Progress: ${processedCount + 1} records processed...`);
          }
        } else {
          // Insert new balance
          // pendingHours and bookedHours start at 0
          // They will be updated by the application when users apply for/get approved leave
          if (!isDryRun) {
            await client.query(
              `INSERT INTO leave_balances 
               (user_id, leave_type_id, balance_hours, allocated_hours, pending_hours, booked_hours, as_of_date, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 0, 0, $5, NOW(), NOW())`,
              [user.id, leaveTypeInfo.id, balanceHours, allocatedHours, asOfDate]
            );
          }
          insertedCount++;
          
          // Collect sample for summary
          if (successSamples.length < 5) {
            successSamples.push({
              action: 'INSERT',
              user: user.name,
              email: userEmail,
              leaveType: leaveType,
              allocated: allocatedDays,
              balance: balanceDays
            });
          }
          
          if ((processedCount + 1) % 100 === 0) {
            console.log(`Progress: ${processedCount + 1} records processed...`);
          }
        }
        
        processedCount++;
        
      } catch (error) {
        errors.push({
          row: index + 2,
          email: record.userEmail,
          leaveType: record.leaveType,
          error: error.message
        });
        skippedCount++;
      }
    }
    
    // Commit transaction (only if not dry-run)
    if (!isDryRun) {
      await client.query('COMMIT');
      console.log('✓ Transaction committed');
    } else {
      console.log('✓ Dry run completed (no changes made)');
    }
    
    console.log('-'.repeat(80));
    console.log('');
    
    // Print summary
    console.log('='.repeat(80));
    console.log('MIGRATION SUMMARY');
    console.log('='.repeat(80));
    if (isDryRun) {
      console.log('*** DRY RUN MODE - No changes were made ***');
      console.log('');
    }
    console.log(`Total records in CSV: ${records.length}`);
    console.log(`Successfully processed: ${processedCount} (${((processedCount/records.length)*100).toFixed(1)}%)`);
    console.log(`  - Inserted: ${insertedCount}`);
    console.log(`  - Updated: ${updatedCount}`);
    console.log(`Skipped: ${skippedCount}`);
    console.log('');
    
    // Show success samples
    if (successSamples.length > 0) {
      console.log('Sample Success Records:');
      console.log('-'.repeat(80));
      successSamples.forEach((sample, i) => {
        console.log(`${i + 1}. [${sample.action}] ${sample.user} (${sample.email})`);
        console.log(`   Leave Type: ${sample.leaveType}`);
        console.log(`   Allocated: ${sample.allocated} days (${sample.allocated * 8} hours)`);
        console.log(`   Balance: ${sample.balance} days (${sample.balance * 8} hours)`);
        if (sample.action === 'UPDATE') {
          console.log(`   Previous - Allocated: ${sample.previous.allocated} days, Balance: ${sample.previous.balance} days`);
        }
        console.log('');
      });
    }
    
    // Show errors if any
    if (errors.length > 0) {
      console.log('ERRORS/WARNINGS:');
      console.log('-'.repeat(80));
      const errorSummary = {};
      errors.forEach(err => {
        errorSummary[err.error] = (errorSummary[err.error] || 0) + 1;
      });
      
      Object.entries(errorSummary).forEach(([error, count]) => {
        console.log(`${error}: ${count} record(s)`);
      });
      console.log('');
      
      // Show first 10 error details
      console.log('First 10 error details:');
      errors.slice(0, 10).forEach((err, i) => {
        console.log(`${i + 1}. Row ${err.row}: ${err.email} - ${err.leaveType}`);
        console.log(`   Error: ${err.error}`);
      });
      
      if (errors.length > 10) {
        console.log(`... and ${errors.length - 10} more errors`);
      }
      console.log('');
    }
    
    console.log('='.repeat(80));
    console.log('');
    
    // Explain the calculation logic
    console.log('CALCULATION LOGIC:');
    console.log('-'.repeat(80));
    console.log('Initial Migration (this script):');
    console.log('  • allocatedHours = allotedLeaves × 8 (total leave for the year)');
    console.log('  • balanceHours = remainingLeaves × 8 (available balance)');
    console.log('  • pendingHours = 0 (no pending leaves at start)');
    console.log('  • bookedHours = 0 (no booked leaves at start)');
    console.log('');
    console.log('Runtime Calculations (handled by application code in leaves.service.ts):');
    console.log('  When user applies for leave:');
    console.log('    → balanceHours decreases');
    console.log('    → pendingHours increases');
    console.log('  When leave is approved:');
    console.log('    → pendingHours decreases');
    console.log('    → bookedHours increases');
    console.log('  When leave is rejected:');
    console.log('    → pendingHours decreases');
    console.log('    → balanceHours increases');
    console.log('');
    console.log('Formula: allocatedHours = balanceHours + pendingHours + bookedHours');
    console.log('='.repeat(80));
    console.log('');
    
  } catch (error) {
    if (!isDryRun) {
      await client.query('ROLLBACK');
      console.error('✗ Transaction rolled back due to error');
    }
    console.error('\n=== Migration failed ===');
    console.error('Error:', error.message);
    console.error(error.stack);
    throw error;
  } finally {
    client.release();
  }
}

// Run migration
console.log('Starting leave balance migration...');
console.log('');

migrateLeaveBalances()
  .then(() => {
    console.log('Migration completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Review the summary above');
    console.log('2. If using --dry-run, run again without the flag to apply changes');
    console.log('3. Verify the data in the database');
    console.log('4. Test applying for leave in the application');
    console.log('');
    pool.end();
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    pool.end();
    process.exit(1);
  });

