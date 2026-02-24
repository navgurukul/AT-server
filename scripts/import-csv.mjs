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
  keepAlive: true, // Keep connection alive
  keepAliveInitialDelayMillis: 10000, // Delay before starting keepalive
});

// Helper function to normalize date to UTC
function normalizeDate(dateString) {
  const date = new Date(dateString);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Helper function to parse hours from workType
function parseHours(workType, totalHoursSpent) {
  if (totalHoursSpent && !isNaN(parseFloat(totalHoursSpent))) {
    return parseFloat(totalHoursSpent);
  }
  
  // Fallback to workType-based calculation
  switch (workType?.toLowerCase()) {
    case 'full-day':
      return 8;
    case 'half-day':
      return 4;
    default:
      return 0;
  }
}

// Process a batch of rows within a transaction
async function processBatch(client, batch, userMap, projectMap, batchNumber) {
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const errors = [];
  
  for (const [index, row] of batch.entries()) {
    try {
      const email = row.email?.trim().toLowerCase();
      const entryDate = row.entryDate?.trim();
      const workDescription = row.workDescription?.trim();
      const projectName = row.projectName?.trim();
      const totalHours = parseHours(row.workType, row.totalHoursSpent);
      
      if (!email || !entryDate) {
        errors.push(`Batch ${batchNumber}, Row ${index + 1}: Missing email or entry date`);
        errorCount++;
        continue;
      }
      
      const user = userMap.get(email);
      if (!user) {
        errors.push(`Batch ${batchNumber}, Row ${index + 1}: User not found for email: ${email}`);
        errorCount++;
        continue;
      }
      
      const workDate = normalizeDate(entryDate);
      const now = new Date();
      
      // Find project (optional - can be null)
      let projectId = null;
      if (projectName) {
        const project = projectMap.get(projectName.toLowerCase());
        if (project && project.orgId === user.orgId) {
          projectId = project.id;
        }
      }
      
      // Check if timesheet already exists for this user and date
      const existingTimesheet = await client.query(
        `SELECT id, state, total_hours FROM timesheets 
         WHERE user_id = $1 AND org_id = $2 AND work_date = $3`,
        [user.id, user.orgId, workDate]
      );
      
      let timesheetId;
      
      if (existingTimesheet.rows.length > 0) {
        timesheetId = existingTimesheet.rows[0].id;
      } else {
        // Create new timesheet
        const insertResult = await client.query(
          `INSERT INTO timesheets 
           (org_id, user_id, work_date, state, total_hours, notes, submitted_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [user.orgId, user.id, workDate, 'submitted', '0', workDescription, workDate, workDate, now]
        );
        
        timesheetId = insertResult.rows[0].id;
      }
      
      // Check if this exact entry already exists (same timesheet, project, description, and hours)
      // This ensures we don't create duplicates when re-running the script
      const duplicateCheck = await client.query(
        `SELECT id FROM timesheet_entries 
         WHERE timesheet_id = $1 
         AND (project_id = $2 OR (project_id IS NULL AND $2 IS NULL))
         AND LOWER(TRIM(task_description)) = LOWER(TRIM($3))
         AND hours_decimal = $4`,
        [timesheetId, projectId, workDescription, totalHours.toString()]
      );
      
      if (duplicateCheck.rows.length > 0) {
        // Entry already exists with exact same data - skip it to avoid duplicates
        // This makes the script idempotent
        skippedCount++;
        continue;
      }
      
      // Entry doesn't exist - create new timesheet entry
      await client.query(
        `INSERT INTO timesheet_entries 
         (org_id, timesheet_id, project_id, task_description, hours_decimal, tags, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [user.orgId, timesheetId, projectId, workDescription, totalHours.toString(), '[]', workDate, now]
      );
      
      // Update total hours for timesheet
      const totalResult = await client.query(
        `SELECT COALESCE(SUM(hours_decimal::numeric), 0) as total 
         FROM timesheet_entries WHERE timesheet_id = $1`,
        [timesheetId]
      );
      
      await client.query(
        `UPDATE timesheets SET total_hours = $1, updated_at = $2 WHERE id = $3`,
        [totalResult.rows[0].total, now, timesheetId]
      );
      
      successCount++;
    } catch (error) {
      errors.push(`Batch ${batchNumber}, Row ${index + 1}: ${error.message}`);
      errorCount++;
    }
  }
  
  return { successCount, errorCount, skippedCount, errors };
}

// Main function to import CSV data with batch processing
async function importCSVData(limit = null, batchSize = 100, startBatch = 1) {
  const results = [];
  let totalRows = 0;
  
  // Test database connection first
  try {
    const testClient = await pool.connect();
    testClient.release();
  } catch (error) {
    throw error;
  }
  
  return new Promise((resolve, reject) => {
    fs.createReadStream('/home/navgurukul/Desktop/AT-server/AT-server/Activity Logs - Sheet1.csv')
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
          
          // Get all projects to map project names/IDs
          const projectsQuery = await pool.query(`SELECT id, name, org_id FROM projects`);
          const projectMap = new Map();
          projectsQuery.rows.forEach(project => {
            if (project.name) {
              projectMap.set(project.name.toLowerCase(), { id: project.id, orgId: project.org_id });
            }
          });
          
          let totalSuccessCount = 0;
          let totalErrorCount = 0;
          let totalSkippedCount = 0;
          const allErrors = [];
          
          // Process in batches
          const numBatches = Math.ceil(results.length / batchSize);
          
          for (let i = startBatch - 1; i < numBatches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, results.length);
            const batch = results.slice(start, end);
            
            let retryCount = 0;
            const maxRetries = 3;
            let batchProcessed = false;
            
            while (!batchProcessed && retryCount < maxRetries) {
              const client = await pool.connect();
              
              try {
                // Begin transaction
                await client.query('BEGIN');
                
                const { successCount, errorCount, skippedCount, errors } = await processBatch(
                  client, 
                  batch, 
                  userMap, 
                  projectMap, 
                  i + 1
                );
                
                // Commit transaction
                await client.query('COMMIT');
                
                totalSuccessCount += successCount;
                totalErrorCount += errorCount;
                totalSkippedCount += skippedCount;
                allErrors.push(...errors);
                
                batchProcessed = true;
                
              } catch (error) {
                // Rollback transaction on error
                await client.query('ROLLBACK');
                
                retryCount++;
                if (retryCount < maxRetries) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                  totalErrorCount += batch.length;
                  allErrors.push(`Batch ${i + 1} completely failed: ${error.message}`);
                  batchProcessed = true;
                }
              } finally {
                client.release();
              }
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

// Run the import with optional limit, batch size, and start batch from command line arguments
// Usage: node import-csv.mjs [limit] [batchSize] [startBatch]
// Example: node import-csv.mjs 10 5      (process only first 10 rows, 5 rows per batch)
// Example: node import-csv.mjs null 500  (process all rows, 500 rows per batch)
// Example: node import-csv.mjs 30000     (process 30000 rows, default 100 rows per batch)
// Example: node import-csv.mjs null 100 37  (process all rows, resume from batch 37)
const limit = process.argv[2] && process.argv[2] !== 'null' ? parseInt(process.argv[2], 10) : null;
const batchSize = process.argv[3] ? parseInt(process.argv[3], 10) : 100;
const startBatch = process.argv[4] ? parseInt(process.argv[4], 10) : 1;

importCSVData(limit, batchSize, startBatch)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
