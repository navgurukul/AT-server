import fs from 'fs';
import { parse } from 'csv-parse';
import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Pool } = pg;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
});

// Helper function to generate a unique code from project name
function generateProjectCode(name, existingCodes) {
  // Remove special characters and convert to uppercase
  let baseCode = name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .map(word => word.substring(0, 3))
    .join('')
    .toUpperCase()
    .substring(0, 30);

  // If code is empty, use a default
  if (!baseCode) {
    baseCode = 'PROJ';
  }

  // Check if code exists, if yes, append a number
  let code = baseCode;
  let counter = 1;
  while (existingCodes.has(code)) {
    code = `${baseCode}${counter}`;
    counter++;
  }

  existingCodes.add(code);
  return code;
}

// Helper function to extract Discord channel ID from webhook URL
function extractDiscordChannelId(webhookUrl) {
  if (!webhookUrl || webhookUrl === 'N/A') return null;
  
  // Discord webhook URL format: https://discord.com/api/webhooks/{channel_id}/{token}
  const match = webhookUrl.match(/\/webhooks\/(\d+)\//);
  return match ? match[1] : null;
}

// Helper function to normalize status
function normalizeStatus(status) {
  if (!status || status === 'N/A') return 'active';
  
  const normalized = status.toLowerCase().trim();
  if (normalized === 'active') return 'active';
  if (normalized === 'inactive' || normalized === 'inActive') return 'inactive';
  
  return 'active'; // default
}

// Main import function
async function importProjects() {
  const client = await pool.connect();
  
  try {
    console.log('Starting project import...\n');
    
    // Get orgId (assuming default org is 1, or fetch from environment)
    const orgId = parseInt(process.env.ORG_ID || '1', 10);
    console.log(`Using org_id: ${orgId}\n`);
    
    // Load existing departments
    const departmentsResult = await client.query(
      'SELECT id, name, org_id FROM departments WHERE org_id = $1',
      [orgId]
    );
    
    const departmentMap = new Map();
    for (const dept of departmentsResult.rows) {
      departmentMap.set(dept.name.toLowerCase().trim(), dept);
    }
    console.log(`Loaded ${departmentMap.size} existing departments\n`);
    
    // Load existing users
    const usersResult = await client.query(
      'SELECT id, email, org_id FROM users WHERE org_id = $1',
      [orgId]
    );
    
    const userMap = new Map();
    for (const user of usersResult.rows) {
      userMap.set(user.email.toLowerCase().trim(), user);
    }
    console.log(`Loaded ${userMap.size} existing users\n`);
    
    // Load existing projects
    const projectsResult = await client.query(
      `SELECT p.id, p.name, p.code, p.department_id, d.name as department_name 
       FROM projects p
       JOIN departments d ON p.department_id = d.id
       WHERE p.org_id = $1`,
      [orgId]
    );
    
    const existingProjects = new Map();
    const existingCodes = new Set();
    
    for (const project of projectsResult.rows) {
      const key = `${project.name.toLowerCase().trim()}|${project.department_name.toLowerCase().trim()}`;
      existingProjects.set(key, project);
      existingCodes.add(project.code);
    }
    console.log(`Loaded ${existingProjects.size} existing projects\n`);
    
    // Read and parse CSV
    const csvFilePath = './Projects-list';
    const fileContent = fs.readFileSync(csvFilePath, 'utf-8');
    
    const records = await new Promise((resolve, reject) => {
      parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      }, (err, records) => {
        if (err) reject(err);
        else resolve(records);
      });
    });
    
    console.log(`Parsed ${records.length} records from CSV\n`);
    console.log('Starting migration...\n');
    
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];
    
    await client.query('BEGIN');
    
    for (const [index, row] of records.entries()) {
      try {
        const projectName = row.projectName?.trim();
        const departmentName = row.department?.trim();
        const projectManagerEmail = row.projectMasterEmail?.trim()?.toLowerCase();
        const slackChannelId = row.channelId?.trim();
        const discordWebhook = row.discordWebhook?.trim();
        const status = normalizeStatus(row.projectStatus);
        const createdAt = row.createdAt ? new Date(row.createdAt) : new Date();
        const updatedAt = row.updatedAt ? new Date(row.updatedAt) : new Date();
        
        // Validate required fields
        if (!projectName) {
          errors.push(`Row ${index + 1}: Missing project name`);
          errorCount++;
          continue;
        }
        
        if (!departmentName) {
          errors.push(`Row ${index + 1}: Missing department for project "${projectName}"`);
          errorCount++;
          continue;
        }
        
        if (!projectManagerEmail) {
          errors.push(`Row ${index + 1}: Missing project manager email for project "${projectName}"`);
          errorCount++;
          continue;
        }
        
        // Check if project already exists (by name and department)
        const projectKey = `${projectName.toLowerCase()}|${departmentName.toLowerCase()}`;
        if (existingProjects.has(projectKey)) {
          console.log(`⏭️  Skipping: "${projectName}" (already exists in department "${departmentName}")`);
          skippedCount++;
          continue;
        }
        
        // Get or create department
        let department = departmentMap.get(departmentName.toLowerCase());
        if (!department) {
          const deptCode = departmentName
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .trim()
            .split(/\s+/)
            .map(word => word.substring(0, 2))
            .join('')
            .toUpperCase()
            .substring(0, 20);
          
          const deptResult = await client.query(
            `INSERT INTO departments (org_id, name, code, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, org_id`,
            [orgId, departmentName, deptCode, new Date(), new Date()]
          );
          
          department = deptResult.rows[0];
          departmentMap.set(departmentName.toLowerCase(), department);
          console.log(`✨ Created new department: "${departmentName}"`);
        }
        
        // Get project manager
        const projectManager = userMap.get(projectManagerEmail);
        if (!projectManager) {
          errors.push(`Row ${index + 1}: Project manager not found for email "${projectManagerEmail}" (project: "${projectName}")`);
          errorCount++;
          continue;
        }
        
        // Generate unique project code
        const projectCode = generateProjectCode(projectName, existingCodes);
        
        // Parse budget
        let budgetAmountMinor = null;
        if (row.projectBudget && row.projectBudget !== 'N/A' && !isNaN(parseFloat(row.projectBudget))) {
          budgetAmountMinor = Math.round(parseFloat(row.projectBudget) * 100).toString();
        }
        
        // Extract discord channel ID
        const discordChannelId = extractDiscordChannelId(discordWebhook);
        
        // Insert project
        await client.query(
          `INSERT INTO projects 
           (org_id, department_id, project_manager_id, name, code, status, 
            budget_amount_minor, slack_channel_id, discord_channel_id, 
            created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            orgId,
            department.id,
            projectManager.id,
            projectName,
            projectCode,
            status,
            budgetAmountMinor,
            slackChannelId === 'N/A' ? null : slackChannelId,
            discordChannelId,
            createdAt,
            updatedAt
          ]
        );
        
        console.log(`✅ Imported: "${projectName}" (Department: "${departmentName}", Code: "${projectCode}")`);
        successCount++;
        
      } catch (err) {
        errors.push(`Row ${index + 1}: ${err.message}`);
        errorCount++;
      }
    }
    
    await client.query('COMMIT');
    
    console.log('\n' + '='.repeat(60));
    console.log('IMPORT SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total records:     ${records.length}`);
    console.log(`✅ Successfully imported: ${successCount}`);
    console.log(`⏭️  Skipped (already exist): ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log('='.repeat(60));
    
    if (errors.length > 0) {
      console.log('\nERRORS:');
      errors.forEach(err => console.log(`  - ${err}`));
    }
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fatal error during import:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the import
importProjects()
  .then(() => {
    console.log('\n✨ Import completed!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Import failed:', err);
    process.exit(1);
  });
