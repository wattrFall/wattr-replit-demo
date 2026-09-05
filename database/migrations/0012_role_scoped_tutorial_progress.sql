CREATE TABLE IF NOT EXISTS user_tutorial_progress (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  tutorial_step integer NOT NULL DEFAULT 0 CHECK (tutorial_step >= 0),
  tutorial_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_tutorial_progress (user_id, role, tutorial_step, tutorial_complete, updated_at)
SELECT user_id, tutorial_role, tutorial_step, tutorial_complete, updated_at
FROM user_preferences
WHERE tutorial_role IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;