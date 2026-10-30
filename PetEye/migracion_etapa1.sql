alter table public.places add column if not exists tipo text not null default 'habitual' check (tipo in ('casa','habitual'));
create unique index if not exists una_casa_por_mascota on public.places (pet_id) where tipo = 'casa';
alter table public.share_links add column if not exists etiqueta text;
