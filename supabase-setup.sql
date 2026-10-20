-- Run this script once in the Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    full_name text not null default '',
    admission_number text,
    role text not null default 'student'
        check (role in ('student', 'teacher', 'admin')),
    requested_role text not null default 'student'
        check (requested_role in ('student', 'teacher')),
    created_at timestamptz not null default now()
);

alter table public.profiles
    add column if not exists requested_role text not null default 'student',
    add column if not exists is_active boolean not null default true;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'profiles_requested_role_check'
          and conrelid = 'public.profiles'::regclass
    ) then
        alter table public.profiles
            add constraint profiles_requested_role_check
            check (requested_role in ('student', 'teacher'));
    end if;
end;
$$;

create unique index if not exists profiles_admission_number_unique
    on public.profiles (admission_number)
    where admission_number is not null and admission_number <> '';

create table if not exists public.submissions (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references auth.users(id) on delete cascade,
    student_name text not null,
    admission_number text not null,
    subject text not null,
    title text not null,
    storage_path text not null,
    file_name text not null,
    file_size bigint not null check (file_size > 0 and file_size <= 15728640),
    status text not null default 'pending'
        check (status in ('pending', 'reviewed')),
    reviewed_by uuid references auth.users(id),
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

create table if not exists public.past_papers (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    subject text not null,
    course text not null,
    exam_body text not null,
    year smallint not null check (year between 1950 and 2100),
    description text not null default '',
    storage_path text not null,
    file_name text not null,
    file_size bigint not null check (file_size > 0 and file_size <= 15728640),
    uploaded_by uuid not null references auth.users(id),
    uploaded_at timestamptz not null default now()
);

create table if not exists public.staff_signup_codes (
    role text primary key check (role in ('teacher', 'admin')),
    code_hash text not null,
    updated_at timestamptz not null default now()
);

-- Change these values before running this script; rerunning it replaces both codes.
insert into public.staff_signup_codes (role, code_hash)
values
    ('teacher', crypt('pass$teacher', gen_salt('bf', 12))),
    ('admin', crypt('pass$admin', gen_salt('bf', 12)))
on conflict (role) do update set
    code_hash = excluded.code_hash,
    updated_at = now();

create index if not exists submissions_student_created_idx
    on public.submissions (student_id, created_at desc);
create index if not exists past_papers_year_idx
    on public.past_papers (year desc);

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select case when is_active then role else null end
    from public.profiles
    where id = auth.uid()
$$;

create or replace function public.verify_staff_signup_code(
    target_role text,
    provided_code text
)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
    select target_role in ('teacher', 'admin')
       and exists (
           select 1
           from public.staff_signup_codes as signup_code
           where signup_code.role = target_role
             and crypt(provided_code, signup_code.code_hash) = signup_code.code_hash
       )
$$;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
    insert into public.profiles (
        id,
        email,
        full_name,
        admission_number,
        role,
        requested_role
    )
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data ->> 'full_name', ''),
        nullif(trim(new.raw_user_meta_data ->> 'admission_number'), ''),
        'student',
        'student'
    );
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.create_profile_for_new_user();

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.profiles
    set email = new.email
    where id = new.id;
    return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
    after update of email on auth.users
    for each row
    when (old.email is distinct from new.email)
    execute procedure public.sync_profile_email();

drop function if exists public.create_admin_invite();
drop table if exists public.admin_invites;

