import fs from 'fs';
import { parse } from 'csv-parse';
import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Pool } = pg;

// Database connection with optimized pool settings for large data migrations
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
  statement_timeout: 60000, // Query timeout in milliseconds (60 seconds)
});

// Helper function to normalize date to UTC timestamp
function normalizeTimestamp(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  return isNaN(date.getTime()) ? null : date;
}

// Helper function to normalize date to UTC date only
function normalizeDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Helper function to calculate hours from duration
function calculateHours(leaveDuration, durationType, halfDayStatus) {
  // First try to use leaveDuration if it's a valid number
  if (leaveDuration && !isNaN(parseFloat(leaveDuration))) {
    const duration = parseFloat(leaveDuration);
    // Assuming full day = 8 hours, so multiply by 8
    return duration * 8;
  }
  
  // Fallback to durationType
  if (durationType === 'half-day') {
    return 4;
  } else if (durationType === 'full-day') {
    return 8;
  }
  
  return 8; // default to full day
}

// Helper function to map duration type
function mapDurationType(durationType, halfDayStatus) {
  if (durationType === 'half-day') {
    return 'half_day';
  } else if (durationType === 'full-day') {
    return 'full_day';
  }
  return 'full_day'; // default
}

// Helper function to map half day segment
function mapHalfDaySegment(halfDayStatus) {
  if (!halfDayStatus) return null;
  if (halfDayStatus === 'first-half') return 'first_half';
  if (halfDayStatus === 'second-half') return 'second_half';
  return null;
}

// Helper function to map leave state
function mapLeaveState(status) {
  const statusLower = status?.toLowerCase();
  if (statusLower === 'approved') return 'approved';
  if (statusLower === 'rejected') return 'rejected';
  if (statusLower === 'pending') return 'pending';
  return 'pending'; // default
}

