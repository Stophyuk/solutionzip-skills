-- deploy/db/roles.sql — first initdb only (mounted into the image's init-scripts). Service roles share POSTGRES_PASSWORD.
-- Name only roles the image has: psql aborts the file at the first error, and the roles after it keep no password.
-- (supabase_functions_admin, for one, does not exist in supabase/postgres 17.6.1.136.)
\set pgpass `echo "$POSTGRES_PASSWORD"`
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
