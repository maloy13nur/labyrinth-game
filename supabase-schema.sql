-- ═══════════════════════════════════════════════════════════════════════════
--  РУПОР — схема базы для Supabase
--  Вставьте целиком в Supabase → SQL Editor → Run.
--  Скрипт безопасно запускать повторно.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── ПРОФИЛИ ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null,
  display_name text not null,
  color        text,
  created_at   timestamptz not null default now()
);

-- Имя пользователя уникально без учёта регистра.
create unique index if not exists profiles_username_lower
  on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "profiles readable by signed in" on public.profiles;
create policy "profiles readable by signed in"
  on public.profiles for select
  to authenticated using (true);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
  on public.profiles for insert
  to authenticated with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles for update
  to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Старое имя нужно, если регистрация оборвалась между созданием аккаунта и
-- записью профиля: аккаунт цел, профиля нет, и приложение не может его
-- достроить само — оно не знает, каким именем человек регистрировался.
-- Функция отдаёт имя самому пользователю и только его; снаружи вместо неё
-- доступен обычный просмотр профилей.
create or replace function public.my_username()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select split_part(email, '@', 1) from auth.users where id = auth.uid();
$$;

-- ── ДРУЗЬЯ ─────────────────────────────────────────────────────────────────
-- Одна строка на пару. pending — заявка отправлена, accepted — друзья.
create table if not exists public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending'
             check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  constraint friendships_pair unique (requester, addressee),
  constraint friendships_not_self check (requester <> addressee)
);

create index if not exists friendships_requester on public.friendships (requester);
create index if not exists friendships_addressee on public.friendships (addressee);

alter table public.friendships enable row level security;

drop policy if exists "friendships visible to both" on public.friendships;
create policy "friendships visible to both"
  on public.friendships for select
  to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

drop policy if exists "friendships request as self" on public.friendships;
create policy "friendships request as self"
  on public.friendships for insert
  to authenticated
  with check (auth.uid() = requester);

-- Принять заявку может только адресат. Раньше политика разрешала обеим
-- сторонам менять строку, а значит отправитель мог сам объявить себя другом
-- без согласия второго человека. Отменить заявку — это удаление строки,
-- для него есть отдельная политика.
drop policy if exists "friendships respond" on public.friendships;
create policy "friendships respond"
  on public.friendships for update
  to authenticated
  using (addressee = auth.uid())
  with check (addressee = auth.uid() and status = 'accepted');

drop policy if exists "friendships remove" on public.friendships;
create policy "friendships remove"
  on public.friendships for delete
  to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

-- ── ГРУППЫ ─────────────────────────────────────────────────────────────────
create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(trim(name)) between 1 and 60),
  owner      uuid not null references public.profiles(id) on delete cascade,
  invite     text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  member    uuid not null references public.profiles(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, member)
);

create index if not exists group_members_member on public.group_members (member);

-- Проверка членства без рекурсии политик: функция читает таблицу в обход RLS.
create or replace function public.is_group_member(gid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and member = auth.uid()
  );
$$;

-- То же для владельца: политика удаления участника иначе обращалась бы к
-- public.groups, а у той политики есть своя проверка членства.
create or replace function public.is_group_owner(gid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.groups
    where id = gid and owner = auth.uid()
  );
$$;

alter table public.groups enable row level security;
alter table public.group_members enable row level security;

drop policy if exists "groups visible to members" on public.groups;
create policy "groups visible to members"
  on public.groups for select
  to authenticated
  using (owner = auth.uid() or public.is_group_member(id));

drop policy if exists "groups create as self" on public.groups;
create policy "groups create as self"
  on public.groups for insert
  to authenticated
  with check (owner = auth.uid());

drop policy if exists "groups owner updates" on public.groups;
create policy "groups owner updates"
  on public.groups for update
  to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "groups owner deletes" on public.groups;
create policy "groups owner deletes"
  on public.groups for delete
  to authenticated
  using (owner = auth.uid());

drop policy if exists "members visible to group" on public.group_members;
create policy "members visible to group"
  on public.group_members for select
  to authenticated
  using (public.is_group_member(group_id) or member = auth.uid());

-- Добавить себя в группу можно только создав её: так организатор попадает в
-- собственный список участников. Вступление по коду идёт через функцию ниже,
-- которая работает в обход этой политики. Без такого ограничения любой, кто
-- узнал UUID чужой группы, мог бы вступить в неё, минуя код приглашения.
drop policy if exists "members add self" on public.group_members;
create policy "members add self"
  on public.group_members for insert
  to authenticated
  with check (member = auth.uid() and public.is_group_owner(group_id));

