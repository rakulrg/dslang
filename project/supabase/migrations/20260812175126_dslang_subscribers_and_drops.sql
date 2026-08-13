/*
# Subscribers and Drop Announcements

## What this does
1. Creates a `subscribers` table — every non-admin user who signs up is stored here
   with their email and subscription preferences (drop alerts, restock alerts, etc).
2. Creates a `drop_announcements` table — admin can post announcements about new
   drops, restocks, or brand news. These are shown on the subscriber dashboard.
3. Creates an `announcement_reads` table — tracks which announcements each
   subscriber has read.

## New Tables

### subscribers
- id (uuid, PK, defaults to auth.uid())
- email (text, unique)
- wants_drop_alerts (bool, default true)
- wants_restock_alerts (bool, default true)
- wants_general_news (bool, default false)
- created_at (timestamptz)

### drop_announcements
- id (uuid, PK)
- title (text)
- body (text)
- type (text: 'drop' | 'restock' | 'news')
- product_slug (text, nullable — link to a product if relevant)
- is_pinned (bool, default false — pinned to top)
- goes_live_at (timestamptz, default now() — when it becomes visible)
- created_at (timestamptz)

### announcement_reads
- id (uuid, PK)
- announcement_id (uuid, FK to drop_announcements)
- subscriber_id (uuid, FK to subscribers)
- read_at (timestamptz)
- Unique constraint on (announcement_id, subscriber_id)

## Security
- subscribers: owner-scoped CRUD (each user sees only their own row)
- drop_announcements: public read, authenticated write
- announcement_reads: owner-scoped read and insert
*/

-- Subscribers table
CREATE TABLE IF NOT EXISTS subscribers (
  id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  wants_drop_alerts boolean NOT NULL DEFAULT true,
  wants_restock_alerts boolean NOT NULL DEFAULT true,
  wants_general_news boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_subscriber" ON subscribers;
CREATE POLICY "select_own_subscriber"
ON subscribers FOR SELECT TO authenticated
USING (auth.uid() = id);

DROP POLICY IF EXISTS "insert_own_subscriber" ON subscribers;
CREATE POLICY "insert_own_subscriber"
ON subscribers FOR INSERT TO authenticated
WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "update_own_subscriber" ON subscribers;
CREATE POLICY "update_own_subscriber"
ON subscribers FOR UPDATE TO authenticated
USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Drop announcements table
CREATE TABLE IF NOT EXISTS drop_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  type text NOT NULL DEFAULT 'drop' CHECK (type IN ('drop', 'restock', 'news')),
  product_slug text,
  is_pinned boolean NOT NULL DEFAULT false,
  goes_live_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE drop_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_announcements" ON drop_announcements;
CREATE POLICY "public_read_announcements"
ON drop_announcements FOR SELECT TO anon, authenticated
USING (goes_live_at <= now());

DROP POLICY IF EXISTS "admin_insert_announcements" ON drop_announcements;
CREATE POLICY "admin_insert_announcements"
ON drop_announcements FOR INSERT TO authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "admin_update_announcements" ON drop_announcements;
CREATE POLICY "admin_update_announcements"
ON drop_announcements FOR UPDATE TO authenticated
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_announcements" ON drop_announcements;
CREATE POLICY "admin_delete_announcements"
ON drop_announcements FOR DELETE TO authenticated
USING (true);

-- Announcement reads table
CREATE TABLE IF NOT EXISTS announcement_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES drop_announcements(id) ON DELETE CASCADE,
  subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, subscriber_id)
);

ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_reads" ON announcement_reads;
CREATE POLICY "select_own_reads"
ON announcement_reads FOR SELECT TO authenticated
USING (auth.uid() = subscriber_id);

DROP POLICY IF EXISTS "insert_own_reads" ON announcement_reads;
CREATE POLICY "insert_own_reads"
ON announcement_reads FOR INSERT TO authenticated
WITH CHECK (auth.uid() = subscriber_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_announcements_created ON drop_announcements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_sub ON announcement_reads(subscriber_id);
