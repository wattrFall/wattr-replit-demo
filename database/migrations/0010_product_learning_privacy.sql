-- Converge early product-learning tables on structured qualitative codes.
ALTER TABLE operator_test_sessions ADD COLUMN IF NOT EXISTS abandonment_code text;
ALTER TABLE operator_test_sessions ADD COLUMN IF NOT EXISTS qualitative_feedback_code text;
ALTER TABLE operator_test_sessions DROP COLUMN IF EXISTS abandonment_reason;
ALTER TABLE operator_test_sessions DROP COLUMN IF EXISTS qualitative_feedback;
ALTER TABLE operator_test_sessions DROP CONSTRAINT IF EXISTS operator_test_sessions_abandonment_code_check;
ALTER TABLE operator_test_sessions ADD CONSTRAINT operator_test_sessions_abandonment_code_check
  CHECK (abandonment_code IS NULL OR abandonment_code IN (
    'NAVIGATION_FRICTION','UNCLEAR_FORECAST','UNCLEAR_RECOMMENDATION',
    'PERMISSION_BLOCK','TECHNICAL_ERROR','MODERATOR_ENDED','OTHER'
  ));
ALTER TABLE operator_test_sessions DROP CONSTRAINT IF EXISTS operator_test_sessions_qualitative_feedback_code_check;
ALTER TABLE operator_test_sessions ADD CONSTRAINT operator_test_sessions_qualitative_feedback_code_check
  CHECK (qualitative_feedback_code IS NULL OR qualitative_feedback_code IN (
    'CLEAR','PARTLY_CLEAR','UNCLEAR','TOO_SLOW','MISSING_CONTEXT','OTHER'
  ));

ALTER TABLE product_feedback ADD COLUMN IF NOT EXISTS feedback_code text;
UPDATE product_feedback SET feedback_code = 'OTHER' WHERE feedback_code IS NULL;
ALTER TABLE product_feedback ALTER COLUMN feedback_code SET NOT NULL;
ALTER TABLE product_feedback DROP COLUMN IF EXISTS comment;
ALTER TABLE product_feedback DROP CONSTRAINT IF EXISTS product_feedback_feedback_code_check;
ALTER TABLE product_feedback ADD CONSTRAINT product_feedback_feedback_code_check
  CHECK (feedback_code IN ('HELPFUL','UNCLEAR','MISSING_CONTEXT','TOO_SLOW','UNEXPECTED_RESULT','OTHER'));

CREATE INDEX IF NOT EXISTS product_learning_events_expiry_idx ON product_learning_events(expires_at);
CREATE INDEX IF NOT EXISTS operator_test_sessions_expiry_idx ON operator_test_sessions(expires_at);
CREATE INDEX IF NOT EXISTS product_feedback_expiry_idx ON product_feedback(expires_at);
CREATE INDEX IF NOT EXISTS product_learning_errors_expiry_idx ON product_learning_errors(expires_at);