// Process a batch of rows within a transaction
async function processBatch(client, batch, userMap, leaveTypeMap, batchNumber) {
  let successCount = 0;
  let errorCount = 0;
  const errors = [];
  
  for (const [index, row] of batch.entries()) {
    try {
      const userEmail = row.userEmail?.trim().toLowerCase();
      const leaveType = row.leaveType?.trim();
      const approverEmail = row.approverEmail?.trim().toLowerCase();
      const status = row.status?.trim();
      const durationType = row.durationType?.trim();
      const halfDayStatus = row.halfDayStatus?.trim();
      const leaveDuration = row.leaveDuration?.trim();
      const startDate = row.startDate?.trim();
      const endDate = row.endDate?.trim();
      const leaveApplyDate = row.leaveApplyDate?.trim();
      const approvalDate = row.approvalDate?.trim();
      const reasonForLeave = row.reasonForLeave?.trim();
      
      if (!userEmail || !startDate || !endDate) {
        errors.push(`Batch ${batchNumber}, Row ${index + 1}: Missing required fields (userEmail, startDate, endDate)`);
        errorCount++;
        continue;
      }
      
      // Get user
      const user = userMap.get(userEmail);
      if (!user) {
        errors.push(`Batch ${batchNumber}, Row ${index + 1}: User not found for email: ${userEmail}`);
        errorCount++;
        continue;
      }
      
      // Get leave type
      const leaveTypeRecord = leaveTypeMap.get(leaveType?.toLowerCase());
      if (!leaveTypeRecord) {
        errors.push(`Batch ${batchNumber}, Row ${index + 1}: Leave type not found: ${leaveType}`);
        errorCount++;
        continue;
      }
      
      // Get approver if available
      let decidedByUserId = null;
      if (approverEmail && status === 'approved') {
        const approver = userMap.get(approverEmail);
        if (approver) {
          decidedByUserId = approver.id;
        }
      }
      
      // Parse dates
      const startDateTime = normalizeTimestamp(startDate);
      const endDateTime = normalizeTimestamp(endDate);
      const requestedAt = normalizeTimestamp(leaveApplyDate) || new Date();
      const updatedAt = approvalDate ? normalizeTimestamp(approvalDate) : requestedAt;
      
      if (!startDateTime || !endDateTime) {
        errors.push(`Batch ${batchNumber}, Row ${index + 1}: Invalid date format`);
        errorCount++;
        continue;
      }
      
      // Calculate hours
      const hours = calculateHours(leaveDuration, durationType, halfDayStatus);
      
      // Map fields
      const mappedDurationType = mapDurationType(durationType, halfDayStatus);
      const halfDaySegment = mapHalfDaySegment(halfDayStatus);
      const state = mapLeaveState(status);
      
      // Check if leave request already exists (based on user, dates, and leave type)
      const existingLeave = await client.query(
        `SELECT id FROM leave_requests 
         WHERE user_id = $1 AND start_date = $2 AND end_date = $3 AND leave_type_id = $4`,
        [user.id, startDateTime, endDateTime, leaveTypeRecord.id]
      );
      
      if (existingLeave.rows.length > 0) {
        // Update existing leave request
        const updateFields = [
          `duration_type = $1`,
          `half_day_segment = $2`,
          `hours = $3`,
          `reason = $4`,
          `state = $5`,
          `updated_at = $6`
        ];
        const updateValues = [
          mappedDurationType,
          halfDaySegment,
          hours.toString(),
          reasonForLeave,
          state,
          updatedAt,
        ];
        
        if (decidedByUserId) {
          updateFields.push(`decided_by_user_id = $${updateValues.length + 1}`);
          updateValues.push(decidedByUserId);
        }
        
        updateValues.push(existingLeave.rows[0].id);
        
        await client.query(
          `UPDATE leave_requests SET ${updateFields.join(', ')} WHERE id = $${updateValues.length}`,
          updateValues
        );
      } else {
        // Insert new leave request
        await client.query(
          `INSERT INTO leave_requests 
           (org_id, user_id, leave_type_id, start_date, end_date, duration_type, 
            half_day_segment, hours, reason, state, created_at, requested_at, 
            decided_by_user_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            user.orgId,
            user.id,
            leaveTypeRecord.id,
            startDateTime,
            endDateTime,
            mappedDurationType,
            halfDaySegment,
            hours.toString(),
            reasonForLeave,
            state,
            requestedAt,
            requestedAt,
            decidedByUserId,
            updatedAt,
          ]
        );
      }
      
      successCount++;
    } catch (error) {
      errors.push(`Batch ${batchNumber}, Row ${index + 1}: ${error.message}`);
      errorCount++;
    }
  }
  
  return { successCount, errorCount, errors };
}

// Main function to import CSV data with batch processing
async function importLeaveHistory(csvFilePath, limit = null, batchSize = 100) {
  const results = [];
  let totalRows = 0;
  
  // Check if CSV file exists
  if (!fs.existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }
  
  // Test database connection first
  try {
    const testClient = await pool.connect();
    testClient.release();
  } catch (error) {
    throw error;
  }
  
  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (data) => {
        totalRows++;
        if (!limit || results.length < limit) {
          results.push(data);
        }
      })
      .on('end', async () => {
        
        try {
          // Get all users from database to map emails to user IDs
          const usersQuery = await pool.query(`SELECT id, email, org_id FROM users`);
          const userMap = new Map();
          usersQuery.rows.forEach(user => {
            userMap.set(user.email.toLowerCase(), { id: user.id, orgId: user.org_id });
          });
          
          // Get all leave types to map leave type names to IDs
          const leaveTypesQuery = await pool.query(`SELECT id, name, org_id FROM leave_types`);
          const leaveTypeMap = new Map();
          leaveTypesQuery.rows.forEach(leaveType => {
            if (leaveType.name) {
              leaveTypeMap.set(leaveType.name.toLowerCase(), { 
                id: leaveType.id, 
                orgId: leaveType.org_id 
              });
            }
          });
          
          // Print available leave types for debugging
          
          let totalSuccessCount = 0;
          let totalErrorCount = 0;
          const allErrors = [];
          
          // Process in batches
          const numBatches = Math.ceil(results.length / batchSize);
          
          for (let i = 0; i < numBatches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, results.length);
            const batch = results.slice(start, end);
            
            const client = await pool.connect();
            
            try {
              // Begin transaction
              await client.query('BEGIN');
              
              const { successCount, errorCount, errors } = await processBatch(
                client, 
                batch, 
                userMap, 
                leaveTypeMap, 
                i + 1
              );
              
              // Commit transaction
              await client.query('COMMIT');
              
              totalSuccessCount += successCount;
              totalErrorCount += errorCount;
              allErrors.push(...errors);
              
            } catch (error) {
              // Rollback transaction on error
              await client.query('ROLLBACK');
              totalErrorCount += batch.length;
              allErrors.push(`Batch ${i + 1} completely failed: ${error.message}`);
            } finally {
              client.release();
            }
            
            // Add a small delay between batches to avoid overwhelming the database
            if (i < numBatches - 1) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          
          resolve();
        } catch (error) {
          reject(error);
        }
      })
      .on('error', reject);
  });
}

// Run the import with optional limit and batch size from command line arguments
// Usage: node import-leave-history.mjs <csvFilePath> [limit] [batchSize]
// Example: node import-leave-history.mjs leaveHistory1janto23feb.csv 10 5      (process only first 10 rows, 5 rows per batch)
// Example: node import-leave-history.mjs Leave-Request-History.csv null 500    (process all rows, 500 rows per batch)
// Example: node import-leave-history.mjs leaveHistory1janto23feb.csv 30        (process 30 rows, default 100 rows per batch)

const csvFilePath = process.argv[2];
const limit = process.argv[3] && process.argv[3] !== 'null' ? parseInt(process.argv[3], 10) : null;
const batchSize = process.argv[4] ? parseInt(process.argv[4], 10) : 100;

if (!csvFilePath) {
  process.exit(1);
}

importLeaveHistory(csvFilePath, limit, batchSize)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
