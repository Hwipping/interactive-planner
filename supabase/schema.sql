-- 영상 제작 기획안의 메타데이터와 이미지 자산을 저장하는 Supabase 스키마

create extension if not exists pgcrypto;

create table if not exists public.planner_projects (
    id uuid primary key default gen_random_uuid(),
    student_name text not null default '',
    title text not null default '새 기획안',
    status text not null default 'working' check (status in ('working', 'complete')),
    password_hash text not null,
    content jsonb not null default '{}'::jsonb,
    cover_asset_path text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '100 days')
);

create table if not exists public.planner_assets (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.planner_projects(id) on delete cascade,
    logical_key text not null,
    kind text not null check (kind in ('reference', 'thumbnail', 'typography', 'youtube-thumbnail')),
    storage_path text not null unique,
    mime_type text not null default 'image/jpeg',
    created_at timestamptz not null default now(),
    unique (project_id, logical_key)
);

create table if not exists public.planner_settings (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
);

create table if not exists public.planner_sessions (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null unique,
    project_id uuid references public.planner_projects(id) on delete cascade,
    role text not null check (role in ('owner', 'admin')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '12 hours')
);

create or replace function public.set_planner_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists planner_projects_updated_at on public.planner_projects;
create trigger planner_projects_updated_at
before update on public.planner_projects
for each row execute function public.set_planner_updated_at();

alter table public.planner_projects enable row level security;
alter table public.planner_assets enable row level security;
alter table public.planner_settings enable row level security;
alter table public.planner_sessions enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'planner-assets',
    'planner-assets',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- 모든 프로젝트 데이터와 파일은 Edge Function을 통해서만 접근한다.
-- 브라우저의 publishable key에는 직접 접근 정책을 부여하지 않는다.

