-- Metric Outreach Tables
-- Run in Supabase SQL editor

create table if not exists metric_leads (
  id uuid primary key default gen_random_uuid(),
  business text not null,
  phone text,
  email text,
  website text,
  city text,
  source text default 'apify',
  status text default 'new',
  -- enrichment
  score integer,
  score_reason text,
  website_snippet text,
  -- sequence tracking
  sequence_step integer default 0,
  last_contacted timestamptz,
  reply_text text,
  -- meta
  created_at timestamptz default now(),
  unique(business, city)
);

create table if not exists metric_sequences (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references metric_leads(id) on delete cascade,
  step integer not null,
  subject text not null,
  body text not null,
  status text default 'pending',
  sent_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists metric_system_health (
  agent_name text primary key,
  last_run timestamptz,
  last_run_date text,
  status text default 'ok',
  emails_sent_today integer default 0
);

-- Weekly report snapshots — stores raw metrics per week for Claude synthesis
create table if not exists weekly_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  metrics jsonb not null,
  created_at timestamptz default now()
);
