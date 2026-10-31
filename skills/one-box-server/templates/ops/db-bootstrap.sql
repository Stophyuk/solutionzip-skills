-- db-bootstrap.sql — run once per app right after the first initdb, as supabase_admin, before starting storage/auth
-- (ops/bootstrap-db.sh does this):
--   docker exec -i <app>-db-1 psql -U supabase_admin -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD" -f - < db-bootstrap.sql
-- Why: the image's init scripts leave auth.* functions owned by `postgres` and the storage schema empty, while
-- GoTrue (as supabase_auth_admin) and storage-api (as supabase_storage_admin) must own what they migrate.
-- Also re-applies the service-role passwords in case roles.sql did not finish.
alter user supabase_storage_admin with password :'pw';
alter user supabase_auth_admin with password :'pw';
alter user authenticator with password :'pw';
alter user pgbouncer with password :'pw';
grant all on schema auth to supabase_auth_admin;
grant all on schema storage to supabase_storage_admin;
-- storage-api switches to the request's role (anon / authenticated / service_role): without membership every upload is refused
grant anon, authenticated, service_role to supabase_storage_admin;
create extension if not exists pg_cron;
grant usage on schema cron to postgres;
grant all on all tables in schema cron to postgres;
do $$ declare r record; begin
  for r in select format('alter table %I.%I owner to supabase_auth_admin', n.nspname, c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relkind in ('r','S','v','m') loop execute r.q; end loop;
  for r in select format('alter function %s owner to supabase_auth_admin', p.oid::regprocedure) q from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' loop execute r.q; end loop;
  for r in select format('alter table %I.%I owner to supabase_storage_admin', n.nspname, c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relkind in ('r','S','v','m') loop execute r.q; end loop;
  for r in select format('alter function %s owner to supabase_storage_admin', p.oid::regprocedure) q from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='storage' loop execute r.q; end loop;
end $$;