create or replace function public.mark_submission_reviewed(submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if public.current_app_role() is distinct from 'teacher'
       and public.current_app_role() is distinct from 'admin' then
        raise exception 'Only teachers or administrators can review submissions.';
    end if;

    update public.submissions
    set status = 'reviewed',
        reviewed_by = auth.uid(),
        reviewed_at = now()
    where id = submission_id;

    if not found then
        raise exception 'Submission not found.';
    end if;
end;
$$;

drop function if exists public.approve_teacher_request(uuid);

alter table public.profiles enable row level security;
alter table public.staff_signup_codes enable row level security;
alter table public.submissions enable row level security;
alter table public.past_papers enable row level security;

grant select on public.profiles to authenticated;
grant select, insert on public.submissions to authenticated;
grant select, insert, update, delete on public.past_papers to anon, authenticated;

drop policy if exists "Users can read their profile and staff can read all" on public.profiles;
create policy "Users can read their profile and staff can read all"
    on public.profiles for select to authenticated
    using (id = auth.uid() or public.current_app_role() in ('teacher', 'admin'));

drop policy if exists "Students can create their own submissions" on public.submissions;
create policy "Students can create their own submissions"
    on public.submissions for insert to authenticated
    with check (
        student_id = auth.uid()
        and public.current_app_role() = 'student'
        and status = 'pending'
    );

drop policy if exists "Students and staff can read submissions" on public.submissions;
create policy "Students and staff can read submissions"
    on public.submissions for select to authenticated
    using (
        student_id = auth.uid()
        or public.current_app_role() in ('teacher', 'admin')
    );

drop policy if exists "Anyone can read past papers" on public.past_papers;
create policy "Anyone can read past papers"
    on public.past_papers for select to anon, authenticated
    using (true);

drop policy if exists "Administrators can add past papers" on public.past_papers;
create policy "Administrators can add past papers"
    on public.past_papers for insert to authenticated
    with check (public.current_app_role() = 'admin' and uploaded_by = auth.uid());

drop policy if exists "Administrators can update past papers" on public.past_papers;
create policy "Administrators can update past papers"
    on public.past_papers for update to authenticated
    using (public.current_app_role() = 'admin')
    with check (public.current_app_role() = 'admin');

drop policy if exists "Administrators can delete past papers" on public.past_papers;
create policy "Administrators can delete past papers"
    on public.past_papers for delete to authenticated
    using (public.current_app_role() = 'admin');

revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated;
revoke all on function public.verify_staff_signup_code(text, text) from public, anon, authenticated;
grant execute on function public.verify_staff_signup_code(text, text) to service_role;
revoke all on table public.staff_signup_codes from public, anon, authenticated;
revoke all on function public.mark_submission_reviewed(uuid) from public, anon;
grant execute on function public.mark_submission_reviewed(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    ('past-papers', 'past-papers', true, 15728640, array['application/pdf']),
    ('student-submissions', 'student-submissions', false, 15728640, array['application/pdf'])
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can read past paper files" on storage.objects;
create policy "Anyone can read past paper files"
    on storage.objects for select to anon, authenticated
    using (bucket_id = 'past-papers');

drop policy if exists "Administrators can upload past paper files" on storage.objects;
create policy "Administrators can upload past paper files"
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'past-papers'
        and public.current_app_role() = 'admin'
    );

drop policy if exists "Administrators can update past paper files" on storage.objects;
create policy "Administrators can update past paper files"
    on storage.objects for update to authenticated
    using (bucket_id = 'past-papers' and public.current_app_role() = 'admin')
    with check (bucket_id = 'past-papers' and public.current_app_role() = 'admin');

drop policy if exists "Administrators can delete past paper files" on storage.objects;
create policy "Administrators can delete past paper files"
    on storage.objects for delete to authenticated
    using (bucket_id = 'past-papers' and public.current_app_role() = 'admin');

drop policy if exists "Students can upload their own submission files" on storage.objects;
create policy "Students can upload their own submission files"
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'student-submissions'
        and (storage.foldername(name))[1] = auth.uid()::text
        and public.current_app_role() = 'student'
    );

drop policy if exists "Students and staff can read submission files" on storage.objects;
create policy "Students and staff can read submission files"
    on storage.objects for select to authenticated
    using (
        bucket_id = 'student-submissions'
        and (
            (storage.foldername(name))[1] = auth.uid()::text
            or public.current_app_role() in ('teacher', 'admin')
        )
    );

-- Create an administrator account first through Supabase Auth > Users, or
-- register a student account and promote it from the SQL Editor:
-- update public.profiles
-- set role = 'admin', requested_role = 'student'
-- where email = 'admin@email.com';
