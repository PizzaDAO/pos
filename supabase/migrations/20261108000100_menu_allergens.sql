-- ============================================================================
-- Migration: menu_allergens  (pos-v1-gaps phase 4)
--
-- `menu.publishAllergens` (backofhouse): POS STORES the published allergen matrix
-- and ANNOUNCES `menu.allergens.published`. Nothing guest-facing reads it (Snax,
-- 2026-11-01: store and announce only).
--
--   * menu_allergen_publications: one row per (tenant, version).
--   * menu_allergen_rows: the matrix of the LATEST publication only (older
--     versions keep their publication row, their rows are replaced).
--   * core_publish_allergens(): ONE transaction, serialised per tenant:
--       - same version + same hash   -> 'replay' (nothing written, nothing emitted)
--       - same version, other hash   -> 'conflict'
--       - every target_id must belong to THIS tenant (item, size via its item,
--         modifier via its group) and every location id to this tenant, checked
--         here because the service key bypasses RLS -> 'unknown_target' /
--         'unknown_location' with the offending ids; nothing is written
--       - a duplicate (type, id) in the payload -> 'duplicate'
--       - writes the rows and emits the event (when the outbox is enabled) in the
--         same transaction, so a publication is never stored without its event.
--
-- DEPLOY ORDER: migration first, code second (nothing emits until the endpoint
-- exists; the code worker must predate no event of this type). Additive and
-- live-safe: new tables and functions only; lock_timeout bounds the catalog lock.
-- No trigger is touched.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create table if not exists public.menu_allergen_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version text not null,
  payload_hash text not null,
  location_ids uuid[],
  row_count integer not null check (row_count >= 0),
  published_by text,
  published_at timestamptz not null default now(),
  unique (tenant_id, version)
);

create table if not exists public.menu_allergen_rows (
  publication_id uuid not null references public.menu_allergen_publications(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  target_type text not null check (target_type in ('item', 'size', 'modifier')),
  target_id uuid not null,
  contains text[] not null default '{}',
  may_contain text[] not null default '{}',
  tags text[] not null default '{}',
  primary key (publication_id, target_type, target_id)
);
create index if not exists menu_allergen_rows_tenant_idx
  on public.menu_allergen_rows (tenant_id, target_type, target_id);

alter table public.menu_allergen_publications enable row level security;
alter table public.menu_allergen_publications force row level security;
alter table public.menu_allergen_rows enable row level security;
alter table public.menu_allergen_rows force row level security;
revoke all on public.menu_allergen_publications from anon, authenticated;
revoke all on public.menu_allergen_rows from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.menu_allergen_publications to service_role;
    grant select, insert, update, delete on public.menu_allergen_rows to service_role;
  end if;
end
$$;

create or replace function public.core_publish_allergens(
  p_tenant_id uuid,
  p_version text,
  p_payload_hash text,
  p_location_ids uuid[],
  p_published_by text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pub public.menu_allergen_publications;
  v_bad jsonb;
  v_dups jsonb;
  v_n integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'core_publish_allergens: rows must be an array';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':allergens', 0));

  select * into v_pub from public.menu_allergen_publications
   where tenant_id = p_tenant_id and version = p_version;
  if found then
    if v_pub.payload_hash = p_payload_hash then
      return jsonb_build_object('outcome', 'replay', 'publication', to_jsonb(v_pub));
    end if;
    return jsonb_build_object('outcome', 'conflict');
  end if;

  if p_location_ids is not null then
    select coalesce(jsonb_agg(l), '[]'::jsonb) into v_bad
      from unnest(p_location_ids) l
     where not exists (select 1 from public.locations x
                        where x.id = l and x.tenant_id = p_tenant_id);
    if jsonb_array_length(v_bad) > 0 then
      return jsonb_build_object('outcome', 'unknown_location', 'ids', v_bad);
    end if;
  end if;

  create temp table if not exists pg_temp._core_allergen_rows (
    target_type text, target_id text, contains text[], may_contain text[], tags text[]
  ) on commit drop;
  truncate pg_temp._core_allergen_rows;
  insert into pg_temp._core_allergen_rows
  select e ->> 'target_type', e ->> 'target_id',
         coalesce(array(select jsonb_array_elements_text(coalesce(e -> 'contains', '[]'::jsonb))), '{}'),
         coalesce(array(select jsonb_array_elements_text(coalesce(e -> 'may_contain', '[]'::jsonb))), '{}'),
         coalesce(array(select jsonb_array_elements_text(coalesce(e -> 'tags', '[]'::jsonb))), '{}')
    from jsonb_array_elements(p_rows) e;

  -- Targets: a malformed id, or one not owned by this tenant, is refused.
  select coalesce(jsonb_agg(r.target_id), '[]'::jsonb) into v_bad
    from (
      select r.target_id from pg_temp._core_allergen_rows r
       where r.target_type not in ('item', 'size', 'modifier')
          or r.target_id is null
          or r.target_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or not (
            case r.target_type
              when 'item' then exists (select 1 from public.menu_items i
                                        where i.id = r.target_id::uuid and i.tenant_id = p_tenant_id)
              when 'size' then exists (select 1 from public.item_sizes s
                                         join public.menu_items i on i.id = s.item_id
                                        where s.id = r.target_id::uuid and i.tenant_id = p_tenant_id)
              when 'modifier' then exists (select 1 from public.modifiers m
                                             join public.modifier_groups g on g.id = m.group_id
                                            where m.id = r.target_id::uuid and g.tenant_id = p_tenant_id)
              else false
            end)
       limit 20
    ) r;
  if jsonb_array_length(v_bad) > 0 then
    return jsonb_build_object('outcome', 'unknown_target', 'ids', v_bad);
  end if;

  select coalesce(jsonb_agg(d.target_id), '[]'::jsonb) into v_dups
    from (select target_type, target_id from pg_temp._core_allergen_rows
           group by target_type, target_id having count(*) > 1 limit 20) d;
  if jsonb_array_length(v_dups) > 0 then
    return jsonb_build_object('outcome', 'duplicate', 'ids', v_dups);
  end if;

  select count(*) into v_n from pg_temp._core_allergen_rows;
  insert into public.menu_allergen_publications
    (tenant_id, version, payload_hash, location_ids, row_count, published_by)
  values (p_tenant_id, p_version, p_payload_hash, p_location_ids, v_n, p_published_by)
  returning * into v_pub;

  delete from public.menu_allergen_rows where tenant_id = p_tenant_id;
  insert into public.menu_allergen_rows
    (publication_id, tenant_id, target_type, target_id, contains, may_contain, tags)
  select v_pub.id, p_tenant_id, target_type, target_id::uuid, contains, may_contain, tags
    from pg_temp._core_allergen_rows;

  if public.core_outbox_enabled() then
    perform public.core_emit(p_tenant_id, null, 'menu.allergens.published',
      'allergen_publication', v_pub.id, null, null,
      jsonb_build_object('publication_id', v_pub.id));
  end if;

  return jsonb_build_object('outcome', 'ok', 'publication', to_jsonb(v_pub));
end;
$$;

revoke all on function public.core_publish_allergens(uuid, text, text, uuid[], text, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_publish_allergens(uuid, text, text, uuid[], text, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_publish_allergens(uuid, text, text, uuid[], text, jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_publish_allergens(uuid, text, text, uuid[], text, jsonb) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
