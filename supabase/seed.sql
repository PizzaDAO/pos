-- ============================================================================
-- Seed: sample pizzeria — "Tony's Pizza" (FULL demo dataset)
--
-- One demo tenant, two locations, the full menu (pizzas with half-and-half
-- modifier groups, drinks, sides), the owner user + membership + platform admin,
-- per-location store/payment settings (incl. fulfillment/delivery zones),
-- inventory + recipe links + staff, and the SaaS layer (onboarded + Pro
-- subscription). This mirrors src/lib/db/seed-data.ts so a freshly-provisioned
-- DB matches EXACTLY what the in-memory mock driver shows.
--
-- Idempotent via fixed UUIDs + ON CONFLICT. Apply AFTER migrations
-- (supabase/apply.sh / supabase db push). See supabase/README.md.
--
-- The menu block is guarded by `to_regclass('public.menu_items')` so it is a
-- safe no-op if only the tenancy core has been applied; the remaining sections
-- assume the domain migrations (20260605000000_domain_core.sql) have run.
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
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Drinks', 2),
    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Sides',  3)
  on conflict (id) do nothing;

  -- ---- Items ----------------------------------------------------------------
  insert into public.menu_items (id, tenant_id, category_id, name, description, is_half_and_half_capable, station) values
    ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000001', 'Margherita',
     'San Marzano tomato, fresh mozzarella, basil.', true, 'oven'),
    ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000001', 'Pepperoni',
     'Tomato, mozzarella, pepperoni.', true, 'oven'),
    ('30000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000002', 'Fountain Soda',
     'Choice of fountain drink.', false, 'none'),
    ('30000000-0000-0000-0000-000000000020', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000003', 'Caesar Salad',
     'Romaine, parmesan, croutons, Caesar dressing.', false, 'cold'),
    ('30000000-0000-0000-0000-000000000030', '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000003', 'Garlic Knots',
     'Fried dough knots, garlic butter, parmesan.', false, 'fryer')
  on conflict (id) do nothing;

  -- ---- Sizes (per item; price in integer cents) -----------------------------
  insert into public.item_sizes (id, item_id, name, price_cents, sort_order) values
    -- Margherita S/M/L
    ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Small (10")',  1099, 1),
    ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'Medium (14")', 1499, 2),
    ('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'Large (18")',  1899, 3),
    -- Pepperoni S/M/L
    ('40000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000002', 'Small (10")',  1299, 1),
    ('40000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000002', 'Medium (14")', 1699, 2),
    ('40000000-0000-0000-0000-000000000013', '30000000-0000-0000-0000-000000000002', 'Large (18")',  2099, 3),
    -- Single-size items
    ('40000000-0000-0000-0000-000000000021', '30000000-0000-0000-0000-000000000010', 'Regular',  299, 1),
    ('40000000-0000-0000-0000-000000000031', '30000000-0000-0000-0000-000000000020', 'Regular',  899, 1),
    ('40000000-0000-0000-0000-000000000041', '30000000-0000-0000-0000-000000000030', '6-piece',  699, 1)
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

-- ============================================================================
-- OWNER + MEMBERSHIP + PLATFORM ADMIN
-- (mirrors src/lib/db/seed-data.ts so RLS lets the demo owner operate the tenant
-- and the platform operator drives /platform).
-- ============================================================================
insert into public.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'ops@pizzapos.example'),
  ('10000000-0000-0000-0000-0000000000a1', 'tony@tonys-pizza.example')
on conflict (id) do nothing;

insert into public.platform_admins (user_id) values
  ('00000000-0000-0000-0000-0000000000aa')
on conflict (user_id) do nothing;

insert into public.memberships (id, user_id, tenant_id, role) values
  ('10000000-0000-0000-0000-0000000000b1',
   '10000000-0000-0000-0000-0000000000a1',
   '10000000-0000-0000-0000-000000000001', 'owner')
on conflict (user_id, tenant_id) do nothing;

-- ============================================================================
-- STORE + PAYMENT SETTINGS (per location). Tax 8.25%, USD, tip presets.
-- Downtown offers pickup + delivery (two zones); Uptown is pickup-only.
-- ============================================================================
insert into public.store_settings
  (tenant_id, location_id, currency, tax_rate_bps, tip_presets_bps, kds_thresholds, fulfillment)
values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101',
   'USD', 825, '{1500,1800,2000}',
   '{"warn_seconds":300,"urgent_seconds":600}'::jsonb,
   '{
      "pickup_enabled": true, "delivery_enabled": true,
      "prep_minutes": 20, "scheduling_lead_minutes": 15, "scheduling_horizon_days": 5,
      "hours": [
        {"weekday":0,"open":"11:00","close":"22:00","closed":false},
        {"weekday":1,"open":"11:00","close":"22:00","closed":false},
        {"weekday":2,"open":"11:00","close":"22:00","closed":false},
        {"weekday":3,"open":"11:00","close":"22:00","closed":false},
        {"weekday":4,"open":"11:00","close":"22:00","closed":false},
        {"weekday":5,"open":"11:00","close":"23:00","closed":false},
        {"weekday":6,"open":"11:00","close":"23:00","closed":false}
      ],
      "delivery_providers": ["in_house_manual","doordash_drive"],
      "pickup_address": "123 Main St, Springfield",
      "delivery_zones": [
        {"id":"zone-near","name":"Downtown core","postal_codes":["10001","10002","10003"],
         "fee_cents":399,"eta_minutes":30,"min_subtotal_cents":0},
        {"id":"zone-far","name":"Greater Springfield","postal_codes":["10010","10011","10012"],
         "fee_cents":699,"eta_minutes":45,"min_subtotal_cents":2000}
      ]
    }'::jsonb),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000102',
   'USD', 825, '{1500,1800,2000}',
   '{"warn_seconds":300,"urgent_seconds":600}'::jsonb,
   '{
      "pickup_enabled": true, "delivery_enabled": false,
      "prep_minutes": 25, "scheduling_lead_minutes": 15, "scheduling_horizon_days": 5,
      "hours": [
        {"weekday":0,"open":"11:00","close":"22:00","closed":false},
        {"weekday":1,"open":"11:00","close":"22:00","closed":false},
        {"weekday":2,"open":"11:00","close":"22:00","closed":false},
        {"weekday":3,"open":"11:00","close":"22:00","closed":false},
        {"weekday":4,"open":"11:00","close":"22:00","closed":false},
        {"weekday":5,"open":"11:00","close":"23:00","closed":false},
        {"weekday":6,"open":"11:00","close":"23:00","closed":false}
      ],
      "delivery_providers": [],
      "pickup_address": "900 North Ave, Springfield",
      "delivery_zones": []
    }'::jsonb)
