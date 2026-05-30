-- 4th cosmetic slot: independent border column.
--
-- Borders were originally folded into selected_pattern (a shared 2nd slot), which made a
-- pattern and a border mutually exclusive. They are now an independent slot so a player can
-- equip BOTH at once (border rings the rim, pattern textures the sphere body). This adds the
-- dedicated column; the server persists borders here via COSMETIC_SLOT_COLUMN.border.
--
-- Nullable text, same shape/grants as the other selected_* columns (no new RLS needed — the
-- existing row-owner policies already cover every column of public.progression).

alter table public.progression
    add column if not exists selected_border text;
