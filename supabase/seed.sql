-- ============================================================================
-- Seed: sample pizzeria — "Tony's Pizza"
--
-- One demo tenant, two locations, and a small but realistic menu with
-- half-and-half-capable modifier groups. Used to develop against once a live
-- Supabase DB exists (DEFERRED in Phase 0).
--
-- NOTE: The menu tables (menu_categories, menu_items, item_sizes,
-- modifier_groups, modifiers, item_modifier_groups) are introduced by a Phase 1
-- migration. This seed is written against that intended shape so it is ready to
-- run when those migrations land; it is idempotent via fixed UUIDs + ON CONFLICT.
-- Apply AFTER migrations. See supabase/README.md.
-- ============================================================================

-- ---- Tenant + locations -----------------------------------------------------
insert into public.tenants (id, name, slug, status) values
  ('10000000-0000-0000-0000-000000000001', 'Tony''s Pizza', 'tonys-pizza', 'active')
on conflict (id) do nothing;

insert into public.locations (id, tenant_id, name, slug, timezone, address) values
  ('10000000-0000-0000-0000-000000000101',
   '10000000-0000-0000-0000-000000000001',
   'Tony''s Downtown', 'tonys-downtown', 'America/New_York',
   '123 Main St, Springfield'),
  ('10000000-0000-0000-0000-000000000102',
   '10000000-0000-0000-0000-000000000001',
   'Tony''s Uptown', 'tonys-uptown', 'America/New_York',
   '900 North Ave, Springfield')
on conflict (id) do nothing;

-- ============================================================================
-- MENU (Phase 1 schema — included here so the seed is complete and ready).
-- Guarded by to_regclass so this block is a no-op until the menu tables exist.
-- ============================================================================
do $$
begin
  if to_regclass('public.menu_items') is null then
    raise notice 'Menu tables not present yet; skipping menu seed (run Phase 1 migrations first).';
    return;
  end if;

  -- ---- Categories -----------------------------------------------------------
  insert into public.menu_categories (id, tenant_id, name, sort_order) values
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Pizzas', 1),
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Drinks', 2)
  on conflict (id) do nothing;

  -- ---- Items ----------------------------------------------------------------
  insert into public.menu_items (id, tenant_id, category_id, name, description, is_half_and_half_capable) values
    ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000001', 'Margherita',
     'San Marzano tomato, fresh mozzarella, basil.', true),
    ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000001', 'Pepperoni',
     'Tomato, mozzarella, pepperoni.', true),
    ('30000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000002', 'Fountain Soda',
     'Choice of fountain drink.', false)
  on conflict (id) do nothing;

  -- ---- Sizes (per pizza item; price in integer cents) -----------------------
  insert into public.item_sizes (id, item_id, name, price_cents, sort_order) values
    -- Margherita S/M/L
    ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Small (10")',  1099, 1),
    ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'Medium (14")', 1499, 2),
    ('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'Large (18")',  1899, 3),
    -- Pepperoni S/M/L
    ('40000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000002', 'Small (10")',  1299, 1),
    ('40000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000002', 'Medium (14")', 1699, 2),
    ('40000000-0000-0000-0000-000000000013', '30000000-0000-0000-0000-000000000002', 'Large (18")',  2099, 3)
  on conflict (id) do nothing;

  -- ---- Modifier groups ------------------------------------------------------
  -- supports_half: whether modifiers in this group can be applied to left/right
  -- half of a pizza (half-and-half). Crust/sauce are whole-pie; toppings split.
  insert into public.modifier_groups (id, tenant_id, name, min_select, max_select, supports_half) values
    ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Crust',    1, 1, false),
    ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Sauce',    1, 1, false),
    ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Toppings', 0, 10, true)
  on conflict (id) do nothing;

  -- ---- Modifiers ------------------------------------------------------------
  insert into public.modifiers (id, group_id, name, price_cents, sort_order) values
    -- Crust
    ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Hand-tossed', 0, 1),
    ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', 'Thin',        0, 2),
    ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', 'Deep dish',  200, 3),
    -- Sauce
    ('60000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000002', 'Tomato',      0, 1),
    ('60000000-0000-0000-0000-000000000012', '50000000-0000-0000-0000-000000000002', 'White',     100, 2),
    -- Toppings (half-and-half capable)
    ('60000000-0000-0000-0000-000000000021', '50000000-0000-0000-0000-000000000003', 'Mushrooms',  150, 1),
    ('60000000-0000-0000-0000-000000000022', '50000000-0000-0000-0000-000000000003', 'Onions',     150, 2),
    ('60000000-0000-0000-0000-000000000023', '50000000-0000-0000-0000-000000000003', 'Sausage',    250, 3),
    ('60000000-0000-0000-0000-000000000024', '50000000-0000-0000-0000-000000000003', 'Extra cheese', 200, 4)
  on conflict (id) do nothing;

  -- ---- Wire modifier groups to pizza items ----------------------------------
  insert into public.item_modifier_groups (item_id, group_id, sort_order) values
    ('30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1),
    ('30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 2),
    ('30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000003', 3),
    ('30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', 1),
    ('30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 2),
    ('30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000003', 3)
  on conflict do nothing;
end $$;
