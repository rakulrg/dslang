CREATE TABLE admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_own_admin" ON admin_users FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "insert_own_admin" ON admin_users FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "delete_own_admin" ON admin_users FOR DELETE
  TO authenticated USING (auth.uid() = user_id);
