-- Older local databases may still contain sequence_no from the removed
-- temporal-message migration. The current runtime orders messages by the
-- existing timestamps/ids and does not write this legacy column. Keep the
-- historical values, but do not require new runtime inserts to provide it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'messages'
      AND column_name = 'sequence_no'
  ) THEN
    ALTER TABLE messages ALTER COLUMN sequence_no DROP NOT NULL;
  END IF;
END
$$;
