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
 * Apply rounding logic to leave balance
 * Scenario 1: If user has leave balance, upgrade according to CSV
 * Scenario 2: Apply rounding:
 *   - If balance < 1.5, round down to 1
 *   - If balance >= 1.5 and <= 2, round down to 1.5
 *   - Otherwise, keep the balance as is
 */
function applyRoundingLogic(balance) {
  const balanceNum = parseFloat(balance);
  
  if (isNaN(balanceNum) || balanceNum <= 0) {
    return 0;
  }
  
  // Apply rounding logic for values between 0 and 2
  if (balanceNum > 0 && balanceNum < 1.5) {
    return 1;
  } else if (balanceNum >= 1.5 && balanceNum <= 2) {
    return 1.5;
  }
  
  // For values > 2, keep as is
  return balanceNum;
}

/**
 * Convert leave days to hours (assuming 8 hours per day)
 */
function daysToHours(days) {
  return days * 8;
}

/**
 * Process CSV and migrate leave balances
 */
async function migrateLeaveBalances() {
  const client = await pool.connect();
  
  // Check for dry-run mode
  const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
  
  try {
    
    if (isDryRun) {
    }
    
    
    // Start transaction (only if not dry-run)
    if (!isDryRun) {
      await client.query('BEGIN');
    }
    
    // Build user email to user id map
    const userResult = await client.query(
      'SELECT id, email FROM users WHERE status = $1',
      ['active']
    );
    const userMap = new Map();
    userResult.rows.forEach(row => {
      userMap.set(row.email.toLowerCase().trim(), row.id);
    });
    
    // Build leave type name to leave type id map
    const leaveTypeResult = await client.query(
      'SELECT id, name FROM leave_types'
    );
    const leaveTypeMap = new Map();
    leaveTypeResult.rows.forEach(row => {
      leaveTypeMap.set(row.name.trim(), row.id);
    });
    
    // Read and parse CSV
    const csvFilePath = './Leave-Ballance-2026.csv';
    
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }
    
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
    
    // Process records
    let processedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    let insertedCount = 0;
    let roundedCount = 0;
    const errors = [];
    const roundingExamples = [];
    
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
        
        // Get user ID
        const userId = userMap.get(userEmail);
        if (!userId) {
          skippedCount++;
          errors.push({
            row: index + 2,
            email: userEmail,
            leaveType: leaveType,
            error: 'User not found or not active'
          });
          continue;
        }
        
        // Get leave type ID
        const leaveTypeId = leaveTypeMap.get(leaveType);
        if (!leaveTypeId) {
          skippedCount++;
          errors.push({
            row: index + 2,
            email: userEmail,
            leaveType: leaveType,
            error: 'Leave type not found'
          });
          continue;
        }
        
        // Parse remaining leaves and apply rounding logic
        let balanceDays = parseFloat(remainingLeaves);
        if (isNaN(balanceDays)) {
          balanceDays = 0;
        }
        
        // Apply rounding logic
        const roundedBalance = applyRoundingLogic(balanceDays);
        
        // Track rounding examples for reporting
        if (balanceDays !== roundedBalance && balanceDays > 0 && roundingExamples.length < 10) {
          roundingExamples.push({
            email: userEmail,
            leaveType: leaveType,
            original: balanceDays,
            rounded: roundedBalance
          });
          roundedCount++;
        } else if (balanceDays !== roundedBalance && balanceDays > 0) {
          roundedCount++;
        }
        
        // Convert to hours (assuming 8 hours per day)
        const balanceHours = daysToHours(roundedBalance);
        
        // Get current date as as_of_date
        const asOfDate = new Date().toISOString().split('T')[0];
        
        // Check if leave balance already exists
        const existingBalance = await client.query(
          `SELECT id, balance_hours 
           FROM leave_balances 
           WHERE user_id = $1 AND leave_type_id = $2`,
          [userId, leaveTypeId]
        );
        
        if (existingBalance.rows.length > 0) {
          // Update existing balance
          if (!isDryRun) {
            await client.query(
              `UPDATE leave_balances 
               SET balance_hours = $1,
                   as_of_date = $2,
                   updated_at = NOW(),
                   "updatedAt" = NOW()
               WHERE user_id = $3 AND leave_type_id = $4`,
              [balanceHours, asOfDate, userId, leaveTypeId]
            );
          }
          updatedCount++;
          
        } else {
          // Insert new balance
          if (!isDryRun) {
            await client.query(
              `INSERT INTO leave_balances 
               (user_id, leave_type_id, balance_hours, pending_hours, booked_hours, as_of_date, created_at, updated_at, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, 0, 0, $4, NOW(), NOW(), NOW(), NOW())`,
              [userId, leaveTypeId, balanceHours, asOfDate]
            );
          }
          insertedCount++;
          
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
    }
    
    // Summary processing complete
    
  } catch (error) {
    if (!isDryRun) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

// Run migration
migrateLeaveBalances()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((error) => {
    pool.end();
    process.exit(1);
  });

