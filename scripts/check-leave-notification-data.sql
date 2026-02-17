-- Check if users have Slack/Discord IDs populated
SELECT 
  id,
  name,
  email,
  slack_id,
  discord_id,
  manager_id
FROM users
WHERE id IN (
  SELECT DISTINCT user_id FROM leave_requests 
  ORDER BY created_at DESC 
  LIMIT 5
);

-- Check latest leave requests
SELECT 
  lr.id,
  lr.user_id,
  u.name as user_name,
  u.slack_id as user_slack_id,
  lt.name as leave_type_name,
  lr.start_date,
  lr.end_date,
  lr.state,
  lr.created_at
FROM leave_requests lr
JOIN users u ON lr.user_id = u.id
JOIN leave_types lt ON lr.leave_type_id = lt.id
ORDER BY lr.created_at DESC
LIMIT 5;

-- Check project manager info for latest project
SELECT 
  p.id as project_id,
  p.name as project_name,
  p.slack_channel_id,
  p.discord_channel_id,
  p.project_manager_id,
  pm.name as project_manager_name,
  pm.slack_id as pm_slack_id,
  pm.discord_id as pm_discord_id
FROM timesheets t
JOIN timesheet_entries te ON t.id = te.timesheet_id
JOIN projects p ON te.project_id = p.id
JOIN users pm ON p.project_manager_id = pm.id
WHERE t.user_id = (SELECT user_id FROM leave_requests ORDER BY created_at DESC LIMIT 1)
ORDER BY t.work_date DESC
LIMIT 1;

-- Check pending leave notifications (these will be sent next)
SELECT 
  id,
  channel,
  template,
  payload->>'userName' as user_name,
  payload->>'leaveTypeName' as leave_type,
  payload->>'projectManagerName' as pm_name,
  payload->>'userSlackId' as user_slack_id,
  payload->>'projectManagerSlackId' as pm_slack_id,
  state,
  created_at
FROM notifications
WHERE template = 'leave_request'
  AND state = 'pending'
ORDER BY created_at DESC
LIMIT 10;
