-- Every table carries `seq`, the insertion order the storage layer reads rows
-- in (sheet order). system_config was the one table created without it.
alter table public.system_config add column seq bigint generated always as identity unique;