drop policy if exists "members leave" on public.group_members;
create policy "members leave"
  on public.group_members for delete
  to authenticated
  using (
    -- Anyone may leave on their own.  Removing somebody else is allowed only
    -- to the group owner: a plain member must not be able to expel the person
    -- who created the group.
    member = auth.uid()
    or public.is_group_owner(group_id)
  );

-- Вступление по коду: функция находит группу и добавляет звонящего.
-- Политика "members add self" иначе не даёт прочитать чужую группу до вставки.
create or replace function public.join_group(invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  gid uuid;
begin
  select id into gid from public.groups where invite = upper(trim(invite_code));
  if gid is null then
    raise exception 'GROUP_NOT_FOUND';
  end if;
  insert into public.group_members (group_id, member, role)
    values (gid, auth.uid(), 'member')
    on conflict (group_id, member) do nothing;
  return gid;
end;
$$;

-- Куда вступил — оттуда можно и выйти. Но организатору выходить нельзя: без
-- него группа осталась бы ничьей и нестираемой. Проверка живёт в базе, а не
-- только в интерфейсе, поэтому обойти её нельзя.
create or replace function public.leave_group(gid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.groups where id = gid and owner = auth.uid()) then
    raise exception 'OWNER_CANNOT_LEAVE';
  end if;
  delete from public.group_members where group_id = gid and member = auth.uid();
end;
$$;

-- ── ПРИСУТСТВИЕ ────────────────────────────────────────────────────────────
-- Клиент отмечается раз в несколько секунд. «Онлайн» — отметка свежее 45 с.
create table if not exists public.presence (
  user_id   uuid primary key references public.profiles(id) on delete cascade,
  last_seen timestamptz not null default now()
);

alter table public.presence enable row level security;

drop policy if exists "presence readable" on public.presence;
create policy "presence readable"
  on public.presence for select
  to authenticated using (true);

drop policy if exists "presence own write" on public.presence;
create policy "presence own write"
  on public.presence for insert
  to authenticated with check (auth.uid() = user_id);

drop policy if exists "presence own update" on public.presence;
create policy "presence own update"
  on public.presence for update
  to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "presence own delete" on public.presence;
create policy "presence own delete"
  on public.presence for delete
  to authenticated using (auth.uid() = user_id);

-- ── ПРИГЛАШЕНИЯ В ЗВОНОК ───────────────────────────────────────────────────
create table if not exists public.call_invites (
  id         uuid primary key default gen_random_uuid(),
  from_user  uuid not null references public.profiles(id) on delete cascade,
  to_user    uuid references public.profiles(id) on delete cascade,
  group_id   uuid references public.groups(id) on delete cascade,
  room       text not null,
  created_at timestamptz not null default now()
);

create index if not exists call_invites_to on public.call_invites (to_user);
create index if not exists call_invites_group on public.call_invites (group_id);

alter table public.call_invites enable row level security;

drop policy if exists "invites visible to target" on public.call_invites;
create policy "invites visible to target"
  on public.call_invites for select
  to authenticated
  using (
    to_user = auth.uid()
    or (group_id is not null and public.is_group_member(group_id))
    or from_user = auth.uid()
  );

drop policy if exists "invites send as self" on public.call_invites;
create policy "invites send as self"
  on public.call_invites for insert
  to authenticated
  with check (
    from_user = auth.uid()
    and (
      to_user is not null
      or (group_id is not null and public.is_group_member(group_id))
    )
  );

drop policy if exists "invites delete own" on public.call_invites;
create policy "invites delete own"
  on public.call_invites for delete
  to authenticated
  using (
    from_user = auth.uid()
    or to_user = auth.uid()
    -- A group invitation has no single addressee, so without this a member
    -- could never dismiss it and it would sit in their list until it expired.
    or (group_id is not null and public.is_group_member(group_id))
  );

-- ── ЧИСТКА СТАРЫХ ПРИГЛАШЕНИЙ ─────────────────────────────────────────────
-- Приглашение живёт десять минут; всё старше просто не показывается, но
-- строки копятся, поэтому удаляем их по расписанию.
create or replace function public.expire_call_invites()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.call_invites where created_at < now() - interval '10 minutes';
$$;
