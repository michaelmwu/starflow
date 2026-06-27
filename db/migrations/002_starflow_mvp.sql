CREATE TABLE IF NOT EXISTS brain_dumps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  raw_text text NOT NULL,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  emotional_tone text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brain_dumps_user_created_idx
  ON brain_dumps(user_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  brain_dump_id uuid REFERENCES brain_dumps(id) ON DELETE SET NULL,
  title text NOT NULL,
  why_it_matters text,
  status text NOT NULL DEFAULT 'open',
  encouragement text,
  emotional_tone text,
  other_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_user_status_created_idx
  ON tasks(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_steps_task_position_idx
  ON task_steps(task_id, position);

DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
