-- Run this in the Supabase SQL editor (or via `supabase db push`) to set up
-- the tables used by the teacher analytics + feedback features.

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  essay_text text not null,
  institution text not null,
  year text not null,
  teacher_name text not null,
  teacher_email text,
  writing_type text not null default 'essay',
  timestamp timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table submissions add column if not exists teacher_email text;
alter table submissions add column if not exists writing_type text not null default 'essay';

create index if not exists submissions_institution_idx on submissions (institution);
create index if not exists submissions_institution_year_idx on submissions (institution, year);
create index if not exists submissions_institution_year_teacher_idx on submissions (institution, year, teacher_name);
create index if not exists submissions_institution_type_idx on submissions (institution, writing_type);

create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  patterns jsonb not null default '[]'::jsonb,
  summary text
);

create index if not exists analyses_submission_id_idx on analyses (submission_id);

-- submission_id is nullable: feedback can be left even when no submission was
-- saved (e.g. institution/teacher name weren't filled in, or the essay was
-- just being tried out).
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid references submissions (id) on delete cascade,
  accurate boolean,
  useful boolean,
  comments text,
  suggestions text,
  created_at timestamptz not null default now()
);

alter table feedback alter column submission_id drop not null;

create index if not exists feedback_submission_id_idx on feedback (submission_id);

-- Binds a (institution, teacher_name) identity to whichever email first
-- submits under that name while signed in. First claim wins — later
-- submissions from a different email don't reassign ownership.
-- institution/teacher_name are stored lowercased+trimmed here for matching;
-- this table is a lookup, not a display source.
create table if not exists teacher_owners (
  institution text not null,
  teacher_name text not null,
  email text not null,
  claimed_at timestamptz not null default now(),
  primary key (institution, teacher_name)
);

alter table submissions enable row level security;
alter table analyses enable row level security;
alter table feedback enable row level security;
alter table teacher_owners enable row level security;
