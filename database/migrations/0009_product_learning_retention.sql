-- Early development builds briefly made sparse learning rows trigger-immutable.
-- Retention expiry and user-deletion cascades must remain possible.
DROP TRIGGER IF EXISTS product_learning_events_immutable ON product_learning_events;
DROP TRIGGER IF EXISTS product_feedback_immutable ON product_feedback;
DROP TRIGGER IF EXISTS product_learning_errors_immutable ON product_learning_errors;
DROP FUNCTION IF EXISTS reject_product_learning_mutation();