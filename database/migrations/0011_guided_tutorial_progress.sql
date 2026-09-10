ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS tutorial_role text;

DO $$ BEGIN
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_tutorial_role_check
    CHECK (tutorial_role IS NULL OR tutorial_role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
