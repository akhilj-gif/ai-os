-- M8: approvals answerable from notification (blueprint §M8). Notifications gain
-- a meta ref so an approval notification can carry {taskId, stepId} and the UI
-- can render approve/reject inline. Generic — future notification kinds can use it.
ALTER TABLE notifications ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
CREATE INDEX notifications_meta_step_idx ON notifications ((meta->>'stepId')) WHERE meta->>'stepId' IS NOT NULL;
