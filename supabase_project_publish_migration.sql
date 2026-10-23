-- Online HTML project preflight staging. Apply once to the shared Supabase project.
-- Project source objects stay in a private bucket; browser access is limited to
-- short-lived signed upload/download URLs issued by the authenticated Next API.

create table if not exists public.project_publish_jobs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  current_revision_id uuid not null,
  status text not null check (status in (
    'uploading', 'queued', 'processing', 'needs_repair', 'needs_attention',
    'passed', 'confirmed', 'published', 'failed'
  )),
  work_type text check (work_type in ('scan', 'repair')),
  work_payload jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  error text,
  release_url text,
  release_result jsonb,
  expires_at timestamptz not null,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_publish_revisions (
  id uuid primary key,
  job_id uuid not null references public.project_publish_jobs(id) on delete cascade,
  parent_revision_id uuid references public.project_publish_revisions(id) on delete set null,
  entry_path text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'array'),
  status text not null check (status in (
    'uploading', 'queued', 'processing', 'needs_repair', 'needs_attention', 'passed', 'failed'
  )),
  fingerprint text,
  preflight_report jsonb,
  browser_audit jsonb,
  repair_suggestions jsonb not null default '[]'::jsonb,
  repairs jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists project_publish_jobs_owner_created_idx
  on public.project_publish_jobs(owner_id, created_at desc);
create index if not exists project_publish_jobs_queue_idx
  on public.project_publish_jobs(status, lease_until, created_at)
  where status in ('queued', 'processing');
create index if not exists project_publish_revisions_job_idx
  on public.project_publish_revisions(job_id, created_at);

alter table public.project_publish_jobs enable row level security;
alter table public.project_publish_revisions enable row level security;

drop policy if exists "Users can read their project publish jobs" on public.project_publish_jobs;
create policy "Users can read their project publish jobs"
  on public.project_publish_jobs for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists "Users can read their project publish revisions" on public.project_publish_revisions;
create policy "Users can read their project publish revisions"
  on public.project_publish_revisions for select to authenticated
  using (exists (
    select 1 from public.project_publish_jobs j
    where j.id = project_publish_revisions.job_id and j.owner_id = auth.uid()
  ));

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-publish-staging', 'project-publish-staging', false, 209715200)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Atomically lease a queued job to exactly one worker. A crashed worker's lease
-- expires and the job becomes eligible for another worker.
create or replace function public.claim_project_publish_job(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof public.project_publish_jobs
language sql
security definer
set search_path = public
as $$
  with candidate as (
    select id
    from public.project_publish_jobs
    where status in ('queued', 'processing')
      and expires_at > now()
      and (lease_until is null or lease_until < now())
    order by created_at
    for update skip locked
    limit 1
  )
  update public.project_publish_jobs j
  set status = 'processing',
      lease_owner = p_worker_id,
      lease_until = now() + make_interval(secs => greatest(60, least(p_lease_seconds, 1800))),
      updated_at = now()
  from candidate c
  where j.id = c.id
  returning j.*;
$$;

revoke all on function public.claim_project_publish_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_project_publish_job(text, integer) to service_role;

grant select on public.project_publish_jobs, public.project_publish_revisions to authenticated;
grant all on public.project_publish_jobs, public.project_publish_revisions to service_role;
revoke insert, update, delete, truncate, references, trigger on public.project_publish_jobs, public.project_publish_revisions from anon, authenticated;
grant select on public.project_publish_jobs, public.project_publish_revisions to authenticated;

-- Atomically queue a scan/repair only when the caller observed an eligible
-- state. This prevents the worker racing a two-step API update.
create or replace function public.enqueue_project_publish_job(
  p_job_id uuid,
  p_owner_id uuid,
  p_work_type text,
  p_work_payload jsonb default '{}'::jsonb,
  p_expected_statuses text[] default array['needs_repair', 'needs_attention', 'failed']
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revision_id uuid;
begin
  if p_work_type not in ('scan', 'repair') then
    raise exception 'invalid work type';
  end if;

  update public.project_publish_jobs
  set status = 'queued',
      work_type = p_work_type,
      work_payload = coalesce(p_work_payload, '{}'::jsonb),
      progress = jsonb_build_object('phase', 'queued', 'completed', 0, 'total', 0),
      lease_owner = null,
      lease_until = null,
      error = null,
      updated_at = now()
  where id = p_job_id
    and owner_id = p_owner_id
    and status = any(p_expected_statuses)
    and expires_at > now()
  returning current_revision_id into v_revision_id;

  if not found then return false; end if;

  update public.project_publish_revisions
  set status = 'queued', error = null
  where id = v_revision_id and job_id = p_job_id;

  if not found then raise exception 'current project revision not found'; end if;
  return true;
end;
$$;

revoke all on function public.enqueue_project_publish_job(uuid, uuid, text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.enqueue_project_publish_job(uuid, uuid, text, jsonb, text[]) to service_role;

-- Persist the scan result and release the worker lease in one transaction.
-- A worker whose lease was reclaimed cannot publish a stale result.
create or replace function public.complete_project_publish_scan(
  p_job_id uuid,
  p_worker_id text,
  p_revision_id uuid,
  p_status text,
  p_fingerprint text,
  p_preflight_report jsonb,
  p_browser_audit jsonb,
  p_repair_suggestions jsonb,
  p_warnings jsonb,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('passed', 'needs_repair', 'needs_attention') then
    raise exception 'invalid scan result status';
  end if;

  update public.project_publish_jobs
  set status = p_status,
      work_type = null,
      work_payload = '{}'::jsonb,
      progress = jsonb_build_object('phase', p_status, 'completed', 1, 'total', 1),
      lease_owner = null,
      lease_until = null,
      error = p_error,
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and lease_owner = p_worker_id
    and current_revision_id = p_revision_id;

  if not found then return false; end if;

  update public.project_publish_revisions
  set status = p_status,
      fingerprint = p_fingerprint,
      preflight_report = p_preflight_report,
      browser_audit = p_browser_audit,
      repair_suggestions = coalesce(p_repair_suggestions, '[]'::jsonb),
      warnings = coalesce(p_warnings, '[]'::jsonb),
      error = p_error
  where id = p_revision_id and job_id = p_job_id;

  if not found then raise exception 'project revision not found'; end if;
  return true;
end;
$$;

revoke all on function public.complete_project_publish_scan(uuid, text, uuid, text, text, jsonb, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_project_publish_scan(uuid, text, uuid, text, text, jsonb, jsonb, jsonb, jsonb, text) to service_role;
