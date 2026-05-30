-- Three-slot composable cosmetics. The old model stored a SINGLE equipped cosmetic in
-- selected_skin (cart shape + pattern shared one slot). The rework splits cosmetics into
-- three INDEPENDENT, simultaneously-equippable slots — cart (body shape), pattern (texture
-- painted on the body, tinted to the player's color), and trail (motion-trail effect,
-- rendered in the player's color). Each slot is its own nullable text id (null = the slot's
-- default: plain cart / no pattern / basic trail). Explicit columns (NOT a jsonb blob) so
-- equips are cheap to validate + index and the schema documents the model.
--
-- The legacy selected_skin column is intentionally KEPT (not dropped) so any already-equipped
-- value survives; the server reads selected_cart/pattern/trail and ignores selected_skin going
-- forward. Written ONLY via the service-role key, same as every other progression column
-- (anon/authenticated writes were revoked in 0004).
alter table public.progression
    add column if not exists selected_cart    text,
    add column if not exists selected_pattern text,
    add column if not exists selected_trail   text;