on conflict (tenant_id, location_id) do nothing;

insert into public.payment_settings
  (tenant_id, location_id, currency, platform_fee_bps, platform_fee_flat_cents, tip_presets_bps)
values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101',
   'USD', 250, 10, '{1500,1800,2000}'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000102',
   'USD', 250, 10, '{1500,1800,2000}')
on conflict (tenant_id, location_id) do nothing;

-- ============================================================================
-- INVENTORY (per location) + recipe links (tenant-level) + STAFF.
-- Downtown pepperoni is seeded near its low threshold (demo low-stock alert).
-- ============================================================================
insert into public.inventory_items
  (id, tenant_id, location_id, name, unit, on_hand, low_threshold)
values
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000101', 'Pizza dough ball', 'each', 80, 20),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000101', 'Mozzarella', 'g', 20000, 5000),
  ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000101', 'Pepperoni', 'g', 600, 500),
  ('70000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000102', 'Pizza dough ball', 'each', 60, 15),
  ('70000000-0000-0000-0000-000000000102', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000102', 'Mozzarella', 'g', 15000, 5000),
  ('70000000-0000-0000-0000-000000000103', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000102', 'Pepperoni', 'g', 4000, 500)
on conflict (id) do nothing;

insert into public.item_inventory_links
  (id, tenant_id, source_type, source_id, inventory_item_id, qty_per_unit)
values
  ('71000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'item', '30000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 1),
  ('71000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   'item', '30000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002', 150),
  ('71000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
   'item', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 1),
  ('71000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
   'item', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', 150),
  ('71000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
   'item', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000003', 80),
  ('71000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001',
   'modifier', '60000000-0000-0000-0000-000000000024', '70000000-0000-0000-0000-000000000002', 75)
on conflict (id) do nothing;

-- Quick-switch PINs are scrypt hashes (plaintext NEVER stored) so the terminal
-- PIN switch is demoable live: Tony 1111 · Carmela 2222 · Christopher 3333 ·
-- Furio 4444. Set them via UPDATE (pin_hash is added by the auth_user_bridge
-- migration). A tenant resets these in the back office.
insert into public.staff (id, tenant_id, name, role, active) values
  ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Tony Soprano',    'owner',   true),
  ('80000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Carmela M.',      'manager', true),
  ('80000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Christopher M.',  'cashier', true),
  ('80000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Furio G.',        'kitchen', true)
on conflict (id) do nothing;

update public.staff set pin_hash = case id
  when '80000000-0000-0000-0000-000000000001' then 'scrypt$4f488f0d1691c55d1556e31c507b239f$95f4f7ba3f253dbaacaa4a9f398c9b0d2c842ce4f9a96d4e66decda6adeb4720'
  when '80000000-0000-0000-0000-000000000002' then 'scrypt$4ab34d7609f8e6617dcfea668f618370$ee86b11282bc48d711aa3394602fb6e1b51743050cb360529d27e151cdd34059'
  when '80000000-0000-0000-0000-000000000003' then 'scrypt$f9711be6a1ca88216fb953d6de599969$c5bf37206b720347db1f626994a4388d55f5816c7bf92530d884db139f11cceb'
  when '80000000-0000-0000-0000-000000000004' then 'scrypt$10470d3a8e1408764b3fca12c9c78eec$3f0f3c62bba15799f6f4a9dd5cdeaaceb1d91599f017d56be0ac0f23b1c36b3e'
  else pin_hash end
where id in (
  '80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000002',
  '80000000-0000-0000-0000-000000000003','80000000-0000-0000-0000-000000000004'
);

-- ============================================================================
-- SaaS LAYER — the demo tenant is already onboarded + on the Pro plan, so
-- /platform shows a healthy live tenant (matches the mock's bootstrap).
-- ============================================================================
insert into public.tenant_onboarding
  (tenant_id, current_step, completed_steps, live)
values
  ('10000000-0000-0000-0000-000000000001', 'go_live',
   '{business,location,connect,menu,plan,go_live}', true)
on conflict (tenant_id) do nothing;

insert into public.subscriptions
  (id, tenant_id, tier, status, current_period_end, trial_end,
   cancel_at_period_end, simulated, stripe_customer_id, stripe_subscription_id)
values
  ('sub_sim_demo_tonys', '10000000-0000-0000-0000-000000000001', 'pro', 'active',
   now() + interval '30 days', null, false, true,
   'cus_sim_demo_tonys', 'sub_stripe_sim_demo_tonys')
on conflict (tenant_id) do nothing;
